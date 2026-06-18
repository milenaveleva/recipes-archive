import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, validateTargetUrl, isBlockedHost } from './guards';

describe('isAllowedOrigin', () => {
  const allowed = ['https://milenaveleva.github.io', 'http://localhost:4321'];
  it('accepts allowlisted origins only', () => {
    expect(isAllowedOrigin('https://milenaveleva.github.io', allowed)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin(null, allowed)).toBe(false);
  });
});

describe('isBlockedHost', () => {
  it('blocks loopback, private and link-local hosts', () => {
    for (const h of [
      'localhost',
      'foo.local',
      'svc.internal',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '::1',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });
  it('allows ordinary public hosts, including names that start with hex', () => {
    for (const h of ['example.com', 'cooking.nytimes.com', 'fc-barcelona.com', '172.32.0.1', '8.8.8.8']) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });
});

describe('validateTargetUrl', () => {
  it('accepts public http(s) URLs', () => {
    const r = validateTargetUrl('https://example.com/recipe');
    expect(r.ok).toBe(true);
  });
  it('rejects non-http(s) schemes', () => {
    expect(validateTargetUrl('ftp://example.com')).toMatchObject({ ok: false });
    expect(validateTargetUrl('javascript:alert(1)')).toMatchObject({ ok: false });
  });
  it('rejects private/loopback targets and garbage', () => {
    expect(validateTargetUrl('http://localhost:8080/x')).toMatchObject({ ok: false });
    expect(validateTargetUrl('http://169.254.169.254/latest/meta-data')).toMatchObject({ ok: false });
    expect(validateTargetUrl('not a url')).toMatchObject({ ok: false });
  });
});
