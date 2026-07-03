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
  /**
   * Provenance of a non-USDA record (e.g. `'JP-MEXT'` for a Japanese national-table
   * food); absent on USDA generics. Read by the `searchFoods` tie-break to keep a
   * national record from displacing a USDA generic on an exact score tie.
   */
  source?: string;
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
  /**
   * NOVA processing group (1 minimally processed, 2 culinary ingredient,
   * 3 processed, 4 ultra-processed), stamped at build time by scripts/nova.mjs.
   * Energy-weighted across a recipe into the processing score (core/processing.ts).
   */
  nova?: 1 | 2 | 3 | 4;
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
  'large', 'medium', 'small', 'chopped', 'minced', 'sliced', 'diced',
  'grated', 'crushed', 'peeled', 'rinsed', 'drained', 'finely', 'roughly',
  'ripe', 'organic', 'extra', 'virgin', 'for', 'into', 'cut', 'pieces',
  'shelled', 'thawed', 'shredded', 'skinless', 'boneless', 'pitted', 'seeded',
  'halved', 'quartered', 'softened', 'melted', 'beaten', 'packed', 'freshly',
  'trimmed', 'cubed', 'crumbled', 'blanched', 'steamed', 'cooled', 'divided',
  'leaf', 'leaves',
]);
// Soft-optional tokens: kept (not stopped) so they still steer RANKING — "whole" is
// identity for grains and dairy ("whole wheat" vs refined, "whole milk" vs skim) — but
// NOT required in the all-tokens pass, so a quantity-descriptor use ("1 whole onion")
// still resolves to the base food ("Onions, raw") at full confidence instead of dropping
// to the relaxed pass. searchFoods retries requiring only the non-optional tokens.
const OPTIONAL = new Set(['whole']);
// NB: words that distinguish one food from another (e.g. "smoked", "toasted",
// colours, "sweet") are NOT stopwords — they are identity, and under the
// all-tokens-required rule they correctly steer "smoked salmon" to the smoked
// entry rather than collapsing it onto the raw one.

