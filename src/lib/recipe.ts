import type { CollectionEntry } from 'astro:content';
import { canonicalUnit, classifyUnit } from '../core/units';
import { inflammationBandOf } from '../core/inflammation';
import { DEFAULT_GL_BASIS, type GlBasis } from '../core/gi';
import { resolveGlBasis } from '../core/course';
import { MINIMAL_GOOD, UPF_HIGH_PCT } from '../core/processing';

export type Recipe = CollectionEntry<'recipes'>;
export type Tone = 'good' | 'mid' | 'bad' | 'unknown';

/** Canonical slug: explicit frontmatter override, else the file id. */
export function recipeSlug(entry: Recipe): string {
  return entry.data.slug ?? entry.id;
}

/* ---- durations (ISO-8601 ⇄ human) ---- */

function durationToMinutes(iso?: string): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    Number(d ?? 0) * 1440 +
    Number(h ?? 0) * 60 +
    Number(min ?? 0) +
    Math.round(Number(s ?? 0) / 60)
  );
}

export function formatDuration(iso?: string): string | null {
  const total = durationToMinutes(iso);
  if (total == null || total <= 0) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

export interface RecipeMetaItem {
  /** Lucide glyph key in META_ICONS (src/lib/icons.ts). */
  icon: 'prep' | 'cook' | 'total' | 'serves' | 'difficulty';
  /** Accessible name for the value (the icon itself is decorative). */
  label: string;
  value: string;
}

/** The fields buildRecipeMeta reads — satisfied by both a collection entry's
 * `data` and an authoring RecipeDraft, so all renderers share one source. */
export interface RecipeMetaSource {
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  servings: number;
  difficulty?: string | null;
}

/** The prep/cook/total/serves/difficulty summary shown as a Lucide
 * icon + value on the detail page and recipe cards. Times and the optional
 * difficulty appear only when set; Serves is always present. Values are
 * display-ready (difficulty is capitalised) so no CSS text-transform is needed. */
export function buildRecipeMeta(data: RecipeMetaSource): RecipeMetaItem[] {
  const prep = formatDuration(data.prepTime);
  const cook = formatDuration(data.cookTime);
  const total = formatDuration(data.totalTime);
  return [
    prep && { icon: 'prep', label: 'Prep', value: prep },
    cook && { icon: 'cook', label: 'Cook', value: cook },
    total && { icon: 'total', label: 'Total', value: total },
    { icon: 'serves', label: 'Serves', value: String(data.servings) },
    data.difficulty && {
      icon: 'difficulty',
      label: 'Difficulty',
      value: data.difficulty[0].toUpperCase() + data.difficulty.slice(1),
    },
  ].filter(Boolean) as RecipeMetaItem[];
}

/** Fields formatIngredientAmount reads — common to a collection ingredient and
 * an authoring DraftIngredient. `item` is the food name, used to spot liquids and
 * seasonings; `note`/`raw` are also scanned for "juice". */
export interface IngredientAmountSource {
  quantity?: number | null;
  quantity2?: number | null;
  unit?: string | null;
  item?: string | null;
  note?: string | null;
  raw?: string | null;
  grams?: number | null;
  milliliters?: number | null;
}

/**
 * Food-name head nouns that mark an ingredient as a liquid (incl. oils), so it
 * displays in ml/L rather than grams. Matched against the LAST word of the name,
 * which is where the liquid identity normally sits ("orange juice", "soy milk",
 * "olive oil", "chicken stock") — so a modifier like "water" in "water chestnut"
 * or "cream" in "cream cheese" doesn't trip it.
 */
const LIQUID_HEADS = new Set([
  'milk', 'buttermilk', 'cream', 'water', 'stock', 'broth', 'bouillon',
  'consomme', 'juice', 'wine', 'beer', 'ale', 'lager', 'cider', 'sake',
  'mirin', 'liquor', 'liqueur', 'vinegar', 'sauce', 'oil', 'syrup', 'soda',
  'brine', 'dashi', 'kombucha', 'kefir', 'coffee', 'tea', 'vermouth',
  'brandy', 'rum', 'vodka', 'whiskey', 'whisky', 'gin', 'champagne', 'prosecco',
]);

/** Whether an ingredient name reads as a liquid (its head noun is a liquid). */
function isLiquid(name?: string | null): boolean {
  if (!name) return false;
  // Drop any parenthetical/alternative descriptor so the head noun is the food
  // itself ("heavy cream (sub milk)" → cream, "soy milk / oat milk" → milk),
  // then match the last word.
  const cleaned = name.replace(/\([^)]*\)/g, ' ').split(/[,/]/)[0];
  const tokens = cleaned.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const head = tokens[tokens.length - 1];
  if (!head) return false;
  const singular = head.length > 3 && head.endsWith('s') ? head.slice(0, -1) : head;
  return LIQUID_HEADS.has(head) || LIQUID_HEADS.has(singular);
}

/** A juice anywhere in the item, note or original line ("lemon juice", "juice of ½ lime"). */
function isJuice(ing: IngredientAmountSource): boolean {
  return [ing.item, ing.note, ing.raw].some((t) => !!t && /\bjuices?\b/i.test(t));
}

