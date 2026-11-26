/**
 * Logic for the /add authoring island, kept out of the React component so it
 * unit-tests without a DOM. Bridges the compute engine (parse → match → metric
 * → macros → markdown) to the wizard's row/form state, and sanitises every
 * value at the serialization boundary so the committed frontmatter always
 * validates against the content schema on rebuild.
 */
import { parseIngredientLine, estimateMetric } from '../../core/parse';
import { canonicalUnit, classifyUnit, volumeToMilliliters } from '../../core/units';
import { searchFoods, type FoodRecord, type FoodMatch, type MatchConfidence } from '../../core/match';
import { computeMacros, type MacroComputation } from '../../core/nutrition';
import { computeScores, type ScoredIngredient, type ScoreResult, type ScoreOptions } from '../../core/score';
import {
  nutrientsFor as nutrientsForShared,
  fvlFromCategory,
  giFor,
  cookIngredient,
  dataSourcesFor as dataSourcesForShared,
} from '../../core/recipeScore';
import { suggestCooking, isCookingMethod, type CookingMethod } from '../../core/cooking';
import { validateRecipe, type ValidationResult } from '../../core/validate';
import { normalizeRecipe, methodIssues, type NormalizableLine } from '../../core/houseRules';
import type { NutriCategory } from '../../core/nutriscore';
import type { MetricAmount, NutrientVector, ParsedLine, ResolvedIngredient } from '../../core/types';
import type { DraftIngredient, RecipeDraft } from '../../core/markdown';
import type { ExtractedRecipe } from '../../core/types';
// The full food dataset (~8k foods, several MB) is fetched lazily via its asset
// URL rather than bundled into the /add island. `?url` makes Vite emit it as a
// static asset and hand back the URL; `loadFoods()` fetches it once on demand.
import foodsUrl from '../../data/usda-foods.json?url';
import foodScoringData from '../../data/food-scoring.json';
import polyphenolData from '../../data/polyphenols.json';

// In-memory food cache, populated by loadFoods() (browser) or primeFoods() (tests/SSR).
let FOODS: FoodRecord[] = [];
let FOOD_BY_ID = new Map<number, FoodRecord>();
let loadPromise: Promise<void> | null = null;

/** Populate the food cache from an in-memory list (tests/SSR). */
export function primeFoods(foods: FoodRecord[]): void {
  FOODS = foods;
  FOOD_BY_ID = new Map(foods.filter((f) => f.fdcId != null).map((f) => [f.fdcId as number, f]));
}

/** Fetch + cache the food dataset once (browser). Resolves when matching is ready. */
export function loadFoods(): Promise<void> {
  if (!loadPromise) {
    loadPromise = fetch(foodsUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`food database ${r.status}`);
        return r.json();
      })
      .then((data: FoodRecord[]) => primeFoods(data))
      .catch((err) => {
        loadPromise = null; // allow a retry on the next call
        throw err;
      });
  }
  return loadPromise;
}

/** Hand-curated, cited scoring metadata per USDA food (GI, FVL). Inflammation is
 *  computed from composition by the FII (src/core/fii.ts), not curated here. */
interface FoodScoring {
  gi?: number;
  giSource?: string;
  giConfidence?: string;
  /** GI when the food is eaten as shaped, boiled dough (see core/recipeScore.giFor). */
  giDough?: { gi: number; giSource?: string; giConfidence?: string };
  fvl?: boolean;
}
const FOOD_SCORING = foodScoringData as Record<string, FoodScoring>;

/** Total polyphenols (mg/100g) per fdcId, merged into nutrients for the FII. */
interface PolyphenolEntry {
  polyphenol_mg?: number;
}
const POLYPHENOLS = polyphenolData as Record<string, PolyphenolEntry>;

/** Per-100g nutrients for a matched food, with the merged polyphenol value (FII input).
 *  The FVL heuristic + polyphenol merge live in core/recipeScore.ts so the authoring
 *  island and the rescorer/reproducibility check assemble every score identically. */
function nutrientsFor(food: FoodRecord | undefined): NutrientVector | null {
  return nutrientsForShared(food, POLYPHENOLS);
}
// Foods we hold curated GI/inflammation/portion data for: preferred in matching
// so a common ingredient still resolves to the richer-data food in the large set.
const CURATED_IDS = new Set(Object.keys(FOOD_SCORING).map(Number));

function scoringFor(fdcId: number | null): FoodScoring | undefined {
  return fdcId != null ? FOOD_SCORING[String(fdcId)] : undefined;
}

/** Whether the food carries a boiled-dough GI, so the review row offers the "boiled dough" toggle. */
export function hasDoughGi(fdcId: number | null): boolean {
  return scoringFor(fdcId)?.giDough != null;
}

