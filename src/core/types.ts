/**
 * Shared types for the recipe compute engine.
 *
 * The engine is framework-agnostic and isomorphic: it runs in the browser
 * during in-app authoring and at build time for validation, with no Astro or
 * DOM dependencies. Field names mirror the `nutrition.perServing` block in
 * `src/content.config.ts` so computed results drop straight into frontmatter.
 */

/** Coarse physical dimension of a measurement unit. */
export type Dimension = 'mass' | 'volume' | 'temperature' | 'count';

/**
 * Per-100g nutrient values for a single matched food (the USDA FoodData
 * Central basis). Every field is optional — a missing field means the source
 * food has no datum for it (treated as unknown, never silently as zero).
 */
export interface NutrientVector {
  energyKcal?: number;
  energyKj?: number;
  protein_g?: number;
  fat_g?: number;
  satFat_g?: number;
  /** Monounsaturated fat (USDA #645). Anti-inflammatory fat-quality signal (fii.ts). */
  monoFat_g?: number;
  /** Polyunsaturated fat (USDA #646). Anti-inflammatory fat-quality signal (fii.ts). */
  polyFat_g?: number;
  /** Trans fat (USDA #605). Pro-inflammatory fat-quality signal (fii.ts). */
  transFat_g?: number;
  /** Carbohydrate, by difference (USDA #205). */
  carbs_g?: number;
  fiber_g?: number;
  sugar_g?: number;
  /** Sugar alcohols / polyols; subtracted from available carbohydrate when present. */
  polyol_g?: number;
  sodium_mg?: number;
  /**
   * Total polyphenols (mg/100g), merged from Phenol-Explorer by fdcId — NOT a USDA
   * datum. Absent for most foods; when present it adds an anti-inflammatory term in
   * the FII (fii.ts) and raises the per-food confidence.
   */
  polyphenol_mg?: number;
  /* Micronutrients to encourage, read by the NRF9.3 nutrient-balance score
   * (src/core/balance.ts). Units match the USDA data and the FDA 2016 Daily
   * Values (vitamin A as µg RAE, vitamin E as mg α-tocopherol). */
  vitA_ug?: number;
  vitC_mg?: number;
  vitE_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
  potassium_mg?: number;
  magnesium_mg?: number;
}

/**
 * Macro fields aggregated by simple mass-weighted summation into the per-serving
 * panel. Energy is summed separately (kcal/kJ reconciliation) and polyols are
 * read inline for the available-carbohydrate derivation; the micronutrients in
 * NutrientVector are aggregated by the scoring engine (score.ts), not here, so
 * this stays the explicit macro set the per-serving panel displays.
 */
export type SummableNutrient =
  | 'protein_g'
  | 'fat_g'
  | 'satFat_g'
  | 'carbs_g'
  | 'fiber_g'
  | 'sugar_g'
  | 'sodium_mg';

/**
 * One recipe ingredient resolved to a metric weight and (optionally) the
 * per-100g nutrients of its confirmed food match. `nutrients` is null/absent
 * when the ingredient has not been matched yet.
 */
export interface ResolvedIngredient {
  grams: number | null;
  excludeFromNutrition?: boolean;
  nutrients?: NutrientVector | null;
}

/**
 * Per-serving macros. Mirrors `nutrition.perServing` in the content schema.
 * A field is present only when at least one contributing food supplied it.
 */
export interface PerServingMacros {
  energyKcal?: number;
  energyKj?: number;
  protein_g?: number;
  carbs_g?: number;
  fiber_g?: number;
  availableCarb_g?: number;
  sugar_g?: number;
  fat_g?: number;
  satFat_g?: number;
  sodium_mg?: number;
}

/** Result of a metric-conversion attempt for a quantity + unit. */
export interface MetricAmount {
  /** Weight in grams, when the unit is a mass unit. Volume weight is resolved
   *  later from the matched food's USDA portion, not estimated here. */
  grams: number | null;
  /** Volume in millilitres, when the unit is a volume. */
  milliliters: number | null;
  dimension: Dimension | null;
}

/** A parsed ingredient line, before any food match. */
export interface ParsedLine {
  raw: string;
  quantity: number | null;
  quantity2: number | null;
  /** Unit exactly as written (provenance), e.g. "cups", "oz". */
  unit: string | null;
  /** Canonical unit id used for conversion, e.g. "cup", "ounce". */
  unitId: string | null;
  item: string;
  note?: string;
  isGroupHeader: boolean;
}

/** A recipe extracted from a web page, normalised to raw lines + step text. */
export interface ExtractedRecipe {
  title?: string;
  description?: string;
  imageUrl?: string;
  ingredients: string[];
  instructions: string[];
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  servings?: number;
  yield?: string;
  author?: string;
  cuisine?: string;
  course?: string;
  sourceName?: string;
  sourceUrl?: string;
}
