/**
 * Ingredient → food matching.
 *
 * The authoring flow's "trustworthy" accuracy mode shows the top candidate
 * foods for each parsed ingredient so the user can confirm the right one. This
 * module is the pure search/scoring core; it takes the food list as an argument
 * (the dataset lives in `src/data/`, loaded lazily by the UI) so it stays
 * framework-agnostic and unit-testable.
 */
import type { NutrientVector } from './types';

/** A food in the bundled USDA subset: per-100g nutrients + optional portions. */
export interface FoodRecord {
  /** USDA FoodData Central id, when known (provenance for the stored match). */
  fdcId?: number;
  description: string;
  category?: string;
  /** Per-100g nutrients. */
  n: NutrientVector;
  /** Named portion weights (e.g. "1 large" egg → 50 g) for count units. */
  portions?: { label: string; grams: number }[];
  /**
   * Burnt-in density: the volume 100 g of this food occupies, in each volume
   * unit (a single density expressed four ways). Present only when derivable
   * from the food's own USDA volume portions; lets any volume amount be weighed.
   */
  per100g?: { cup: number; flOz: number; tsp: number; tbsp: number };
}

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface FoodMatch {
  food: FoodRecord;
  score: number;
  confidence: MatchConfidence;
}

// Preparation/quantity words that carry no identity — dropped before scoring so
// "finely chopped onion" and "onion" match the same foods.
const STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'with', 'without', 'to', 'taste',
  'fresh', 'frozen', 'dried', 'raw', 'cooked', 'boiled', 'roasted', 'ground',
  'whole', 'large', 'medium', 'small', 'chopped', 'minced', 'sliced', 'diced',
  'grated', 'crushed', 'peeled', 'rinsed', 'drained', 'finely', 'roughly',
  'ripe', 'organic', 'extra', 'virgin', 'for', 'into', 'cut', 'pieces',
]);

// Light singular/plural stemming so "onion" matches USDA's "Onions, raw" and
// "tomatoes" matches "tomato". Applied to both query and food tokens, so even
// imperfect stems still match consistently on each side.
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function scoreMatch(queryTokens: string[], food: FoodRecord): number {
  const desc = tokenize(food.description);
  if (!desc.length || !queryTokens.length) return 0;
  const descSet = new Set(desc);
  let matched = 0; // exact token matches
  let soft = 0; // compound-word reaches ("mint" → "peppermint")
  for (const t of queryTokens) {
    if (descSet.has(t)) {
      matched++;
    } else if (t.length >= 4 && desc.some((d) => d.length > t.length && d.endsWith(t))) {
      // English food names are head-final, so the identity sits at the end of a
      // compound ("pepperMINT", "butterMILK", "chickPEA"). Crediting a query
      // token that's the suffix of a longer food token surfaces those foods that
      // an exact-token match misses; the >=4 length floor keeps short tokens
      // ("oil", "pea") from over-reaching.
      soft++;
    }
  }
  if (!matched && !soft) return 0;

  const eff = matched + soft * 0.5; // a soft match counts for half an exact one
  const recall = eff / queryTokens.length; // share of the query covered
  const precision = eff / desc.length; // how focused the food name is
  const qHead = queryTokens[queryTokens.length - 1]; // the food noun
  const headIn = descSet.has(qHead) ? 0.1 : 0;
  // USDA descriptions lead with the food's identity ("Apples, raw" vs
  // "Croissants, apple"), so a leading-token match strongly favours the base
  // food over a product that merely contains it — essential at full-dataset scale.
  const leads = desc[0] === qHead ? 0.3 : 0;
  const score = Math.min(1, recall * 0.5 + precision * 0.25 + headIn + leads);
  // A purely-soft match (no exact token) is a guess — hold it in the 'low' band
  // so it shows as a pickable candidate but never auto-selects.
  return matched === 0 ? Math.min(score, 0.5) : score;
}

function confidenceFor(score: number): MatchConfidence {
  if (score >= 0.85) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

/**
 * Rank the foods most likely to match an ingredient query (its item text),
 * best first. Returns an empty array when nothing overlaps. `preferIds` nudges
 * foods we hold richer curated data for (GI, portions) ahead of equally-good
 * matches, so a common ingredient still resolves to the better-documented food
 * in a large dataset; confidence reflects the textual match only (pre-bonus).
 */
export function searchFoods(
  query: string,
  foods: FoodRecord[],
  limit = 6,
  preferIds?: Set<number>,
): FoodMatch[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  return foods
    .map((food) => {
      const score = scoreMatch(queryTokens, food);
      // Small rank-only tie-breaker toward foods we hold curated data for, so a
      // common ingredient lands on its better-documented food among equally-good
      // matches. Gated on a non-low score so a weak curated match can't leapfrog
      // a better one to the top (where it would block auto-selection); `score`/
      // confidence stay the textual match.
      const boosted = preferIds && food.fdcId != null && preferIds.has(food.fdcId) && score >= 0.55;
      return { food, score, ranked: boosted ? score + 0.05 : score };
    })
    .filter((m) => m.score > 0)
    // Tie-break deterministically so selection never depends on the dataset's
    // file order: first prefer a food we can weigh by volume (one carrying a
    // burnt-in density), then the higher fdcId — Foundation foods carry the larger
    // ids and the fuller nutrient analyses. So an equal-scoring generic
    // ("chicken breast", "cooked rice") lands on the weighable Foundation
    // reference rather than an SR-Legacy processed cut ("…roll", "Rice crackers").
    .sort(
      (a, b) =>
        b.ranked - a.ranked ||
        (b.food.per100g ? 1 : 0) - (a.food.per100g ? 1 : 0) ||
        (b.food.fdcId ?? 0) - (a.food.fdcId ?? 0),
    )
    .slice(0, limit)
    .map(({ food, score }) => ({ food, score, confidence: confidenceFor(score) }));
}

/** The per-100g nutrient vector for a matched food. */
export function foodToNutrientVector(food: FoodRecord): NutrientVector {
  return food.n;
}

/** A named portion's weight in grams, if the food defines that portion. */
export function portionGrams(food: FoodRecord, label: string): number | null {
  const want = label.trim().toLowerCase();
  const hit = food.portions?.find((p) => p.label.toLowerCase() === want);
  return hit?.grams ?? null;
}