/** One reviewable ingredient line in the wizard. */
export interface IngredientRow {
  id: string;
  raw: string;
  parsed: ParsedLine;
  candidates: FoodMatch[];
  /** Chosen USDA match; null = unmatched (no nutrition contribution). */
  selectedFdcId: number | null;
  /** Metric weight used for nutrition; editable. */
  grams: number | null;
  /** Volume of the original measure (provenance), when measured by volume. */
  milliliters: number | null;
  excludeFromNutrition: boolean;
  /** How the ingredient is cooked; scores read its cooked, as-eaten state. */
  cooking: CookingMethod;
  /** The author chose `cooking` (or it was stored): a match change keeps it instead of re-suggesting. */
  userSetCooking: boolean;
  /**
   * The fdcId reviewed as a deliberate stand-in (stored `proxyOk: true`), or null. The
   * approval belongs to that one match, so the draft re-emits `proxyOk` only while the row
   * still selects it.
   */
  proxyFdcId: number | null;
  /** The fdcId the author picked by hand in the review row (a reviewed match), or null. */
  userPickedFdcId: number | null;
  /** 'dough': the flour is rolled into homemade pasta or noodles and boiled. */
  starchForm: 'dough' | null;
}

let rowCounter = 0;

/** Parse a raw line into a review row, pre-selecting a confident match. */
export function buildRow(raw: string): IngredientRow {
  const parsed = parseIngredientLine(raw);
  const est = estimateMetric(parsed);
  // Pass the note as a refinement: searchFoods uses it only when item+note has an
  // all-token match (a descriptive "flour (all-purpose)"), else falls back to the
  // item alone — so a free-text note ("cream (for topping)") never mis-steers.
  const candidates = parsed.isGroupHeader
    ? []
    : searchFoods(parsed.item, FOODS, 6, CURATED_IDS, parsed.note);
  const top = candidates[0];
  const selectedFdcId = top && top.confidence !== 'low' ? top.food.fdcId ?? null : null;
  const selectedFood = selectedFdcId != null ? FOOD_BY_ID.get(selectedFdcId) ?? null : null;
  return {
    id: `row-${rowCounter++}`,
    raw,
    parsed,
    candidates,
    selectedFdcId,
    grams: initialGrams(est, parsed, selectedFood),
    milliliters: est.milliliters,
    excludeFromNutrition: false,
    cooking: parsed.isGroupHeader ? 'raw' : suggestCooking(raw, selectedFood),
    userSetCooking: false,
    proxyFdcId: null,
    userPickedFdcId: null,
    starchForm: null,
  };
}

/** Split a textarea into rows, dropping blank lines. */
export function linesToRows(text: string): IngredientRow[] {
  return splitLines(text).map(buildRow);
}

/**
 * Re-parse the textarea while preserving the user's edits (chosen match, edited
 * weight, exclusion) for any line whose raw text is unchanged.
 */
export function reparseRows(text: string, existing: IngredientRow[]): IngredientRow[] {
  const pool = new Map<string, IngredientRow[]>();
  for (const r of existing) {
    const list = pool.get(r.raw) ?? [];
    list.push(r);
    pool.set(r.raw, list);
  }
  return splitLines(text).map((line) => pool.get(line)?.shift() ?? buildRow(line));
}

/** Split a USDA portion label ("2 tablespoon", "0.25 cup", "1 clove") into its
 *  leading amount and unit phrase, so the gram weight can be normalised to one
 *  unit. Null when the label has no leading number. */
