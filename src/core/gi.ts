/**
 * Glycemic index (GI) and glycemic load (GL) for a whole recipe.
 *
 * Composite GI starts as the available-carbohydrate-weighted mean of each food's
 * published GI: GI₀ = Σ(GIᵢ·availCarbᵢ) / Σ availCarbᵢ. Only carbohydrate sources with
 * a published GI and a meaningful amount of available carbohydrate contribute;
 * near-carb-free foods (meat, oil, leafy greens) are excluded from the denominator,
 * and carbohydrate from foods without a tabulated GI is left out rather than guessed.
 *
 * The carb-weighted formula over-predicts the measured GI of a mixed meal — by 19–45 %
 * for starch + chicken meals (Dodd 2011) — chiefly because protein eaten with the
 * carbohydrate blunts the glucose response. The composite is therefore multiplied by
 * a conservative protein correction (`proteinCorrectionFactor`) driven by the dish's
 * ADDED protein per gram of available carbohydrate. "Added" protein is protein from
 * protein-dominant foods (meat, fish, eggs, cheese, tofu, nuts) with known carbohydrate
 * data whose protein is not already inside the composite: a food that enters the
 * composite with a measured GI (yogurt, milk, any carb-dominant staple) was tested with
 * its own protein, so counting that protein again would double-correct; a food left out
 * of the composite, or carrying only a nominal/estimated GI, adds its protein
 * (score.ts `isAddedProtein`). Fat is not corrected for: at realistic doses it showed no
 * significant effect on measured meal GI (Meng 2017), and its per-gram effect is a
 * fraction of protein's (Moghaddam 2006).
 *
 * GL = corrected GI × available carbohydrate per serving / 100, banded with MEAL
 * cut-offs (a whole meal carries far more carbohydrate than the single foods the
 * classic ≤10 / ≥20 GL bands were drawn for). Every figure is an estimate for
 * comparison, not a clinical measurement (see README ## References).
 */

import { round } from './num';

/** A carbohydrate source's contribution to the recipe. */
export interface GiCarbSource {
  /** Grams of available carbohydrate this food contributes to the whole recipe. */
  availableCarb_g: number;
  /** Published GI for the food, or null/absent when unknown (then ignored). */
  gi: number | null;
  /** Whether the GI comes from a measured table match (vs a category/composition estimate). */
  measured?: boolean;
}

/** Recipe-level inputs to the mixed-meal correction. */
export interface GlycemicMealContext {
  /** Whole-recipe grams of protein from protein-dominant foods not already inside the composite. */
  addedProtein_g?: number;
}

export type Band = 'low' | 'medium' | 'high';

export interface Glycemics {
  /** Protein-adjusted carb-weighted composite GI (0–100 scale), rounded. */
  gi: number;
  /** Per-serving glycemic load from the adjusted GI, rounded. */
  gl: number;
  giBand: Band;
  /** Meal GL band: low < 20, medium 20–39, high ≥ 40. */
  glBand: Band;
  /**
   * Share (%) of the recipe's available carbohydrate whose GI comes from a measured
   * table match (giConfidence high|medium), rather than a category median or a
   * composition-based prediction. Surfaced so a mostly-predicted GI reads as the
   * rougher estimate it is.
   */
  measuredGiPct: number;
}

/** Below this, a food carries too little available carbohydrate to affect GI. */
export const CARB_EPSILON_G = 0.5;

/**
 * Glucose-response reduction per g of added protein per g of available carbohydrate:
 * tuna protein lowers the glucose AUC by ~0.57 % per g added to 50 g carbohydrate
 * (Wolever 2017, from Meng 2017) → 0.285 per g/g. Deliberately at the low end — the
 * pooled slope across 154 trial comparisons is −50 % per g/g in adults without
 * diabetes (Wolever 2024), but much of that is whey/dairy drinks; solid animal
 * protein, and adults with type 2 diabetes (−10 %), respond less.
 */
export const PROTEIN_SLOPE = 0.285;

