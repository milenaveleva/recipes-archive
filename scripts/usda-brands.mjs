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
// "Breakfast Cereals" (ready-to-eat boxed + instant hot cereals) are finished
// products, not cooking ingredients; the raw grains they're milled from live in
// "Cereal Grains and Pasta" (oats, rice, wheat, flour, …), which stays.
const EXCLUDED_CATEGORIES = new Set([
  'Fast Foods',
  'Restaurant Foods',
  'Meals, Entrees, and Side Dishes',
  'Baby Foods',
  'Breakfast Cereals',
  'Beef Products',
  'Pork Products',
  'Poultry Products',
  'Lamb, Veal, and Game Products',
  'Sausages and Luncheon Meats',
  'American Indian/Alaska Native Foods',
]);
// Products/dishes dropped wherever they sit (matched anywhere in the name):
//  - macaroni and cheese (filed under Baby Foods / Meals / Luncheon Meats)
//  - fast-food items miscategorised outside "Fast Foods" (e.g. "Shake, fast food")
//  - frog legs (the archive is plant + seafood; frog is neither)
//  - lemonade (sugar-water drink / mix, incl. hard lemonade — not an ingredient)
//  - meatless analogues (processed fake-meat: meatless bacon/sausage/chicken/…)
//  - french fries (white + sweet potato; whole/baked/boiled potatoes stay)
const EXCLUDED_DESCRIPTION_RE = /macaroni and cheese|\bfast food\b|frog legs?|lemonade|meatless|french fried/i;

// Industrial fat products: margarine & margarine-like spreads (dropped wherever
// the word appears, including foods made with margarine — banana bread, mashed
// potatoes), and shortenings (dropped by leading noun, so a cooking oil that only
// lists "tortilla shortening" as a use stays).
const EXCLUDED_FAT_RE = /margarine|^shortening/i;

// Foods carrying the standalone word "enriched" (fortified): flour, bread,
// cornmeal, pasta, rice — and processed foods made with enriched flour — all with
// iron/folate/niacin/thiamin added back. The archive keeps the base food rather
// than the fortified form, so the added synthetic micronutrients don't stand in
// for intrinsic nutrient density. Matching is component-blind (a snack "made with
// enriched masa flour" is dropped too). The negative lookbehind spares the
// concatenated "unenriched" (its "enriched" is preceded by a letter), a distinct
// food; the corpus carries no separated-negation forms ("un-enriched"/"not enriched").
const ENRICHED_RE = /(?<![a-z])enriched\b/i;

// Animal/dairy milk: any name leading with "Milk" (fluid/dry/canned/condensed/
// evaporated/shakes/desserts/filled/imitation) plus every buttermilk entry
// (biscuits, dressings, waffles included). Plant milks are exempt by id — they're
// renamed to "Milk, <plant>" for findability (see renamePlantMilk) and must
// survive this rule even after the rename makes them lead with "Milk".
const MILK_DROP_RE = /^milk\b|buttermilk/i;

