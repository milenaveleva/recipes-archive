/**
 * Hero-image pipeline: fetch a recipe's remote image through the CORS-proxy
 * Worker, then commit it into the repo so Astro's `image()` helper can optimize
 * it at build and the recipe points at a local, build-time-hashed asset instead
 * of hot-linking the source site.
 *
 * The recipe markdown gets `image: "./images/<slug>.<ext>"`, which `image()`
 * resolves relative to `src/content/recipes/` — so the bytes are committed to
 * `src/content/recipes/images/<slug>.<ext>`. That file MUST exist before the
 * markdown referencing it is built, so the caller commits the image first.
 *
 * The committed format/extension is sniffed from the bytes' own magic numbers,
 * not the response's (spoofable) Content-Type: a server mislabeling a PNG as
 * `image/jpeg` still lands a correctly-named file, and a non-image body (an HTML
 * soft-404 served as `image/*`) is rejected outright so it can never break the
 * build's `image()` resolver. Best-effort by contract: every "this isn't a
 * usable image" outcome returns `null` (the caller falls back to the remote
 * `imageUrl`); only a transport or commit error throws. Isomorphic +
 * dependency-injected (fetch/commit) so the logic is unit-testable with mocks.
 */
import { commitBinaryFile, type CommitResult, type GitHubRepo } from './github';

/** ASCII of `len` bytes from `start`, bounds-safe (used for container tags). */
function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * The raster image format the bytes actually are, by magic number, or null when
 * they aren't a recognised raster image. The set matches the formats Astro's
 * image service handles and a browser renders; SVG is text, handled separately.
 */
export function sniffImageFormat(bytes: Uint8Array): 'jpg' | 'png' | 'gif' | 'webp' | 'avif' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  // ISO-BMFF: an `ftyp` box at offset 4 whose major/compatible brands name AVIF.
  // Scan the brand list bounded by the box size (bytes 0-3, big-endian) so we
  // never read past it into the next box and false-positive an MP4/HEIC.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(boxSize >= 16 ? boxSize : 16, bytes.length, 256);
    const brands = ascii(bytes, 8, end - 8);
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
  }
  return null;
}

/** True when the bytes are SVG markup (rejects HTML served as `image/svg+xml`). */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024));
  return /<svg[\s>]/i.test(head);
}

/** The repo path to commit to, and the frontmatter value that resolves to it. */
export function heroImagePaths(slug: string, ext: string): {
  commitPath: string;
  frontmatterPath: string;
} {
  return {
    commitPath: `src/content/recipes/images/${slug}.${ext}`,
    frontmatterPath: `./images/${slug}.${ext}`,
  };
}

export interface HeroImageOutcome {
  /** Frontmatter `image:` value (src-relative), to set on the draft. */
  frontmatterPath: string;
  /** Repo path the bytes were committed to. */
  commitPath: string;
  commit: CommitResult;
}

export interface HeroImageRequest {
  /** Absolute http(s) URL of the source image (already resolved against the page). */
  imageUrl: string;
  /** Recipe slug; drives the committed filename. */
  slug: string;
  /** Base URL of the CORS-proxy Worker. */
  proxy: string;
  /** GitHub access token with push rights. */
  token: string;
  repo: GitHubRepo;
  /** Commit message for the image. */
  message: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `commitBinaryFile`. */
  commitImpl?: typeof commitBinaryFile;
}

/**
 * Fetch the image via the proxy and commit it. Returns the outcome on success,
 * or `null` when the response isn't a usable image (non-OK, non-image
 * content-type, or bytes that don't sniff as a supported image). Throws only if
 * the fetch or the commit itself errors. The Worker caps the response size, so
 * there's no size guard here.
 */
export async function fetchAndCommitHeroImage(
  req: HeroImageRequest,
): Promise<HeroImageOutcome | null> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const commitImpl = req.commitImpl ?? commitBinaryFile;

  const res = await fetchImpl(`${req.proxy}?url=${encodeURIComponent(req.imageUrl)}`);
  if (!res.ok) return null;

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/')) return null;

  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = contentType.startsWith('image/svg')
    ? looksLikeSvg(bytes) ? 'svg' : null
    : sniffImageFormat(bytes);
  if (!ext) return null;

  const { commitPath, frontmatterPath } = heroImagePaths(req.slug, ext);
  const commit = await commitImpl(req.token, req.repo, {
    path: commitPath,
    bytes,
    message: req.message,
  });
  return { frontmatterPath, commitPath, commit };
}