function parsePortion(p: { label: string; grams: number }): { amount: number; unit: string } | null {
  const m = /^\s*([\d.]+(?:\s*\/\s*[\d.]+)?)\s+(.+?)\s*$/.exec(p.label);
  if (!m) return null;
  const raw = m[1].replace(/\s/g, '');
  const amount = raw.includes('/')
    ? Number(raw.split('/')[0]) / Number(raw.split('/')[1])
    : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // Drop any descriptor after the unit ("cup, chopped", "cup (8 fl oz)") so the
  // bare measure ("cup") canonicalises and matches the ingredient's unit.
  const unit = m[2].split(/[,(]/)[0].trim();
  return unit ? { amount, unit } : null;
}

/**
 * Best-effort starting weight from the matched food's USDA portions (densities
 * are never guessed). Mass units already carry grams from `est`. Otherwise: for
 * a recognised volume unit, use the portion whose own unit canonicalises to the
 * same measure (so "1 tsp"/"2 tablespoon"/"0.25 cup" labels all match), scaled
 * to one unit × the quantity — and return null when the food has no matching
 * volume portion, so the author enters the weight rather than seeing a guess.
 * Count words ("clove", "1 egg") fall back to the food's first portion.
 */
export function initialGrams(
  est: MetricAmount,
  parsed: ParsedLine,
  food: FoodRecord | null,
): number | null {
  if (est.grams != null) return round1(est.grams);
  const qty = parsed.quantity;
  if (qty == null || qty <= 0) return null;

  const want = canonicalUnit(parsed.unitId ?? parsed.unit);
  if (want && food?.portions?.length) {
    for (const p of food.portions) {
      const lp = parsePortion(p);
      if (lp && canonicalUnit(lp.unit) === want) return round1((p.grams / lp.amount) * qty);
    }
  }
  // Volume unit with no exact-unit portion: weigh via the food's burnt-in
  // density (the volume 100 g occupies). Volume↔volume is exact, so a "1 cup"
  // portion can weigh "2 tbsp" — still the food's own USDA data, not a guess.
  if (classifyUnit(want) === 'volume' && est.milliliters != null && est.milliliters > 0 && food?.per100g) {
    const mlPer100g = volumeToMilliliters(food.per100g.cup, 'cup');
    if (mlPer100g != null && mlPer100g > 0) return round1((est.milliliters * 100) / mlPer100g);
  }
  // A count word (clove, slice, "1 egg") has no recognised mass/volume unit: use
  // the food's first count-style portion. A recognised volume unit with neither a
  // matching portion nor a density gets no guess (null → the author enters the
  // weight), and a count never inherits a cup/oz portion's weight.
  if (!classifyUnit(want) && food?.portions?.length) {
    for (const p of food.portions) {
      const lp = parsePortion(p);
      if (lp && !classifyUnit(lp.unit)) return round1((p.grams / lp.amount) * qty);
    }
  }
  return null;
}

/**
 * Patch for changing a row's chosen match: select the food AND re-derive the
 * weight from that food's own portions/density. Grams is a function of (quantity,
 * unit, food), so switching the match must recompute it rather than carry over the
 * previous match's value. A mass-unit ingredient keeps its absolute grams; a
 * volume/count one re-derives, or clears to null when the new food offers no usable
 * portion (so the author enters it instead of seeing a stale weight). The cooking
 * suggestion depends on the food too (a dry staple is boiled), so it is re-suggested for
 * the new match — unless the author set the method, which is kept.
 */
export function selectMatch(row: IngredientRow, fdcId: number | null): Partial<IngredientRow> {
  const food = fdcId != null ? FOOD_BY_ID.get(fdcId) ?? null : null;
  const patch: Partial<IngredientRow> = {
    selectedFdcId: fdcId,
    userPickedFdcId: fdcId,
    grams: initialGrams(estimateMetric(row.parsed), row.parsed, food),
  };
  if (!row.userSetCooking && !row.parsed.isGroupHeader) patch.cooking = suggestCooking(row.raw, food);
  // The pasta-dough flag belongs to a food with a dough GI; a re-match to one without
  // hides the toggle, so the hidden flag must not survive into the draft.
  if (!hasDoughGi(fdcId)) patch.starchForm = null;
  return patch;
}

/**
 * Confidence of the row's selected match ('none' when unmatched). A match the author
 * picked by hand counts as reviewed, so it is at least 'medium' (it no longer raises the
 * gate's low-confidence review warning); the identity and state checks still apply.
 */
export function selectedConfidence(row: IngredientRow): MatchConfidence | 'none' {
  if (row.selectedFdcId == null) return 'none';
  const auto = row.candidates.find((c) => c.food.fdcId === row.selectedFdcId)?.confidence ?? 'medium';
  return auto === 'low' && row.userPickedFdcId === row.selectedFdcId ? 'medium' : auto;
}

/** Map review rows to the engine's resolved-ingredient shape. */
export function rowsToResolved(rows: IngredientRow[]): ResolvedIngredient[] {
  return rows
    .filter((r) => !r.parsed.isGroupHeader)
    .map((r) => {
      const food = r.selectedFdcId != null ? FOOD_BY_ID.get(r.selectedFdcId) : undefined;
      const cooked = cookIngredient(safeGrams(r.grams), food?.n ?? null, food, r.cooking, r.excludeFromNutrition);
      return {
        grams: cooked.grams,
        excludeFromNutrition: r.excludeFromNutrition,
        nutrients: cooked.nutrients,
      };
    });
}

/** Per-serving macros for the review rows; pass `resolved` when it is already computed. */
export function computeNutrition(
  rows: IngredientRow[],
  servings: number,
  resolved: ResolvedIngredient[] = rowsToResolved(rows),
): MacroComputation {
  return computeMacros(resolved, clampServings(servings));
}

/**
 * Run the validation gate (core/validate.ts) over the review rows, reusing the macros the
 * island already computed (`resolved` from rowsToResolved, `macro` from computeNutrition)
 * and the loaded food lookup, so a keystroke never re-resolves the recipe or rebuilds a
 * food map. Only the fields the gate reads are taken from the form.
 */
export function validateRows(
  rows: IngredientRow[],
  fields: Pick<FormState, 'title' | 'servings' | 'course' | 'sourceKcalPerServing'>,
  resolved: ResolvedIngredient[],
  macro: MacroComputation,
): ValidationResult {
  return validateRecipe(
    {
      title: fields.title.trim() || undefined,
      servings: clampServings(fields.servings),
      course: fields.course.trim() || undefined,
      source: { kcalPerServing: safeKcal(fields.sourceKcalPerServing) },
      ingredients: draftIngredients(rows),
    },
    FOOD_BY_ID,
    { precomputed: { resolved, macro } },
  );
}

/**
 * Auto-fix freshly parsed rows and the method to the house rules (core/houseRules.ts
 * `normalizeRecipe`): forbidden ingredients swapped, cooked staples to their dry weight,
 * handfuls to grams, olive oil in spoons, eggs as a count, state words to the note, a main
 * course's grain at 80 g per serving (servings unchanged) and a drink's water counted. A row
 * the rules leave alone is returned as the same object (its review edits intact); a changed
 * row is rebuilt from its new line with the pinned food and weight. `changes` lists what was
 * changed, for the author to review.
 */
export function normalizeRows(
  rows: IngredientRow[],
  form: Pick<FormState, 'title' | 'course' | 'servings' | 'instructions'>,
): { rows: IngredientRow[]; instructions: string; changes: string[] } {
  // A count row's weight is the engine's portion guess, so only a mass/volume weight is passed on.
  const measured = (r: IngredientRow) => {
    const dim = classifyUnit(r.parsed.unitId ?? r.parsed.unit);
    return dim === 'mass' || dim === 'volume';
  };
  const lines: NormalizableLine[] = rows.map((r) => ({
    raw: r.raw,
    fdcId: r.selectedFdcId,
    grams: measured(r) ? r.grams : null,
    exclude: r.excludeFromNutrition,
    cooking: r.userSetCooking ? r.cooking : null,
    proxyOk: r.proxyFdcId != null && r.proxyFdcId === r.selectedFdcId,
  }));
  const steps = splitLines(form.instructions);
  const { value, changes } = normalizeRecipe(
    { title: form.title, course: form.course, servings: clampServings(form.servings), ingredients: lines, steps },
    FOOD_BY_ID,
  );
  const same = (a: NormalizableLine, b: NormalizableLine) =>
    a.raw === b.raw && (a.fdcId ?? null) === (b.fdcId ?? null) && (a.grams ?? null) === (b.grams ?? null) && !!a.exclude === !!b.exclude;
  const used = new Set<number>();
  const out = value.ingredients.map((line) => {
    const i = lines.findIndex((l, k) => !used.has(k) && same(l, line));
    if (i >= 0) {
      used.add(i);
      return rows[i];
    }
    const row = buildRow(line.raw);
    if (line.fdcId != null) Object.assign(row, selectMatch(row, line.fdcId));
    if (line.grams != null) row.grams = line.grams;
    row.excludeFromNutrition = !!line.exclude;
    if (line.cooking && isCookingMethod(line.cooking)) {
      row.cooking = line.cooking;
      row.userSetCooking = true;
    }
    if (line.proxyOk) row.proxyFdcId = row.selectedFdcId;
    return row;
  });
  // The method is written back only when a step changed, so its own line structure survives.
  const stepsChanged = (value.steps ?? []).length !== steps.length || (value.steps ?? []).some((st, i) => st !== steps[i]);
  return { rows: out, instructions: stepsChanged ? (value.steps ?? []).join('\n') : form.instructions, changes };
}

/** House-rule findings on the method/tips text (meat suggestions), kept apart from the
 *  row gate so typing a method step never re-runs the ingredient checks. */
export function validateMethod(text: string): ValidationResult {
  const errors = methodIssues(text).map(({ severity: _s, ...issue }) => issue);
  return { errors, warnings: [] };
}

/** The stored `raw` text of a row (falls back to the parsed food name). */
function rowRaw(r: IngredientRow): string {
  return r.raw || r.parsed.item;
}

/** Map review rows to the scoring engine's shape (adds GI, measured-GI flag, FVL and the
 *  NOVA marker text per match; the inflammation tag is computed from nutrients by the FII). */
export function rowsToScored(rows: IngredientRow[]): ScoredIngredient[] {
  return rows
    .filter((r) => !r.parsed.isGroupHeader)
    .map((r) => {
      const food = r.selectedFdcId != null ? FOOD_BY_ID.get(r.selectedFdcId) : undefined;
      const s = scoringFor(r.selectedFdcId);
      // Same cooked view as the rescorer (recipeScore.toScored), so the authored block reproduces.
      const cooked = cookIngredient(safeGrams(r.grams), nutrientsFor(food), food, r.cooking, r.excludeFromNutrition);
      return {
        grams: cooked.grams,
        rawGrams: safeGrams(r.grams),
        excludeFromNutrition: r.excludeFromNutrition,
        fdcId: r.selectedFdcId,
        nutrients: cooked.nutrients,
        gi: giFor(s, r.starchForm).gi,
        giMeasured: giFor(s, r.starchForm).measured,
        fvl: s?.fvl ?? fvlFromCategory(food),
        nova: food?.nova ?? null,
        // Same text the draft stores as `raw` (rowToDraftIngredient), so a rescore of
        // the committed markdown reads the identical processing markers.
        raw: rowRaw(r),
      };
    });
}

/** Compute the glycemic / Nutri-Score / inflammation block for the review rows. */
export function computeRecipeScores(
  rows: IngredientRow[],
  servings: number,
  options: ScoreOptions = {},
): ScoreResult {
  return computeScores(rowsToScored(rows), clampServings(servings), options);
}

function rowToDraftIngredient(row: IngredientRow): DraftIngredient {
  return {
    raw: rowRaw(row),
    quantity: row.parsed.quantity,
    quantity2: row.parsed.quantity2,
    unit: row.parsed.unit,
    item: row.parsed.item || row.raw,
    note: row.parsed.note,
    grams: safeGrams(row.grams),
    milliliters: row.milliliters,
    fdcId: row.selectedFdcId,
    matchConfidence: selectedConfidence(row),
    excludeFromNutrition: row.excludeFromNutrition,
    cooking: row.cooking,
    proxyOk: row.proxyFdcId != null && row.proxyFdcId === row.selectedFdcId ? true : undefined,
    starchForm: row.starchForm ?? undefined,
  };
}

/** The draft's stored ingredient lines for the review rows (group headers dropped). */
export function draftIngredients(rows: IngredientRow[]): DraftIngredient[] {
  return rows.filter((r) => !r.parsed.isGroupHeader).map(rowToDraftIngredient);
}

/** All wizard form fields outside the ingredient rows. */
export interface FormState {
  title: string;
  description: string;
  servings: number;
  prepMin: number | null;
  cookMin: number | null;
  cuisine: string;
  course: string;
  category: string;
  /** Nutri-Score category of the finished dish (NOT the taxonomy `category` above). */
  nutriCategory: NutriCategory;
  /** Beverages: a non-nutritive sweetener is present (drives the Nutri-Score NNS penalty). */
  nnsPresent: boolean;
  /** Beverages: the drink is plain water (Nutri-Score forces grade A). */
  isWater: boolean;
  /** General food: the dish IS a cheese (Nutri-Score keeps its protein points past the negative cap). */
  isCheese: boolean;
  /** General food: red/processed meat is the main protein (caps Nutri-Score protein points, Merz 2024). */
  redMeat: boolean;
  lists: string; // comma-separated
  imageUrl: string;
  sourceName: string;
  sourceUrl: string;
  /** Energy per serving the source itself published (kept for the validation gate's cross-check). */
  sourceKcalPerServing: number | null;
  instructions: string; // one step per line
}

export const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  servings: 4,
  prepMin: null,
  cookMin: null,
  cuisine: '',
  course: '',
  category: '',
  nutriCategory: 'general',
  nnsPresent: false,
  isWater: false,
  isCheese: false,
  redMeat: false,
  lists: '',
  imageUrl: '',
  sourceName: '',
  sourceUrl: '',
  sourceKcalPerServing: null,
  instructions: '',
};

