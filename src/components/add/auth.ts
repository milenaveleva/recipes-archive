/**
 * Browser-side GitHub sign-in for the authoring island.
 *
 * Opens the Worker's /auth endpoint in a popup and waits for the user token to
 * arrive by postMessage, pinned to the Worker's origin. Tokens live in
 * sessionStorage, so a sign-in survives reloads within the tab but is wiped when
 * the tab/browser closes — a leak is bounded by the session, never written to
 * disk for months. A short-lived access token is refreshed against the Worker's
 * /refresh endpoint when it nears expiry. The resulting access token is what
 * github.ts uses to commit — anyone may sign in, but only a repo collaborator's
 * token can actually push.
 *
 * The pure helpers (URL/origin/message/expiry) are unit-tested; the popup and
 * storage wrappers touch browser globals and run only in the island.
 */

export interface AuthSession {
  accessToken: string;
  /** Present when the GitHub App expires user tokens; null when the token never expires. */
  refreshToken: string | null;
  /** Epoch ms when the access token expires, or null when it never does. */
  expiresAt: number | null;
  /** GitHub login, for display; '' when unknown. */
  login: string;
}

export type AuthMessage = { ok: true; session: AuthSession } | { ok: false; error: string };

/** Must match the Worker's MESSAGE_SOURCE (worker/src/oauth.ts). */
const MESSAGE_SOURCE = 'recipes-archive-auth';
/** sessionStorage keys; gh_token holds the GitHub access token from sign-in. */
const KEYS = { access: 'gh_token', refresh: 'gh_refresh', expires: 'gh_expires', login: 'gh_login' };
const EXPIRY_SKEW_MS = 60_000;

/* ---- pure helpers ---- */

function normalizeBase(proxyBase: string): string {
  return proxyBase.replace(/\/+$/, '');
}

/** The popup document's origin — what `event.origin` must equal on the token message. */
export function workerOriginOf(proxyBase: string): string {
  return new URL(proxyBase).origin;
}

export function buildAuthUrl(proxyBase: string, siteOrigin: string): string {
  return `${normalizeBase(proxyBase)}/auth?origin=${encodeURIComponent(siteOrigin)}`;
}

/** True when an expiring token is within `skewMs` of (or past) its expiry. */
export function isExpired(expiresAt: number | null, nowMs: number, skewMs = EXPIRY_SKEW_MS): boolean {
  if (expiresAt == null) return false;
  return nowMs >= expiresAt - skewMs;
}

/**
 * Validate a postMessage payload into a session or error. Returns null when the
 * message isn't ours (so the listener ignores unrelated postMessages).
 */
export function parseAuthMessage(data: unknown): AuthMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.source !== MESSAGE_SOURCE) return null;
  if (d.ok === false) return { ok: false, error: typeof d.error === 'string' && d.error ? d.error : 'Sign-in failed.' };
  if (typeof d.accessToken !== 'string' || !d.accessToken) return { ok: false, error: 'Sign-in returned no token.' };
  return {
    ok: true,
    session: {
      accessToken: d.accessToken,
      refreshToken: typeof d.refreshToken === 'string' && d.refreshToken ? d.refreshToken : null,
      expiresAt: typeof d.expiresAt === 'number' && d.expiresAt > 0 ? d.expiresAt : null,
      login: typeof d.login === 'string' ? d.login : '',
    },
  };
}

/* ---- sessionStorage persistence ---- */

