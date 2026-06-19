/**
 * Logic for the /add authoring island, kept out of the React component so it
 * unit-tests without a DOM. Bridges the compute engine (parse → match → metric
 * → macros → markdown) to the wizard's row/form state, and sanitises every
 * value at the serialization boundary so the committed frontmatter always
 * validates against the content schema on rebuild.
 */
import { parseIngredientLine, estimateMetric } from '../../core/parse';
import { searchFoods, type FoodRecord, type FoodMatch, type MatchConfidence } from '../../core/match';
import { computeMacros, type MacroComputation } from '../../core/nutrition';
import { computeScores, type ScoredIngredient, type ScoreResult, type ScoreOptions } from '../../core/score';
import type { NutriCategory } from '../../core/nutriscore';
import type { MetricAmount, ParsedLine, ResolvedIngredient } from '../../core/types';
import type { DraftIngredient, RecipeDraft } from '../../core/markdown';
import type { ExtractedRecipe } from '../../core/types';
import foodsData from '../../data/usda-foods.json';
import foodScoringData from '../../data/food-scoring.json';

export const FOODS = foodsData as FoodRecord[];
export const FOOD_BY_ID: Map<number, FoodRecord> = new Map(
  FOODS.filter((f) => f.fdcId != null).map((f) => [f.fdcId as number, f]),
);

/** Hand-curated, cited scoring metadata per USDA food (GI, inflammation tag, FVL). */
interface FoodScoring {
  gi?: number;
  giSource?: string;
  giConfidence?: string;
  inflammation?: number;
  fvl?: boolean;
}
const FOOD_SCORING = foodScoringData as Record<string, FoodScoring>;

function scoringFor(fdcId: number | null): FoodScoring | undefined {
  return fdcId != null ? FOOD_SCORING[String(fdcId)] : undefined;
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
  const candidates = parsed.isGroupHeader ? [] : searchFoods(parsed.item, FOODS);
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

/** Best-effort starting weight: metric estimate, else a matched-food portion. */
export function initialGrams(
  est: MetricAmount,
  parsed: ParsedLine,
  food: FoodRecord | null,
): number | null {
  if (est.grams != null) return round1(est.grams);
  if (food?.portions?.length && parsed.quantity != null && parsed.quantity > 0) {
    const unit = (parsed.unitId ?? parsed.unit ?? '').toLowerCase();
    const portion =
      (unit && food.portions.find((p) => p.label.toLowerCase().includes(unit))) ||
      food.portions[0];
    return round1(portion.grams * parsed.quantity);
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
        fvl: s?.fvl ?? false,
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

/** Assemble a committable draft from the form, rows, and computed macros. */
export function buildDraft(
  form: FormState,
  rows: IngredientRow[],
  macro: MacroComputation,
  createdAt: string,
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
          nutriScore: scores.nutriScore,
          inflammation: scores.inflammation
            ? { ...scores.inflammation, method: 'ingredient-tag v1' }
            : undefined,
          computedAt: createdAt,
          dataSources: dataSourcesFor(scores),
        }
      : undefined,
    createdAt,
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
