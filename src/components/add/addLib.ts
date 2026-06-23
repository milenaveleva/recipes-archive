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
import type { NutriCategory } from '../../core/nutriscore';
import type { MetricAmount, ParsedLine, ResolvedIngredient } from '../../core/types';
import type { DraftIngredient, RecipeDraft } from '../../core/markdown';
import type { ExtractedRecipe } from '../../core/types';
// The full food dataset (~8k foods, several MB) is fetched lazily via its asset
// URL rather than bundled into the /add island. `?url` makes Vite emit it as a
// static asset and hand back the URL; `loadFoods()` fetches it once on demand.
import foodsUrl from '../../data/usda-foods.json?url';
import foodScoringData from '../../data/food-scoring.json';

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

/** Hand-curated, cited scoring metadata per USDA food (GI, inflammation tag, FVL). */
interface FoodScoring {
  gi?: number;
  giSource?: string;
  giConfidence?: string;
  inflammation?: number;
  fvl?: boolean;
}
const FOOD_SCORING = foodScoringData as Record<string, FoodScoring>;
// Foods we hold curated GI/inflammation/portion data for: preferred in matching
// so a common ingredient still resolves to the richer-data food in the large set.
const CURATED_IDS = new Set(Object.keys(FOOD_SCORING).map(Number));

function scoringFor(fdcId: number | null): FoodScoring | undefined {
  return fdcId != null ? FOOD_SCORING[String(fdcId)] : undefined;
}

/** USDA categories whose foods count toward the Nutri-Score fruit/veg/legume share. */
const FVL_CATEGORIES = ['Vegetables', 'Fruits', 'Legumes'];
// Excluded from the FVL share per Nutri-Score 2023: starchy staples, nuts & oils
// (scored separately / not FVL), juices (beverages), and obviously-processed
// forms. Deliberately NOT excluding "seed(s)" — legumes are described as
// "…mature seeds…". Coarse by nature; FVL is confirmed per-ingredient in review.
const NON_FVL =
  /\b(potato|potatoes|cassava|yam|yams|plantain|plantains|taro|juice|nectar|oil|nut|nuts|peanut|peanuts|fried|breaded|chip|chips|crisp|crisps|snack|candied|sauce|ketchup|jam|jelly)\b/i;

/** Derive the Nutri-Score FVL flag from a food's USDA category (scales to all
 *  foods); curated `fvl` always takes precedence over this heuristic. */
function fvlFromCategory(food: FoodRecord | undefined): boolean {
  if (!food?.category) return false;
  if (!FVL_CATEGORIES.some((c) => food.category!.includes(c))) return false;
  return !NON_FVL.test(food.description);
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
}

let rowCounter = 0;

