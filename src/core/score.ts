/**
 * Orchestrates the recipe scoring engines: from resolved ingredients (metric
 * weight + per-100g nutrients + a GI value, inflammation tag and FVL flag for
 * the matched food) it produces the glycemic, Nutri-Score and inflammation
 * block stored in recipe frontmatter and shown by the score medallions.
 *
 * GI/GL is carb-weighted (gi.ts); Nutri-Score is the general-foods 2023
 * algorithm computed per 100 g (nutriscore.ts); inflammation is the energy-weighted
 * mean of per-food Food Inflammation Index scores (fii.ts + inflammation.ts). All
 * figures are estimates.
 *
 * Nutri-Score and NRF9.3 both profile the finished dish as one per-100 g
 * composition over the full nutrition-contributing mass (`basisGrams`, the mass of
 * foods carrying a usable energy value) — the single-basis model Nutri-Score
 * applies to a labelled product. A food that omits a field contributes 0 to that
 * field's sum but still counts in the basis, so its concentration is diluted
 * rather than re-based per nutrient. The one exception is NRF's nutrients-to-limit
 * (sat fat, sugar, sodium): those read a seen-mass concentration (over only the
 * mass that reported them) so a food omitting a limit datum imputes the typical
 * amount instead of a 0 that would flatter the score. `nutriScore.coverage` records
 * how much of the basis actually reported the profiling nutrients. Foods flagged
 * excludeFromNutrition (water, stock) are left out entirely; this slightly
 * concentrates brothy recipes versus an as-consumed basis, acceptable for an estimate.
 */
import { availableCarbOf, energyKcalOf, KJ_PER_KCAL } from './nutrition';
import { round } from './num';
import { computeGlycemics, type Glycemics } from './gi';
import { computeNutriScore, type NutriResult, type NutriCategory } from './nutriscore';
import { computeInflammation, type Inflammation, type InflammationItem } from './inflammation';
import { foodFII } from './fii';
import { applyFoodForm } from './foodAdjust';
import { computeBalance, type BalanceResult } from './balance';
import { computeProcessing, type ProcessingItem, type ProcessingResult, type NovaGroup } from './processing';
import type { NutrientVector } from './types';

/** Sodium (g) → salt (g) conversion used by Nutri-Score. */
const SALT_PER_SODIUM = 2.5;

/** GI source citation for the composite estimate (all GI values cite this). */
export const GI_SOURCE = 'Atkinson 2021 GI tables (carb-weighted composite estimate)';

/**
 * One recipe ingredient resolved for scoring: metric weight, the matched food's
 * per-100g nutrients, its published GI, and whether it counts toward Nutri-Score's
 * fruit/vegetables/legumes share. The inflammation tag is computed from `nutrients`
 * by the Food Inflammation Index (fii.ts), not carried here; `fdcId` lets the
 * composition-blind food-form adjustment (foodAdjust.ts) find the matched food.
 */
export interface ScoredIngredient {
  grams: number | null;
  excludeFromNutrition?: boolean;
  nutrients?: NutrientVector | null;
  /** USDA fdcId of the matched food, for the food-form inflammation adjustment. */
  fdcId?: number | null;
  /** Published GI of the matched food, or null when unknown. */
  gi?: number | null;
  /** Whether the matched food is a fruit/vegetable/legume (Nutri-Score FVL). */
  fvl?: boolean;
  /** Matched food's NOVA processing group, energy-weighted into the processing score. */
  nova?: NovaGroup | null;
}

export interface ScoreResult {
  glycemic?: Glycemics & { gi_source: string };
  /** Nutri-Score plus `coverage`: the least-reported share of the profiling basis. */
  nutriScore?: NutriResult & { coverage?: number };
  inflammation?: Inflammation;
  balance?: BalanceResult;
  processing?: ProcessingResult;
}

/**
 * Nutri-Score options for the recipe. Nutri-Score is a per-product model, so the
 * category is a property of the *finished* dish, declared by the author (most
 * recipes are general foods; beverages and fats/oils/nuts/seeds score under their
 * own 2023 sub-algorithms). Defaults to general.
 */
