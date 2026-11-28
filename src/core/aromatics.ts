/**
 * Aromatic bioactive adjustment to a recipe's inflammatory-potential score.
 *
 * The score (fii.ts) reads the dish's pooled composition per 100 kcal — so ginger, turmeric, garlic, onion,
 * saffron, black pepper, thyme/oregano and rosemary, whose anti-inflammatory bioactives
 * are not composition columns and whose culinary amounts carry almost no energy, are
 * barely seen. This module adds a bounded, recipe-level credit for them
 * (src/data/fii-aromatics.json):
 *
 *   Δ = k · Σ_aromatic effect · min(1, grams per serving / doseG),   Δ ≥ −maxTotal
 *
 * `effect` is the aromatic's overall inflammatory effect score from Shivappa 2014, used
 * only for direction and relative size; `doseG` is a typical culinary amount per serving
 * of the matched form, so the credit grows with the amount used and saturates at one
 * typical dose. Several forms of one aromatic (fresh + ground ginger) add their dose
 * fractions before saturating. Δ is never positive, and the cap keeps it under one band
 * width, so it can tip a borderline dish but cannot erase a large free-sugar load. It is
 * an extrapolation of diet-level evidence to the recipe level — an estimate, not a
 * validated per-food effect.
 */
import { round } from './num';
import aromaticsData from '../data/fii-aromatics.json';

interface AromaticFood {
  form: string;
  doseG: number;
}
interface Aromatic {
  effect: number;
  foods: Record<string, AromaticFood>;
}
const DATA = aromaticsData as { k: number; maxTotal: number; aromatics: Record<string, Aromatic> };

/** Scale from Shivappa 2014 effect-score units onto the −2…+2 score axis. */
export const AROMATIC_K: number = DATA.k;
/** Largest total credit (score units) the aromatic term may apply to one recipe. */
export const AROMATIC_MAX_TOTAL: number = DATA.maxTotal;

interface AromaticMatch {
  key: string;
  effect: number;
  doseG: number;
}
const BY_FDC = new Map<number, AromaticMatch>();
for (const [key, a] of Object.entries(DATA.aromatics)) {
  // Every listed aromatic is anti-inflammatory in the source; a non-negative effect or a
  // non-positive dose would turn the bounded credit into a penalty or a division by zero.
  if (!(a.effect < 0)) throw new Error(`fii-aromatics.json: ${key} effect must be negative`);
  for (const [fdcId, f] of Object.entries(a.foods)) {
    if (!(f.doseG > 0)) throw new Error(`fii-aromatics.json: ${key} ${fdcId} doseG must be positive`);
    if (BY_FDC.has(Number(fdcId))) throw new Error(`fii-aromatics.json: fdcId ${fdcId} listed twice`);
    BY_FDC.set(Number(fdcId), { key, effect: a.effect, doseG: f.doseG });
  }
}

/** The aromatic a matched food counts as, or null when it is not one. */
export function aromaticOf(fdcId: number | null | undefined): AromaticMatch | null {
  return fdcId == null ? null : BY_FDC.get(fdcId) ?? null;
}

export interface AromaticItem {
  fdcId?: number | null;
  /** The ingredient's weight as written (g, whole recipe). */
  grams: number | null | undefined;
}

/**
 * The recipe's aromatic adjustment in score units: ≤ 0, ≥ −AROMATIC_MAX_TOTAL, rounded to
 * 0.01; 0 when the recipe uses none of the listed aromatics.
 */
export function aromaticAdjustment(items: AromaticItem[], servings: number): number {
  if (!(servings > 0)) return 0;
  const fraction = new Map<string, { effect: number; f: number }>();
  for (const it of items) {
    const a = aromaticOf(it.fdcId);
    if (!a || it.grams == null || !(it.grams > 0)) continue;
    const prev = fraction.get(a.key) ?? { effect: a.effect, f: 0 };
    prev.f += it.grams / servings / a.doseG;
    fraction.set(a.key, prev);
  }
  let delta = 0;
  for (const { effect, f } of fraction.values()) delta += effect * Math.min(1, f);
  return round(Math.max(AROMATIC_K * delta, -AROMATIC_MAX_TOTAL), 2) || 0;
}
