/**
 * Shared numeric helpers for the compute engine, so macro, glycemic,
 * Nutri-Score and inflammation figures all round and clamp by one definition.
 */
export function round(n: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Clamp `n` to the inclusive range [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