/** Seed the form from an imported recipe. */
export function formFromExtract(r: ExtractedRecipe): FormState {
  return {
    ...EMPTY_FORM,
    title: r.title ?? '',
    description: r.description ?? '',
    servings: clampServings(r.servings ?? 4),
    prepMin: isoToMinutes(r.prepTime),
    cookMin: isoToMinutes(r.cookTime),
    cuisine: r.cuisine ?? '',
    course: r.course ?? '',
    imageUrl: r.imageUrl ?? '',
    sourceName: r.sourceName ?? '',
    sourceUrl: r.sourceUrl ?? '',
    instructions: r.instructions.join('\n'),
  };
}

/* ---- editing an existing recipe ---- */

/** The stored ingredient shape (a subset of the frontmatter) needed to re-seed a row. */
export interface StoredIngredient {
  raw: string;
  // Parsed provenance fields — restored verbatim so a re-parse can't overwrite
  // author-corrected values (e.g. a hand-converted "1 tbsp" → quantity 14 g).
  quantity?: number | null;
  quantity2?: number | null;
  unit?: string | null;
  item?: string;
  note?: string;
  grams?: number | null;
  milliliters?: number | null;
  fdcId?: number | null;
  matchConfidence?: MatchConfidence | 'none';
  excludeFromNutrition?: boolean;
  cooking?: CookingMethod;
  proxyOk?: boolean;
  starchForm?: string;
}

