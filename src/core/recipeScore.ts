/**
 * Assemble a stored recipe's ingredients into the compute engine's shapes and
 * produce its full precomputed nutrition block (macros + the six scores). This is
 * the single source of the ingredient→score assembly, shared by:
 *   - the /add authoring island (addLib.ts imports `nutrientsFor`/`fvlFromCategory`/`dataSourcesFor`),
 *   - the rescorer (scripts/rescore-recipes.mjs, via the compiled core),
 *   - the build-time reproducibility check (recipeScore.repro.test.ts).
 *
 * Ingredients are stored RAW (raw food record, raw weight) with a cooking method; this
 * assembly turns each into its cooked, as-eaten state (cooking.ts: per-nutrient retention
 * + mass yield) before any engine sees it, so macros and every score read the cooked dish.
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
import { applyCooking, cookingApplies, isCookingMethod, type CookingMethod } from './cooking';
import type { NutrientVector, ResolvedIngredient } from './types';
import { PREPS, type Prep } from './fii';

const isPrep = (v: unknown): v is Prep => typeof v === 'string' && (PREPS as readonly string[]).includes(v);

/** Curated per-food scoring metadata (GI + FVL); inflammation is composition-derived. */
export interface FoodScoring {
  gi?: number;
  /** Provenance tier of `gi`: high|medium = measured table match; low|predicted|none = estimated. */
  giConfidence?: string;
  /** GI when the food is eaten as boiled pasta dough (a flour rolled into homemade pasta or noodles). */
  giDough?: { gi: number; giSource?: string; giConfidence?: string };
  fvl?: boolean;
}

/**
 * The GI a food takes in one ingredient line: its `giDough` value when the line marks the
 * starch as boiled dough and the food carries one, else its default as-eaten GI. GI is a
 * property of the food as eaten, and a flour baked into bread digests unlike one rolled
 * into fresh pasta.
 */
export function giFor(scoring: FoodScoring | undefined, starchForm?: string | null): { gi: number | null; measured: boolean } {
  const v = starchForm === 'dough' && scoring?.giDough ? scoring.giDough : scoring;
  return { gi: v?.gi ?? null, measured: isMeasuredGi(v) };
}

/** Whether a food's GI is a measured table match (giConfidence high|medium). */
export function isMeasuredGi(scoring: FoodScoring | undefined): boolean {
  return scoring?.giConfidence === 'high' || scoring?.giConfidence === 'medium';
}

/** One food's polyphenol subclass contents (src/data/polyphenols.json). */
export type PolyphenolEntry = Partial<Record<(typeof POLYPHENOL_FIELDS)[number], number>> & { source?: string };
/** The polyphenol subclass fields merged into a food's nutrient vector. */
export const POLYPHENOL_FIELDS = [
  'anthocyanidins_mg', 'flavan3ols_mg', 'flavanones_mg', 'flavones_mg', 'flavonols_mg', 'tyrosols_mg',
] as const;
export type PolyphenolTable = Record<string, PolyphenolEntry | string>;

/** Per-100g nutrients for a matched food, with its polyphenol subclasses merged in (inflammation input). */
export function nutrientsFor(food: FoodRecord | undefined, polyphenols: PolyphenolTable): NutrientVector | null {
  if (!food?.n) return null;
  const poly = food.fdcId != null ? polyphenols[String(food.fdcId)] : undefined;
  if (!poly || typeof poly !== 'object') return food.n;
  const extra: Partial<NutrientVector> = {};
  for (const f of POLYPHENOL_FIELDS) if (Number.isFinite(poly[f])) extra[f] = poly[f];
  return { ...food.n, ...extra };
}

/** USDA categories whose foods count toward the Nutri-Score fruit/veg/legume share. */
const FVL_CATEGORIES = ['Vegetables', 'Fruits', 'Legumes'];
// Excluded from the FVL share per Nutri-Score 2023: starchy staples, nuts & oils, nectars
// and sweetened juice drinks, and obviously-processed forms. A 100 % fruit or vegetable
// juice counts in full (Nutri-Score 2023 beverage update, maximal points for 100 % fruit
// juices). Coarse by nature; FVL is confirmed per ingredient in the authoring review.
const NON_FVL =
  /\b(potato|potatoes|cassava|yam|yams|plantain|plantains|taro|nectar|oil|nut|nuts|peanut|peanuts|fried|breaded|chip|chips|crisp|crisps|snack|candied|sauce|ketchup|jam|jelly)\b/i;