// Light singular/plural stemming so "onion" matches USDA's "Onions, raw" and
// "tomatoes" matches "tomato". Applied to both query and food tokens, so even
// imperfect stems still match consistently on each side.
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`; // berries → berry
  // Strip "es" only for a genuine "-es" plural — a sibilant (boxes, dishes,
  // churches) or a consonant+o (tomatoes, potatoes). An "-e + s" plural (apples,
  // grapes, oranges) must lose only the "s" (→ apple, grape, orange), never the
  // "e" too ("appl"/"grap"), or a singular query never matches the plural USDA name.
  if (w.length > 4 && (w.endsWith('oes') || /(s|x|z|ch|sh)es$/.test(w))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Alternate ingredient names mapped to the word USDA actually uses, so a
// Commonwealth/regional term still finds the food (USDA names are US English).
// Keyed and valued in STEMMED form and applied to query AND food tokens, so the
// mapping is symmetric; the keys don't appear in USDA names, so food-side
// application is a no-op and only the query is canonicalised.
const SYNONYMS = new Map<string, string>([
  ['beetroot', 'beet'], // British "beetroot(s)" → USDA "Beets"
  ['aubergine', 'eggplant'],
  ['courgette', 'zucchini'],
  ['rocket', 'arugula'],
  ['prawn', 'shrimp'], // British "prawns" → USDA "Shrimp"
  ['sultana', 'raisin'],
  ['swede', 'rutabaga'],
  ['maize', 'corn'],
  ['groundnut', 'peanut'],
  ['yoghurt', 'yogurt'], // British spelling → USDA "Yogurt"
  ['chilli', 'chili'], // British spelling → USDA "chili"
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    // Drop only PROVENANCE/processing parentheticals — those opening with "includes"
    // or "may contain" (e.g. "(Includes foods for USDA's Food Distribution Program)",
    // "(includes crisphead types)", "(may contain additives to retain moisture)").
    // Their ~5 noise tokens otherwise sink a food's precision so a query lands on an
    // unrelated food. A parenthetical that holds a COMMON NAME — "(fava beans)",
    // "(ghee)", "(sake)", "(pak-choi)" — is kept; it's often the only token a user
    // searches by, and USDA does not always put the identity before the parens.
    .replace(/\((?:includes|may contain)[^)]*\)/g, ' ')
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .map((w) => SYNONYMS.get(w) ?? w);
}

function scoreMatch(queryTokens: string[], food: FoodRecord, requireAll: boolean): number {
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
  // Primary pass (requireAll): every query token must be present (exact or
  // compound-suffix), order-independent, so "peanut butter" only matches foods
  // carrying BOTH "peanut" and "butter" — never plain "Butter" or "Peanuts".
  // Relaxed fallback pass (used by searchFoods only when the strict pass finds
  // nothing): any token suffices, so a descriptor absent from every USDA name
  // ("crusty bread") still surfaces the base food rather than an empty list.
  if (requireAll ? matched + soft < queryTokens.length : !matched && !soft) return 0;

  const eff = matched + soft * 0.5; // a soft match counts for half an exact one
  const recall = eff / queryTokens.length; // share of the query covered
  const precision = eff / desc.length; // how focused the food name is
  const qHead = queryTokens[queryTokens.length - 1]; // the food noun
  const headIn = descSet.has(qHead) ? 0.1 : 0;
  // USDA descriptions lead with the food's identity ("Apples, raw" vs
  // "Croissants, apple"), so a leading-token match strongly favours the base
  // food over a product that merely contains it — essential at full-dataset scale.
  const leads = desc[0] === qHead ? 0.3 : 0;
  // Uncapped: returned so the caller can tie-break by the TRUE score among
  // candidates whose displayed score saturates at 1 — the precision term then
  // favours a focused name ("Beets", raw 1.15) over one that merely leads with
  // the same noun ("Beet greens", 1.025), which the cap would otherwise collapse.
  const raw = recall * 0.5 + precision * 0.25 + headIn + leads;
  // A purely-soft match (no exact token) is a guess — hold it in the 'low' band
  // so it shows as a pickable candidate but never auto-selects.
  return matched === 0 ? Math.min(raw, 0.5) : raw;
}

function confidenceFor(score: number): MatchConfidence {
  if (score >= 0.85) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

/**
 * Rank the foods most likely to match an ingredient query (its item text),
 * best first, in three tiers so precision is preferred but never leaves an empty
 * list when a real food exists:
 *   1. item + `note` tokens, every token required — a DESCRIPTIVE note
 *      ("flour (all-purpose)", "broth (low sodium)") refines the match;
 *   2. item tokens alone, every token required — used when the note is free-text
 *      junk ("cream (for topping)") that tier 1 can't satisfy, so the note can
 *      only ever HELP, never surface a wrong food;
 *   3. item tokens, relaxed to a partial match — used when even the item alone
 *      has no all-token match ("crusty bread"), so the base food still surfaces.
 * Within a tier a food must contain EVERY token (AND, order-independent), so
 * "peanut butter" never lists plain "Butter"/"Peanuts". `preferIds` nudges foods
 * we hold richer curated data for ahead of equally-good matches; confidence
 * reflects the textual match only (pre-bonus). Empty only when nothing matches.
 */
export function searchFoods(
  query: string,
  foods: FoodRecord[],
  limit = 6,
  preferIds?: Set<number>,
  note?: string,
): FoodMatch[] {
  const itemTokens = tokenize(query);
  if (!itemTokens.length) return [];
  // An "or …" clause in the note names an ALTERNATIVE ingredient ("chardonnay",
  // note "or other dry white wine"), not a refinement of this one — drop it from
  // the tokens that steer the match so it can't pull the result toward the
  // substitute, while the full note is still retained on the ingredient.
  const matchNote = note ? note.replace(/\bor\b[\s\S]*$/i, '').trim() : '';
  const noteTokens = matchNote ? tokenize(matchNote) : [];
  const rank = (tokens: string[], requireAll: boolean) =>
    foods
      .map((food) => {
        const raw = scoreMatch(tokens, food, requireAll);
        const score = Math.min(1, raw); // displayed score + confidence basis, capped to 0..1
        // Small rank-only tie-breaker toward foods we hold curated data for, so a
        // common ingredient lands on its better-documented food among equally-good
        // matches. Gated on a non-low score so a weak curated match can't leapfrog
        // a better one to the top (where it would block auto-selection); `score`/
        // confidence stay the textual match.
        const boosted = preferIds && food.fdcId != null && preferIds.has(food.fdcId) && score >= 0.55;
        return { food, score, raw, ranked: boosted ? score + 0.05 : score };
      })
      .filter((m) => m.score > 0)
      // Tie-break deterministically so selection never depends on the dataset's
      // file order: first prefer a food we can weigh by volume (one carrying a
      // burnt-in density), so a volume amount always converts to grams; then the
      // higher TRUE (uncapped) score, so a focused name ("Beets") outranks one that
      // merely leads with the same noun ("Beet greens") once both saturate the
      // displayed 1.0 cap; then, on an exact tie, a domestic (USDA) record over a
      // national-table one, so a higher-band national fdcId (81_000_000+) never wins
      // the id tie-break below and displaces the USDA generic (a regional food wins a
      // regional term by out-scoring, not by id); then the higher fdcId — Foundation
      // foods carry the larger ids and the fuller nutrient analyses.
      .sort(
        (a, b) =>
          b.ranked - a.ranked ||
          (b.food.per100g ? 1 : 0) - (a.food.per100g ? 1 : 0) ||
          b.raw - a.raw ||
          (b.food.source ? 0 : 1) - (a.food.source ? 0 : 1) ||
          (b.food.fdcId ?? 0) - (a.food.fdcId ?? 0),
      );
  // Note tokens go BEFORE item tokens so the item's last word stays the overall
  // head-noun — the leads/head ranking then favours a food whose identity is the
  // item ("Cream, …") over one led by the note word ("Toppings, … cream").
  let ranked = noteTokens.length ? rank([...noteTokens, ...itemTokens], true) : [];
  // Soft re-rank: the note may carry identity ("milk", note "…I used soy") that no
  // single food satisfies together with the item under the strict AND rule. Before
  // dropping the note entirely, try a relaxed note+item match so that identity still
  // steers ranking ("soy" → "Soy milk" over plain dairy "Milk"). Only runs when the
  // strict note pass found nothing, so it can never override a clean full match.
  if (!ranked.length && noteTokens.length) ranked = rank([...noteTokens, ...itemTokens], false);
  if (!ranked.length) ranked = rank(itemTokens, true);
  // Soft-optional retry: a descriptor like "whole" ("whole onion") ranked in the passes
  // above (so "whole wheat" already preferred the whole-grain food) but no base food
  // carries it. Before relaxing to a partial match, require only the identity tokens so
  // the base food ("Onions, raw") still resolves under the strict AND rule at full score.
  if (!ranked.length) {
    const required = itemTokens.filter((t) => !OPTIONAL.has(t));
    if (required.length && required.length < itemTokens.length) ranked = rank(required, true);
  }
  if (!ranked.length) ranked = rank(itemTokens, false);
  return ranked.slice(0, limit).map(({ food, score }) => ({ food, score, confidence: confidenceFor(score) }));
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
