/**
 * Composition-blind food-form adjustment to a per-food Food Inflammation Index tag.
 *
 * The FII (fii.ts) reads only a food's nutrient composition, so it is blind to signals
 * that composition cannot carry — fermentation / live cultures most of all. Fermented
 * dairy is consistently anti-inflammatory in trials, yet its saturated fat and sodium
 * make the composition FII read it as pro-inflammatory. This layer applies a small,
 * cited additive delta (src/data/food-adjustments.json, keyed by USDA fdcId) to the
 * per-food tag and re-clamps to the −2…+2 axis. The delta's direction is evidence-based;
 * its magnitude is a calibration value, like the energy mass floor (inflammation.ts).
 *
 * Applied at the recipe-assembly layer (score.ts) so the FII itself stays purely
 * compositional; the rescorer mirrors this via scripts/lib/fii.mjs (applyFoodForm).
 */
import { round, clamp } from './num';
import adjustmentsData from '../data/food-adjustments.json';

interface Adjustment {
  delta: number;
  reason: string;
  cite: string;
}
// The JSON also holds a leading `_doc` string; only object entries with a finite delta count.
const ADJUSTMENTS = adjustmentsData as Record<string, Adjustment | string>;

/** Additive FII delta for a food (0 when it has no adjustment), keyed by USDA fdcId. */
export function foodFormAdjustment(fdcId: number | null | undefined): number {
  if (fdcId == null) return 0;
  const a = ADJUSTMENTS[String(fdcId)];
  return a && typeof a === 'object' && Number.isFinite(a.delta) ? a.delta : 0;
}

/** Apply the food-form delta to a per-food tag, re-clamped to the −2…+2 axis. */
export function applyFoodForm(tag: number, fdcId: number | null | undefined): number {
  const delta = foodFormAdjustment(fdcId);
  return delta ? clamp(round(tag + delta, 1), -2, 2) : tag;
}