export interface ScoreOptions {
  nutriCategory?: NutriCategory;
  /** Beverages: a non-nutritive sweetener is present. */
  nnsPresent?: boolean;
  /** Beverages: the dish is plain water (graded A). */
  isWater?: boolean;
  /** General foods: the dish is a cheese (keeps protein past the negative cap). */
  isCheese?: boolean;
  /** General foods: the dish is red meat (protein points capped at 2, 2023 rule). */
  redMeat?: boolean;
}

/**
 * Per-100g nutrient fields aggregated once and read by both sub-scores: the
 * Nutri-Score basis (energy, sugar, satFat, total fat, salt, protein, fibre) and
 * the NRF9.3 nutrient-balance basis (which also needs raw sodium and the 7
 * encouraged micronutrients). One accumulation, one seen-mass treatment. The
 * array is the single source; `Field` is derived from it so the two can't drift.
 */
const FIELDS = [
  'energyKcal', 'sugar', 'satFat', 'fat', 'salt', 'protein', 'fiber',
  'sodium', 'vitA', 'vitC', 'vitE', 'calcium', 'iron', 'potassium', 'magnesium',
] as const;
type Field = (typeof FIELDS)[number];

/** Compute the glycemic, Nutri-Score and inflammation block for a recipe. */
export function computeScores(
  ingredients: ScoredIngredient[],
  servings: number,
  options: ScoreOptions = {},
): ScoreResult {
  const carbSources: { availableCarb_g: number; gi: number | null }[] = [];
  const inflammationItems: InflammationItem[] = [];
  const processingItems: ProcessingItem[] = [];

  // Per-nutrient sums and the mass of foods that reported each (so a missing
  // field is excluded rather than counted as zero).
  const sum = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>;
  const mass = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>;
  let basisGrams = 0; // mass of foods in the Nutri-Score basis (those with energy)
  let fvlGrams = 0;

  for (const ing of ingredients) {
    if (ing.excludeFromNutrition) continue;
    const grams = ing.grams;
    if (grams == null || !(grams > 0)) continue;

    // The food's absolute energy contribution (kcal), shared by the two
    // energy-weighted scores below; null when the food carries no usable energy.
    const kcalPer100 = ing.nutrients ? energyKcalOf(ing.nutrients) : null;
    const energyKcal = kcalPer100 != null ? (kcalPer100 * grams) / 100 : null;

    // Inflammation: a per-food FII computed from composition (fii.ts), energy-weighted
    // at the recipe level. Weight by the food's absolute energy contribution when known.
    const fii = foodFII(ing.nutrients);
    if (fii) {
      const tag = applyFoodForm(fii.tag, ing.fdcId);
      inflammationItems.push({ grams, energyKcal, tag });
    }

    // Processing: the food's NOVA group, energy-weighted into the recipe distribution.
    if (ing.nova != null) processingItems.push({ energyKcal, nova: ing.nova });

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
    addField(sum, mass, 'fat', n.fat_g, grams, factor); // total fat → SFA/total-fat ratio (fats category)
    addField(sum, mass, 'salt', saltGrams(n.sodium_mg), grams, factor);
    addField(sum, mass, 'protein', n.protein_g, grams, factor);
    addField(sum, mass, 'fiber', n.fiber_g, grams, factor);
    // Raw sodium + the 7 encouraged micronutrients feed the NRF9.3 balance score.
    addField(sum, mass, 'sodium', n.sodium_mg, grams, factor);
    addField(sum, mass, 'vitA', n.vitA_ug, grams, factor);
    addField(sum, mass, 'vitC', n.vitC_mg, grams, factor);
    addField(sum, mass, 'vitE', n.vitE_mg, grams, factor);
    addField(sum, mass, 'calcium', n.calcium_mg, grams, factor);
    addField(sum, mass, 'iron', n.iron_mg, grams, factor);
    addField(sum, mass, 'potassium', n.potassium_mg, grams, factor);
    addField(sum, mass, 'magnesium', n.magnesium_mg, grams, factor);
    basisGrams += grams;
    if (ing.fvl) fvlGrams += grams;
  }

  const result: ScoreResult = {};

  const glycemic = computeGlycemics(carbSources, servings);
  if (glycemic) result.glycemic = { ...glycemic, gi_source: GI_SOURCE };

  if (basisGrams > 0) {
    // Single per-100 g basis over the full nutrition-contributing mass: the finished
    // dish profiled as one composition, the way Nutri-Score profiles a product.
    const per100Basis = (f: Field) => (sum[f] / basisGrams) * 100;
    // Seen-mass concentration: a nutrient over only the mass that reported it — used
    // for NRF's nutrients-to-limit so a missing datum imputes the typical amount.
    const per100Seen = (f: Field) => (mass[f] > 0 ? (sum[f] / mass[f]) * 100 : 0);
    // Share of the basis that reported a nutrient (energy defines the basis → 1).
    const coverageOf = (f: Field) => (basisGrams > 0 ? mass[f] / basisGrams : 0);

    const totalFat = per100Basis('fat');
    // Saturated fat can't exceed total fat; clamp to guard a data/rounding error, but
    // only when total fat is actually reported (else an unreported fat would zero it).
    const satFat = mass['fat'] > 0 ? Math.min(per100Basis('satFat'), totalFat) : per100Basis('satFat');

    const nutri = computeNutriScore(
      {
        energyKj: per100Basis('energyKcal') * KJ_PER_KCAL,
        sugars_g: per100Basis('sugar'),
        satFat_g: satFat,
        salt_g: per100Basis('salt'),
        protein_g: per100Basis('protein'),
        fiber_g: per100Basis('fiber'),
        fvlPercent: (fvlGrams / basisGrams) * 100,
        totalFat_g: totalFat,
        nnsPresent: options.nnsPresent,
        isWater: options.isWater,
        isCheese: options.isCheese,
        isRedMeat: options.redMeat,
      },
      options.nutriCategory ?? 'general',
    );
    // Weakest-link data completeness behind the grade (energy is always present).
    const coverage = Math.min(
      coverageOf('sugar'), coverageOf('satFat'), coverageOf('salt'),
      coverageOf('protein'), coverageOf('fiber'),
    );
    result.nutriScore = { ...nutri, coverage: round(coverage, 2) };

    // NRF9.3 nutrient-balance is a per-100-kcal RATIO (nutrient ÷ energy). Encouraged
    // nutrients use the full basis, so a missing one dilutes (biases the score DOWN,
    // never up — we don't credit a nutrient no food confirms). The nutrients-to-limit
    // use seen-mass, so a food omitting sat-fat/sugar/sodium imputes the typical
    // concentration rather than a 0 that would shrink the penalty and inflate the score.
    const balance = computeBalance({
      energyKcalPer100g: per100Basis('energyKcal'),
      protein_g: per100Basis('protein'),
      fiber_g: per100Basis('fiber'),
      vitA_ug: per100Basis('vitA'),
      vitC_mg: per100Basis('vitC'),
      vitE_mg: per100Basis('vitE'),
      calcium_mg: per100Basis('calcium'),
      iron_mg: per100Basis('iron'),
      potassium_mg: per100Basis('potassium'),
      magnesium_mg: per100Basis('magnesium'),
      satFat_g: per100Seen('satFat'),
      sugar_g: per100Seen('sugar'),
      sodium_mg: per100Seen('sodium'),
    });
    if (balance) result.balance = balance;
  }

  const inflammation = computeInflammation(inflammationItems);
  if (inflammation) result.inflammation = inflammation;

  const processing = computeProcessing(processingItems);
  if (processing) result.processing = processing;

  return result;
}

/**
 * Accumulate a per-100g nutrient `value` (scaled to an absolute amount by
 * `factor` = grams/100) into its running sum, recording the food's `grams`
 * as reporting mass — but only when the food actually carries the datum, so a
 * missing field is excluded rather than averaged in as zero.
 */
function addField(
  sum: Record<Field, number>,
  mass: Record<Field, number>,
  field: Field,
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