/** Whether the line writes an amount: a parsed quantity, or a number/fraction in its text
 *  ("juice of ½ lemon" parses no quantity but names one). */
function hasWrittenAmount(ing: IngredientAmountSource): boolean {
  if (ing.quantity != null) return true;
  return [ing.item, ing.note, ing.raw].some((t) => !!t && /[\d¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/.test(t));
}

/**
 * Seasonings — salt, pepper, ground/dried spices, dried herbs, leaveners, vanilla — are
 * measured by spoon or pinch, never shown by weight. Fresh produce that shares a word
 * (bell pepper, fresh ginger, fresh thyme, garlic cloves) is deliberately not matched.
 */
const SEASONING_PATTERNS: RegExp[] = [
  /\bsalt\b/,
  /^(?:freshly\s+)?(?:(?:ground|cracked|black|white|pink|lemon|cayenne)\s+)*pepper(?:corns?)?$/,
  /\b(?:black|white|ground|cracked|cayenne|lemon)\s+pepper\b/,
  /\bpeppercorns?\b/,
  /\b(?:red\s+)?pepper\s+flakes\b/,
  /\b(?:cumin|paprika|cinnamon|turmeric|nutmeg|oregano|cardamom|allspice|caraway|sumac|za'?atar|saffron|cayenne|garam masala|curry powder|garlic powder|onion powder|five[- ]spice|mixed spice|baking powder|baking soda|bicarbonate of soda|star anise|bay lea(?:f|ves))\b/,
  /\bchil(?:l)?i\s+(?:flakes|powder)\b/,
  /\b(?:coriander|fennel|mustard|caraway|celery|nigella|anise|cumin)\s+seeds?\b/,
  /\bground\s+(?:coriander|ginger|cloves?|cinnamon|nutmeg|cumin|allspice|cardamom|turmeric)\b/,
  /\b(?:coriander|ginger|cloves?)\b.*\bground\b/,
  /\bdried\s+(?:thyme|rosemary|oregano|basil|parsley|dill|mint|sage|tarragon|marjoram|herbs?)\b/,
  /\b(?:thyme|rosemary|herbs?)\b.*\bdried\b/,
  /\bvanilla(?:\s+(?:extract|essence|pods?|beans?|paste|sugar|powder))?$/,
  /\bvanilla\s+(?:extract|essence|pods?|beans?|paste|powder)\b/,
  /\b(?:spices?|seasoning)\b/,
];

/** Whether an ingredient name is a seasoning (shown by spoon/pinch, never grams). */
export function isSeasoning(name?: string | null): boolean {
  if (!name) return false;
  // "Low-sodium soy sauce" is a sauce measured by volume, not a seasoning.
  const n = name.toLowerCase().trim().replace(/\b(reduced|low|less)[- ](salt|sodium)\b/g, '');
  return SEASONING_PATTERNS.some((re) => re.test(n));
}

/** Vulgar fractions a cook reads at a glance, keyed by their decimal value. */
const FRACTIONS: [number, string][] = [
  [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'],
];

/** A quantity as a cook writes it: "½", "1¼", "2⅓"; other values as a rounded decimal. */
export function formatQuantity(q: number): string {
  const whole = Math.floor(q + 1e-9);
  const rest = q - whole;
  if (rest < 0.02) return String(whole);
  const frac = FRACTIONS.find(([v]) => Math.abs(rest - v) < 0.02);
  if (frac) return `${whole || ''}${frac[1]}`;
  return String(round(q, 2));
}

/**
 * The amount shown beside an ingredient, the way a cook reads it: teaspoons and
 * tablespoons keep their spoon measure ("1 tbsp"); a seasoning shows only a spoon,
 * pinch/dash or count — never grams (else nothing); a juice shows ml (from its
 * volume, or its weight at ≈1 g/ml); an ingredient with no written quantity ("salt,
 * to taste", "parsley, for garnish") shows nothing, since its weight is only a hidden
 * estimate for the nutrition math; a liquid (recognised by its name) or anything
 * metered in a metric volume shows ml/L; everything else shows its metric weight in
 * grams/kg. A non-liquid measured by an imperial volume like "cups" with no weight
 * falls back to its written amount ("1½ cups") — cups measure solids too, so a bare
 * volume conversion would be meaningless. Grams remain the basis for ALL nutrition
 * math regardless of what's shown. Returns null when no amount should be shown.
 */
export function formatIngredientAmount(ing: IngredientAmountSource): string | null {
  const olive = oliveOilSpoons(ing);
  if (olive) return olive;
  // Eggs are counted, never weighed: "16 eggs", not "800 g" (a size word is not a unit).
  if (isEgg(ing.item) && ing.quantity != null && (!ing.unit || EGG_SIZE.test(ing.unit))) return formatQuantity(ing.quantity);
  const qtyText = () =>
    ing.quantity2 != null
      ? `${formatQuantity(ing.quantity!)}–${formatQuantity(ing.quantity2)}`
      : formatQuantity(ing.quantity!);

  const canon = canonicalUnit(ing.unit);
  // Herb leaves and sprigs are counted ("6 leaves", "2 sprigs"), never a fraction of a gram.
  if (ing.quantity != null && /^(leaf|leaves|sprigs?)$/i.test(ing.unit ?? '')) return `${qtyText()} ${ing.unit}`;
  if ((canon === 'teaspoon' || canon === 'tablespoon') && ing.quantity != null) {
    return `${qtyText()} ${canon === 'tablespoon' ? 'tbsp' : 'tsp'}`;
  }
  if (isSeasoning(ing.item)) {
    if (ing.quantity == null) return null;
    if (canon === 'pinch' || canon === 'dash') return `${qtyText()} ${ing.unit}`;
    // A count ("2 bay leaves", "1 cinnamon stick") is fine; any mass/volume is not.
    if (!ing.unit) return qtyText();
    return classifyUnit(ing.unit) == null ? `${qtyText()} ${ing.unit}` : null;
  }
  if (isJuice(ing)) {
    // No written amount ("lemon juice, to taste") shows none, whatever weight was estimated.
    if (!hasWrittenAmount(ing)) return null;
    // Citrus/fruit juice is ≈1.0 g/ml, so a weight-only juice reads as the same ml.
    const ml = ing.milliliters != null && ing.milliliters > 0 ? ing.milliliters : ing.grams;
    if (ml != null && ml > 0) return formatMilliliters(ml);
  }
  if (ing.quantity == null) {
    // A line the source wrote without an amount ("red onion, sliced") shows the weight it is
    // scored with, unless it is to taste, optional or a garnish (no amount is the right read).
    if (ing.grams != null && ing.grams > 0 && !NO_AMOUNT.test(`${ing.raw ?? ''} ${ing.note ?? ''}`)) return formatGrams(ing.grams);
    return null;
  }
  // Liquids (recognised by name) and anything written in a metric volume show
  // ml/L; a cup of a dry good is NOT a liquid and falls through to weight.
  const metricVolume =
    canon === 'milliliter' ||
    canon === 'centiliter' ||
    canon === 'deciliter' ||
    canon === 'liter';
  if (ing.milliliters != null && ing.milliliters > 0 && (metricVolume || isLiquid(ing.item))) {
    return formatMilliliters(ing.milliliters);
  }
  if (ing.grams != null && ing.grams > 0) return formatGrams(ing.grams);
  return ing.unit ? `${qtyText()} ${ing.unit}` : qtyText();
}

/** Whole eggs, yolks or whites — counted, never shown by weight. */
function isEgg(name?: string | null): boolean {
  return !!name && /^(?:whole |large |medium |small |free-range |organic )*eggs?(?: (?:yolks?|whites?))?$/i.test(name.trim());
}
/** Egg size words that parse as a unit ("2 medium eggs") but only describe the count. */
const EGG_SIZE = /^(?:small|medium|large|extra-large|xl|size [smlx]+)$/i;

/** Grams of olive oil in one tablespoon (15 ml × 0.91 g/ml). */
const OLIVE_OIL_G_PER_TBSP = 13.5;

/**
 * Olive oil is always measured by the spoon: its weight or volume shows as tablespoons
 * rounded to the half spoon (under half a tablespoon, as teaspoons), never grams or ml.
 * Null when the line is not olive oil or has no amount.
 */
export function oliveOilSpoons(ing: IngredientAmountSource): string | null {
  if (!/\bolive oil\b/i.test(ing.item ?? '')) return null;
  const canon = canonicalUnit(ing.unit);
  let tbsp: number | null = null;
  if (canon === 'tablespoon' && ing.quantity != null) tbsp = ing.quantity;
  else if (canon === 'teaspoon' && ing.quantity != null) tbsp = ing.quantity / 3;
  else if (ing.milliliters != null && ing.milliliters > 0) tbsp = ing.milliliters / 15;
  else if (ing.grams != null && ing.grams > 0) tbsp = ing.grams / OLIVE_OIL_G_PER_TBSP;
  if (tbsp == null || !(tbsp > 0)) return null;
  if (tbsp < 0.5) return `${formatQuantity(Math.max(0.5, Math.round(tbsp * 3 * 2) / 2))} tsp`;
  return `${formatQuantity(Math.round(tbsp * 2) / 2)} tbsp`;
}

/** State words that open a staple's name ("dried chickpeas", "unsweetened oat milk") but belong in its note. */
const STATE_PREFIX = /^(dry|dried|raw|uncooked|unsweetened)\s+(.+)$/i;
/** Names where the state word is part of the product itself (dried oregano, raw honey). */
const STATE_IN_NAME = /^(dried|dry|raw)\s+(oregano|thyme|basil|parsley|dill|mint|sage|rosemary|tarragon|marjoram|herbs?|wakame|seaweed|yeast|honey|almonds|fruit|apricots?|figs?|dates|cranberries|mushrooms?|porcini|tomatoes|chil(?:l)?i(?:es)?)\b/i;

/**
 * The name and note an ingredient line shows: a leading state word on a staple
 * ("dried chickpeas", "dry penne") moves into the faded note ("chickpeas · dry, soaked
 * and cooked"), and so does "fresh" on a herb ("basil · fresh"), so every line reads the
 * same way; product names that carry the word (dried oregano, raw honey) keep it.
 */
/** A fresh herb named with its "fresh" ("fresh basil leaves"), which belongs in the note. */
const FRESH_HERB = /^fresh\s+((?:flat-leaf |curly |thai |lemon |wild )?(?:parsley|basil|coriander|cilantro|mint|spearmint|peppermint|dill|chives?|thyme|rosemary|sage|oregano|tarragon|marjoram|bay lea(?:f|ves)|chervil|lovage|herbs?|lemon balm|garlic leaves)\b.*)$/i;

export function displayItemNote(item: string, note?: string | null): { item: string; note: string | null } {
  const herb = FRESH_HERB.exec(item.trim());
  if (herb) return { item: herb[1], note: note && !/^fresh\b/i.test(note) ? `fresh, ${note}` : note || 'fresh' };
  const m = STATE_PREFIX.exec(item.trim());
  if (!m || STATE_IN_NAME.test(item.trim())) return { item, note: note ?? null };
  // "dried" and "uncooked" read as the one word the lists use: "dry" (raw stays raw).
  const word = m[1].toLowerCase();
  const state = word === 'raw' || word === 'unsweetened' ? word : 'dry';
  const rest = note && !new RegExp(`^(${state}|dried|uncooked)\\b`, 'i').test(note) ? `${state}, ${note}` : (note || state).replace(/^(dried|uncooked)\b/i, 'dry');
  return { item: m[2], note: rest };
}

/** Lines whose missing amount is deliberate: to taste, optional, a garnish or a serving extra. */
const NO_AMOUNT = /\b(to taste|optional|to serve|for serving|to garnish|for garnish|garnish|as needed|if needed|for frying|for deep frying|for greasing|for dusting|for sprinkling|for drizzling|for topping|to top|to finish|to decorate|for decoration|extra|a little|a pinch|pinch)\b/i;

/**
 * Whether to show the original line beside an ingredient that has no displayed amount: only
 * when the line says something the item and note don't ("lime (optional)", "juice of ½
 * lemon"), so a line that merely restates them ("spring onions, sliced") is not printed
 * twice; never for a seasoning, whose original line may carry a gram weight.
 */
export function showRawFallback(ing: IngredientAmountSource, amount: string | null): boolean {
  if (amount != null || !ing.raw || isSeasoning(ing.item)) return false;
  const words = (t?: string | null) => (t ?? '').toLowerCase().match(/[\p{L}\p{N}½¼¾⅓⅔⅛]+/gu) ?? [];
  const known = new Set([...words(ing.item), ...words(ing.note)]);
  return words(ing.raw).some((w) => !known.has(w));
}

/* ---- number formatting ---- */

/** Round to a sensible precision for display (no false precision). */
export function round(n: number | undefined | null, dp = 0): number | null {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Round a displayed metric amount: anything over 10 g/ml snaps to the nearest
 * 10 (so "196 g" reads "200 g", "34 g" reads "30 g") — recipe weights don't
 * warrant single-gram precision — while a value at or under 10 keeps its exact
 * figure, since small doses ("4.5 g") would be distorted by coarsening. Whole
 * spoon measures bypass this (formatIngredientAmount handles tsp/tbsp first).
 */
function roundMetric(v: number): number {
  return v > 10 ? Math.round(v / 10) * 10 : (round(v, 1) ?? v);
}

/** Format a metric weight: grams under 1000, else kg (rounded per roundMetric). */
export function formatGrams(g?: number | null): string | null {
  if (g == null) return null;
  const v = roundMetric(g);
  return v >= 1000 ? `${round(v / 1000, 2)} kg` : `${v} g`;
}

/** Format a metric liquid volume: millilitres under 1000, else litres (rounded per roundMetric). */
function formatMilliliters(ml: number): string {
  const v = roundMetric(ml);
  return v >= 1000 ? `${round(v / 1000, 2)} L` : `${v} ml`;
}

/* ---- score normalization: every metric → a 1–10 rating ----
 * The six scores live on different native scales (GI 0–100, GL 0–60+, Nutri A–E,
 * NRF 1–10, inflammation −2…+2, processing %). To read as one coherent wall they
 * are each normalized to a 1–10 rating where 1 = healthiest and 10 = least healthy
 * — lower is always better. Each metric's own good/medium/high bands land on
 * 1–3 / 4–6 / 7–10, so the shared `ratingTone` colour always agrees with the number,
 * and the ring fills with the rating (empty + green = great, full + red = poor). The
 * two "more is better" metrics — Nutri-Score and nutrient balance — are inverted onto
 * the same scale. Raw values are kept for display, not discarded.
 */

const clampRating = (n: number): number => Math.min(10, Math.max(1, Math.round(n)));

/** 1–10 rating → tone. One banding for every dial: 1–3 good, 4–6 moderate, 7–10 poor. */
export function ratingTone(rating?: number | null): Tone {
  if (rating == null) return 'unknown';
  if (rating <= 3) return 'good';
  if (rating <= 6) return 'mid';
  return 'bad';
}

/** Glycemic index → 1–10 (low ≤55 → 1–3, medium 56–69 → 4–6, high ≥70 → 7–10). */
export function giRating(gi?: number | null): number | null {
  if (gi == null) return null;
  if (gi <= 55) return clampRating(1 + (gi / 55) * 2);
  if (gi <= 69) return clampRating(4 + ((gi - 55) / 14) * 2);
  return clampRating(7 + ((gi - 69) / 31) * 3);
}

/**
 * Per-serving glycemic load → 1–10, mapped linearly within the bands of the basis it was
 * scored on (`glBandOf` in core/gi.ts), so the rating agrees with the stored band:
 *  - 'meal' (full-meal courses): low <20 → 1–3, medium 20–39 → 4–6, high ≥40 → 7–10,
 *    reaching 10 at GL 60.
 *  - 'portion' (every other course): low ≤10 → 1–3, medium 11–19 → 4–6, high ≥20 → 7–10,
 *    reaching 10 at GL 30.
 * Without a basis it uses the engine's DEFAULT_GL_BASIS (core/gi.ts).
 */
export function glRating(gl?: number | null, basis: GlBasis = DEFAULT_GL_BASIS): number | null {
  if (gl == null) return null;
  if (basis === 'portion') {
    if (gl <= 10) return clampRating(1 + (gl / 10) * 2);
    if (gl < 20) return clampRating(4 + ((gl - 10) / 10) * 2);
    return clampRating(7 + ((gl - 20) / 10) * 3);
  }
  if (gl < 20) return clampRating(1 + (gl / 20) * 2);
  if (gl < 40) return clampRating(4 + ((gl - 20) / 20) * 2);
  return clampRating(7 + ((gl - 40) / 20) * 3);
}

/**
 * The GL basis of a stored glycemic block: its own `glBasis` when valid, else the basis the
 * recipe's course implies, else DEFAULT_GL_BASIS (core/course.ts `resolveGlBasis`).
 */
export function glBasisOf(basis?: string | null, course?: string | null): GlBasis {
  return resolveGlBasis(basis, course);
}

/**
 * Inflammation score (−2 anti … +2 pro) → 1–10 on one straight line (−2 → 1, 0 → 5.5,
 * +2 → 10), so every change in the score moves the dial by the same amount
 * (rounded to a whole point like every dial, ≈ 0.44 score per point). The dial's colour
 * comes from the band instead (`inflammationBandTone`), so it agrees with the band word
 * even where the number alone would tone differently. The band argument is accepted for
 * call-site symmetry and ignored.
 */
export function inflammationRating(score?: number | null, _band?: string | null): number | null {
  if (score == null) return null;
  const x = Math.min(2, Math.max(-2, score));
  return clampRating(1 + ((x + 2) * 9) / 4);
}

/** The dial colour of an inflammation band: anti and mildly anti good, neutral mid, pro bad. */
export function inflammationBandTone(band: string): Tone {
  if (band === 'anti-inflammatory' || band === 'mildly-anti-inflammatory') return 'good';
  if (band === 'neutral') return 'mid';
  if (band === 'mildly-pro-inflammatory' || band === 'pro-inflammatory') return 'bad';
  return 'unknown';
}

/** Nutrient balance (NRF 1–10, higher better) → 1–10 concern, inverted so denser = better. */
export function balanceRating(score?: number | null): number | null {
  if (score == null) return null;
  return clampRating(11 - score);
}

/** Nutri-Score grade → 1–10 (A → 1 … E → 10), so A/B land green, C amber, D/E red. */
export function nutriRating(grade?: string | null): number | null {
  if (!grade) return null;
  const idx = nutriGrades.indexOf(grade as (typeof nutriGrades)[number]);
  return idx < 0 ? null : clampRating(1 + idx * 2.25);
}

export function inflammationLabel(band?: string | null): string {
  if (!band) return '—';
  return band
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join('-')
    .replace('Inflammatory', 'Inflam.');
}

/** Ultra-processed (NOVA 4) energy share at/above which the processing dial reads poor —
 *  the same cut-off that makes the band 'highly-processed' (`UPF_HIGH_PCT`). */
export const UPF_ALARM_PCT = UPF_HIGH_PCT;

/**
 * Processing → 1–10 rating (1 = least processed, 10 = most), monotone in both shares: it
 * never falls as the ultra-processed (NOVA 4) share rises or as the whole-food (NOVA 1–2)
 * share falls. Each band owns one tone:
 *   poor 7–10    — 'highly-processed' (UPF share ≥ `UPF_ALARM_PCT`), positioned by how far
 *                  the UPF share runs past the cut-off; the only red reading, since NOVA
 *                  reserves "ultra-processed" for group 4 (Monteiro 2019)
 *   good 1–3     — 'minimally-processed', positioned by the non-whole-food share
 *   caution 4–6  — 'moderately-processed' (a processed, NOVA-3-heavy dish such as canned
 *                  legumes with cheese), positioned by the larger of its whole-food
 *                  shortfall and its approach to the UPF cut-off
 * An unknown UPF share counts as 0, so the band alone decides.
 */
export function processingRating(
  minimallyProcessedPct?: number | null,
  ultraProcessedPct?: number | null,
  band?: string | null,
): number | null {
  if (minimallyProcessedPct == null || !band) return null;
  const upf = Math.min(100, Math.max(0, ultraProcessedPct ?? 0));
  if (band === 'highly-processed' || upf >= UPF_ALARM_PCT) {
    return clampRating(7 + (Math.max(0, upf - UPF_ALARM_PCT) / (100 - UPF_ALARM_PCT)) * 3);
  }
  const nonWhole = Math.min(100, Math.max(0, 100 - minimallyProcessedPct));
  // The UPF share is part of the non-whole-food share, so this term already rises with it.
  if (band === 'minimally-processed') return clampRating(1 + Math.min(1, nonWhole / (100 - MINIMAL_GOOD)) * 2);
  const wholeShort = Math.min(1, Math.max(0, (MINIMAL_GOOD - minimallyProcessedPct) / MINIMAL_GOOD));
  return clampRating(4 + Math.max(wholeShort, upf / UPF_ALARM_PCT) * 2);
}

/** Display label for a processing band ('minimally-processed' → 'Minimally Processed'). */
export function processingLabel(band?: string | null): string {
  if (!band) return '—';
  return band
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/* ---- score dials (every metric → the same 1–10 dial) ----
 * Each medallion shows one 1–10 rating (see the normalization block above): the number in
 * the centre, the ring filled to `rating / 10`, and both tinted by `ratingTone`. Because 1
 * is always healthiest and 10 always least healthy, every dial reads the same way — a small
 * green ring is good, a full red ring is poor, lower is better — with no per-metric direction
 * to remember. Each dial shows only the number, its name, and a hover tooltip (`blurb`).
 */

/** Nutri-Score grades, best → worst — indexed to map a grade to its 1–10 rating. */
export const nutriGrades = ['A', 'B', 'C', 'D', 'E'] as const;

/** Tone → Tailwind text color (ring arc, accents). Shared so the three renderers
 *  can't drift; the literal class strings keep them in Tailwind's content scan. */
export const toneText: Record<Tone, string> = {
  good: 'text-band-good',
  mid: 'text-band-mid',
  bad: 'text-band-bad',
  unknown: 'text-line-strong',
};
/** Tone → Tailwind background color (grade cell, status dot). */
export const toneBg: Record<Tone, string> = {
  good: 'bg-band-good',
  mid: 'bg-band-mid',
  bad: 'bg-band-bad',
  unknown: 'bg-line-strong',
};

/** Horizontal anchor for a score dial's hover tooltip. */
export type TooltipAlign = 'left' | 'center' | 'right';
/** Tooltip anchor → Tailwind position class. Shared so the Astro dial and its React
 *  mirror can't drift (same pattern as `toneText`/`toneBg`). In a 2-column grid the
 *  left/right columns anchor to their outer edge so the tooltip grows inward and can't
 *  overflow the viewport; anything else stays centred. */
export function tipAlignClass(align: TooltipAlign): string {
  return align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2';
}

export interface ScoreDial {
  key: 'gi' | 'gl' | 'nutri' | 'balance' | 'inflam' | 'processing';
  label: string;
  /** One-line explanation of what the score measures, shown as a hover/focus tooltip. */
  blurb: string;
  /** Short native-value line under the label ("≈ 55, estimated"); absent when the score is. */
  caption?: string;
  /** The 1–10 rating as a string ("1" … "10"), or "—" when the score is absent. */
  value: string;
  /** Whether this score has a real value; when false, `value` is the "—" placeholder.
   *  The compact strip filters on this so it never carries a dangling "GI —" chip. */
  present: boolean;
  tone: Tone;
  /** Ring fill 0..1 = `rating / 10`; 0 when the score is absent. */
  fill: number;
}

/** Minimal structural shape shared by the collection entry and the authoring draft. */
type NutritionLike =
  | {
      perServing?: { availableCarb_g?: number | null } | null;
      glycemic?: {
        gi?: number | null;
        gl?: number | null;
        giBand?: string | null;
        glBand?: string | null;
        glBasis?: string | null;
        measuredGiPct?: number | null;
      } | null;
      nutriScore?: { grade?: string | null; coverage?: number | null } | null;
      inflammation?: { score?: number | null; band?: string | null } | null;
      balance?: { score?: number | null; band?: string | null } | null;
      processing?: {
        minimallyProcessedPct?: number | null;
        ultraProcessedPct?: number | null;
        band?: string | null;
      } | null;
    }
  | null
  | undefined;

/** Inflammation band in caption prose ('mildly-anti-inflammatory' → 'Mildly anti-inflammatory'). */
function inflammationCaptionBand(band: string): string {
  const words = band.replace(/^mildly-/, 'mildly ');
  return words[0].toUpperCase() + words.slice(1);
}

/** Nutri-Score data coverage below which the dial carries a "low data" note. */
export const NUTRI_LOW_DATA_COVERAGE = 0.9;

/** GI display value: an estimate, so rounded to the nearest 5 (no false precision). */
export function giEstimateLabel(gi: number): string {
  return `≈ ${Math.round(gi / 5) * 5}, estimated`;
}

/**
 * Build the six score dials from a nutrition block — the single source of the
 * rating/tone/fill/caption logic shared by the Astro detail page, the React edit
 * preview, and the authoring panel (so the three renderers never drift). Every dial is
 * the same shape: `value` is the metric's 1–10 rating, `fill` is `rating / 10`, `tone`
 * is `ratingTone(rating)`, and `caption` is a short native-value line. `course` resolves
 * the GL basis when the stored block carries none (`glBasisOf`).
 */
export function buildScoreDials(nutrition: NutritionLike, course?: string | null): ScoreDial[] {
  const gly = nutrition?.glycemic ?? undefined;
  const nutri = nutrition?.nutriScore ?? undefined;
  const inflam = nutrition?.inflammation ?? undefined;
  const bal = nutrition?.balance ?? undefined;
  const proc = nutrition?.processing ?? undefined;
  const grade = nutri?.grade ?? null;
  const carbs = nutrition?.perServing?.availableCarb_g ?? null;

  const gi = giRating(gly?.gi);
  const glBasis = glBasisOf(gly?.glBasis, course);
  const gl = glRating(gly?.gl, glBasis);
  const nu = nutriRating(grade);
  const ba = balanceRating(bal?.score);
  const inf = inflammationRating(inflam?.score, inflam?.band);
  const pr = processingRating(proc?.minimallyProcessedPct, proc?.ultraProcessedPct, proc?.band);

  const dial = (rating: number | null, caption?: string) => ({
    value: rating != null ? String(rating) : '—',
    present: rating != null,
    tone: ratingTone(rating),
    fill: rating != null ? rating / 10 : 0,
    ...(rating != null && caption ? { caption } : {}),
  });

  const measured = gly?.measuredGiPct;
  const lowData = nutri?.coverage != null && nutri.coverage < NUTRI_LOW_DATA_COVERAGE;
  const inflamBand = inflam?.band ?? (inflam?.score != null ? inflammationBandOf(inflam.score) : null);

  return [
    {
      key: 'gi',
      label: 'Glycemic Index',
      blurb:
        'Estimated glycemic index of the dish (native 0–100, glucose = 100): its carbohydrates’ published values, carb-weighted, then lowered for the protein eaten alongside, which blunts the glucose rise. Shown as 1 (best) to 10 — lower is better.' +
        (measured != null
          ? ` ${measured}% of the carbohydrate has a measured GI; the rest is estimated from similar foods.`
          : ' An estimate.'),
      ...dial(gi, gly?.gi != null ? giEstimateLabel(gly.gi) : undefined),
    },
    {
      key: 'gl',
      label: 'Glycemic Load',
      blurb:
        'Glycemic load of one serving: the estimated GI × the serving’s available carbohydrate ÷ 100 — the portion’s total blood-glucose impact, not just its speed.' +
        (carbs != null ? ` This serving carries ${Math.round(carbs)} g of available carbohydrate.` : '') +
        (glBasis === 'meal'
          ? ' Banded for a whole meal (low under 20, medium 20–39, high 40+), since a main course, soup, salad or breakfast carries several foods’ worth of carbohydrate.'
          : ' Banded as a single portion (low 10 or less, medium 11–19, high 20+), the classic cut-offs for one food, side, snack, dessert or drink.') +
        ' Shown as 1 (best) to 10 — lower is better. An estimate.',
      ...dial(gl, gly?.gl != null ? `${gly.gl} per serving · ${glBasis} bands` : undefined),
    },
    {
      key: 'nutri',
      label: 'Nutrition Score',
      blurb:
        'Nutri-Score 2023 (native A best … E worst): fibre, protein and fruit/vegetables/legumes weighed against energy, sugar, saturated fat and salt. Mapped to 1 (grade A) … 10 (grade E) — lower is better. Built for packaged products, applied to the dish as an estimate.' +
        (lowData
          ? ` Low data: only ${Math.round(nutri!.coverage! * 100)}% of the dish’s weight reports every scored nutrient, so the grade is less certain.`
          : ''),
      ...dial(nu, grade ? `Grade ${grade}${lowData ? ' · low data' : ''}` : undefined),
    },
    {
      key: 'balance',
      label: 'Nutrient Balance',
      blurb:
        'Nutrient density (native NRF9.3, 1–10, where more is denser): nine nutrients to encourage — protein, fibre, vitamins, minerals — minus three to limit (saturated fat, sugar, sodium), per 100 kcal. Inverted here to 1 (best) … 10 so every dial reads the same way — lower is better. An estimate.',
      ...dial(ba, bal?.band ? `${bal.band[0].toUpperCase()}${bal.band.slice(1)} nutrient density` : undefined),
    },
    {
      key: 'inflam',
      label: 'Inflammation',
      blurb:
        'Inflammatory potential (our own estimate, native −2 anti to +2 pro): the whole dish’s cooked composition per 100 kcal — fibre, vitamins C and E, magnesium, omega-3, carotenoids and flavonoids against free sugars, saturated and industrial trans fat and sodium — each weighted by the strength of the trial evidence for it. Zero means the protective nutrients of an average diet with none of the limited ones; an average diet itself reads mildly pro. “Anti-inflammatory” means clearly better than that reference, never a clinical claim. Shown as 1 (most anti-inflammatory) to 10 — lower is better. An estimate, not a clinical measure.',
      ...dial(inf, inflamBand ? inflammationCaptionBand(inflamBand) : undefined),
      // The ring sits on the straight-line rating, but its colour is the band's, so it
      // always agrees with the band word beneath it.
      ...(inf != null && inflamBand && inflammationBandTone(inflamBand) !== 'unknown' ? { tone: inflammationBandTone(inflamBand) } : {}),
    },
    {
      key: 'processing',
      label: 'Processing',
      blurb:
        'How processed the dish is (NOVA), by share of its energy: “minimally processed” when whole foods and basic culinary ingredients (groups 1–2) supply at least 70 %, “highly processed” only when ultra-processed foods (group 4) supply 30 % or more, and “moderately processed” otherwise — including dishes built on processed foods such as canned beans, cheese or bread (group 3). Only a highly-processed dish reads 7–10. Shown as 1 (least processed) to 10 — lower is better. A rough estimate — processing is judged by food type and the ingredient wording.',
      ...dial(pr, proc?.band ? processingLabel(proc.band) : undefined),
    },
  ];
}

/** Whether a nutrition block carries any of the scored figures. Gates the detail-page
 *  rail, whose lg grid shows all six slots (an absent one as an "—" ring). */
export function hasAnyScore(nutrition: NutritionLike): boolean {
  return !!(
    nutrition?.glycemic ||
    nutrition?.nutriScore ||
    nutrition?.inflammation ||
    nutrition?.balance ||
    nutrition?.processing
  );
}

/** Whether at least one score has a real value. Gates the compact card strip, which
 *  drops absent scores — so the strip is shown only when it will have a chip to render
 *  (a block present but all-null would leave `hasAnyScore` true yet the strip empty). */
export function hasDisplayableScore(nutrition: NutritionLike): boolean {
  return buildScoreDials(nutrition).some((d) => d.present);
}

/* ---- collection helpers ---- */

/** Published recipes (drafts hidden in production), newest first. */
export function visibleRecipes(all: Recipe[]): Recipe[] {
  const isDev = import.meta.env.DEV;
  return all
    .filter((r) => isDev || !r.data.draft)
    .sort((a, b) => {
      const da = a.data.updatedAt ?? a.data.createdAt ?? new Date(0);
      const db = b.data.updatedAt ?? b.data.createdAt ?? new Date(0);
      return db.getTime() - da.getTime();
    });
}

function tally(all: Recipe[], pick: (r: Recipe) => string[]): [string, number][] {
  // Derive counts from slug-deduped groups so cloud chips match the generated
  // term pages exactly — e.g. 'Vegetarian' and 'vegetarian' collapse to one
  // chip linking to one page, rather than two chips pointing at the same URL.
  return groupByTerm(all, pick)
    .map(({ term, recipes }) => [term, recipes.length] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const allCategories = (all: Recipe[]) =>
  tally(all, (r) => (r.data.category ? [r.data.category] : []));
export const allLists = (all: Recipe[]) => tally(all, (r) => r.data.lists);

/** Group recipes by a (possibly multi-valued) term for term-page generation. */
export function groupByTerm(
  all: Recipe[],
  pick: (r: Recipe) => string[],
): { slug: string; term: string; recipes: Recipe[] }[] {
  const map = new Map<string, { slug: string; term: string; recipes: Recipe[] }>();
  for (const r of all) {
    for (const term of pick(r)) {
      const slug = slugifyTerm(term);
      if (!map.has(slug)) map.set(slug, { slug, term, recipes: [] });
      map.get(slug)!.recipes.push(r);
    }
  }
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}

/** Slugify a tag/category/list value for use in a URL segment. */
export const slugifyTerm = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/**
 * Extract numbered method steps from raw markdown body as step text, for
 * schema.org recipeInstructions. Matches ONLY ordered-list items (`1.`, `2)`)
 * so unordered bullets under a "## Notes" / "## Tips" section are not emitted
 * as cooking steps. Falls back to [] when there is no numbered list.
 */
export function extractSteps(body?: string): string[] {
  if (!body) return [];
  const steps: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*\d+[.)]\s+(.*\S)\s*$/.exec(line);
    if (m) steps.push(m[1].replace(/\*\*/g, '').replace(/`/g, '').trim());
  }
  return steps;
}
