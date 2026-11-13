/**
 * Recipe inflammation estimate — the energy-weighted aggregate of its ingredients'
 * per-food Food Inflammation Index scores (fii.ts), plus a bounded aromatic adjustment
 * (aromatics.ts).
 *
 * Each ingredient carries a composition-derived FII tag in −2 (anti) … +2 (pro), read per
 * 100 kcal. The recipe score weights each tag by the food's ENERGY contribution to the
 * dish, not its raw mass: energy adjustment is how every biomarker-validated dietary
 * inflammation index is computed (EDIP servings/1000 kcal; energy-adjusted DII per
 * 1000 kcal). With per-kcal tags the two fit together — were the tags linear in the
 * nutrient densities, the energy-weighted mean would be exactly the dish's own
 * per-kcal profile (Σ nutrient ÷ Σ kcal). The per-gram weight floor (`FLOOR_KCAL_PER_G`)
 * is the per-kcal conversion's energy floor expressed per gram, so a near-zero-energy
 * food (a leafy herb, salt, tea) is weighted by the same effective energy its tag was
 * divided by and that identity still holds. Honest limit: the per-parameter clamps make
 * the tags non-linear, so a pinch of salt or herb is capped rather than counted in full.
 *
 * The five bands are read by quantile of the USDA per-food reference distribution
 * (inflammation-reference.json `bands`, regenerated with the reference): the bottom
 * quintile of single foods is "anti-inflammatory", the top quintile "pro-inflammatory",
 * so a recipe's band reflects where its energy-weighted score sits among foods. Labels
 * are relative — "anti-inflammatory" means more anti than a typical food, never a
 * clinical category. This is an estimate for comparison only — deliberately NOT the
 * licensed Dietary Inflammatory Index, and never labelled "DII".
 */
import { round, clamp } from './num';
import { MIN_KCAL_PER_100G } from './fii';
import referenceData from '../data/inflammation-reference.json';

/** Quintile edges of the per-food tag distribution, from inflammation-reference.json. */
export interface InflammationBandEdges {
  antiMax: number;
  mildlyAntiMax: number;
  neutralMax: number;
  mildlyProMax: number;
}
const BANDS = (referenceData as { bands: InflammationBandEdges }).bands;
/** The band edges, shared with the dial presentation so its colour follows the same cut-offs. */
export const INFLAMMATION_BAND_EDGES: Readonly<InflammationBandEdges> = BANDS;
if (!BANDS || typeof BANDS.antiMax !== 'number') {
  // The band edges are generated as a unit with the rest of the reference; a file
  // without them means a stale or partial regen, not a recoverable state.
  throw new Error(
    'inflammation-reference.json is missing band edges — run `node scripts/build-inflammation-reference.mjs`',
  );
}

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
  /** Energy-weighted mean FII tag plus the aromatic adjustment, rounded to 0.1, within −2…+2. */
  score: number;
  band: InflammationBand;
  /** The aromatic adjustment already included in `score` (FII units, < 0); absent when 0. */
  aromaticAdjustment?: number;
}

/**
 * Energy-per-gram weight floor: a food weighs at least this much per gram even when nearly
 * calorie-free. It equals the FII's per-kcal conversion floor (fii.ts MIN_KCAL_PER_100G,
 * 20 kcal/100 g) per gram, so a food below that energy density is weighted by the same
 * effective energy its per-kcal tag was computed against.
 */
export const FLOOR_KCAL_PER_G = MIN_KCAL_PER_100G / 100;

/**
 * Map a −2..+2 score to the five-band scale by quintile edges of the USDA per-food
 * tag distribution (inflammation-reference.json `bands`): ≤ antiMax is the bottom
 * quintile of foods, > mildlyProMax the top.
 */
export function inflammationBandOf(score: number): InflammationBand {
  if (score <= BANDS.antiMax) return 'anti-inflammatory';
  if (score <= BANDS.mildlyAntiMax) return 'mildly-anti-inflammatory';
  if (score <= BANDS.neutralMax) return 'neutral';
  if (score <= BANDS.mildlyProMax) return 'mildly-pro-inflammatory';
  return 'pro-inflammatory';
}

/**
 * Energy-weighted mean of ingredient FII tags plus the recipe's aromatic adjustment
 * (aromatics.ts, ≤ 0), or null when no scorable ingredient has a positive weight. Each
 * ingredient's weight is its energy contribution, floored at `FLOOR_KCAL_PER_G` per gram.
 */
export function computeInflammation(items: InflammationItem[], aromaticAdjustment = 0): Inflammation | null {
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
  const adj = Number.isFinite(aromaticAdjustment) && aromaticAdjustment < 0 ? aromaticAdjustment : 0;
  const score = clamp(round(weighted / totalWeight + adj, 1), -2, 2);
  const result: Inflammation = { score, band: inflammationBandOf(score) };
  if (adj < 0) result.aromaticAdjustment = adj;
  return result;
}
