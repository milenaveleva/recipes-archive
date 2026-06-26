/**
 * Recipe inflammation estimate — the energy-weighted aggregate of its ingredients'
 * per-food Food Inflammation Index scores (fii.ts).
 *
 * Each ingredient carries a composition-derived FII tag in −2 (anti) … +2 (pro). The
 * recipe score weights each by its ENERGY contribution to the dish, not its raw mass:
 * energy-adjustment is how every biomarker-validated dietary inflammation index is
 * computed (EDIP servings/1000 kcal; energy-adjusted DII per 1000 kcal), and it stops a
 * watery, voluminous ingredient from dominating a raw-gram mean. A small mass floor
 * (`FLOOR_KCAL_PER_G`) keeps near-zero-calorie anti-inflammatory foods — leafy greens,
 * tea, most spices — from vanishing under pure energy weighting. Honest limit of the
 * choice: energy weighting still under-credits those low-calorie foods relative to
 * mass, and the floor constant is a calibration value, not a biomarker-derived one.
 *
 * The five bands are read by quantile of the recipe corpus once it is large enough;
 * until then they sit at the fixed fallback cut-points below (a small-N corpus makes
 * empirical quantiles statistically empty). Labels are relative — "anti-inflammatory"
 * means more anti than a typical dish, never a clinical category. This is an estimate
 * for comparison only — deliberately NOT the licensed Dietary Inflammatory Index, and
 * never labelled "DII".
 */
import { round } from './num';

export type InflammationBand =
  | 'anti-inflammatory'
  | 'mildly-anti-inflammatory'
  | 'neutral'
  | 'mildly-pro-inflammatory'
  | 'pro-inflammatory';

export interface InflammationItem {
  /** Metric weight of the ingredient. */
  grams: number;
  /** The ingredient's absolute energy contribution (kcal), or null when unknown. */
  energyKcal?: number | null;
  /** Per-food FII tag in −2..+2 (negative = anti-inflammatory). */
  tag: number;
}

export interface Inflammation {
  /** Energy-weighted mean FII tag, rounded to 0.1. */
  score: number;
  band: InflammationBand;
}

/**
 * Energy-per-gram floor: a food contributes at least this much weight per gram even
 * when nearly calorie-free, so leafy greens / tea / spices still register without a
 * pinch dominating. A calibration constant, not a biomarker-derived value.
 */
export const FLOOR_KCAL_PER_G = 1;

/**
 * Map a −2..+2 score to a five-band scale (symmetric around neutral). Fixed
 * small-N fallback cut-points, pending corpus-quantile calibration.
 */
export function inflammationBandOf(score: number): InflammationBand {
  if (score <= -1.0) return 'anti-inflammatory';
  if (score <= -0.3) return 'mildly-anti-inflammatory';
  if (score < 0.3) return 'neutral';
  if (score < 1.0) return 'mildly-pro-inflammatory';
  return 'pro-inflammatory';
}

/**
 * Energy-weighted mean of ingredient FII tags, or null when no scorable ingredient
 * has a positive weight. Each ingredient's weight is its energy contribution, floored
 * at `FLOOR_KCAL_PER_G` per gram so low-calorie foods are not silently dropped.
 */
export function computeInflammation(items: InflammationItem[]): Inflammation | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const it of items) {
    if (!Number.isFinite(it.grams) || it.grams <= 0) continue;
    if (!Number.isFinite(it.tag)) continue;
    const kcal = Number.isFinite(it.energyKcal) ? (it.energyKcal as number) : 0;
    const weight = Math.max(kcal, FLOOR_KCAL_PER_G * it.grams);
    if (weight <= 0) continue;
    weighted += it.tag * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  const score = round(weighted / totalWeight, 1);
  return { score, band: inflammationBandOf(score) };
}
