/**
 * Assemble a stored recipe's ingredients into the compute engine's shapes and
 * produce its full precomputed nutrition block (macros + the six scores). This is
 * the single source of the ingredient→score assembly, shared by:
 *   - the /add authoring island (addLib.ts imports `nutrientsFor`/`fvlFromCategory`),
 *   - the rescorer (scripts/rescore-recipes.mjs, via the compiled core),
 *   - the build-time reproducibility check (recipeScore.repro.test.ts).
 *
 * Because all three go through here, a stored block can always be regenerated from
 * the same food data + engine that authored it — the guarantee the reproducibility
 * test enforces. Framework-free: it takes the food lookup + curated scoring as
 * arguments rather than importing the datasets, so it runs in the browser, in Node,
 * and under Vitest unchanged.
 */
import { computeMacros, type MacroComputation } from './nutrition';
import { computeScores, type ScoredIngredient, type ScoreResult, type ScoreOptions } from './score';
import type { FoodRecord } from './match';
import type { NutrientVector, ResolvedIngredient } from './types';

/** Curated per-food scoring metadata (GI + FVL); inflammation is composition-derived. */
export interface FoodScoring {
  gi?: number;
  fvl?: boolean;
}

/** Per-100g nutrients for a matched food, with the merged polyphenol value (FII input). */
export function nutrientsFor(
  food: FoodRecord | undefined,
  polyphenols: Record<string, { polyphenol_mg?: number }>,
): NutrientVector | null {
  if (!food?.n) return null;
  const poly = food.fdcId != null ? polyphenols[String(food.fdcId)] : undefined;
  return poly?.polyphenol_mg != null ? { ...food.n, polyphenol_mg: poly.polyphenol_mg } : food.n;
}

/** USDA categories whose foods count toward the Nutri-Score fruit/veg/legume share. */
const FVL_CATEGORIES = ['Vegetables', 'Fruits', 'Legumes'];
// Excluded from the FVL share per Nutri-Score 2023: starchy staples, nuts & oils,
// juices, and obviously-processed forms. Coarse by nature; FVL is confirmed per
// ingredient in the authoring review.
const NON_FVL =
  /\b(potato|potatoes|cassava|yam|yams|plantain|plantains|taro|juice|nectar|oil|nut|nuts|peanut|peanuts|fried|breaded|chip|chips|crisp|crisps|snack|candied|sauce|ketchup|jam|jelly)\b/i;

/** Nutri-Score FVL flag from a food's USDA category; curated `fvl` overrides this. */
export function fvlFromCategory(food: FoodRecord | undefined): boolean {
  if (!food?.category) return false;
  if (!FVL_CATEGORIES.some((c) => food.category!.includes(c))) return false;
  return !NON_FVL.test(food.description);
}

/** The subset of a stored ingredient the assembly reads. */
export interface StoredScoringIngredient {
  grams?: number | null;
  fdcId?: number | null;
  excludeFromNutrition?: boolean;
}

/** Recipe-level scoring context (Nutri-Score category + retained flags). */
export interface RecipeScoringOptions extends ScoreOptions {
  servings: number;
}

/** One matched ingredient → the scoring engine's shape (adds GI + FVL + NOVA). */
export function toScored(
  ing: StoredScoringIngredient,
  foodById: Map<number, FoodRecord>,
  foodScoring: Record<string, FoodScoring>,
  polyphenols: Record<string, { polyphenol_mg?: number }>,
): ScoredIngredient {
  const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
  const s = ing.fdcId != null ? foodScoring[String(ing.fdcId)] : undefined;
  return {
    grams: ing.grams ?? null,
    excludeFromNutrition: ing.excludeFromNutrition,
    fdcId: ing.fdcId ?? null,
    nutrients: nutrientsFor(food, polyphenols),
    gi: s?.gi ?? null,
    fvl: s?.fvl ?? fvlFromCategory(food),
    nova: food?.nova ?? null,
  };
}

/** One matched ingredient → the macro engine's shape (mass + per-100g nutrients). */
export function toResolved(
  ing: StoredScoringIngredient,
  foodById: Map<number, FoodRecord>,
): ResolvedIngredient {
  const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
  return {
    grams: ing.grams ?? null,
    excludeFromNutrition: ing.excludeFromNutrition,
    nutrients: food?.n ?? null,
  };
}

export interface RecipeScore {
  macro: MacroComputation;
  scores: ScoreResult;
}

/** Recompute a recipe's macros + six scores from its stored ingredients + food data. */
export function scoreRecipe(
  ingredients: StoredScoringIngredient[],
  options: RecipeScoringOptions,
  foodById: Map<number, FoodRecord>,
  foodScoring: Record<string, FoodScoring>,
  polyphenols: Record<string, { polyphenol_mg?: number }>,
): RecipeScore {
  const { servings, ...scoreOptions } = options;
  const macro = computeMacros(
    ingredients.map((ing) => toResolved(ing, foodById)),
    servings,
  );
  const scores: ScoreResult = macro.contributingCount
    ? computeScores(
        ingredients.map((ing) => toScored(ing, foodById, foodScoring, polyphenols)),
        servings,
        scoreOptions,
      )
    : {};
  return { macro, scores };
}
