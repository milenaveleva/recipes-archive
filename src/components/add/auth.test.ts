import { describe, it, expect } from 'vitest';
import { buildAuthUrl, workerOriginOf, isExpired, parseAuthMessage } from './auth';

describe('buildAuthUrl', () => {
  it('appends /auth with the encoded opener origin, trimming a trailing slash', () => {
    expect(buildAuthUrl('https://worker.dev', 'https://milenaveleva.github.io')).toBe(
      'https://worker.dev/auth?origin=https%3A%2F%2Fmilenaveleva.github.io',
    );
    expect(buildAuthUrl('https://worker.dev/', 'https://milenaveleva.github.io')).toBe(
      'https://worker.dev/auth?origin=https%3A%2F%2Fmilenaveleva.github.io',
    );
  });
});

describe('workerOriginOf', () => {
  it('extracts the origin the popup message must come from', () => {
    expect(workerOriginOf('https://worker.dev/auth?x=1')).toBe('https://worker.dev');
  });
});

describe('isExpired', () => {
  it('treats a null expiry as never-expiring', () => {
    expect(isExpired(null, 9_999_999)).toBe(false);
  });
  it('is false well before expiry and true within the skew window', () => {
    expect(isExpired(1_000_000, 900_000)).toBe(false);
    expect(isExpired(1_000_000, 1_000_000 - 60_000)).toBe(true); // exactly at skew
    expect(isExpired(1_000_000, 1_200_000)).toBe(true); // past
  });
});

describe('parseAuthMessage', () => {
  it('ignores non-objects and foreign envelopes', () => {
    expect(parseAuthMessage(null)).toBeNull();
    expect(parseAuthMessage('hi')).toBeNull();
    expect(parseAuthMessage({ source: 'something-else', accessToken: 'x' })).toBeNull();
  });

  it('parses a success envelope, coercing optional fields', () => {
    const r = parseAuthMessage({
      source: 'recipes-archive-auth',
      ok: true,
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresAt: 1234,
      login: 'milenaveleva',
    });
    expect(r).toEqual({ ok: true, session: { accessToken: 'tok', refreshToken: 'rt', expiresAt: 1234, login: 'milenaveleva' } });
  });

  it('defaults missing optional fields to null/empty', () => {
    const r = parseAuthMessage({ source: 'recipes-archive-auth', ok: true, accessToken: 'tok' });
    expect(r).toEqual({ ok: true, session: { accessToken: 'tok', refreshToken: null, expiresAt: null, login: '' } });
  });

  it('treats a non-positive expiresAt as never-expiring (null)', () => {
    const r = parseAuthMessage({ source: 'recipes-archive-auth', ok: true, accessToken: 'tok', expiresAt: 0 });
    expect(r).toEqual({ ok: true, session: { accessToken: 'tok', refreshToken: null, expiresAt: null, login: '' } });
  });

  it('reports an error envelope', () => {
    expect(parseAuthMessage({ source: 'recipes-archive-auth', ok: false, error: 'denied' })).toEqual({ ok: false, error: 'denied' });
  });

  it('treats a tokenless success as an error', () => {
    expect(parseAuthMessage({ source: 'recipes-archive-auth', ok: true })).toEqual({ ok: false, error: 'Sign-in returned no token.' });
  });
});
