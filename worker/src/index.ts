/**
 * CORS proxy for in-app recipe import.
 *
 * A static GitHub Pages site can't fetch third-party recipe HTML from the
 * browser (CORS). This Worker fetches a target URL server-side and returns it
 * with an `Access-Control-Allow-Origin` pinned to our site. It is locked down
 * three ways: only our origin may call it, only http(s) non-private targets are
 * fetched (see ./guards), and responses are content-type filtered and size
 * capped. Deploy with `wrangler deploy` (see ../README.md).
 */
import { isAllowedOrigin, validateTargetUrl } from './guards';

interface Env {
  /** Comma-separated origin allowlist; overrides the default below. */
  ALLOWED_ORIGINS?: string;
}

const DEFAULT_ORIGINS = ['https://milenaveleva.github.io', 'http://localhost:4321'];
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — recipe pages and hero images are small
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT = /^(text\/html|application\/xhtml|text\/plain|image\/)/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = parseOrigins(env.ALLOWED_ORIGINS) ?? DEFAULT_ORIGINS;
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' }, cors);
    if (!isAllowedOrigin(origin, allowed)) return json(403, { error: 'origin not allowed' }, cors);

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return json(400, { error: 'missing ?url= parameter' }, cors);

    const check = validateTargetUrl(target);
    if (!check.ok) return json(400, { error: check.reason }, cors);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstream: Response | undefined;
    try {
      // Follow redirects manually so each hop's Location is re-validated — a
      // public URL must not be allowed to 30x-redirect into a private host.
      let current = check.url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await fetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; recipes-archive importer)',
            Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
          },
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) {
          upstream = res;
          break;
        }
        const next = validateTargetUrl(new URL(location, current).toString());
        if (!next.ok) return json(400, { error: `redirect ${next.reason}` }, cors);
        current = next.url;
      }
    } catch {
      // Generic message only — upstream error text can leak internal host info.
      return json(502, { error: 'upstream fetch failed' }, cors);
    } finally {
      clearTimeout(timer);
    }
    if (!upstream) return json(508, { error: 'too many redirects' }, cors);

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    if (!ALLOWED_CONTENT.test(contentType)) {
      return json(415, { error: `unsupported content-type: ${contentType}` }, cors);
    }
    const declaredLength = Number(upstream.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_BYTES) return json(413, { error: 'response too large' }, cors);

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) return json(413, { error: 'response too large' }, cors);

    return new Response(buffer, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    });
  },
};

function parseOrigins(value?: string): string[] | null {
  const list = value?.split(',').map((s) => s.trim()).filter(Boolean);
  return list && list.length ? list : null;
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const allow = origin && allowed.includes(origin) ? origin : (allowed[0] ?? '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