/** Parse a raw line into a review row, pre-selecting a confident match. */
export function buildRow(raw: string): IngredientRow {
  const parsed = parseIngredientLine(raw);
  const est = estimateMetric(parsed);
  const candidates = parsed.isGroupHeader ? [] : searchFoods(parsed.item, FOODS, 6, CURATED_IDS);
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

/** Confidence of the row's selected match ('none' when unmatched). */
export function selectedConfidence(row: IngredientRow): MatchConfidence | 'none' {
  if (row.selectedFdcId == null) return 'none';
  return row.candidates.find((c) => c.food.fdcId === row.selectedFdcId)?.confidence ?? 'medium';
}

/** Map review rows to the engine's resolved-ingredient shape. */
export function rowsToResolved(rows: IngredientRow[]): ResolvedIngredient[] {
  return rows
    .filter((r) => !r.parsed.isGroupHeader)
    .map((r) => ({
      grams: safeGrams(r.grams),
      excludeFromNutrition: r.excludeFromNutrition,
      nutrients: r.selectedFdcId != null ? FOOD_BY_ID.get(r.selectedFdcId)?.n ?? null : null,
    }));
}

export function computeNutrition(rows: IngredientRow[], servings: number): MacroComputation {
  return computeMacros(rowsToResolved(rows), clampServings(servings));
}

/** Map review rows to the scoring engine's shape (adds GI, tag, FVL per match). */
export function rowsToScored(rows: IngredientRow[]): ScoredIngredient[] {
  return rows
    .filter((r) => !r.parsed.isGroupHeader)
    .map((r) => {
      const food = r.selectedFdcId != null ? FOOD_BY_ID.get(r.selectedFdcId) : undefined;
      const s = scoringFor(r.selectedFdcId);
      return {
        grams: safeGrams(r.grams),
        excludeFromNutrition: r.excludeFromNutrition,
        nutrients: food?.n ?? null,
        gi: s?.gi ?? null,
        inflammationTag: s?.inflammation ?? null,
        fvl: s?.fvl ?? fvlFromCategory(food),
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
    raw: row.raw || row.parsed.item,
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
  };
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
  tags: string; // comma-separated
  lists: string; // comma-separated
  imageUrl: string;
  sourceName: string;
  sourceUrl: string;
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
  tags: '',
  lists: '',
  imageUrl: '',
  sourceName: '',
  sourceUrl: '',
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
  tags?: string[];
  lists?: string[];
  imageUrl?: string;
  source?: { name?: string; url?: string };
  ingredients?: StoredIngredient[];
  nutrition?: { nutriScore?: { category?: NutriCategory; nnsPresent?: boolean } };
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
    tags: (recipe.tags ?? []).join(', '),
    lists: (recipe.lists ?? []).join(', '),
    imageUrl: recipe.imageUrl ?? '',
    sourceName: recipe.source?.name ?? '',
    sourceUrl: recipe.source?.url ?? '',
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
        // Only beverages use the NNS penalty; ignore a stale flag if the category changed.
        nnsPresent: form.nutriCategory === 'beverage' && form.nnsPresent,
      })
    : {};
  return {
    title: form.title.trim(),
    description: form.description.trim() || undefined,
    imageUrl: safeUrl(form.imageUrl, sourceUrl),
    source:
      form.sourceName.trim() || sourceUrl
        ? { name: form.sourceName.trim() || undefined, url: sourceUrl }
        : undefined,
    servings: clampServings(form.servings),
    prepTime: minutesToIso(form.prepMin),
    cookTime: minutesToIso(form.cookMin),
    totalTime: minutesToIso(totalMin),
    cuisine: form.cuisine.trim() || undefined,
    course: form.course.trim() || undefined,
    category: form.category.trim() || undefined,
    tags: splitCsv(form.tags),
    lists: splitCsv(form.lists),
    ingredients: rows.filter((r) => !r.parsed.isGroupHeader).map(rowToDraftIngredient),
    instructions: splitLines(form.instructions),
    nutrition: macro.contributingCount
      ? {
          perServing: macro.perServing,
          glycemic: scores.glycemic,
          nutriScore: scores.nutriScore
            ? {
                ...scores.nutriScore,
                // Retain the NNS flag so an edit recomputes the same beverage grade.
                nnsPresent: form.nutriCategory === 'beverage' && form.nnsPresent ? true : undefined,
              }
            : undefined,
          inflammation: scores.inflammation
            ? { ...scores.inflammation, method: 'ingredient-tag v1' }
            : undefined,
          computedAt: dates.computedAt ?? createdAt,
          dataSources: dataSourcesFor(scores),
        }
      : undefined,
    createdAt,
    updatedAt: dates.updatedAt,
  };
}

/** Provenance strings for the scores actually present in the nutrition block. */
function dataSourcesFor(scores: ScoreResult): string[] {
  const sources = ['USDA FoodData Central'];
  if (scores.glycemic) sources.push('Atkinson 2021 GI tables');
  if (scores.nutriScore) sources.push('Nutri-Score 2023');
  if (scores.inflammation) sources.push('Inflammation index (ingredient-tag v1)');
  return sources;
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
