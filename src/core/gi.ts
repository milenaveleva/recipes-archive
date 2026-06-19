/**
 * Glycemic index (GI) and glycemic load (GL) for a whole recipe.
 *
 * Composite GI is the available-carbohydrate-weighted mean of each food's
 * published GI: GI = Σ(GIᵢ·availCarbᵢ) / Σ availCarbᵢ. Total glycemic load is
 * Σ(GIᵢ·availCarbᵢ) / 100, reported per serving. Only carbohydrate sources with
 * a published GI and a meaningful amount of available carbohydrate contribute;
 * near-carb-free foods (meat, oil, leafy greens) are excluded from the
 * denominator, and carbohydrate from foods without a tabulated GI is left out
 * rather than guessed.
 *
 * This carb-weighted formula is the transparent, citeable approach, but it
 * tends to OVER-PREDICT the measured GI of a mixed meal (fat and protein blunt
 * the real glycemic response), so the result is an estimate for comparison, not
 * a clinical figure (Dodd 2011; see README ## References).
 */

import { round } from './num';

/** A carbohydrate source's contribution to the recipe. */
export interface GiCarbSource {
  /** Grams of available carbohydrate this food contributes to the whole recipe. */
  availableCarb_g: number;
  /** Published GI for the food, or null/absent when unknown (then ignored). */
  gi: number | null;
}

export type Band = 'low' | 'medium' | 'high';

export interface Glycemics {
  /** Carb-weighted composite GI (0–100 scale), rounded. */
  gi: number;
  /** Per-serving glycemic load, rounded. */
  gl: number;
  giBand: Band;
  glBand: Band;
}

/** Below this, a food carries too little available carbohydrate to affect GI. */
const CARB_EPSILON_G = 0.5;

/** GI band: low ≤55, medium 56–69, high ≥70. */
export function giBandOf(gi: number): Band {
  return gi <= 55 ? 'low' : gi <= 69 ? 'medium' : 'high';
}

/** GL band: low ≤10, medium 11–19, high ≥20. */
export function glBandOf(gl: number): Band {
  return gl <= 10 ? 'low' : gl <= 19 ? 'medium' : 'high';
}

/**
 * Compute composite GI and per-serving GL, or null when the recipe has no
 * carbohydrate source with a known GI.
 *
 * @param sources available-carb + GI for each food
 * @param servings divided into total GL; coerced to a positive integer
 */
export function computeGlycemics(sources: GiCarbSource[], servings: number): Glycemics | null {
  const perServings = Number.isFinite(servings) && servings >= 1 ? Math.round(servings) : 1;

  let weightedGi = 0; // Σ(GIᵢ·availCarbᵢ)
  let carb = 0; // Σ availCarbᵢ (GI-known sources only)
  for (const s of sources) {
    if (s.gi == null || !Number.isFinite(s.gi)) continue;
    const c = s.availableCarb_g;
    if (!Number.isFinite(c) || c <= CARB_EPSILON_G) continue;
    weightedGi += s.gi * c;
    carb += c;
  }
  if (carb <= 0) return null;

  const gi = round(weightedGi / carb, 0);
  const gl = round(weightedGi / 100 / perServings, 0);
  return { gi, gl, giBand: giBandOf(gi), glBand: glBandOf(gl) };
}
