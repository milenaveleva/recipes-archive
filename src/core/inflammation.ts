/**
 * Ingredient-tagged inflammation index for a recipe.
 *
 * Each food carries a tag in −2..+2 (anti- to pro-inflammatory) grounded in the
 * consistent food-group classifications of empirical, biomarker-validated
 * dietary inflammation indices — fruit, vegetables, whole grains, legumes,
 * nuts, oily fish and extra-virgin olive oil score anti-inflammatory; red and
 * processed meat, refined grains and added sugar score pro-inflammatory (Tabung
 * 2016 EDIP; Kałuża 2025 eADI; see README ## References). The recipe score is
 * the mass-fraction-weighted mean of its tagged ingredients, mapped to a
 * five-band scale.
 *
 * This is an independent, ingredient-tagged index — deliberately NOT the
 * licensed whole-diet Dietary Inflammatory Index, and never labelled "DII". It
 * is an estimate for comparison only.
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
  /** Inflammation tag in −2..+2 (negative = anti-inflammatory). */
  tag: number;
}

export interface Inflammation {
  /** Mass-weighted mean tag, rounded to 0.1. */
  score: number;
  band: InflammationBand;
}

/** Map a −2..+2 score to a five-band scale (symmetric around neutral). */
export function inflammationBandOf(score: number): InflammationBand {
  if (score <= -1.0) return 'anti-inflammatory';
  if (score <= -0.3) return 'mildly-anti-inflammatory';
  if (score < 0.3) return 'neutral';
  if (score < 1.0) return 'mildly-pro-inflammatory';
  return 'pro-inflammatory';
}

/**
 * Mass-fraction-weighted mean of ingredient tags, or null when no tagged
 * ingredient has a positive weight.
 */
export function computeInflammation(items: InflammationItem[]): Inflammation | null {
  let weighted = 0;
  let mass = 0;
  for (const it of items) {
    if (!Number.isFinite(it.grams) || it.grams <= 0) continue;
    if (!Number.isFinite(it.tag)) continue;
    weighted += it.tag * it.grams;
    mass += it.grams;
  }
  if (mass <= 0) return null;
  const score = round(weighted / mass, 1);
  return { score, band: inflammationBandOf(score) };
}