export function loadSession(): AuthSession | null {
  try {
    const accessToken = sessionStorage.getItem(KEYS.access);
    if (!accessToken) return null;
    const expiresRaw = sessionStorage.getItem(KEYS.expires);
    const expiresAt = expiresRaw ? Number(expiresRaw) : null;
    return {
      accessToken,
      refreshToken: sessionStorage.getItem(KEYS.refresh) || null,
      // Only a finite positive epoch is a real expiry; '0'/NaN/Infinity → never-expiring.
      expiresAt: expiresAt != null && Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
      login: sessionStorage.getItem(KEYS.login) || '',
    };
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  try {
    sessionStorage.setItem(KEYS.access, session.accessToken);
    if (session.refreshToken) sessionStorage.setItem(KEYS.refresh, session.refreshToken);
    else sessionStorage.removeItem(KEYS.refresh);
    if (session.expiresAt != null) sessionStorage.setItem(KEYS.expires, String(session.expiresAt));
    else sessionStorage.removeItem(KEYS.expires);
    sessionStorage.setItem(KEYS.login, session.login);
  } catch {
    /* persisting is best-effort */
  }
}

export function clearSession(): void {
  try {
    for (const k of Object.values(KEYS)) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/* ---- in-tab sign-in/out broadcast ---- */

/**
 * The header sign-in widget and the /add authoring island are separate scripts
 * sharing one sessionStorage; this window event lets a sign-in or sign-out in
 * one update the other within the same tab (sessionStorage `storage` events
 * don't fire in the originating document, and sessionStorage isn't shared across
 * tabs anyway, so cross-tab sync is moot).
 */
const AUTH_CHANGE_EVENT = 'recipes-archive:auth-change';

/** Announce that the stored session changed (after a sign-in or sign-out). */
export function notifyAuthChange(): void {
  try {
    window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
  } catch {
    /* non-browser context */
  }
}

/** Subscribe to in-tab session changes; returns an unsubscribe function. */
export function onAuthChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(AUTH_CHANGE_EVENT, handler);
  return () => window.removeEventListener(AUTH_CHANGE_EVENT, handler);
}

/* ---- popup + refresh (browser only) ---- */

/** Open the GitHub sign-in popup and resolve with the delivered session. */
export function signIn(proxyBase: string): Promise<AuthSession> {
  return new Promise((resolve, reject) => {
    const workerOrigin = workerOriginOf(proxyBase);
    const popup = window.open(buildAuthUrl(proxyBase, window.location.origin), 'github-signin', 'width=720,height=820');
    if (!popup) {
      reject(new Error('Popup blocked — allow popups for this site, then try again.'));
      return;
    }

    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      try {
        popup.close();
      } catch {
        /* popup may already be closed */
      }
      action();
    };

    function onMessage(event: MessageEvent) {
      if (event.origin !== workerOrigin) return; // pin to the Worker's origin
      const parsed = parseAuthMessage(event.data);
      if (!parsed) return; // not our envelope
      if (parsed.ok) finish(() => resolve(parsed.session));
      else finish(() => reject(new Error(parsed.error)));
    }

    window.addEventListener('message', onMessage);
    // Stop waiting if the user closes the popup without finishing.
    const closedTimer = setInterval(() => {
      if (popup.closed) finish(() => reject(new Error('Sign-in was cancelled.')));
    }, 500);
  });
}

/** Exchange the refresh token for a fresh session via the Worker. */
export async function refreshSession(proxyBase: string, refreshToken: string): Promise<AuthSession> {
  const res = await fetch(`${normalizeBase(proxyBase)}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    let msg = `Refresh failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(msg);
  }
  const b = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresAt?: number; login?: string };
  if (!b.accessToken) throw new Error('Refresh returned no token.');
  return {
    accessToken: b.accessToken,
    refreshToken: b.refreshToken ?? refreshToken,
    expiresAt: typeof b.expiresAt === 'number' && b.expiresAt > 0 ? b.expiresAt : null,
    login: b.login ?? '',
  };
}

/**
 * Return a session whose access token is valid now, refreshing if it has (or is
 * about to) expire. Throws when a refresh is needed but impossible.
 */
export async function freshSession(proxyBase: string | undefined, session: AuthSession, nowMs: number): Promise<AuthSession> {
  if (!isExpired(session.expiresAt, nowMs)) return session;
  if (!session.refreshToken || !proxyBase) throw new Error('Your sign-in expired. Please sign in again.');
  return refreshSession(proxyBase, session.refreshToken);
}