/** A juice that is not 100 % juice: a juice drink, cocktail or beverage, or a sugar-sweetened
 *  juice (a vitamin- or calcium-fortified 100 % juice still counts). */
const NOT_PURE_JUICE = /\bjuice\b.*\b(drink|cocktail|beverage|sweetened|added sugar|sugar added|with sugar)\b|\b(drink|cocktail|beverage)\b.*\bjuice\b/i;

/** Nutri-Score FVL flag from a food's USDA category; curated `fvl` overrides this. */
export function fvlFromCategory(food: FoodRecord | undefined): boolean {
  if (!food?.category) return false;
  if (!FVL_CATEGORIES.some((c) => food.category!.includes(c))) return false;
  return !NON_FVL.test(food.description) && !NOT_PURE_JUICE.test(food.description);
}

/** The subset of a stored ingredient the assembly reads. */
export interface StoredScoringIngredient {
  grams?: number | null;
  fdcId?: number | null;
  excludeFromNutrition?: boolean;
  /** Original ingredient line — scanned for NOVA processing markers. */
  raw?: string | null;
  /** Parsed food name — the marker text when `raw` is empty. */
  item?: string | null;
  /** How the ingredient is cooked; missing = raw. */
  cooking?: CookingMethod | null;
  /** 'dough': the starch is eaten as shaped, boiled dough (selects the food's `giDough`). */
  starchForm?: string | null;
  /** Whether the fruit or vegetable is blended or juiced (re-classifies its sugars as free). */
  prep?: Prep | null;
}

/** Pick the scoring fields from a stored frontmatter ingredient — shared by the
 *  rescorer and the reproducibility test so both feed the assembly identically. */
export function storedScoringFields(ing: Record<string, unknown>): StoredScoringIngredient {
  return {
    grams: ing.grams as number | null | undefined,
    fdcId: ing.fdcId as number | null | undefined,
    excludeFromNutrition: ing.excludeFromNutrition as boolean | undefined,
    raw: ing.raw as string | null | undefined,
    item: ing.item as string | null | undefined,
    cooking: isCookingMethod(ing.cooking) ? ing.cooking : undefined,
    starchForm: ing.starchForm === 'dough' ? 'dough' : undefined,
    prep: isPrep(ing.prep) ? ing.prep : undefined,
  };
}

/**
 * An ingredient's cooked, as-eaten view for the engines: the cooked mass and the cooked
 * composition per 100 g of that mass (so mass × concentration = the retained totals, and
 * the Nutri-Score / NRF per-100 g basis is the summed cooked mass). The Food Inflammation
 * Index reads the same composition per 100 kcal, which cancels the water change, so it
 * sees the nutrient losses but never a dilution (boiled pasta scores as dry pasta less
 * its retention losses). Excluded, weightless or unmatched ingredients pass through.
 */
export function cookIngredient(
  grams: number | null,
  nutrients: NutrientVector | null,
  food: FoodRecord | undefined,
  cooking: CookingMethod | null | undefined,
  excluded?: boolean,
): { grams: number | null; nutrients: NutrientVector | null } {
  if (excluded || grams == null || !(grams > 0) || !nutrients || !cooking || cooking === 'raw') {
    return { grams, nutrients };
  }
  const c = applyCooking(grams, nutrients, food, cooking);
  return { grams: c.cookedGrams, nutrients: c.cookedPer100 };
}

/** Recipe-level scoring context (servings, Nutri-Score category + retained flags, course → GL basis). */
export interface RecipeScoringOptions extends ScoreOptions {
  servings: number;
}

