import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Commercial-brand filter for the USDA generic-ingredient dataset.
 *
 * USDA SR Legacy mixes manufacturer-branded products (candy bars, named
 * smoothies, restaurant dishes, infant formula) in with generic reference
 * foods. They pollute ingredient matching — an "apple" query should never land
 * on "Candies, NESTLE …". This module is the single source of truth for
 * dropping them, shared by `build-usda.mjs` (fresh ingest) and
 * `prune-branded.mjs` (re-clean the committed file without re-downloading), so a
 * re-ingest reproduces the cleaned dataset instead of reintroducing brands.
 *
 * Signal: SR Legacy uppercases brand names ("Candies, NESTLE, BUTTERFINGER Bar"),
 * so an uppercase run of ≥3 letters that is not a known generic acronym is a
 * strong brand marker. Two curated overrides handle the long tail the heuristic
 * can't see: EXCLUDE_IDS for Title-Case brands it misses (recall), KEEP_IDS for
 * the rare ALL-CAPS non-brand it would wrongly flag (precision).
 */

// Legit ALL-CAPS tokens that appear in generic foods and must NOT mark a brand:
// nutrient/diet acronyms, units, Roman numerals, and NFSMI (a USDA standardized
// recipe identifier — "NFSMI Recipe No. C-32", not a manufacturer).
const NON_BRAND_TOKENS = new Set([
  'USDA', 'DHA', 'ARA', 'EPA', 'NFS', 'NFSMI', 'RTE', 'RTH', 'UHT', 'USA', 'GTIN',
  'UPC', 'BBQ', 'RTD', 'CSFP', 'HDL', 'LDL',
  'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII',
]);

// An uppercase run bounded by uppercase letters; & ' . - may sit inside it (so
// "T.G.I.", "REESE'S", "UNCLE BEN'S" stay single tokens). There is no
// leading-boundary anchor, so a run glued to a lowercase prefix is still seen
// ("McDONALD'S" → "DONALD'S"). A ≥3-letter threshold is applied below.
const BRAND_TOKEN_RE = /[A-Z][A-Z&'.\-]*[A-Z]/g;

/** Uppercase brand-marker tokens (≥3 letters) in a description, minus acronyms. */
export function brandTokens(description) {
  const out = [];
  let m;
  BRAND_TOKEN_RE.lastIndex = 0;
  while ((m = BRAND_TOKEN_RE.exec(description))) {
    const t = m[0];
    const letters = (t.match(/[A-Z]/g) || []).length;
    if (letters >= 3 && !NON_BRAND_TOKENS.has(t)) out.push(t);
  }
  return out;
}

/** Heuristic: does this food's description carry a brand marker? */
export function isBranded(food) {
  return brandTokens(food.description || '').length > 0;
}

// Title-Case brand stragglers the ALL-CAPS heuristic cannot see (Pillsbury,
// McDonald's, Udi's, Oscar Mayer, Archway, …). Curated + adversarially verified;
// usda-exclude.json keeps the brand + original description for provenance.
const EXCLUDE_PATH = fileURLToPath(new URL('./usda-exclude.json', import.meta.url));
export const EXCLUDE_IDS = new Set(
  JSON.parse(readFileSync(EXCLUDE_PATH, 'utf8')).map((r) => r.fdcId),
);

// ALL-CAPS non-brands the heuristic would otherwise flag: "EMI-TSUNOMATA" is a
// cultivated-seaweed variety name, not a manufacturer.
export const KEEP_IDS = new Set([167602, 167603]);

/** Final decision: drop this food from the generic dataset? */
export function shouldDrop(food) {
  if (KEEP_IDS.has(food.fdcId)) return false;
  if (EXCLUDE_IDS.has(food.fdcId)) return true;
  return isBranded(food);
}

const SCORING_PATH = fileURLToPath(new URL('../src/data/food-scoring.json', import.meta.url));

/** The fdcIds carrying curated GI/inflammation/FVL — these must never be dropped. */
export function curatedIds() {
  return new Set(Object.keys(JSON.parse(readFileSync(SCORING_PATH, 'utf8'))).map(Number));
}

/**
 * Serialize the food list to the committed JSON shape — one food object per
 * line, so the (large) diff stays scannable. Shared by both write paths
 * (build-usda.mjs, prune-branded.mjs) so they produce byte-identical output.
 */
export function serializeFoods(foods) {
  return `[\n${foods.map((f) => `  ${JSON.stringify(f)}`).join(',\n')}\n]\n`;
}

/** Throw if the filtered set would orphan any curated food-scoring entry. */
export function assertCuratedPresent(foods) {
  const have = new Set(foods.map((f) => f.fdcId));
  const missing = [...curatedIds()].filter((id) => !have.has(id));
  if (missing.length) {
    throw new Error(
      `branded filter would orphan curated food-scoring ids: ${missing.join(', ')} — ` +
        `add them to KEEP_IDS in scripts/usda-brands.mjs or remove them from food-scoring.json`,
    );
  }
}
