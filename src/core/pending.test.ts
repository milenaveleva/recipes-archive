import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PENDING_KEY,
  PENDING_MAX_AGE_MS,
  readPending,
  recordPending,
  dropPending,
  prunePending,
  isBuildFresh,
  type PendingMutation,
} from './pending';

/** A minimal in-memory Storage so the suite runs without a DOM environment. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const create = (slug: string, committedAt: number): PendingMutation => ({
  slug,
  kind: 'create',
  committedAt,
  card: { title: slug, servings: 2, tags: [] },
});
const del = (slug: string, committedAt: number): PendingMutation => ({
  slug,
  kind: 'delete',
  committedAt,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('record / read', () => {
  it('records a mutation and reads it back', () => {
    recordPending(create('dahl', 1000));
    expect(readPending()).toEqual([create('dahl', 1000)]);
  });

  it('returns mutations newest-first', () => {
    recordPending(create('a', 1000));
    recordPending(create('b', 3000));
    recordPending(create('c', 2000));
    expect(readPending().map((m) => m.slug)).toEqual(['b', 'c', 'a']);
  });

  it('replaces a prior mutation for the same slug (e.g. create then delete)', () => {
    recordPending(create('dahl', 1000));
    recordPending(del('dahl', 2000));
    const all = readPending();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(del('dahl', 2000));
  });

  it('drops a mutation by slug', () => {
    recordPending(create('a', 1000));
    recordPending(create('b', 2000));
    dropPending('a');
    expect(readPending().map((m) => m.slug)).toEqual(['b']);
  });

  it('dropPending is a no-op for an unknown slug', () => {
    recordPending(create('a', 1000));
    dropPending('nope');
    expect(readPending().map((m) => m.slug)).toEqual(['a']);
  });
});

describe('corrupt / unavailable storage', () => {
  it('returns [] on corrupt JSON', () => {
    localStorage.setItem(PENDING_KEY, '{not json');
    expect(readPending()).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ slug: 'x' }));
    expect(readPending()).toEqual([]);
  });

  it('filters out entries missing required fields or with a bad kind', () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify([
        create('ok', 1000),
        { slug: 'bad' },
        { kind: 'create', committedAt: 1 },
        { slug: 'wrongkind', kind: 'upsert', committedAt: 1 },
      ]),
    );
    expect(readPending().map((m) => m.slug)).toEqual(['ok']);
  });

  it('never throws when localStorage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => recordPending(create('a', 1000))).not.toThrow();
    expect(readPending()).toEqual([]);
  });

  it('never throws when setItem is blocked (private mode)', () => {
    const blocked = memoryStorage();
    blocked.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', blocked);
    expect(() => recordPending(create('a', 1000))).not.toThrow();
  });
});

describe('isBuildFresh', () => {
  it('is fresh once a page built at/after the commit is loaded', () => {
    expect(isBuildFresh(create('a', 5000), 5000)).toBe(true);
    expect(isBuildFresh(create('a', 5000), 6000)).toBe(true);
  });

  it('is not fresh while the loaded page predates the commit', () => {
    expect(isBuildFresh(create('a', 6000), 5000)).toBe(false);
  });

  it('treats a missing build time (0) as not-yet-built', () => {
    expect(isBuildFresh(create('a', 1_000_000), 0)).toBe(false);
  });
});

describe('prunePending (age-out only)', () => {
  it('drops aged mutations, keeps fresh ones, and persists when changed', () => {
    const now = 10_000_000;
    recordPending(create('fresh', now - 1000));
    recordPending(create('stale', now - PENDING_MAX_AGE_MS - 1));

    const survivors = prunePending(now);
    expect(survivors.map((m) => m.slug)).toEqual(['fresh']);
    // The aged entry is removed from storage too.
    expect(readPending().map((m) => m.slug)).toEqual(['fresh']);
  });

  it('does NOT drop a fresh mutation regardless of build time (presence decides that)', () => {
    const now = 10_000_000;
    recordPending(create('pending', now - 1000));
    expect(prunePending(now).map((m) => m.slug)).toEqual(['pending']);
  });

  it('returns survivors newest-first', () => {
    const now = 10_000_000;
    recordPending(create('older', now - 3000));
    recordPending(create('newer', now - 1000));
    expect(prunePending(now).map((m) => m.slug)).toEqual(['newer', 'older']);
  });
});
