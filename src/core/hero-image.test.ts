import { describe, it, expect, vi } from 'vitest';
import {
  sniffImageFormat,
  looksLikeSvg,
  heroImagePaths,
  fetchAndCommitHeroImage,
} from './hero-image';
import type { CommitResult, GitHubRepo } from './github';

const REPO: GitHubRepo = { owner: 'o', repo: 'r', branch: 'main' };
const COMMIT: CommitResult = { path: '', sha: 's', commitSha: 'c', updated: false };

// Minimal valid magic-number headers (≥12 bytes, the sniff floor).
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = new Uint8Array([...new TextEncoder().encode('GIF89a'), 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP'),
]);
const AVIF = new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0]);
// AVIF whose major brand is 'mif1' and 'avif' is only a later compatible brand.
const AVIF_COMPAT = new Uint8Array([
  0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypmif1'), 0, 0, 0, 0,
  ...new TextEncoder().encode('mif1'), ...new TextEncoder().encode('avif'),
]);
// A non-AVIF ISO-BMFF (MP4): an `ftyp` box with brands that never name AVIF.
const MP4 = new Uint8Array([
  0, 0, 0, 0x18, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0,
  ...new TextEncoder().encode('isom'), ...new TextEncoder().encode('mp42'),
]);
const HTML = new TextEncoder().encode('<!doctype html><html><body>404 not found</body></html>');
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');

function imageResponse(bytes: Uint8Array<ArrayBuffer>, contentType: string): Response {
  return new Response(bytes, { headers: { 'content-type': contentType } });
}

describe('sniffImageFormat', () => {
  it('recognises raster formats by magic number', () => {
    expect(sniffImageFormat(JPEG)).toBe('jpg');
    expect(sniffImageFormat(PNG)).toBe('png');
    expect(sniffImageFormat(GIF)).toBe('gif');
    expect(sniffImageFormat(WEBP)).toBe('webp');
    expect(sniffImageFormat(AVIF)).toBe('avif');
    expect(sniffImageFormat(AVIF_COMPAT)).toBe('avif'); // 'avif' as a later compatible brand
  });

  it('does not mistake a non-AVIF ISO-BMFF (MP4) for an image', () => {
    expect(sniffImageFormat(MP4)).toBeNull();
  });

  it('returns null for non-images and too-short buffers', () => {
    expect(sniffImageFormat(new Uint8Array(HTML))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull(); // valid prefix, too short
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
  });
});

describe('looksLikeSvg', () => {
  it('accepts SVG markup and rejects HTML', () => {
    expect(looksLikeSvg(new Uint8Array(SVG))).toBe(true);
    expect(looksLikeSvg(new Uint8Array(HTML))).toBe(false);
  });
});

describe('heroImagePaths', () => {
  it('builds the commit path and the src-relative frontmatter path', () => {
    expect(heroImagePaths('lentil-dahl', 'jpg')).toEqual({
      commitPath: 'src/content/recipes/images/lentil-dahl.jpg',
      frontmatterPath: './images/lentil-dahl.jpg',
    });
  });
});

describe('fetchAndCommitHeroImage', () => {
  const base = {
    imageUrl: 'https://site.test/hero.jpg',
    slug: 'lentil-dahl',
    proxy: 'https://proxy.test',
    token: 'tok',
    repo: REPO,
    message: 'Add hero image: Dahl',
  };

  const okCommit = () =>
    vi.fn(
      (
        _token: string,
        _repo: GitHubRepo,
        input: { path: string; bytes: Uint8Array; message: string },
      ): Promise<CommitResult> => Promise.resolve({ ...COMMIT, path: input.path }),
    );

  it('fetches via the proxy, commits the bytes, and returns the local paths', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => imageResponse(JPEG, 'image/jpeg'));
    const commitImpl = okCommit();
    const out = await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl });

    expect(fetchImpl).toHaveBeenCalledWith('https://proxy.test?url=https%3A%2F%2Fsite.test%2Fhero.jpg');
    expect(commitImpl).toHaveBeenCalledTimes(1);
    const input = commitImpl.mock.calls[0][2];
    expect(input.path).toBe('src/content/recipes/images/lentil-dahl.jpg');
    expect(Array.from(input.bytes)).toEqual(Array.from(JPEG));
    expect(input.message).toBe('Add hero image: Dahl');
    expect(out).toEqual({
      frontmatterPath: './images/lentil-dahl.jpg',
      commitPath: 'src/content/recipes/images/lentil-dahl.jpg',
      commit: expect.objectContaining({ sha: 's' }),
    });
  });

  it('names the file from the actual bytes, not a mislabeled content-type', async () => {
    // Server lies: PNG bytes served as image/jpeg. The committed file is .png.
    const fetchImpl = vi.fn(async (): Promise<Response> => imageResponse(PNG, 'image/jpeg'));
    const commitImpl = okCommit();
    const out = await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl });
    expect(out?.frontmatterPath).toBe('./images/lentil-dahl.png');
    expect(commitImpl.mock.calls[0][2].path).toBe('src/content/recipes/images/lentil-dahl.png');
  });

  it('commits an SVG when the content-type and markup agree', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => imageResponse(new Uint8Array(SVG), 'image/svg+xml'));
    const commitImpl = okCommit();
    const out = await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl });
    expect(out?.frontmatterPath).toBe('./images/lentil-dahl.svg');
  });

  it('returns null and skips the commit for a non-OK response', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response('nope', { status: 502 }));
    const commitImpl = okCommit();
    expect(await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl })).toBeNull();
    expect(commitImpl).not.toHaveBeenCalled();
  });

  it('returns null for a non-image content-type', async () => {
    const fetchImpl = vi.fn(
      async (): Promise<Response> => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    const commitImpl = okCommit();
    expect(await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl })).toBeNull();
    expect(commitImpl).not.toHaveBeenCalled();
  });

  it('rejects an HTML body mislabeled as an image (never commits a non-image)', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => imageResponse(new Uint8Array(HTML), 'image/jpeg'));
    const commitImpl = okCommit();
    expect(await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl })).toBeNull();
    expect(commitImpl).not.toHaveBeenCalled();
  });

  it('rejects HTML served as image/svg+xml', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => imageResponse(new Uint8Array(HTML), 'image/svg+xml'));
    const commitImpl = okCommit();
    expect(await fetchAndCommitHeroImage({ ...base, fetchImpl, commitImpl })).toBeNull();
    expect(commitImpl).not.toHaveBeenCalled();
  });
});