/** The stored recipe frontmatter fields the editor re-seeds the form from. */
export interface StoredRecipe {
  title?: string;
  description?: string;
  servings?: number;
  prepTime?: string;
  cookTime?: string;
  cuisine?: string;
  course?: string;
  category?: string;
  lists?: string[];
  imageUrl?: string;
  source?: { name?: string; url?: string; kcalPerServing?: number };
  ingredients?: StoredIngredient[];
  nutrition?: {
    nutriScore?: {
      category?: NutriCategory;
      nnsPresent?: boolean;
      isWater?: boolean;
      isCheese?: boolean;
      redMeat?: boolean;
    };
  };
}

/** Seed the form fields from a stored recipe's frontmatter (for editing). */
export function formFromRecipe(recipe: StoredRecipe, steps: string[]): FormState {
  return {
    ...EMPTY_FORM,
    title: recipe.title ?? '',
    description: recipe.description ?? '',
    servings: clampServings(recipe.servings ?? 4),
    prepMin: isoToMinutes(recipe.prepTime),
    cookMin: isoToMinutes(recipe.cookTime),
    cuisine: recipe.cuisine ?? '',
    course: recipe.course ?? '',
    category: recipe.category ?? '',
    nutriCategory: recipe.nutrition?.nutriScore?.category ?? 'general',
    nnsPresent: recipe.nutrition?.nutriScore?.nnsPresent ?? false,
    isWater: recipe.nutrition?.nutriScore?.isWater ?? false,
    isCheese: recipe.nutrition?.nutriScore?.isCheese ?? false,
    redMeat: recipe.nutrition?.nutriScore?.redMeat ?? false,
    lists: (recipe.lists ?? []).join(', '),
    imageUrl: recipe.imageUrl ?? '',
    sourceName: recipe.source?.name ?? '',
    sourceUrl: recipe.source?.url ?? '',
    sourceKcalPerServing: recipe.source?.kcalPerServing ?? null,
    instructions: steps.join('\n'),
  };
}

