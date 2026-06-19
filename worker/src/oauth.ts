/**
 * GitHub-App user-authorization (sign-in) helpers for the import Worker.
 *
 * A static site can't exchange an authorization code for an access token — that
 * step needs the App's client secret. This Worker performs the exchange
 * server-side and hands the resulting user token back to the opener window via
 * `postMessage`, pinned to our site origin.
 *
 * Anyone with a GitHub account may sign in, but only the repo's collaborators
 * can publish: a user token can write solely to repositories where the App is
 * installed and the user has push access, and the island re-checks push access
 * before composing. The login is read from `GET /user` only to show who is
 * signed in.
 *
 * Sign-in state is a self-contained HMAC-signed value (no server storage): it
 * carries the opener origin and a timestamp so the callback can verify the
 * round-trip is one we started and knows exactly which origin to message back.
 *
 * Everything here is pure / string-level with an injectable `fetch`, so it
 * unit-tests in Node without the Workers runtime.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USER_AGENT = 'recipes-archive-auth';
/** postMessage envelope tag the browser island matches on. */
export const MESSAGE_SOURCE = 'recipes-archive-auth';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the GitHub round-trip
const CLOCK_SKEW_MS = 60 * 1000;

export interface TokenSet {
  accessToken: string;
  /** Present only when the App has "Expire user authorization tokens" enabled. */
  refreshToken: string | null;
  /** Epoch ms when the access token expires, or null when it never does. */
  expiresAt: number | null;
}

export type AuthResult =
  | { ok: true; tokens: TokenSet; login: string }
  | { ok: false; status: number; reason: string };

/* ---- base64url ---- */

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---- HMAC-signed state ---- */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

interface StatePayload {
  o: string; // opener origin to message back to
  t: number; // issued-at epoch ms
  n: string; // random value so each state is unique; anti-replay relies on GitHub's single-use code, not on tracking this
}

/** Build an opaque, integrity-protected sign-in state bound to the opener origin. */
export async function buildState(origin: string, secret: string, nowMs: number): Promise<string> {
  const payload: StatePayload = { o: origin, t: nowMs, n: toBase64Url(crypto.getRandomValues(new Uint8Array(12))) };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Verify a sign-in state's signature and freshness; return the bound origin. */
export async function verifyState(
  state: string,
  secret: string,
  nowMs: number,
): Promise<{ ok: true; origin: string } | { ok: false; reason: string }> {
  const dot = state.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed state' };
  const body = state.slice(0, dot);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(state.slice(dot + 1)),
      new TextEncoder().encode(body),
    );
  } catch {
    return { ok: false, reason: 'malformed state' };
  }
  if (!valid) return { ok: false, reason: 'bad signature' };

  let payload: StatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as StatePayload;
  } catch {
    return { ok: false, reason: 'malformed state' };
  }
  if (typeof payload.t !== 'number' || typeof payload.o !== 'string') return { ok: false, reason: 'malformed state' };
  const age = nowMs - payload.t;
  if (age > STATE_TTL_MS || age < -CLOCK_SKEW_MS) return { ok: false, reason: 'expired state' };
  return { ok: true, origin: payload.o };
}

/* ---- authorize redirect ---- */

/**
 * GitHub authorize URL for the App's user-authorization flow. No `scope` is
 * sent — a GitHub App's permissions are fixed at registration; `allow_signup`
 * is off so the page doesn't invite new-account creation.
 */
export function authorizeRedirectUrl(clientId: string, state: string, redirectUri: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

/**
 * Origins permitted to RECEIVE a user token (sign-in routes). A token must
 * never be delivered to a plaintext / any-local-process origin, so this defaults
 * to the https subset of the proxy allowlist (dropping http://localhost). An
 * explicit ALLOWED_AUTH_ORIGINS override is honoured verbatim — use it on a
 * local `wrangler dev` worker to test sign-in against http://localhost.
 */
export function authAllowedOrigins(proxyOrigins: string[], override?: string): string[] {
  const explicit = override?.split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit && explicit.length) return explicit;
  return proxyOrigins.filter((o) => o.startsWith('https://'));
}

