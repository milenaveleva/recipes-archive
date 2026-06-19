import { describe, it, expect } from 'vitest';
import {
  buildState,
  verifyState,
  authorizeRedirectUrl,
  authAllowedOrigins,
  completeAuthorization,
  refreshAuthorization,
  successHtml,
  errorHtml,
  MESSAGE_SOURCE,
} from './oauth';

const SECRET = 'super-secret-client-secret';

/** A fetch stand-in that routes by URL substring to canned Responses. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('signed sign-in state', () => {
  it('round-trips the opener origin', async () => {
    const state = await buildState('https://milenaveleva.github.io', SECRET, 1_000_000);
    const r = await verifyState(state, SECRET, 1_000_500);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe('https://milenaveleva.github.io');
  });

  it('rejects a tampered signature', async () => {
    const state = await buildState('https://milenaveleva.github.io', SECRET, 1_000_000);
    const tampered = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
    const r = await verifyState(tampered, SECRET, 1_000_500);
    expect(r.ok).toBe(false);
  });

  it('rejects a state signed with a different secret', async () => {
    const state = await buildState('https://milenaveleva.github.io', SECRET, 1_000_000);
    const r = await verifyState(state, 'other-secret', 1_000_500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad signature');
  });

  it('rejects an expired state', async () => {
    const state = await buildState('https://milenaveleva.github.io', SECRET, 0);
    const r = await verifyState(state, SECRET, 11 * 60 * 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired state');
  });

  it('rejects malformed input', async () => {
    expect((await verifyState('nodot', SECRET, 0)).ok).toBe(false);
    expect((await verifyState('.sig', SECRET, 0)).ok).toBe(false);
  });
});

describe('authorizeRedirectUrl', () => {
  it('targets GitHub with state + redirect, no scope, signup off', () => {
    const url = new URL(authorizeRedirectUrl('client-123', 'state-abc', 'https://worker.dev/callback'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://worker.dev/callback');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('allow_signup')).toBe('false');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('authAllowedOrigins', () => {
  it('keeps only https origins by default, dropping http://localhost', () => {
    expect(authAllowedOrigins(['https://milenaveleva.github.io', 'http://localhost:4321'])).toEqual([
      'https://milenaveleva.github.io',
    ]);
  });

  it('honours an explicit override verbatim (for a dev worker)', () => {
    expect(authAllowedOrigins(['https://site'], 'http://localhost:4321, http://localhost:8787')).toEqual([
      'http://localhost:4321',
      'http://localhost:8787',
    ]);
  });

  it('ignores a blank override and falls back to the https filter', () => {
    expect(authAllowedOrigins(['https://site', 'http://x'], '   ')).toEqual(['https://site']);
  });
});

describe('completeAuthorization', () => {
  it('exchanges a code and reports the login, computing expiry from expires_in', async () => {
    const fetchImpl = fakeFetch({
      'login/oauth/access_token': () =>
        okJson({ access_token: 'tok-abc', token_type: 'bearer', expires_in: 28800, refresh_token: 'rt-xyz', refresh_token_expires_in: 15897600 }),
      'api.github.com/user': () => okJson({ login: 'milenaveleva' }),
    });
    const r = await completeAuthorization({ code: 'c', clientId: 'id', clientSecret: SECRET, redirectUri: 'https://w/callback', fetchImpl, nowMs: 1_000_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokens.accessToken).toBe('tok-abc');
      expect(r.tokens.refreshToken).toBe('rt-xyz');
      expect(r.tokens.expiresAt).toBe(1_000_000 + 28_800 * 1000);
      expect(r.login).toBe('milenaveleva');
    }
  });

  it('still succeeds with empty login when /user is unavailable', async () => {
    const fetchImpl = fakeFetch({
      'login/oauth/access_token': () => okJson({ access_token: 'tok', token_type: 'bearer' }),
      'api.github.com/user': () => new Response('nope', { status: 500 }),
    });
    const r = await completeAuthorization({ code: 'c', clientId: 'id', clientSecret: SECRET, redirectUri: 'https://w/callback', fetchImpl, nowMs: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokens.expiresAt).toBeNull(); // no expires_in → non-expiring
      expect(r.login).toBe('');
    }
  });

  it('fails (502) when GitHub rejects the code', async () => {
    const fetchImpl = fakeFetch({
      'login/oauth/access_token': () => okJson({ error: 'bad_verification_code', error_description: 'expired' }),
    });
    const r = await completeAuthorization({ code: 'c', clientId: 'id', clientSecret: SECRET, redirectUri: 'https://w/callback', fetchImpl, nowMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
  });
});

describe('refreshAuthorization', () => {
  it('mints a fresh token set', async () => {
    const fetchImpl = fakeFetch({
      'login/oauth/access_token': () => okJson({ access_token: 'tok-2', expires_in: 28800, refresh_token: 'rt-2' }),
      'api.github.com/user': () => okJson({ login: 'milenaveleva' }),
    });
    const r = await refreshAuthorization({ refreshToken: 'rt-1', clientId: 'id', clientSecret: SECRET, fetchImpl, nowMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokens.accessToken).toBe('tok-2');
      expect(r.tokens.refreshToken).toBe('rt-2');
    }
  });

  it('fails (401) when the refresh token is rejected', async () => {
    const fetchImpl = fakeFetch({ 'login/oauth/access_token': () => new Response('', { status: 401 }) });
    const r = await refreshAuthorization({ refreshToken: 'bad', clientId: 'id', clientSecret: SECRET, fetchImpl, nowMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});

describe('popup result pages', () => {
  it('successHtml pins the target origin and carries the token in a tagged envelope', () => {
    const html = successHtml('https://milenaveleva.github.io', { accessToken: 'tok', refreshToken: 'rt', expiresAt: 123, login: 'milenaveleva' });
    expect(html).toContain('"https://milenaveleva.github.io"');
    expect(html).toContain(MESSAGE_SOURCE);
    expect(html).toContain('tok');
    expect(html).toContain('postMessage');
  });

  it('escapes < so an injected value cannot break out of the script', () => {
    const html = successHtml('https://milenaveleva.github.io', { accessToken: '</script><img src=x>', refreshToken: null, expiresAt: null, login: 'x' });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c');
  });

  it('errorHtml reports the message as a failure envelope', () => {
    const html = errorHtml('https://milenaveleva.github.io', 'GitHub sign-in failed');
    expect(html).toContain('GitHub sign-in failed');
    expect(html).toContain('"ok":false');
  });
});