/** Rebuild review rows from stored ingredients, restoring each confirmed match + weight. */
export function rowsFromIngredients(ingredients: StoredIngredient[]): IngredientRow[] {
  return ingredients.map((ing) => {
    const row = buildRow(ing.raw);
    return {
      ...row,
      // Restore the stored parse so a re-seed doesn't overwrite author-corrected
      // structured fields (a fresh parse of `raw` may differ). `undefined` (key
      // absent) falls back to the fresh parse; an explicit null is honoured.
      parsed: {
        ...row.parsed,
        quantity: ing.quantity !== undefined ? ing.quantity : row.parsed.quantity,
        quantity2: ing.quantity2 !== undefined ? ing.quantity2 : row.parsed.quantity2,
        unit: ing.unit !== undefined ? ing.unit : row.parsed.unit,
        item: ing.item ?? row.parsed.item,
        note: ing.note ?? row.parsed.note,
      },
      // Keep the stored match selectable even if today's search wouldn't surface it.
      candidates: withStoredMatch(row.candidates, ing.fdcId ?? null, ing.matchConfidence),
      selectedFdcId: ing.fdcId ?? null,
      // Honor a stored value (incl. an explicit null) over a fresh estimate;
      // only an absent field falls back to the re-parse.
      grams: ing.grams !== undefined ? ing.grams : row.grams,
      milliliters: ing.milliliters !== undefined ? ing.milliliters : row.milliliters,
      excludeFromNutrition: ing.excludeFromNutrition ?? false,
      // A stored method is honoured as-is; an absent one is raw (never re-suggested).
      cooking: isCookingMethod(ing.cooking) ? ing.cooking : 'raw',
      userSetCooking: true,
      proxyFdcId: ing.proxyOk && ing.fdcId != null ? ing.fdcId : null,
      userPickedFdcId: null,
      starchForm: ing.starchForm === 'dough' ? 'dough' : null,
    };
  });
}