/** One matched ingredient → the scoring engine's shape, cooked (adds GI + FVL + NOVA + marker text). */
export function toScored(
  ing: StoredScoringIngredient,
  foodById: Map<number, FoodRecord>,
  foodScoring: Record<string, FoodScoring>,
  polyphenols: PolyphenolTable,
): ScoredIngredient {
  const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
  const s = ing.fdcId != null ? foodScoring[String(ing.fdcId)] : undefined;
  const cooked = cookIngredient(ing.grams ?? null, nutrientsFor(food, polyphenols), food, ing.cooking, ing.excludeFromNutrition);
  const g = giFor(s, ing.starchForm);
  return {
    grams: cooked.grams,
    rawGrams: ing.grams ?? null,
    excludeFromNutrition: ing.excludeFromNutrition,
    fdcId: ing.fdcId ?? null,
    prep: ing.prep ?? null,
    nutrients: cooked.nutrients,
    gi: g.gi,
    giMeasured: g.measured,
    fvl: s?.fvl ?? fvlFromCategory(food),
    nova: food?.nova ?? null,
    raw: ing.raw || ing.item || null,
  };
}

/** One matched ingredient → the macro engine's shape (cooked mass + cooked per-100g nutrients). */
export function toResolved(
  ing: StoredScoringIngredient,
  foodById: Map<number, FoodRecord>,
): ResolvedIngredient {
  const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
  const cooked = cookIngredient(ing.grams ?? null, food?.n ?? null, food, ing.cooking, ing.excludeFromNutrition);
  return {
    grams: cooked.grams,
    excludeFromNutrition: ing.excludeFromNutrition,
    nutrients: cooked.nutrients,
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
  polyphenols: PolyphenolTable,
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

/** Credit line per national food-composition table, keyed by a matched food's `source` tag. */
export const NATIONAL_TABLE_CREDITS: Record<string, string> = {
  'JP-MEXT': 'MEXT Standard Tables of Food Composition in Japan 2020',
  'FR-CIQUAL': 'ANSES Ciqual French food composition table 2020',
};

/** Credit line for the inflammation score (inflammatory-potential estimate). */
export const INFLAMMATION_CREDIT = 'Inflammatory potential (estimate; pooled composition per 100 kcal); USDA Flavonoid Database R3.3; Phenol-Explorer';
/** Credit line for the aromatic adjustment, emitted only when it applies. */
export const AROMATIC_CREDIT = 'Aromatic adjustment (Shivappa 2014 effect scores, direction and relative size)';

/** Credit line for the cooking retention + yield tables (cooking.ts). */
export const COOKING_FACTORS_CREDIT = 'USDA Nutrient Retention Factors Release 6 (2007); Bognár 2002 cooking yields';

/**
 * Provenance strings for a nutrition block: the base USDA table, each national table a
 * non-excluded ingredient's matched food comes from (in NATIONAL_TABLE_CREDITS order, so
 * the list is stable), the cooking factor tables when at least one contributing
 * ingredient actually had retention/yield applied (`cookingApplies`), and one line per
 * score present. Credits follow the matched food's own `source`; per-field gap-fill
 * provenance is not a matched-food source and is not credited here.
 */
export function dataSourcesFor(
  scores: ScoreResult,
  ingredients: StoredScoringIngredient[],
  foodById: Map<number, FoodRecord>,
): string[] {
  const sources = ['USDA FoodData Central'];
  const matched = ingredients
    .filter((i) => !i.excludeFromNutrition && i.fdcId != null)
    .map((i) => ({ ing: i, food: foodById.get(i.fdcId!) }));
  const used = new Set(matched.map((m) => m.food?.source));
  for (const [tag, credit] of Object.entries(NATIONAL_TABLE_CREDITS)) if (used.has(tag)) sources.push(credit);
  const cooked = matched.some(
    ({ ing, food }) => ing.grams != null && ing.grams > 0 && food?.n != null && cookingApplies(food, ing.cooking),
  );
  if (cooked) sources.push(COOKING_FACTORS_CREDIT);
  if (scores.glycemic) sources.push('Atkinson 2021 GI tables');
  if (scores.nutriScore) sources.push('Nutri-Score 2023');
  if (scores.inflammation) sources.push(INFLAMMATION_CREDIT);
  if (scores.inflammation?.aromaticAdjustment) sources.push(AROMATIC_CREDIT);
  if (scores.balance) sources.push('Nutrient-Rich Foods Index (NRF9.3)');
  if (scores.processing) sources.push('NOVA food classification (energy-weighted)');
  return sources;
}
