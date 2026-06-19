/**
 * Optimistic "pending mutations" overlay store.
 *
 * The site is fully static: committing or deleting a recipe writes markdown to
 * the repo and only surfaces after the GitHub Action rebuilds + redeploys
 * (~a minute). To make the UI feel immediate, a successful commit/delete records
 * a pending mutation here; the index and recipe pages read it to inject, badge,
 * or hide cards until the rebuilt page catches up.
 *
 * Reconciliation is primarily by DOM presence, which is clock-independent: on the
 * index a `create` is done once the rebuilt card exists, a `delete` once the card
 * is gone. Only an `edit` (the card exists in both the old and new build) can't be
 * told apart that way, so it falls back to build time — every page embeds the
 * wall-clock moment it was built (a <meta>), and `isBuildFresh` reports whether
 * that page was generated at/after the commit. An absolute max-age (`prunePending`)
 * clears anything a failed build never lands.
 *
 * Pure + framework-agnostic (used from the React island and from bundled vanilla
 * scripts); every localStorage touch is guarded, so private-mode / SSR is a no-op.
 */

export type PendingKind = 'create' | 'edit' | 'delete';

/** Enough of a recipe to render or badge a card before the rebuild lands. */
export interface PendingCard {
  title: string;
  servings: number;
  /** ISO-8601 durations, formatted client-side for the card. */
  totalTime?: string;
  cookTime?: string;
  category?: string;
  tags: string[];
  imageUrl?: string;
}

export interface PendingMutation {
  /** Route slug — the key a card/page is matched by. */
  slug: string;
  kind: PendingKind;
  /** Browser clock (epoch ms) at the moment the commit succeeded. */
  committedAt: number;
  /** Card fields for a create/edit; absent for a delete. */
  card?: PendingCard;
}

/**
 * localStorage key. Load-bearing literal: BaseLayout's inline no-flash hide
 * script reads the same key (it can't import this module), passed through from
 * the `PENDING_KEY` export, so keep the two in sync via that import.
 */
export const PENDING_KEY = 'recipes-archive:pending-v1';

/** Drop a mutation once it is older than this even if no rebuild landed, so a
 *  failed build can't strand the overlay forever. */
export const PENDING_MAX_AGE_MS = 20 * 60 * 1000;

function read(): PendingMutation[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isMutation) : [];
  } catch {
    return [];
  }
}

function write(list: PendingMutation[]): void {
  try {
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // localStorage unavailable (private mode / SSR) — the overlay degrades to nothing.
  }
}

function isMutation(m: unknown): m is PendingMutation {
  if (!m || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  return (
    typeof x.slug === 'string' &&
    (x.kind === 'create' || x.kind === 'edit' || x.kind === 'delete') &&
    typeof x.committedAt === 'number'
  );
}

/** All recorded mutations, most recent first. */
export function readPending(): PendingMutation[] {
  return read().sort((a, b) => b.committedAt - a.committedAt);
}

/** Record a mutation, replacing any prior one for the same slug. */
export function recordPending(m: PendingMutation): void {
  const list = read().filter((x) => x.slug !== m.slug);
  list.push(m);
  write(list);
}

/** Forget the mutation for a slug — call once its rebuild has landed. */
export function dropPending(slug: string): void {
  const list = read();
  const kept = list.filter((x) => x.slug !== slug);
  if (kept.length !== list.length) write(kept);
}

/**
 * True once a page built at `buildTimeMs` was generated at/after the commit, so
 * it already reflects an edit. Used only for `edit` reconciliation, where DOM
 * presence can't distinguish the old card from the rebuilt one.
 */
export function isBuildFresh(m: PendingMutation, buildTimeMs: number): boolean {
  return buildTimeMs >= m.committedAt;
}

/**
 * Drop mutations older than the max age (so a failed build can't strand them),
 * persist only when something changed, and return the survivors newest-first.
 * Whether a given rebuild actually landed is decided by the caller via DOM
 * presence (create/delete) or `isBuildFresh` (edit).
 */
export function prunePending(nowMs: number): PendingMutation[] {
  const list = read();
  const survivors = list.filter((m) => nowMs - m.committedAt <= PENDING_MAX_AGE_MS);
  if (survivors.length !== list.length) write(survivors);
  return survivors.sort((a, b) => b.committedAt - a.committedAt);
}
