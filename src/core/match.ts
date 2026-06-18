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
  let matched = 0;
  for (const t of queryTokens) if (descSet.has(t)) matched++;
  if (!matched) return 0;

  const recall = matched / queryTokens.length; // share of the query covered
  const precision = matched / desc.length; // how focused the food name is
  // The head noun (last query token) is usually the food itself.
  const headBonus = descSet.has(queryTokens[queryTokens.length - 1]) ? 0.15 : 0;
  return Math.min(1, recall * 0.8 + precision * 0.2 + headBonus);
}

function confidenceFor(score: number): MatchConfidence {
  if (score >= 0.85) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

/**
 * Rank the foods most likely to match an ingredient query (its item text),
 * best first. Returns an empty array when nothing overlaps.
 */
export function searchFoods(query: string, foods: FoodRecord[], limit = 6): FoodMatch[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  return foods
    .map((food) => ({ food, score: scoreMatch(queryTokens, food) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => ({ ...m, confidence: confidenceFor(m.score) }));
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