/* ---- token exchange ---- */

interface RawTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<{ ok: true; tokens: TokenSet } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(params),
    });
  } catch {
    return { ok: false, reason: 'token endpoint unreachable' };
  }
  if (!res.ok) return { ok: false, reason: `token endpoint returned ${res.status}` };

  let raw: RawTokenResponse;
  try {
    raw = (await res.json()) as RawTokenResponse;
  } catch {
    return { ok: false, reason: 'token response not JSON' };
  }
  if (raw.error || !raw.access_token) return { ok: false, reason: raw.error_description || raw.error || 'no access token' };

  const expiresIn = raw.expires_in;
  return {
    ok: true,
    tokens: {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token ?? null,
      expiresAt: typeof expiresIn === 'number' ? nowMs + expiresIn * 1000 : null,
    },
  };
}

/** Best-effort: the signed-in login for display only; null if it can't be read. */
async function fetchLogin(accessToken: string, fetchImpl: typeof fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { login?: string };
    return typeof body.login === 'string' ? body.login : null;
  } catch {
    return null;
  }
}

/** Exchange an authorization code for a user access token. */
export async function completeAuthorization(p: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl: typeof fetch;
  nowMs: number;
}): Promise<AuthResult> {
  const tok = await postToken(
    { client_id: p.clientId, client_secret: p.clientSecret, code: p.code, redirect_uri: p.redirectUri },
    p.fetchImpl,
    p.nowMs,
  );
  if (!tok.ok) return { ok: false, status: 502, reason: 'GitHub sign-in failed' };
  const login = await fetchLogin(tok.tokens.accessToken, p.fetchImpl);
  return { ok: true, tokens: tok.tokens, login: login ?? '' };
}

/** Mint a fresh user access token from a refresh token. */
export async function refreshAuthorization(p: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch;
  nowMs: number;
}): Promise<AuthResult> {
  const tok = await postToken(
    { client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'refresh_token', refresh_token: p.refreshToken },
    p.fetchImpl,
    p.nowMs,
  );
  if (!tok.ok) return { ok: false, status: 401, reason: 'Session expired; sign in again.' };
  const login = await fetchLogin(tok.tokens.accessToken, p.fetchImpl);
  return { ok: true, tokens: tok.tokens, login: login ?? '' };
}

/* ---- popup result pages ---- */

interface SuccessPayload {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  login: string;
}

/** HTML page that delivers the token to the opener and closes the popup. */
export function successHtml(targetOrigin: string, payload: SuccessPayload): string {
  return renderPostMessageHtml(targetOrigin, { source: MESSAGE_SOURCE, ok: true, ...payload });
}

/** HTML page that reports a sign-in failure to the opener and closes the popup. */
export function errorHtml(targetOrigin: string, message: string): string {
  return renderPostMessageHtml(targetOrigin, { source: MESSAGE_SOURCE, ok: false, error: message });
}

function renderPostMessageHtml(targetOrigin: string, message: unknown): string {
  // Escape characters that could break out of the inline <script>, plus the
  // line/paragraph separators JSON leaves raw but JS string literals forbid.
  const sep = new RegExp('[\\u2028\\u2029]', 'g');
  const safe = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(sep, (c) => '\\u' + c.charCodeAt(0).toString(16));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#3a352f">
Completing sign-in… you can close this window.
<script>
(function () {
  var message = ${safe(message)};
  var targetOrigin = ${safe(targetOrigin)};
  try { if (window.opener) window.opener.postMessage(message, targetOrigin); } catch (e) {}
  setTimeout(function () { try { window.close(); } catch (e) {} }, 80);
})();
</script>
</body></html>`;
}