/**
 * Split a recipe body into numbered method steps (verbatim — keeping any inline
 * markdown) and the surrounding markdown, so an edit can re-seed the step
 * textarea yet preserve everything else **in place**. The method is the first
 * run of numbered items up to the next "## " heading; content before it
 * (intro prose) and after it ("## Notes", tips — including any numbered lines
 * there) is kept verbatim and in order, not hoisted into the steps.
 */
export function splitMethodBody(body: string): { steps: string[]; before: string; after: string } {
  const lines = (body ?? '').split('\n');
  const stepRe = /^\s*\d+[.)]\s+(.*\S)\s*$/;
  const firstStep = lines.findIndex((l) => stepRe.test(l));
  if (firstStep === -1) {
    // No numbered method — keep the whole body so nothing is dropped.
    return { steps: [], before: (body ?? '').trim(), after: '' };
  }
  // The method block ends at the next "## " heading (or end of body).
  let end = lines.length;
  for (let i = firstStep + 1; i < lines.length; i++) {
    if (/^\s*##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const steps = lines
    .slice(firstStep, end)
    .map((l) => stepRe.exec(l)?.[1].trim())
    .filter((s): s is string => !!s);
  // `before` drops a trailing "## Method" heading (the serializer re-adds it).
  const beforeLines = lines.slice(0, firstStep);
  while (
    beforeLines.length &&
    (beforeLines[beforeLines.length - 1].trim() === '' ||
      /^\s*##\s+method\s*$/i.test(beforeLines[beforeLines.length - 1]))
  ) {
    beforeLines.pop();
  }
  return {
    steps,
    before: beforeLines.join('\n').trim(),
    after: lines.slice(end).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/** Ensure the stored fdcId appears among candidates so the match <select> shows it. */
function withStoredMatch(
  candidates: FoodMatch[],
  fdcId: number | null,
  conf?: MatchConfidence | 'none',
): FoodMatch[] {
  if (fdcId == null || candidates.some((c) => c.food.fdcId === fdcId)) return candidates;
  const food = FOOD_BY_ID.get(fdcId);
  if (!food) return candidates;
  const confidence: MatchConfidence = conf && conf !== 'none' ? conf : 'medium';
  return [{ food, score: 0, confidence }, ...candidates];
}

/** Positive, finite kcal per serving, else undefined (the schema requires > 0). */
function safeKcal(n: number | null): number | undefined {
  return n != null && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The draft's `source` block: name, URL and the source's own kcal per serving, when any is set. */
export function sourceOf(form: FormState, sourceUrl = safeUrl(form.sourceUrl)): RecipeDraft['source'] {
  const name = form.sourceName.trim() || undefined;
  const kcalPerServing = safeKcal(form.sourceKcalPerServing);
  return name || sourceUrl || kcalPerServing != null ? { name, url: sourceUrl, kcalPerServing } : undefined;
}

/**
 * Assemble a committable draft from the form, rows, and computed macros.
 * `createdAt` is the recipe's birth date; on an edit, pass the original
 * `createdAt` and supply `dates.updatedAt`/`dates.computedAt` (today) so the
 * edit re-stamps the freshness without losing the original date.
 */
export function buildDraft(
  form: FormState,
  rows: IngredientRow[],
  macro: MacroComputation,
  createdAt: string,
  dates: { computedAt?: string; updatedAt?: string } = {},
): RecipeDraft {
  const totalMin = (form.prepMin ?? 0) + (form.cookMin ?? 0);
  const sourceUrl = safeUrl(form.sourceUrl);
  // Only score when a nutrition block will actually be emitted.
  const scores: ScoreResult = macro.contributingCount
    ? computeRecipeScores(rows, form.servings, {
        nutriCategory: form.nutriCategory,
        // Each flag is gated to the category it applies to, so a stale toggle left over
        // from a category switch never reaches the engine.
        nnsPresent: form.nutriCategory === 'beverage' && form.nnsPresent,
        isWater: form.nutriCategory === 'beverage' && form.isWater,
        isCheese: form.nutriCategory === 'general' && form.isCheese,
        redMeat: form.nutriCategory === 'general' && form.redMeat,
        course: form.course,
      })
    : {};
  // Assemble the Nutri-Score block with the retained scoring inputs (flags) BEFORE the
  // computed `coverage` — the same field order scripts/rescore-recipes.mjs emits — so an
  // /add-authored block and a rescored one serialize identically (no spurious churn).
  const nutriScoreDraft = (() => {
    if (!scores.nutriScore) return undefined;
    const { coverage, ...base } = scores.nutriScore;
    return {
      ...base,
      nnsPresent: form.nutriCategory === 'beverage' && form.nnsPresent ? true : undefined,
      isWater: form.nutriCategory === 'beverage' && form.isWater ? true : undefined,
      isCheese: form.nutriCategory === 'general' && form.isCheese ? true : undefined,
      redMeat: form.nutriCategory === 'general' && form.redMeat ? true : undefined,
      coverage,
    };
  })();
  return {
    title: form.title.trim(),
    description: form.description.trim() || undefined,
    imageUrl: safeUrl(form.imageUrl, sourceUrl),
    source: sourceOf(form, sourceUrl),
    servings: clampServings(form.servings),
    prepTime: minutesToIso(form.prepMin),
    cookTime: minutesToIso(form.cookMin),
    totalTime: minutesToIso(totalMin),
    cuisine: form.cuisine.trim() || undefined,
    course: form.course.trim() || undefined,
    category: form.category.trim() || undefined,
    lists: splitCsv(form.lists),
    ingredients: draftIngredients(rows),
    instructions: splitLines(form.instructions),
    nutrition: macro.contributingCount
      ? {
          perServing: macro.perServing,
          // Same key order as the rescorer's serializer (scripts/rescore-recipes.mjs).
          glycemic: scores.glycemic
            ? {
                gi: scores.glycemic.gi,
                gl: scores.glycemic.gl,
                giBand: scores.glycemic.giBand,
                glBand: scores.glycemic.glBand,
                glBasis: scores.glycemic.glBasis,
                gi_source: scores.glycemic.gi_source,
                measuredGiPct: scores.glycemic.measuredGiPct,
              }
            : undefined,
          nutriScore: nutriScoreDraft,
          inflammation: scores.inflammation
            ? {
                score: scores.inflammation.score,
                band: scores.inflammation.band,
                method: 'fii v4',
                // Same key order as the rescorer's serializer (scripts/rescore-recipes.mjs).
                ...(scores.inflammation.aromaticAdjustment != null
                  ? { aromaticAdjustment: scores.inflammation.aromaticAdjustment }
                  : {}),
              }
            : undefined,
          balance: scores.balance,
          processing: scores.processing
            ? {
                minimallyProcessedPct: scores.processing.minimallyProcessedPct,
                ultraProcessedPct: scores.processing.ultraProcessedPct,
                band: scores.processing.band,
                method: 'NOVA (energy-weighted)',
              }
            : undefined,
          computedAt: dates.computedAt ?? createdAt,
          dataSources: dataSourcesFor(scores, rows),
        }
      : undefined,
    createdAt,
    updatedAt: dates.updatedAt,
  };
}

/** Provenance strings for the nutrition block — the shared recipeScore.dataSourcesFor,
 *  fed the same stored-ingredient fields the rescorer reads. */
function dataSourcesFor(scores: ScoreResult, rows: IngredientRow[]): string[] {
  return dataSourcesForShared(
    scores,
    rows
      .filter((r) => !r.parsed.isGroupHeader)
      .map((r) => ({
        grams: safeGrams(r.grams),
        fdcId: r.selectedFdcId,
        excludeFromNutrition: r.excludeFromNutrition,
        cooking: r.cooking,
      })),
    FOOD_BY_ID,
  );
}

/* ---- value sanitizers (keep emitted frontmatter schema-valid) ---- */

/** A positive integer serving count (schema requires int().positive()). */
export function clampServings(n: number): number {
  const v = Math.round(n);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

/** A non-negative finite weight, or null (schema requires nonnegative()). */
function safeGrams(g: number | null): number | null {
  return g != null && Number.isFinite(g) && g >= 0 ? round1(g) : null;
}

/** A valid absolute http(s) URL (optionally resolved against a base), or undefined. */
export function safeUrl(raw: string, base?: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    const u = base ? new URL(s, base) : new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/* ---- small helpers ---- */

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function splitCsv(s: string): string[] {
  return s.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Whole minutes → ISO-8601 duration; undefined for ≤0 (never the empty 'PT'). */
export function minutesToIso(min: number | null): string | undefined {
  if (min == null || !Number.isFinite(min)) return undefined;
  const total = Math.round(min);
  if (total <= 0) return undefined;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}`;
}

/** ISO-8601 duration → whole minutes (days/seconds included), or null. */
export function isoToMinutes(iso?: string): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const mins =
    Number(m[1] ?? 0) * 1440 +
    Number(m[2] ?? 0) * 60 +
    Number(m[3] ?? 0) +
    Math.round(Number(m[4] ?? 0) / 60);
  return mins > 0 ? mins : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