/**
 * Added protein (g per g available carbohydrate) below which no correction applies.
 * 12.5 g and 25 g of protein on 50 g carbohydrate (0.25 and 0.5 g/g) produced no
 * significant change in measured meal GI (Meng 2017), so low-protein dishes are
 * left at the plain composite; the slope only acts on protein above 0.25 g/g.
 */
export const PROTEIN_THRESHOLD = 0.25;

/**
 * Largest reduction ever applied: the composite over-predicted measured meal GI by
 * at most 45 % (Dodd 2011), i.e. measured ≥ predicted / 1.45, so the correction never
 * cuts the composite by more than 1 − 1/1.45 ≈ 31 %.
 */
export const MAX_PROTEIN_REDUCTION = 1 - 1 / 1.45;

/**
 * Multiplier (≤ 1) applied to the carb-weighted composite GI for a dish with
 * `proteinPerCarb` g of added protein per g of available carbohydrate:
 * f = 1 − min(MAX_PROTEIN_REDUCTION, PROTEIN_SLOPE · max(0, proteinPerCarb − PROTEIN_THRESHOLD)).
 * Returns 1 (no effect) for missing/invalid input or protein at or below the threshold.
 */
export function proteinCorrectionFactor(proteinPerCarb: number): number {
  if (!Number.isFinite(proteinPerCarb) || proteinPerCarb <= PROTEIN_THRESHOLD) return 1;
  const reduction = Math.min(MAX_PROTEIN_REDUCTION, PROTEIN_SLOPE * (proteinPerCarb - PROTEIN_THRESHOLD));
  return 1 - reduction;
}

/** GI band: low ≤55, medium 56–69, high ≥70. */
export function giBandOf(gi: number): Band {
  return gi <= 55 ? 'low' : gi <= 69 ? 'medium' : 'high';
}

/**
 * Per-serving GL band with whole-MEAL cut-offs: low < 20, medium 20–39, high ≥ 40.
 * A meal carries several foods' worth of carbohydrate, so the single-food bands
 * (≤10 / ≥20) would flag nearly every main course as "high".
 */
export function glBandOf(gl: number): Band {
  return gl < 20 ? 'low' : gl < 40 ? 'medium' : 'high';
}

/**
 * Compute the protein-adjusted composite GI and per-serving GL, or null when the
 * recipe has no carbohydrate source with a known GI.
 *
 * @param sources available-carb + GI for each food
 * @param servings divided into total GL; coerced to a positive integer
 * @param meal recipe-level context (added protein) for the mixed-meal correction
 */
export function computeGlycemics(
  sources: GiCarbSource[],
  servings: number,
  meal: GlycemicMealContext = {},
): Glycemics | null {
  const perServings = Number.isFinite(servings) && servings >= 1 ? Math.round(servings) : 1;

  let weightedGi = 0; // Σ(GIᵢ·availCarbᵢ)
  let carb = 0; // Σ availCarbᵢ (GI-known sources only)
  let totalCarb = 0; // Σ availCarbᵢ over ALL meaningful carb sources (GI known or not)
  let measuredCarb = 0; // Σ availCarbᵢ whose GI is a measured table match
  for (const s of sources) {
    const c = s.availableCarb_g;
    if (!Number.isFinite(c) || c <= CARB_EPSILON_G) continue;
    totalCarb += c;
    // GI is a 0–100+ scale; a negative value is invalid data, not a low GI — drop it
    // (its carbohydrate still counts toward totalCarb, so the measured share reflects the gap).
    if (s.gi == null || !Number.isFinite(s.gi) || s.gi < 0) continue;
    weightedGi += s.gi * c;
    carb += c;
    if (s.measured) measuredCarb += c;
  }
  if (carb <= 0) return null;

  const protein = meal.addedProtein_g;
  const factor = protein != null && protein > 0 ? proteinCorrectionFactor(protein / totalCarb) : 1;
  const adjusted = weightedGi * factor;

  const gi = round(adjusted / carb, 0);
  const gl = round(adjusted / 100 / perServings, 0);
  const measuredGiPct = round((measuredCarb / totalCarb) * 100, 0);
  return { gi, gl, giBand: giBandOf(gi), glBand: glBandOf(gl), measuredGiPct };
}