// Processed / prepared potato products (only applied to "Potato…" entries): hash
// browns, tots/puffs, chips, frozen wedges, frozen-roasted, o'brien, au gratin,
// scalloped, potato salad/pancakes, and instant dehydrated/granule/flake/ready-to-eat
// mash. French fries are handled by EXCLUDED_DESCRIPTION_RE. Whole potato stays —
// raw, baked, boiled, microwaved, canned, plain frozen-boiled, home-prepared mash,
// and potato flour.
const POTATO_PRODUCT_RE =
  /\b(hash brown|o'?brien|au gratin|scalloped|puffs?|chips?|tots?|roasted|pancakes?|salad)\b|\bwedges,\s*frozen|\bmashed,\s*(dehydrated|granules|flakes|ready-to-eat)/i;

// Plant-milk fdcIds: kept, and renamed to "Milk, <plant>, …" so they group with
// (and are findable as) milk. USDA names them plant-first ("Soymilk", "Oat milk",
// "Beverages, almond/rice/coconut milk", "Nuts, coconut milk"); the fdcId is the
// stable provenance key, so renaming the display label loses nothing traceable.
const PLANT_MILK_IDS = new Set([
  2257044, 1999630, 173765, 173769, 175216, 175215, 173767, 175217, 174293, 174295,
  173768, 173766, 172446, 172456, // soy
  2257045, 1999631, 174820, 168751, 174832, 173187, // almond
  171942, // rice
  174116, 170173, 169409, 170172, // coconut
  2257046, // oat
]);

// Plant words the rename anchors on. Only consulted for the curated PLANT_MILK_IDS,
// so the plant is always one of these; listing a few extra is harmless.
const PLANT_WORDS = ['soy', 'almond', 'oat', 'rice', 'coconut', 'cashew', 'hemp', 'flax'];

/**
 * Reorder a plant-milk name to "Milk, <plant>, <rest>" (e.g. "Oat milk, unsweetened,
 * plain" → "Milk, oat, unsweetened, plain"; "Beverages, chocolate almond milk, …" →
 * "Milk, almond, chocolate, …"). Drops the "Beverages,"/"Nuts," catalog prefix, keys
 * off the real plant word (so a leading flavour like "chocolate" lands in <rest>, not
 * the plant slot), and folds any leftover head descriptor (e.g. "(All flavors)") into
 * <rest>. Idempotent: after reorder the head segment is "Milk", which holds no plant
 * word, so a re-run finds none and returns the name unchanged.
 */
function renamePlantMilk(desc) {
  const s = desc.replace(/^(beverages|nuts),\s*/i, '').replace(/soymilk/gi, 'soy milk');
  const segs = s.split(',').map((seg) => seg.trim());
  const plant = PLANT_WORDS.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(segs[0]));
  if (!plant) return desc;
  // Strip the plant word, the "milk" word and any parens from the head segment; what
  // remains is a flavour/qualifier (e.g. "chocolate", "All flavors") that joins <rest>.
  const headRest = segs[0]
    .replace(new RegExp(`\\b${plant}\\b`, 'i'), '')
    .replace(/\bmilk\b/i, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const rest = [headRest, ...segs.slice(1)].filter(Boolean).join(', ');
  return rest ? `Milk, ${plant}, ${rest}` : `Milk, ${plant}`;
}

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
  'cake', 'cookies', 'doughnuts', 'leavening agents', 'rolls', 'sweet rolls', 'pie', 'pie crust',
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

// Hand-removed foods whose only USDA volume portion can't parse to a usable
// density (labels like "1 serving 2 tbsp" or the broken "0 cup") — instant drink
// powders, dry-mix flan/rennin, a few ice creams, ready-to-serve marinara — so
// they would carry no per100g.
const SCRAPPED_IDS = new Set([
  174135, 173235, 174872, 173230, 168000, 169621, 168796, 169633, 167575,
  167572, 169631, 167576, 168789, 169617, 168790, 171192, 332282,
]);

// Generic USDA foods dropped because a national table carries a more complete
// record of the same food. 2003603 "Mushroom, beech" (no energy, sparse vector)
// is superseded by MEXT's buna-shimeji (81008016), which carries energy, fibre,
// fatty-acid breakdown and sugars.
export const SUPERSEDED_IDS = new Set([2003603]);

export function isExcludedFood(food) {
  if (SCRAPPED_IDS.has(food.fdcId)) return true;
  if (EXCLUDED_CATEGORIES.has(food.category)) return true;
  const desc = food.description || '';
  if (EXCLUDED_DESCRIPTION_RE.test(desc)) return true;
  if (EXCLUDED_FAT_RE.test(desc)) return true;
  if (ENRICHED_RE.test(desc)) return true;
  // Drop dairy milk + all buttermilk, but keep curated plant milks (which are
  // renamed to lead with "Milk", so they would otherwise match here).
  if (MILK_DROP_RE.test(desc) && !PLANT_MILK_IDS.has(food.fdcId)) return true;
  if (/^potato/i.test(desc) && POTATO_PRODUCT_RE.test(desc)) return true;
  if (GROUP_PRUNE_CATEGORIES.has(food.category) && isExcludedGroup(desc)) return true;
  // In "Soups, Sauces, and Gravies": drop gravies (often meat-based) and soups
  // (composite dishes) — but keep soup broths/stocks/bouillon (real cooking
  // liquids). Sauces and dips stay.
  if (food.category === 'Soups, Sauces, and Gravies') {
    const lead = desc.split(/[,(]/)[0];
    if (/\bgrav(y|ies)\b/i.test(lead)) return true;
    if (/\bsoups?\b/i.test(lead) && !/\b(broth|stock|bouillon|consomm)/i.test(desc)) return true;
  }
  return false;
}

/** Final decision: drop this food from the generic dataset? */
export function shouldDrop(food) {
  if (KEEP_IDS.has(food.fdcId)) return false;
  if (EXCLUDE_IDS.has(food.fdcId)) return true;
  if (SUPERSEDED_IDS.has(food.fdcId)) return true;
  if (isExcludedFood(food)) return true;
  return isBranded(food);
}

const SCORING_PATH = fileURLToPath(new URL('../src/data/food-scoring.json', import.meta.url));
const POLYPHENOL_PATH = fileURLToPath(new URL('../src/data/polyphenols.json', import.meta.url));
const CROSSWALK_PATH = fileURLToPath(new URL('../src/data/phenol-crosswalk.json', import.meta.url));

/** fdcIds carrying a curated score datum — GI/FVL (food-scoring.json) or a polyphenol
 *  value (polyphenols.json, and the phenol-crosswalk.json that generates it) — which the
 *  branded/category filter must never drop, or that datum would be orphaned. The data
 *  files also hold `_doc`/`_source` meta keys; those are non-integer and skipped. */
export function curatedIds() {
  const ids = new Set();
  const add = (path, fromValues) => {
    let obj;
    try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
    for (const x of fromValues ? Object.values(obj) : Object.keys(obj)) {
      const n = Number(x);
      if (Number.isInteger(n)) ids.add(n);
    }
  };
  add(SCORING_PATH, false);    // keys: fdcId → { gi, fvl }
  add(POLYPHENOL_PATH, false); // keys: fdcId → { polyphenol_mg }
  add(CROSSWALK_PATH, true);   // values: Phenol-Explorer name → fdcId
  return ids;
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
 * A portion label that measures a different basis than the food's own volume — a
 * yield/conversion reference ("1 cup, dry, yields"=cooked weight; "1 cup in shell,
 * edible yield"; "1 pint as purchased, yields"; "1 cup, with pits, yields") rather
 * than "X volume of THIS food weighs Y". These give wrong densities, so they're
 * skipped in favour of a clean volume portion. A "dry" measure is a mismatch only
 * for a food that is itself cooked/prepared — a genuinely-dry food's "dry" cup is
 * its real density (crispy chow-mein noodles, instant-coffee powder).
 */
function isBasisMismatch(label, description) {
  if (/\byields?\b|\bas purchased\b|\bin shell\b|\bwith pits\b/i.test(label)) return true;
  if (/\bdry\b/i.test(label) && /\b(cooked|prepared)\b/i.test(description ?? '')) return true;
  return false;
}

/**
 * Density (g/ml) from a food's own USDA portions: the first portion that parses
 * to an amount + a volume unit fixes it (volume↔volume is exact, so the food's
 * reference portion supplies the density for every other volume unit). Yield/basis
 * references are skipped (see isBasisMismatch). Never guessed — returns null when
 * the food lists no usable volume portion.
 */
function volumeDensity(portions, description) {
  for (const p of portions ?? []) {
    if (isBasisMismatch(p.label, description)) continue;
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

// Curated density overrides (g/ml) for the rare food whose only USDA volume
// portion is a known-bad measure that volumeDensity can't otherwise avoid. Unlike
// a derived density these come from external references, so each carries a source —
// the one sanctioned exception to "density only from the food's own USDA portion".
const DENSITY_OVERRIDES = new Map([
  // Spearmint, fresh (173475): USDA's only volume portion, "2 tbsp = 11.4 g"
  // (≈91 g/cup, 0.385 g/ml), is a packed/minced measure ~3× too dense for fresh
  // mint. Chopped fresh mint is ~25 g/cup, matching peppermint (0.108 g/ml) and
  // culinary references (cookitsimply, coolconversion); use that.
  [173475, 0.108],
  // "Peanut butter, creamy" (2262072, Foundation) lists no USDA volume portion, so
  // a tbsp/cup amount can't be weighed; use the density its 10 SR Legacy peanut-
  // butter siblings share (~1.082 g/ml ≈ 258 g/cup, e.g. 172471).
  [2262072, 1.082],
]);

/**
 * Compact food record with a deterministic key order, a burnt-in `per100g`
 * density (when derivable), and only the COUNT portions retained — volume is
 * carried by per100g and mass portions are never read, so dropping them sheds
 * redundant data without losing any capability. Idempotent: on a food whose
 * volume portions were already dropped, the stored per100g is carried through
 * verbatim (re-deriving it from the rounded cup would drift the other fields).
 */
function normalizeFood(f) {
  const description = PLANT_MILK_IDS.has(f.fdcId) ? renamePlantMilk(f.description) : f.description;
  const out = { fdcId: f.fdcId, description, n: f.n };
  if (f.category) out.category = f.category;
  const d = DENSITY_OVERRIDES.get(f.fdcId) ?? volumeDensity(f.portions, f.description);
  if (d && Number.isFinite(d) && d > 0) out.per100g = per100gFields(d);
  // Once volume portions have been dropped there is nothing to re-derive from, so
  // carry a previously-computed density through verbatim (keeps re-cleans idempotent
  // and avoids precision loss from reconstructing it via the rounded cup value).
  else if (f.per100g) out.per100g = f.per100g;
  const counts = (f.portions ?? []).filter((p) => portionDimension(p.label) === 'count');
  if (counts.length) out.portions = counts;
  return out;
}

// Curated non-USDA foods (synthetic fdcId ≥ 9_000_000, well above USDA's range):
// composite ingredients USDA has no generic entry for, e.g. a "seafood mix" whose
// nutrients are the equal-parts mean of real USDA components. They aren't in the
// bulk archives, so serializeFoods re-injects them on every write — otherwise a
// fresh build-usda ingest would drop them.
const CUSTOM_PATH = fileURLToPath(new URL('../src/data/custom-foods.json', import.meta.url));
const CUSTOM_FOODS = JSON.parse(readFileSync(CUSTOM_PATH, 'utf8'));

/**
 * Serialize the food list to the committed JSON shape — curated custom foods
 * merged in (by fdcId, so a re-clean dedups against custom-foods.json), normalised
 * (burnt-in density attached) and sorted alphabetically by name (fdcId tiebreaker),
 * one food object per line so the (large) diff stays scannable. Shared by both
 * write paths (build-usda.mjs, prune-branded.mjs) so they produce identical output.
 */
export function serializeFoods(foods) {
  const byId = new Map(foods.map((f) => [f.fdcId, f]));
  for (const c of CUSTOM_FOODS) byId.set(c.fdcId, c);
  const normalized = [...byId.values()]
    .map(normalizeFood)
    .sort((a, b) => (a.description || '').localeCompare(b.description || '', 'en') || (a.fdcId ?? 0) - (b.fdcId ?? 0));
  return `[\n${normalized.map((f) => `  ${JSON.stringify(f)}`).join(',\n')}\n]\n`;
}

/** Throw if the filtered set would orphan any curated/scored entry. */
export function assertCuratedPresent(foods) {
  const have = new Set(foods.map((f) => f.fdcId));
  const missing = [...curatedIds()].filter((id) => !have.has(id));
  if (missing.length) {
    throw new Error(
      `branded filter would orphan curated ids: ${missing.join(', ')} — add them to ` +
        `KEEP_IDS in scripts/usda-brands.mjs, or remove them from ` +
        `food-scoring.json / polyphenols.json / phenol-crosswalk.json`,
    );
  }
}
