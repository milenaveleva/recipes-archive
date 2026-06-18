/**
 * Pure, runtime-agnostic guards for the CORS proxy.
 *
 * Kept separate from the fetch handler so they unit-test in Node without the
 * Workers runtime. The proxy pins *who* may call it (origin allowlist) and
 * guards *what* it will fetch (http(s) only, no localhost/private-network
 * targets) to avoid being turned into an SSRF relay.
 */

/** True when the request Origin is on the allowlist. */
export function isAllowedOrigin(origin: string | null, allowed: string[]): boolean {
  return origin != null && allowed.includes(origin);
}

export type TargetCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** Validate a target URL: http(s) scheme and a non-private host. */
export function validateTargetUrl(raw: string): TargetCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http(s) URLs are allowed' };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: 'target host is not allowed' };
  }
  return { ok: true, url };
}

/**
 * Reject loopback, link-local, and private-network hosts (both named and IP
 * literals) so the proxy can't reach internal infrastructure.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');

  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }

  // IPv6 literals carry a colon; named hosts (e.g. "fc-barcelona.com") do not.
  if (h.includes(':')) {
    const v6 = h.replace(/^\[|\]$/g, '');
    if (v6 === '::1') return true; // loopback
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique-local
    if (/^fe80/.test(v6)) return true; // link-local
    // IPv4-mapped/embedded (e.g. ::ffff:127.0.0.1) — range-check the IPv4 tail.
    const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
    if (tail && isBlockedIpv4(tail[1])) return true;
    return false;
  }

  // Non-dotted numeric/hex hosts (decimal 2130706433, hex 0x7f000001) are
  // alternative encodings of an IP — refuse rather than try to decode them.
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;

  return isBlockedIpv4(h);
}

/** True when a dotted-decimal IPv4 string is loopback/private/link-local/CGNAT. */
function isBlockedIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
