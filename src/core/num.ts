/**
 * Shared numeric rounding for the compute engine, so macro, glycemic,
 * Nutri-Score and inflammation figures all round by one definition.
 */
export function round(n: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
