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

// Volume unit → millilitres (mirror of src/core/units.ts ML_PER, US customary)
// plus the volume aliases that appear in USDA portion labels. Density work only
// ever concerns volume; a mass portion's grams are already absolute.
const ML_PER = {
  milliliter: 1, centiliter: 10, deciliter: 100, liter: 1000,
  teaspoon: 4.92892, tablespoon: 14.7868, 'fluid ounce': 29.5735,
  cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41,
};
const VOL_ALIASES = {
  ml: 'milliliter', millilitre: 'milliliter', milliliters: 'milliliter', millilitres: 'milliliter',
  cl: 'centiliter', dl: 'deciliter', l: 'liter', litre: 'liter', liters: 'liter', litres: 'liter',
  tsp: 'teaspoon', teaspoons: 'teaspoon', tbsp: 'tablespoon', tbs: 'tablespoon', tablespoons: 'tablespoon',
  c: 'cup', cups: 'cup', 'fl oz': 'fluid ounce', 'fl-oz': 'fluid ounce', 'fluid ounces': 'fluid ounce',
  pt: 'pint', pints: 'pint', qt: 'quart', quarts: 'quart', gal: 'gallon', gallons: 'gallon',
};

/** Canonical volume-unit id for a portion-label phrase, or null when not a volume. */
function canonVolUnit(phrase) {
  const u = phrase.trim().toLowerCase().replace(/\.+$/, '');
  const c = VOL_ALIASES[u] ?? u;
  return c in ML_PER ? c : null;
}

/**
 * Density (g/ml) from a food's own USDA portions: the first portion that parses
 * to an amount + a volume unit fixes it (volume↔volume is exact, so the food's
 * reference portion supplies the density for every other volume unit). Never
 * guessed — returns null when the food lists no usable volume portion.
 */
function volumeDensity(portions) {
  for (const p of portions ?? []) {
    const m = /^\s*([\d.]+(?:\s*\/\s*[\d.]+)?)\s+(.+?)\s*$/.exec(p.label);
    if (!m || !Number.isFinite(p.grams) || p.grams <= 0) continue;
    const raw = m[1].replace(/\s/g, '');
    const amount = raw.includes('/') ? Number(raw.split('/')[0]) / Number(raw.split('/')[1]) : Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // Drop a trailing descriptor ("cup, packed", "cup slices (1\" dia)") then,
    // if the whole phrase isn't a unit, retry on its first word ("cup").
    const phrase = m[2].split(/[,(]/)[0].trim();
    const unit = canonVolUnit(phrase) ?? canonVolUnit(phrase.split(/\s+/)[0]);
    if (unit) return p.grams / (amount * ML_PER[unit]);
  }
  return null;
}

/** Volume that 100 g occupies, in cup/fl-oz/tsp/tbsp (a burnt-in density table). */
function per100gFields(gPerMl) {
  const mlPer100g = 100 / gPerMl;
  const sig4 = (x) => Number(x.toPrecision(4));
  return {
    cup: sig4(mlPer100g / ML_PER.cup),
    flOz: sig4(mlPer100g / ML_PER['fluid ounce']),
    tsp: sig4(mlPer100g / ML_PER.teaspoon),
    tbsp: sig4(mlPer100g / ML_PER.tablespoon),
  };
}

/**
 * Compact food record with a deterministic key order and, when derivable, a
 * burnt-in `per100g` density. Re-running on an already-normalised food is
 * idempotent (per100g recomputes from the same portions to the same value).
 */
function normalizeFood(f) {
  const out = { fdcId: f.fdcId, description: f.description, n: f.n };
  if (f.category) out.category = f.category;
  if (f.portions?.length) out.portions = f.portions;
  const d = volumeDensity(f.portions);
  if (d && Number.isFinite(d) && d > 0) out.per100g = per100gFields(d);
  return out;
}

/**
 * Serialize the food list to the committed JSON shape — normalised (burnt-in
 * density attached) and sorted alphabetically by name (fdcId tiebreaker), one
 * food object per line so the (large) diff stays scannable. Shared by both write
 * paths (build-usda.mjs, prune-branded.mjs) so they produce byte-identical output.
 */
export function serializeFoods(foods) {
  const normalized = foods
    .map(normalizeFood)
    .sort((a, b) => (a.description || '').localeCompare(b.description || '', 'en') || (a.fdcId ?? 0) - (b.fdcId ?? 0));
  return `[\n${normalized.map((f) => `  ${JSON.stringify(f)}`).join(',\n')}\n]\n`;
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
