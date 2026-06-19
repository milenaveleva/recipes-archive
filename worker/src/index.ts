/**
 * Backend for the in-app authoring flow. One Worker, two jobs:
 *
 *  - CORS proxy (`GET /?url=`): a static GitHub Pages site can't fetch
 *    third-party recipe HTML from the browser, so this fetches a target URL
 *    server-side and returns it with an `Access-Control-Allow-Origin` pinned to
 *    our site. Locked down three ways: only our origin may call it, only
 *    http(s) non-private targets are fetched (see ./guards), and responses are
 *    content-type filtered and size capped.
 *  - GitHub sign-in (`/auth`, `/callback`, `/refresh`): the authorization-code
 *    exchange needs the GitHub App's client secret, which can't live in static
 *    site JS, so it happens here (see ./oauth). The user token is handed to the
 *    opener window via postMessage, pinned to our origin.
 *
 * Deploy with `wrangler deploy` (see ../README.md).
 */
import { isAllowedOrigin, validateTargetUrl } from './guards';
import {
  authAllowedOrigins,
  authorizeRedirectUrl,
  buildState,
  completeAuthorization,
  errorHtml,
  refreshAuthorization,
  successHtml,
  verifyState,
} from './oauth';

interface Env {
  /** Comma-separated origin allowlist for the CORS proxy; overrides the default below. */
  ALLOWED_ORIGINS?: string;
  /**
   * Comma-separated origins permitted to RECEIVE a sign-in token. Defaults to
   * the https subset of ALLOWED_ORIGINS (so a token is never delivered to
   * http://localhost). Set explicitly only on a dev worker to allow localhost.
   */
  ALLOWED_AUTH_ORIGINS?: string;
  /** GitHub App OAuth credentials (set as Worker secrets) — enable sign-in. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const DEFAULT_ORIGINS = ['https://milenaveleva.github.io', 'http://localhost:4321'];
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — recipe pages and hero images are small
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT = /^(text\/html|application\/xhtml|text\/plain|image\/)/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = parseOrigins(env.ALLOWED_ORIGINS) ?? DEFAULT_ORIGINS;
    // Token-delivery routes use a stricter (https-only by default) allowlist so a
    // user token is never postMessaged to a plaintext / any-local-process origin.
    const authOrigins = authAllowedOrigins(allowed, env.ALLOWED_AUTH_ORIGINS);
    const url = new URL(request.url);
    const path = '/' + url.pathname.split('/').filter(Boolean).join('/');

    switch (path) {
      case '/auth':
        return handleAuthStart(url, env, authOrigins);
      case '/callback':
        return handleCallback(url, env, authOrigins);
      case '/refresh':
        return handleRefresh(request, env, authOrigins);
      default:
        return handleProxy(request, allowed);
    }
  },
};

/* ---- recipe-import CORS proxy ---- */

async function handleProxy(request: Request, allowed: string[]): Promise<Response> {
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
}

/* ---- GitHub sign-in ---- */

// Start the GitHub App user-authorization flow. The opener origin rides in the
// signed state so the callback can message exactly the window that began it.
async function handleAuthStart(url: URL, env: Env, allowed: string[]): Promise<Response> {
  const wanted = url.searchParams.get('origin');
  const origin = wanted && allowed.includes(wanted) ? wanted : null;
  if (!origin) return plainHtmlError(403, 'This site is not allowed to sign in here.');
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return htmlResponse(errorHtml(origin, 'Sign-in is not configured on the server.'));
  }
  const state = await buildState(origin, env.GITHUB_CLIENT_SECRET, Date.now());
  const location = authorizeRedirectUrl(env.GITHUB_CLIENT_ID, state, `${url.origin}/callback`);
  return Response.redirect(location, 302);
}

// GitHub redirects here with ?code&state; exchange server-side and postMessage
// the token to the opener. Every exit returns a popup page so the opener always
// hears back (success or a reason) and the window can close.
async function handleCallback(url: URL, env: Env, allowed: string[]): Promise<Response> {
  // No trusted origin to message back to → never fall back to a wildcard target.
  if (allowed.length === 0) return plainHtmlError(500, 'Sign-in origin is not configured.');
  const fallback = allowed[0];
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return htmlResponse(errorHtml(fallback, 'Sign-in is not configured on the server.'));
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return htmlResponse(errorHtml(fallback, 'Missing sign-in parameters.'));

  const verified = await verifyState(state, env.GITHUB_CLIENT_SECRET, Date.now());
  if (!verified.ok) return htmlResponse(errorHtml(fallback, 'Sign-in expired or was tampered with. Please try again.'));
  const origin = allowed.includes(verified.origin) ? verified.origin : null;
  if (!origin) return htmlResponse(errorHtml(fallback, 'Origin not allowed.'));

  const result = await completeAuthorization({
    code,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    redirectUri: `${url.origin}/callback`,
    fetchImpl: fetch,
    nowMs: Date.now(),
  });
  if (!result.ok) return htmlResponse(errorHtml(origin, result.reason));

  return htmlResponse(
    successHtml(origin, {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresAt: result.tokens.expiresAt,
      login: result.login,
    }),
  );
}

// Exchange a refresh token for a fresh access token. Called by fetch() from the
// site, so it is CORS-gated like the proxy.
async function handleRefresh(request: Request, env: Env, allowed: string[]): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, allowed);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, cors);
  if (!isAllowedOrigin(origin, allowed)) return json(403, { error: 'origin not allowed' }, cors);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json(503, { error: 'sign-in not configured' }, cors);

  let body: { refreshToken?: unknown };
  try {
    body = (await request.json()) as { refreshToken?: unknown };
  } catch {
    return json(400, { error: 'invalid JSON body' }, cors);
  }
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (!refreshToken) return json(400, { error: 'missing refreshToken' }, cors);

  const result = await refreshAuthorization({
    refreshToken,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    fetchImpl: fetch,
    nowMs: Date.now(),
  });
  if (!result.ok) return json(result.status, { error: result.reason }, cors);

  return json(
    200,
    {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresAt: result.tokens.expiresAt,
      login: result.login,
    },
    cors,
  );
}

/* ---- helpers ---- */

function parseOrigins(value?: string): string[] | null {
  const list = value?.split(',').map((s) => s.trim()).filter(Boolean);
  return list && list.length ? list : null;
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const allow = origin && allowed.includes(origin) ? origin : (allowed[0] ?? '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// For sign-in errors where no trusted opener origin is known, so we must NOT
// postMessage a token-bearing script anywhere: a plain, self-contained page.
function plainHtmlError(status: number, message: string): Response {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return htmlResponse(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem;color:#3a352f">${safe}</body>`,
    status,
  );
}
