/**
 * Orchestrates the recipe scoring engines: from resolved ingredients (metric
 * weight + per-100g nutrients + a GI value, inflammation tag and FVL flag for
 * the matched food) it produces the glycemic, Nutri-Score and inflammation
 * block stored in recipe frontmatter and shown by the score medallions.
 *
 * GI/GL is carb-weighted (gi.ts); Nutri-Score is the general-foods 2023
 * algorithm computed per 100 g (nutriscore.ts); inflammation is the
 * mass-weighted ingredient-tag index (inflammation.ts). All figures are
 * estimates.
 *
 * Each Nutri-Score nutrient is summed only over the mass of foods that actually
 * report it — a food enters the per-100g basis only when it has a usable energy
 * value, and a missing macro field is treated as unknown rather than silently
 * zero (the contract in types.ts), so an incomplete imported food cannot dilute
 * the density of the foods that do carry data. Foods flagged excludeFromNutrition
 * (water, stock) are left out entirely; this slightly concentrates brothy
 * recipes versus an as-consumed basis, which is acceptable for an estimate.
 */
import { availableCarbOf, energyKcalOf, KJ_PER_KCAL } from './nutrition';
import { computeGlycemics, type Glycemics } from './gi';
import { computeNutriScore, type NutriResult } from './nutriscore';
import { computeInflammation, type Inflammation } from './inflammation';
import type { NutrientVector } from './types';

/** Sodium (g) → salt (g) conversion used by Nutri-Score. */
const SALT_PER_SODIUM = 2.5;

/** GI source citation for the composite estimate (all GI values cite this). */
export const GI_SOURCE = 'Atkinson 2021 GI tables (carb-weighted composite estimate)';

/**
 * One recipe ingredient resolved for scoring: metric weight, the matched food's
 * per-100g nutrients, its published GI, inflammation tag, and whether it counts
 * toward Nutri-Score's fruit/vegetables/legumes share.
 */
export interface ScoredIngredient {
  grams: number | null;
  excludeFromNutrition?: boolean;
  nutrients?: NutrientVector | null;
  /** Published GI of the matched food, or null when unknown. */
  gi?: number | null;
  /** Inflammation tag (−2..+2) of the matched food, or null when untagged. */
  inflammationTag?: number | null;
  /** Whether the matched food is a fruit/vegetable/legume (Nutri-Score FVL). */
  fvl?: boolean;
}

export interface ScoreResult {
  glycemic?: Glycemics & { gi_source: string };
  nutriScore?: NutriResult;
  inflammation?: Inflammation;
}

type NutriField = 'energyKcal' | 'sugar' | 'satFat' | 'salt' | 'protein' | 'fiber';

/** Compute the glycemic, Nutri-Score and inflammation block for a recipe. */
export function computeScores(ingredients: ScoredIngredient[], servings: number): ScoreResult {
  const carbSources: { availableCarb_g: number; gi: number | null }[] = [];
  const inflammationItems: { grams: number; tag: number }[] = [];

  // Per-nutrient sums and the mass of foods that reported each (so a missing
  // field is excluded rather than counted as zero).
  const sum: Record<NutriField, number> = { energyKcal: 0, sugar: 0, satFat: 0, salt: 0, protein: 0, fiber: 0 };
  const mass: Record<NutriField, number> = { energyKcal: 0, sugar: 0, satFat: 0, salt: 0, protein: 0, fiber: 0 };
  let basisGrams = 0; // mass of foods in the Nutri-Score basis (those with energy)
  let fvlGrams = 0;

  for (const ing of ingredients) {
    if (ing.excludeFromNutrition) continue;
    const grams = ing.grams;
    if (grams == null || !(grams > 0)) continue;

    if (ing.inflammationTag != null) {
      inflammationItems.push({ grams, tag: ing.inflammationTag });
    }

    const n = ing.nutrients;
    if (!n) continue;
    const factor = grams / 100;

    const avail = availableCarbOf(n);
    if (avail != null) {
      carbSources.push({ availableCarb_g: avail * factor, gi: ing.gi ?? null });
    }

    // A food enters the Nutri-Score basis only with a usable energy value;
    // without one it cannot be profiled and must not dilute the density.
    const kcal = energyKcalOf(n);
    if (kcal == null) continue;
    addField(sum, mass, 'energyKcal', kcal, grams, factor);
    addField(sum, mass, 'sugar', n.sugar_g, grams, factor);
    addField(sum, mass, 'satFat', n.satFat_g, grams, factor);
    addField(sum, mass, 'salt', saltGrams(n.sodium_mg), grams, factor);
    addField(sum, mass, 'protein', n.protein_g, grams, factor);
    addField(sum, mass, 'fiber', n.fiber_g, grams, factor);
    basisGrams += grams;
    if (ing.fvl) fvlGrams += grams;
  }

  const result: ScoreResult = {};

  const glycemic = computeGlycemics(carbSources, servings);
  if (glycemic) result.glycemic = { ...glycemic, gi_source: GI_SOURCE };

  if (basisGrams > 0) {
    const per100 = (f: NutriField) => (mass[f] > 0 ? (sum[f] / mass[f]) * 100 : 0);
    result.nutriScore = computeNutriScore({
      energyKj: per100('energyKcal') * KJ_PER_KCAL,
      sugars_g: per100('sugar'),
      satFat_g: per100('satFat'),
      salt_g: per100('salt'),
      protein_g: per100('protein'),
      fiber_g: per100('fiber'),
      fvlPercent: (fvlGrams / basisGrams) * 100,
    });
  }

  const inflammation = computeInflammation(inflammationItems);
  if (inflammation) result.inflammation = inflammation;

  return result;
}

/**
 * Accumulate a per-100g nutrient `value` (scaled to an absolute amount by
 * `factor` = grams/100) into its running sum, recording the food's `grams`
 * as reporting mass — but only when the food actually carries the datum, so a
 * missing field is excluded rather than averaged in as zero.
 */
function addField(
  sum: Record<NutriField, number>,
  mass: Record<NutriField, number>,
  field: NutriField,
  value: number | null | undefined,
  grams: number,
  factor: number,
): void {
  if (value == null || !Number.isFinite(value)) return;
  sum[field] += value * factor;
  mass[field] += grams;
}

/** Salt (g/100g) from sodium (mg/100g), or null when sodium is unknown (not zero). */
function saltGrams(sodium_mg: number | undefined): number | null {
  if (sodium_mg == null || !Number.isFinite(sodium_mg)) return null;
  return (sodium_mg / 1000) * SALT_PER_SODIUM;
}
