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

// USDA categories with no place in this archive. "Fast Foods" / composite dishes
// pollute ingredient matching; all land-animal meat is excluded (the archive is
// plant- and seafood-based) — only "Finfish and Shellfish Products" (seafood of
// any kind) is kept among animal flesh, while eggs/dairy stay (not meat).
const EXCLUDED_CATEGORIES = new Set([
  'Fast Foods',
  'Restaurant Foods',
  'Meals, Entrees, and Side Dishes',
  'Baby Foods',
  'Beef Products',
  'Pork Products',
  'Poultry Products',
  'Lamb, Veal, and Game Products',
  'Sausages and Luncheon Meats',
  'American Indian/Alaska Native Foods',
]);
// Specific dishes to drop regardless of category: macaroni and cheese (sits
// under Baby Foods / Meals / Luncheon Meats), and fast-food items miscategorised
// outside "Fast Foods" (e.g. "Shake, fast food, vanilla" filed under Beverages).
const EXCLUDED_DESCRIPTION_RE = /macaroni and cheese|\bfast food\b/i;

// Within Sweets / Baked Products, drop finished-dessert/junk leading-noun groups
// (the noun before the first comma) — they are products, not cooking ingredients.
// Scoped to those two categories so a "Pie"/"Cake"/"Rolls" elsewhere is untouched.
const GROUP_PRUNE_CATEGORIES = new Set(['Sweets', 'Baked Products']);
const EXCLUDED_GROUPS = new Set([
  // Sweets
  'candies', 'puddings', 'pudding', 'syrups', 'syrup', 'fruit syrup', 'frostings',
  'frozen novelties', 'frozen yogurts', 'desserts', 'gelatin desserts', 'gelatins',
  'pectin', 'chewing gum', 'gums', 'sherbet', 'pie fillings', 'jellies',
  // Baked Products
  'cake', 'doughnuts', 'leavening agents', 'rolls', 'sweet rolls', 'pie', 'pie crust',
]);
function isExcludedGroup(desc) {
  const g = desc.split(/[,(]/)[0].trim().toLowerCase();
  if (/\bmuffins?\b/.test(g)) return true; // Muffins / Muffin / English muffins / …Muffin Mix
  if (!EXCLUDED_GROUPS.has(g)) return false;
  // Keep real maple syrup — a cooking ingredient (used in recipes) — but not the
  // "table blends, pancake, with 2% maple" imitations or other syrups.
  if (/^syrups,\s*maple\b/i.test(desc)) return false;
  return true;
}

export function isExcludedFood(food) {
  if (EXCLUDED_CATEGORIES.has(food.category)) return true;
  const desc = food.description || '';
  if (EXCLUDED_DESCRIPTION_RE.test(desc)) return true;
  if (GROUP_PRUNE_CATEGORIES.has(food.category) && isExcludedGroup(desc)) return true;
  // Soups are composite dishes; drop them but keep broths/stocks/bouillon
  // (real cooking liquids). Sauces, gravies and dips in this category stay.
  if (
    food.category === 'Soups, Sauces, and Gravies' &&
    /\bsoups?\b/i.test(desc.split(/[,(]/)[0]) &&
    !/\b(broth|stock|bouillon|consomm)/i.test(desc)
  ) {
    return true;
  }
  return false;
}

/** Final decision: drop this food from the generic dataset? */
export function shouldDrop(food) {
  if (KEEP_IDS.has(food.fdcId)) return false;
  if (EXCLUDE_IDS.has(food.fdcId)) return true;
  if (isExcludedFood(food)) return true;
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

const MASS_CANON = new Set(['gram', 'kilogram', 'ounce', 'pound', 'milligram', 'microgram']);
const MASS_ALIASES = {
  g: 'gram', grams: 'gram', gr: 'gram', gramme: 'gram', grammes: 'gram',
  kg: 'kilogram', kilograms: 'kilogram', kilo: 'kilogram',
  oz: 'ounce', ounces: 'ounce', lb: 'pound', lbs: 'pound', pounds: 'pound',
  mg: 'milligram', milligrams: 'milligram', mcg: 'microgram', micrograms: 'microgram',
};
function isMassUnit(phrase) {
  const u = phrase.trim().toLowerCase().replace(/\.+$/, '');
  return MASS_CANON.has(MASS_ALIASES[u] ?? u);
}

/**
 * Classify a portion label: 'volume' (cup/tbsp/…), 'mass' (oz/lb/…), or 'count'
 * (everything else — "1 large", "1 clove", "1 slice"). Only count portions are
 * kept in the dataset: volume is carried by the derived per100g density and mass
 * portions are never read (a mass ingredient weighs straight from its unit).
 */
function portionDimension(label) {
  const m = /^\s*([\d.]+(?:\s*\/\s*[\d.]+)?)\s+(.+?)\s*$/.exec(label);
  if (!m) return 'count';
  const phrase = m[2].split(/[,(]/)[0].trim();
  // Scan the whole phrase and each word, so a unit anywhere is caught ("fl oz"
  // as a phrase; "cup" inside "serving 1/4 cup"). Volume is tested before mass so
  // "fl oz" reads as volume, not the "oz" → mass it also contains.
  const tokens = [phrase, ...phrase.split(/\s+/)];
  if (tokens.some((t) => canonVolUnit(t))) return 'volume';
  if (tokens.some((t) => isMassUnit(t))) return 'mass';
  return 'count';
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

/**
 * Volume that 100 g occupies, in cup/fl-oz/tsp/tbsp (a burnt-in density table).
 * Stored at full precision — data is never rounded; any rounding happens only at
 * display time. (Rounding here would both lose precision and drift the fields
 * against each other on re-derivation.)
 */
function per100gFields(gPerMl) {
  const mlPer100g = 100 / gPerMl;
  return {
    cup: mlPer100g / ML_PER.cup,
    flOz: mlPer100g / ML_PER['fluid ounce'],
    tsp: mlPer100g / ML_PER.teaspoon,
    tbsp: mlPer100g / ML_PER.tablespoon,
  };
}

/**
 * Compact food record with a deterministic key order, a burnt-in `per100g`
 * density (when derivable), and only the COUNT portions retained — volume is
 * carried by per100g and mass portions are never read, so dropping them sheds
 * redundant data without losing any capability. Idempotent: on a food whose
 * volume portions were already dropped, the stored per100g is carried through
 * verbatim (re-deriving it from the rounded cup would drift the other fields).
 */
function normalizeFood(f) {
  const out = { fdcId: f.fdcId, description: f.description, n: f.n };
  if (f.category) out.category = f.category;
  const d = volumeDensity(f.portions);
  if (d && Number.isFinite(d) && d > 0) out.per100g = per100gFields(d);
  // Once volume portions have been dropped there is nothing to re-derive from, so
  // carry a previously-computed density through verbatim (keeps re-cleans idempotent
  // and avoids precision loss from reconstructing it via the rounded cup value).
  else if (f.per100g) out.per100g = f.per100g;
  const counts = (f.portions ?? []).filter((p) => portionDimension(p.label) === 'count');
  if (counts.length) out.portions = counts;
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
