/**
 * Per-serving macro computation.
 *
 * Each matched food carries per-100g nutrients; a recipe's totals are the
 * mass-weighted sum across nutrition-contributing ingredients, divided by the
 * serving count. Available carbohydrate is total carbohydrate minus dietary
 * fibre (and minus polyols where present) — the "by difference" basis used for
 * glycemic-load work (Wolever 2025; see README ## References). It is floored at
 * zero per ingredient, so one over-fibred food match cannot drive another
 * food's carbohydrate negative.
 *
 * A macro field is emitted only when at least one contributing food supplied a
 * value for it, so a wholly-unknown nutrient reads as absent rather than a
 * misleading zero. All figures are estimates.
 */
import type {
  NutrientVector,
  PerServingMacros,
  ResolvedIngredient,
  SummableNutrient,
} from './types';

/** kJ per kcal (thermochemical) — used to derive energy in kJ from kcal. */
const KJ_PER_KCAL = 4.184;

/** Nutrients summed by simple mass weighting (energy + polyols handled apart). */
const SUMMABLE: readonly SummableNutrient[] = [
  'protein_g',
  'fat_g',
  'satFat_g',
  'carbs_g',
  'fiber_g',
  'sugar_g',
  'sodium_mg',
];

export interface MacroComputation {
  /** Per-serving macros, rounded for display, ready for frontmatter. */
  perServing: PerServingMacros;
  /** Whole-recipe totals (sum across ingredients), rounded for display. */
  totals: PerServingMacros;
  /** Summed weight (g) of ingredients that contributed nutrients. */
  totalGrams: number;
  /** Count of ingredients that contributed nutrients. */
  contributingCount: number;
  /**
   * Count of non-excluded ingredients that could not contribute — missing a
   * usable weight or a nutrient match. Drives the authoring review prompt.
   */
  missingDataCount: number;
}

/**
 * Compute per-serving macros from resolved ingredients.
 *
 * @param ingredients each with grams + (optionally) per-100g nutrients
 * @param servings divided into the totals; coerced to a positive integer
 */
export function computeMacros(
  ingredients: ResolvedIngredient[],
  servings: number,
): MacroComputation {
  const perServings =
    Number.isFinite(servings) && servings >= 1 ? Math.round(servings) : 1;

  const sums: Partial<Record<SummableNutrient, number>> = {};
  const seen = new Set<SummableNutrient>();
  let energyKcal = 0;
  let energySeen = false;
  let availableCarb = 0;
  let availableSeen = false;
  let totalGrams = 0;
  let contributingCount = 0;
  let missingDataCount = 0;

  for (const ing of ingredients) {
    if (ing.excludeFromNutrition) continue;
    if (ing.grams == null || !(ing.grams > 0) || !ing.nutrients) {
      missingDataCount++;
      continue;
    }
    const factor = ing.grams / 100;
    const n = ing.nutrients;

    const kcal = energyKcalOf(n);
    if (kcal != null) {
      energyKcal += kcal * factor;
      energySeen = true;
    }
    for (const key of SUMMABLE) {
      const v = n[key];
      if (v != null && Number.isFinite(v)) {
        sums[key] = (sums[key] ?? 0) + v * factor;
        seen.add(key);
      }
    }
    if (n.carbs_g != null && Number.isFinite(n.carbs_g)) {
      const net = n.carbs_g - (n.fiber_g ?? 0) - (n.polyol_g ?? 0);
      availableCarb += Math.max(0, net) * factor;
      availableSeen = true;
    }
    totalGrams += ing.grams;
    contributingCount++;
  }

  const totals: PerServingMacros = {};
  if (energySeen) {
    totals.energyKcal = energyKcal;
    totals.energyKj = energyKcal * KJ_PER_KCAL;
  }
  for (const key of SUMMABLE) {
    if (seen.has(key)) totals[key] = sums[key];
  }
  if (availableSeen) totals.availableCarb_g = availableCarb;

  return {
    perServing: mapMacros(totals, (k, v) => round(v / perServings, dpFor(k))),
    totals: mapMacros(totals, (k, v) => round(v, dpFor(k))),
    totalGrams: round(totalGrams, 1),
    contributingCount,
    missingDataCount,
  };
}

/** Energy in kcal from a vector, deriving from kJ when only kJ is present. */
function energyKcalOf(n: NutrientVector): number | null {
  if (n.energyKcal != null && Number.isFinite(n.energyKcal)) return n.energyKcal;
  if (n.energyKj != null && Number.isFinite(n.energyKj)) return n.energyKj / KJ_PER_KCAL;
  return null;
}

/** Transform every present macro value, dropping nulls. */
function mapMacros(
  m: PerServingMacros,
  fn: (k: keyof PerServingMacros, v: number) => number,
): PerServingMacros {
  const out: PerServingMacros = {};
  for (const k of Object.keys(m) as (keyof PerServingMacros)[]) {
    const v = m[k];
    if (v != null) out[k] = fn(k, v);
  }
  return out;
}

/** Display precision: energy & sodium to whole units, grams to 0.1. */
function dpFor(k: keyof PerServingMacros): number {
  return k === 'energyKcal' || k === 'energyKj' || k === 'sodium_mg' ? 0 : 1;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
