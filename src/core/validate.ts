/**
 * Ingredient-data validation gate: flags stored ingredient lines whose food match,
 * weight or state is implausible, and recipes whose per-serving numbers are out of
 * range, before they ship. Shared by the CLI report (scripts/validate-recipes.mjs),
 * the all-recipes test (validate.recipes.test.ts) and the /add authoring island.
 *
 * Pure and isomorphic: the food lookup is passed in, nothing is imported from the
 * datasets, so it runs in the browser, in Node and under Vitest unchanged.
 *
 * Rules (each issue carries a stable `code`):
 *   - identity: the matched food shares no identity token with the item (after plural
 *     folding + synonyms), or hits a known false friend (ice → ice-cream cones,
 *     pumpkin → pumpkin leaves, walnut oil → walnuts, …);
 *   - state: the item says cooked/canned/drained but the food is raw/dry (or the item
 *     says raw/dry/uncooked and the food is cooked), unless the line carries the
 *     "(≈ N g uncooked)" note that records the raw dry-matter conversion;
 *   - grams per unit: tsp/tbsp/clove/cup/pinch and counted items weighed outside a
 *     plausible range (warning), or beyond 3× that range (error);
 *   - per serving: kcal outside the course's range, sodium above 2,300 mg, one
 *     ingredient dominating the recipe's energy or available carbohydrate, and a
 *     disagreement with the source's own published kcal per serving;
 *   - exclusions: water / ice / soda-water lines must be excluded or matched to plain
 *     water; a counted line without a food or a weight is an error;
 *   - duplicate identical lines.
 *
 * A reviewed proxy match (a stand-in food chosen on purpose, e.g. leeks for ramsons)
 * carries `proxyOk: true`, which silences the identity and state checks for that line.
 */
import type { FoodRecord } from './match';
import { computeMacros, energyKcalOf, availableCarbOf } from './nutrition';
import { storedScoringFields, toResolved } from './recipeScore';
import { normalizeCourse, type CourseKey } from './course';
import { canonicalUnit } from './units';
import type { MacroComputation } from './nutrition';
import type { ResolvedIngredient } from './types';

export type IssueCode =
  | 'UNKNOWN_FOOD'
  | 'MISSING_MATCH'
  | 'MISSING_GRAMS'
  | 'WATER_MATCH'
  | 'FALSE_FRIEND'
  | 'IDENTITY_MISMATCH'
  | 'STATE_MISMATCH'
  | 'GRAMS_PER_UNIT'
  | 'KCAL_PER_SERVING'
  | 'SODIUM_PER_SERVING'
  | 'DOMINANT_ENERGY'
  | 'DOMINANT_CARB'
  | 'SOURCE_KCAL'
  | 'DUPLICATE_LINE';

export interface Issue {
  code: IssueCode;
  /** Index into the recipe's `ingredients` array, for line-level issues. */
  ingredientIndex?: number;
  message: string;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

/** The subset of a stored ingredient the validator reads. */
export interface ValidatableIngredient {
  raw: string;
  group?: string;
  quantity?: number | null;
  quantity2?: number | null;
  unit?: string | null;
  item?: string;
  note?: string;
  grams?: number | null;
  fdcId?: number | null;
  excludeFromNutrition?: boolean;
  cooking?: string | null;
  proxyOk?: boolean;
}

/** The subset of a stored recipe the validator reads. */
export interface ValidatableRecipe {
  servings?: number;
  course?: string;
  source?: { name?: string; url?: string; kcalPerServing?: number } | null;
  ingredients?: ValidatableIngredient[];
}

export interface ValidateOptions {
  /** Issue codes to skip entirely. */
  skip?: IssueCode[];
  /**
   * Macros the caller already computed for these ingredients (the /add island), so the
   * gate does not resolve and sum them a second time. `resolved` must be index-aligned
   * with `recipe.ingredients` (one entry per stored line, the same cooked view
   * recipeScore.toResolved produces).
   */
  precomputed?: { resolved: ResolvedIngredient[]; macro: MacroComputation };
}

/* ---------------------------------------------------------------- tokens --- */

/** Words that carry no food identity (amounts, sizes, prep, state, colours). */
const STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with', 'without', 'for', 'to', 'in', 'on', 'into', 'as', 'at', 'about', 'plus',
  'some', 'few', 'little', 'more', 'extra', 'optional', 'taste', 'needed', 'serve', 'serving', 'garnish', 'approx',
  'fresh', 'freshly', 'organic', 'large', 'small', 'medium', 'big', 'baby', 'young', 'ripe', 'long', 'thin', 'thick',
  'finely', 'roughly', 'coarsely', 'chopped', 'sliced', 'diced', 'minced', 'grated', 'crushed', 'peeled', 'halved',
  'quartered', 'shredded', 'torn', 'cubed', 'trimmed', 'rinsed', 'washed', 'pitted', 'deseeded', 'seeded', 'whole',
  'handful', 'pinch', 'dash', 'sprig', 'slice', 'piece', 'bunch', 'leaf', 'leave', 'stalk', 'stick', 'head', 'cube',
  'raw', 'cooked', 'boiled', 'canned', 'tinned', 'drained', 'leftover', 'dried', 'dry', 'frozen', 'ground', 'uncooked',
  'precooked', 'pre', 'hot', 'cold', 'warm', 'lukewarm', 'boiling', 'room', 'temperature', 'chilled',
  'red', 'green', 'yellow', 'white', 'black', 'purple', 'brown', 'golden',
  'sweet', 'sea', 'plain', 'natural', 'regular', 'mixed', 'light', 'low', 'fat', 'reduced', 'salted', 'unsalted',
  'g', 'kg', 'ml', 'l', 'cm', 'tsp', 'tbsp', 'cup', 'oz', 'lb',
  // Generic USDA description words.
  'spice', 'beverage', 'product', 'prepared', 'ns', 'nfs', 'ready', 'eat', 'commercial', 'include', 'type', 'form',
  'style', 'made', 'from', 'added', 'solid', 'liquid', 'enriched', 'unenriched', 'generic', 'mature', 'variety',
  'all', 'purpose', 'pack', 'heat', 'by', 'not', 'other', 'than', 'usda', 'unprepared', 'mix',
]);

/** Spelling / regional variants folded onto one canonical token (both sides). */
const CANON: Record<string, string> = {
  aubergine: 'eggplant', brinjal: 'eggplant',
  courgette: 'zucchini',
  rocket: 'arugula', roquette: 'arugula',
  coriander: 'cilantro',
  prawn: 'shrimp',
  scallion: 'onion', shallot: 'onion',
  garbanzo: 'chickpea',
  capsicum: 'pepper', kapia: 'pepper', paprika: 'pepper',
  chilli: 'pepper', chili: 'pepper', chile: 'pepper', chily: 'pepper', chilly: 'pepper', jalapeno: 'pepper', cayenne: 'pepper',
  yoghurt: 'yogurt', yogourt: 'yogurt', skyr: 'yogurt',
  ramson: 'leek',
  zest: 'peel', rind: 'peel',
  beetroot: 'beet',
  cornflour: 'cornstarch',
  maize: 'corn', sweetcorn: 'corn', polenta: 'corn', cornmeal: 'corn',
  choy: 'choi', bok: 'pak', pakchoi: 'choi',
  swede: 'rutabaga',
  mangetout: 'pea',
  rapeseed: 'canola',
  groundnut: 'peanut',
  oatmeal: 'oat',
  soya: 'soy', tamari: 'soy', shoyu: 'soy',
  stock: 'broth', bouillon: 'broth',
  parmigiano: 'parmesan', grana: 'parmesan', reggiano: 'parmesan',
  pecorino: 'romano',
  gelatine: 'gelatin',
  cacao: 'cocoa',
  ghee: 'butter',
  bulghur: 'bulgur',
  passata: 'tomato',
  kombu: 'kelp',
  nori: 'laver',
  linseed: 'flaxseed', flax: 'flaxseed',
  ketchup: 'catsup',
  espresso: 'coffee',
  icing: 'sugar', caster: 'sugar',
};

/** Item words that also stand for a broader food named in USDA descriptions. */
const EXPAND: Record<string, string[]> = {
  spaghetti: ['pasta'], penne: ['pasta'], fusilli: ['pasta'], linguine: ['pasta'], tagliatelle: ['pasta'],
  orecchiette: ['pasta'], macaroni: ['pasta'], lasagne: ['pasta'], lasagna: ['pasta'], farfalle: ['pasta'],
  rigatoni: ['pasta'], orzo: ['pasta'], fettuccine: ['pasta'], conchiglie: ['pasta'], gnocchi: ['potato'],
  baguette: ['bread'], ciabatta: ['bread'], sourdough: ['bread'], toast: ['bread'], bun: ['bread'], roll: ['bread'],
  cannellini: ['bean'], borlotti: ['bean'], edamame: ['soybean'],
  feta: ['cheese'], halloumi: ['cheese'], mascarpone: ['cheese'], burrata: ['mozzarella', 'cheese'], quark: ['cheese'],
  turo: ['cottage', 'cheese'], ricotta: ['cheese'], gouda: ['cheese'], cheddar: ['cheese'], emmental: ['swiss', 'cheese'],
  creme: ['cream'], fraiche: ['cream'],
  gorgonzola: ['blue', 'cheese'], roquefort: ['blue', 'cheese'], stilton: ['blue', 'cheese'],
  salad: ['lettuce'],
  bacon: ['pork'], lardon: ['pork', 'bacon'], prosciutto: ['ham'], pancetta: ['pork', 'bacon'], chorizo: ['sausage'],
  basmati: ['rice'], jasmine: ['rice'], arborio: ['rice'], risotto: ['rice'],
  porridge: ['oat'], muesli: ['oat'],
  stevia: ['sweetener'], erythritol: ['sweetener'],
  lemongrass: ['lemon'],
  spearmint: ['mint'], peppermint: ['mint'],
  scampi: ['shrimp'],
  tortilla: ['bread'], wrap: ['tortilla'],
  wholemeal: ['wheat'], spelt: ['wheat'], semolina: ['wheat'], couscous: ['wheat'],
};

/** Fold a word to a plural-insensitive stem. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(ch|sh|ss|x|z|o)es$/.test(w)) return w.slice(0, -2);
  if (/[^su]s$/.test(w)) return w.slice(0, -1);
  return w;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bwild garlic\b/g, 'ramsons')
    .replace(/\bbear'?s garlic\b/g, 'ramsons')
    .replace(/\bspring onions?\b|\bgreen onions?\b/g, 'scallion')
    .replace(/\bsweet ?corn\b/g, 'corn')
    .replace(/\bceler(y|iac) root\b/g, 'celeriac')
    .replace(/\bwithout salt\b|\bwith salt\b|\bno salt added\b|\blow salt\b/g, ' ');
}

/** Identity tokens of a text: stemmed, canonicalised, stop words removed. */
export function identityTokens(text: string, expand = false): Set<string> {
  const out = new Set<string>();
  for (const word of normalize(text).split(/[^a-z]+/)) {
    if (!word) continue;
    const s = stem(word);
    const c = CANON[s] ?? CANON[word] ?? s;
    if (STOP.has(c) || STOP.has(word) || c.length < 2) continue;
    out.add(c);
    if (expand) for (const e of EXPAND[c] ?? EXPAND[word] ?? []) out.add(e);
  }
  return out;
}

/** Whether two token sets share an identity token (or a ≥4-letter token embeds in another). */
export function sharesIdentity(item: Set<string>, food: Set<string>): boolean {
  for (const a of item) {
    if (food.has(a)) return true;
    for (const b of food) {
      if (a.length >= 4 && b.includes(a)) return true;
      if (b.length >= 4 && a.includes(b)) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------- false friends --- */

const has = (re: RegExp, s: string) => re.test(s);

/** Plain drinking water (bottled / tap) — the only food a water line may match. */
export function isPlainWater(description: string): boolean {
  return /^(water, (bottled|tap|municipal|well)|beverages, water\b)/i.test(description);
}

/** Water / ice / soda-water lines (no other food word). */
export function isWaterLike(item: string): boolean {
  const words = normalize(item).replace(/\([^)]*\)/g, ' ').split(/[^a-z]+/).filter(Boolean);
  if (!words.some((w) => /^(water|ice|soda)$/.test(w))) return false;
  const ok = /^(water|ice|soda|cube|cubes|sparkling|mineral|carbonated|still|tap|filtered|crushed|cold|hot|warm|lukewarm|boiling|chilled|iced|a|some|little|of|for|the|to|plus|extra|more|about|serving|serve|or|and|very|room|temperature|few|handful|cup|cups)$/;
  return words.every((w) => ok.test(w));
}

/** Plant parts that make a food a different ingredient from the plant's main food. */
const PART_RE = /\b(leaves|leaf|seeds?|kernels?|flowers?|blossoms?|greens|shoots?|stems?|tops|sprouts?|peel|vine)\b/;
/** The same parts as named on the item side (zest / rind are peel). */
const ITEM_PART_RE = /\b(leaves|leaf|seeds?|kernels?|flowers?|blossoms?|greens|shoots?|stems?|tops|sprouts?|peel|zest|rind|vine)\b/;
/** Items whose usual food *is* a seed / leaf form, so a part word on the food is expected. */
const PART_EXEMPT =
  /\b(cumin|caraway|sesame|chia|flax|flaxseed|linseed|sunflower|poppy|hemp|fenugreek|nigella|anise|aniseed|fennel seed|mustard seed|cilantro|coriander|parsley|mint|basil|dill|sage|thyme|oregano|rosemary|tarragon|chive|bay|curry|kaffir|lime leaf|lime leaves|grape|vine|tea|lettuce|spinach|kale|chard|cabbage|bean sprout|alfalfa|mung|brussels|celery seed|cardamom|pomegranate|quinoa|buckwheat|amaranth|psyllium|pepita|lotus|cress|moringa|nettle|sorrel|purslane|perilla|shiso|turnip green|collard|beet green|dandelion|watercress|pea shoot|microgreen|herb|salad|endive|radicchio|frisee|mache|arugula|rocket|bok|choi|choy|pak|edamame|soybean|stevia|sweetener|erythritol|tahini|coconut|nut|almond|pistachio|cashew|walnut|pecan|hazelnut|peanut|macadamia|pine)s?\b/;

/** A specific false-friend match: the food is a different ingredient sharing a word. */
export function falseFriend(item: string, description: string): string | null {
  const i = normalize(item);
  const d = normalize(description);
  if (has(/\bice\b/, i) && !has(/\bice cream\b/, i) && has(/\bice cream\b|\bcones?\b/, d)) return 'ice matched to an ice-cream food';
  if (has(/\bwater\b/, i) && !has(/watercress|chestnut|convolvulus|spinach/, i) && has(/convolvulus|watercress|chestnut|water spinach/, d))
    return 'water matched to a water-named vegetable';
  if (has(/\bsoda\b/, i) && !has(/\bbread\b|\bcracker/, i) && has(/\bbread\b|\bcracker|saltine/, d)) return 'soda matched to a soda bread / cracker';
  // oil vs the nut/seed/fruit it is pressed from
  const itemOil = has(/\boils?\b/, i);
  const foodOil = has(/\boils?\b|\bfat\b|shortening|\blard\b|\bmargarine/, d);
  if (itemOil && !foodOil && !has(/\bin oil\b|packed in oil|\boil[- ]packed/, i)) return 'oil matched to a non-oil food';
  if (!itemOil && has(/^oils?\b|^oil,/, d) && !has(/\bdressing|\bspray|\bmayo/, i)) return 'non-oil item matched to an oil';
  // vinegar vs wine
  if (has(/vinegar/, i) && !has(/vinegar/, d)) return 'vinegar matched to a non-vinegar food';
  if (!has(/vinegar/, i) && has(/\bwine\b/, i) && has(/vinegar/, d)) return 'wine matched to a vinegar';
  // peel/zest vs juice
  const itemPeel = has(/\b(peel|zest|rind)\b/, i);
  if (itemPeel && !has(/\bjuice\b/, i) && has(/\bjuice\b/, d) && !has(/\bpeel\b/, d)) return 'peel/zest matched to a juice';
  if (has(/\bjuice\b/, i) && !itemPeel && has(/\bpeel\b/, d)) return 'juice matched to a peel';
  // mustard (condiment / seeds) vs mustard greens
  if (has(/\bmustard\b/, i) && !has(/\bgreens?\b|\bleaves\b/, i) && has(/mustard greens|mustard spinach/, d)) return 'mustard matched to mustard greens';
  if (has(/\bgreens\b/, i) && !has(/mustard/, i) && has(/\bmustard\b/, d) && !has(/greens/, d)) return 'greens matched to a mustard';
  // whole food vs a plant part of it (pumpkin → pumpkin leaves / seeds). Descriptive
  // qualifiers ("mature seeds" of a pulse, "with peel", "(includes tops and bulb)") name
  // the whole food, not a part, so they are removed first.
  const dPart = d
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bmature seeds\b|\bwith(out)? (peel|skin|seeds)\b|\bseedless\b|\bleaf[- ]portion\b|\bgreen leaf\b|\bred leaf\b/g, ' ');
  const part = PART_RE.exec(dPart);
  if (part && !ITEM_PART_RE.test(i) && !PART_EXEMPT.test(i) && !PART_EXEMPT.test(dPart.split(',')[0])) {
    return `item matched to the ${part[1]} of the plant`;
  }
  if (has(/\b(seeds?|kernels?)\b|[a-z]seeds?\b/, i) && !itemOil && !has(/pomegranate/, i) && !has(/seeds?\b|\bkernels?\b|\bnuts?\b|\bflax/, d)) {
    return 'seeds matched to a non-seed food';
  }
  return null;
}

/* ------------------------------------------------------------------ state --- */

/** Matches the "(≈ N g uncooked)" note that records a cooked staple's raw dry-matter weight. */
const UNCOOKED_NOTE = /≈\s*[\d.,]+\s*(g|kg)\s+(uncooked|dry|raw)/i;
const ITEM_COOKED = /\b(cooked|boiled|canned|tinned|drained|leftover|pre-?cooked)\b/;
const ITEM_RAW = /\b(uncooked|raw|dry)\b/;
const FOOD_RAW = /\b(raw|dry|uncooked)\b/;
const FOOD_COOKED = /\b(cooked|boiled|canned|drained|steamed|roasted|baked|stewed|braised|grilled|broiled|fried|microwaved)\b/;
/** Foods whose raw form is what "canned"/"drained" names in practice (coconut milk, oil-packed items). */
const STATE_EXEMPT = /\bcoconut milk\b|\bcoconut cream\b|\bin oil\b|\bpaste\b|\bpuree\b|\bsauce\b|\bjuice\b|\bmilk\b|\bnuts?\b|\bseeds?\b|\bwine\b|\bdry (white|red)?\s*wine|\bdry sherry|\bdry vermouth|\bwhite wine|\bred wine|\byeast\b|\bmustard\b|\brub\b|\bseasoning\b|\bspice|\bherbs?\b|\bchil(l)?i|\bpepper\b|\bonion\b|\bgarlic\b|\bginger\b|\bbread\b|\btoast/;

/** State conflict between the item text and the matched food, or null. */
export function stateConflict(ing: ValidatableIngredient, description: string): string | null {
  // A counted line (no unit, or a size word) weighs the raw piece whatever happens to it
  // later ("8 eggs, boiled"), so only a weighed line's note describes the weighed state.
  const weighed = !!ing.unit && !COUNT_UNIT.test(ing.unit);
  const noteText = weighed ? (ing.note ?? '').replace(UNCOOKED_NOTE, '') : '';
  const text = normalize(`${ing.item ?? ''} ${noteText}`);
  const d = normalize(description);
  if (UNCOOKED_NOTE.test(ing.raw) || UNCOOKED_NOTE.test(ing.note ?? '')) return null;
  if (STATE_EXEMPT.test(text)) return null;
  const foodRaw = FOOD_RAW.test(d) && !FOOD_COOKED.test(d);
  const foodCooked = FOOD_COOKED.test(d) && !FOOD_RAW.test(d);
  const itemCooked = ITEM_COOKED.exec(text);
  const itemRaw = ITEM_RAW.exec(text);
  if (itemCooked && itemRaw) return null; // "raw or pre-cooked": either state is fine
  if (itemCooked && foodRaw) {
    return `item says "${itemCooked[1]}" but the food is raw/dry — weigh it as the raw equivalent and add "(≈ N g uncooked)"`;
  }
  if (itemRaw && foodCooked) return `item says "${itemRaw[1]}" but the food is cooked`;
  return null;
}

/* ---------------------------------------------------------- grams per unit --- */

type Range = readonly [number, number];

/** Grams per one unit for spoon/volume/count units. */
const UNIT_RANGES: Record<string, Range> = {
  tsp: [0.5, 8],
  tbsp: [2, 25],
  pinch: [0.05, 1.5],
  clove: [2, 8],
  cup: [20, 300],
  bunch: [15, 150],
  sprig: [0.2, 5],
  handful: [5, 100],
  slice: [5, 60],
  can: [150, 850],
  stalk: [20, 120],
};

/** Canonical unit id (units.ts `canonicalUnit`) → UNIT_RANGES key, for ids that differ. */
const UNIT_KIND: Record<string, string> = {
  teaspoon: 'tsp',
  tablespoon: 'tbsp',
  tin: 'can',
};

/** Per-piece weight ranges for counted items (first match wins, so specific before general). */
const COUNT_RANGES: [RegExp, Range, string][] = [
  [/\bgarlic\b.*\bheads?\b|\bheads?\b.*\bgarlic\b|\bgarlic bulbs?\b/, [25, 60], 'garlic head'],
  [/\bgarlic\b/, [2, 8], 'garlic clove'],
  [/\bscallions?\b|\bspring onions?\b|\bgreen onions?\b/, [5, 30], 'spring onion'],
  [/\bshallots?\b/, [15, 60], 'shallot'],
  [/\bonions?\b/, [40, 250], 'onion'],
  [/\begg yolks?\b|\byolks?\b/, [12, 25], 'egg yolk'],
  [/\begg whites?\b/, [25, 40], 'egg white'],
  [/\beggs?\b/, [40, 70], 'egg'],
  [/\blemons?\b/, [50, 150], 'lemon'],
  [/\blimes?\b/, [30, 100], 'lime'],
  [/\boranges?\b/, [100, 250], 'orange'],
  [/\bcarrots?\b/, [40, 150], 'carrot'],
  [/\bsweet potato(es)?\b/, [100, 400], 'sweet potato'],
  [/\bpotato(es)?\b/, [80, 350], 'potato'],
  [/\bcherry tomato(es)?\b/, [8, 25], 'cherry tomato'],
  [/\bsun-?dried tomato(es)?\b|\bdried tomato(es)?\b/, [2, 15], 'sun-dried tomato'],
  [/\btomato(es)?\b/, [60, 250], 'tomato'],
  [/\bavocados?\b/, [100, 250], 'avocado'],
  [/\bcucumbers?\b/, [150, 450], 'cucumber'],
  [/\b(bell )?peppers?\b.*\b(bell|sweet|kapia|red|green|yellow)\b|\b(bell|sweet|kapia) peppers?\b|\bcapsicums?\b/, [80, 250], 'bell pepper'],
  [/\bjalapenos?\b/, [10, 30], 'jalapeño'],
  [/\bchil(l)?i(e)?s?\b|\bchil(l)?i peppers?\b/, [3, 45], 'chilli'],
  [/\bzucchinis?\b|\bcourgettes?\b/, [100, 350], 'zucchini'],
  [/\beggplants?\b|\baubergines?\b/, [200, 500], 'eggplant'],
  [/\bapples?\b/, [100, 250], 'apple'],
  [/\bpears?\b/, [120, 250], 'pear'],
  [/\bbananas?\b/, [80, 150], 'banana'],
  [/\bpeach(es)?\b|\bnectarines?\b/, [100, 200], 'peach'],
  [/\bdried apricots?\b/, [4, 15], 'dried apricot'],
  [/\bapricots?\b/, [25, 60], 'apricot'],
  [/\bkiwis?\b/, [50, 100], 'kiwi'],
  [/\bleeks?\b/, [80, 350], 'leek'],
  [/\bcelery stalks?\b|\bcelery sticks?\b|\bcelery ribs?\b/, [30, 70], 'celery stalk'],
  [/\bfennel bulbs?\b|\bfennel\b/, [150, 400], 'fennel bulb'],
  [/\bbeet(root)?s?\b/, [80, 250], 'beetroot'],
  [/\bradish(es)?\b/, [5, 25], 'radish'],
  [/\bkohlrabi\b/, [150, 400], 'kohlrabi'],
  [/\bbay leaf\b|\bbay leaves\b/, [0.1, 1], 'bay leaf'],
  [/\bsalmon fillets?\b|\bfish fillets?\b|\bcod fillets?\b/, [80, 250], 'fish fillet'],
  [/\bchicken breasts?\b/, [120, 300], 'chicken breast'],
  [/\bpita\b|\bpitta\b/, [40, 90], 'pita'],
  [/\bbaguettes?\b/, [100, 400], 'baguette'],
];

/** Juice yield of one counted citrus fruit, for a line matched to the juice. */
const JUICE_RANGES: Record<string, Range> = { lemon: [20, 60], lime: [10, 45], orange: [50, 130] };

/** Leafy herbs: far lighter per spoon / bunch than the general ranges. */
const HERB_RE = /\b(dill|parsley|cilantro|coriander|basil|mint|chives?|tarragon|chervil|thyme|rosemary|oregano|marjoram|sage|lovage|herbs?)\b/;
const HERB_RANGES: Record<string, Range> = { tsp: [0.1, 3], tbsp: [0.3, 8], bunch: [5, 60] };

/** Size words / "piece" that make a line a counted one. */
const COUNT_UNIT = /^(small|medium|large|piece|pieces|whole|ears?|heads?)$/i;

/**
 * UNIT_RANGES key for a stored unit, or null when it is a mass/volume unit or a size word.
 * Spoon/volume spellings resolve through units.ts `canonicalUnit` (so "T" is a tablespoon
 * and "t" a teaspoon); count words fold their plural ("cloves", "bunches").
 */
export function unitKind(unit: string | null | undefined): string | null {
  const canon = canonicalUnit(unit);
  if (!canon) return null;
  for (const form of [canon, canon.replace(/es$/, ''), canon.replace(/s$/, '')]) {
    const kind = UNIT_KIND[form] ?? form;
    if (Object.hasOwn(UNIT_RANGES, kind)) return kind;
  }
  return null;
}

const MASS_OR_VOLUME = /^(g|gram|grams|kg|mg|ml|l|litre|liter|dl|cl|oz|lb|lbs|pound|pounds|fl ?oz|cm|mm)$/i;

/** Plausible grams per one unit for a line, with a label, or null when no range applies. */
export function unitRange(ing: ValidatableIngredient, food?: FoodRecord): { range: Range; label: string } | null {
  const unit = ing.unit?.trim();
  if (unit && MASS_OR_VOLUME.test(unit)) return null;
  // A cooked staple stored as its raw dry-matter weight is not a per-unit weight.
  if (UNCOOKED_NOTE.test(ing.raw) || UNCOOKED_NOTE.test(ing.note ?? '')) return null;
  const item = normalize(`${ing.item ?? ''}`);
  const kind = unitKind(unit);
  if (kind === 'clove' && !/\bgarlic\b/.test(item)) return null; // whole spice cloves
  if (kind) {
    if (HERB_RANGES[kind] && HERB_RE.test(item)) return { range: HERB_RANGES[kind], label: `${kind} of herbs` };
    return { range: UNIT_RANGES[kind], label: kind };
  }
  if (unit && /^heads?$/i.test(unit) && /\bgarlic\b/.test(item)) return { range: [25, 60], label: 'garlic head' };
  if (/^handfuls?\b/.test(item)) return { range: UNIT_RANGES.handful, label: 'handful' };
  if (/\bslices?\b/.test(item)) {
    return /\bbread\b|\bsourdough\b|\btoast\b|\bbaguette\b|\bciabatta\b|\bbrioche\b/.test(item)
      ? { range: [10, 60], label: 'bread slice' }
      : null;
  }
  if (unit && !COUNT_UNIT.test(unit)) return null;
  // A part of the counted fruit/vegetable (zest, juice, leaves) is not the whole piece.
  if (/\b(juice|zest|peel|rind|leaf|leaves|seeds?)\b/.test(item)) return null;
  // A packaged product named after its main ingredient is not one piece of it.
  if (/\b(jars?|packs?|packets?|packages?|bottles?|cartons?|bags?|box(es)?|spread|sauce|paste|pesto)\b/.test(item)) return null;
  // The counted food is the one named first ("red onion or shallot" → onion).
  let best: { at: number; range: Range; label: string } | null = null;
  for (const [re, range, label] of COUNT_RANGES) {
    const m = re.exec(item);
    if (m && (!best || m.index < best.at)) best = { at: m.index, range, label };
  }
  if (!best) return null;
  if (JUICE_RANGES[best.label] && food && /\bjuice\b/i.test(food.description)) {
    return { range: JUICE_RANGES[best.label], label: `${best.label} (juice)` };
  }
  return { range: best.range, label: best.label };
}

/* ------------------------------------------------------------------ course --- */

/** Plausible kcal per serving by course (course.ts `normalizeCourse`). */
const COURSE_KCAL: Record<CourseKey, Range> = {
  main: [150, 1200],
  soup: [150, 1200],
  salad: [150, 1200],
  breakfast: [150, 1200],
  appetizer: [40, 800],
  side: [40, 800],
  snack: [40, 800],
  dessert: [40, 800],
  drink: [0, 400],
  sauce: [5, 400],
  condiment: [5, 400],
};
const DEFAULT_KCAL: Range = [40, 1200];

/* ------------------------------------------------------- carb dominance --- */

/**
 * Identity tokens (after `identityTokens` stemming, synonyms and pasta/bread expansion) of
 * the starchy staples that are expected to carry most of a dish's carbohydrate: grains,
 * flours, pastry, pasta, rice, bread, potatoes and other starchy roots, chestnuts, tapioca,
 * legumes, oats, noodles, couscous, polenta.
 */
const STARCHY_STAPLE = new Set([
  'grain', 'wheat', 'flour', 'pasta', 'noodle', 'rice', 'risotto', 'bread', 'bagel', 'pita', 'tortilla',
  'potato', 'gnocchi', 'yam', 'cassava', 'yuca', 'taro', 'plantain', 'parsnip', 'squash', 'pumpkin',
  'bean', 'lentil', 'chickpea', 'pea', 'legume', 'dal', 'dhal', 'hummu', 'hummus',
  'oat', 'granola', 'couscous', 'corn', 'quinoa', 'bulgur', 'barley', 'buckwheat', 'millet', 'farro',
  'freekeh', 'sorghum', 'amaranth', 'teff', 'rye', 'semolina', 'csipetke', 'dumpling', 'orzo',
  'chestnut', 'tapioca', 'pastry', 'dough',
]);

/** Sugars, sweets and drinks: an unexpected source of most of a dish's carbohydrate. */
const SWEET_CARB = /\b(sugar|honey|syrup|molasses|agave|treacle|jam|marmalade|jelly|chocolate|candy|candied|caramel|cookies?|cakes?|biscuits?|sweets|juice|nectar|soda|cola|lemonade|liqueur)\b/;

/** Dried fruit (concentrated sugar), named in the item or the matched food. */
const DRIED_FRUIT = /\b(dried|dehydrated|raisins?|sultanas?|currants?|prunes?|dates?|candied)\b/;

/** Courses where fruit, including dried fruit, is the expected main carbohydrate. */
const SWEET_COURSES: ReadonlySet<CourseKey> = new Set(['dessert', 'snack', 'breakfast', 'drink', 'condiment']);

/**
 * Whether an ingredient carrying most of the recipe's available carbohydrate is the
 * expected carbohydrate base of the dish, so DOMINANT_CARB stays silent: a starchy staple
 * in any dish, fresh fruit outside a main course / soup / side, and dried fruit in a sweet
 * course. Sugars, syrups, sweets and juices are never expected (the warning still fires),
 * nor is dried fruit dominating a savoury dish.
 */
export function isExpectedCarbBase(item: string, food: FoodRecord | undefined, course: CourseKey | null): boolean {
  const description = food?.description ?? '';
  const text = normalize(`${item} ${description}`).replace(/\bsugar snap\b/g, 'snap');
  if (SWEET_CARB.test(text)) return false;
  const tokens = new Set([...identityTokens(item, true), ...identityTokens(description, true)]);
  if ([...tokens].some((t) => STARCHY_STAPLE.has(t))) return true;
  const fruit = /\bfruit/i.test(food?.category ?? '');
  if (!fruit) return false;
  if (DRIED_FRUIT.test(text)) return course != null && SWEET_COURSES.has(course);
  return course !== 'main' && course !== 'soup' && course !== 'side';
}

/* -------------------------------------------------------------- validator --- */

const fmt = (n: number) => (Math.abs(n) >= 10 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString());

/** Severity for a value against a range: ok, warn (outside), error (beyond 3×). */
function rangeSeverity(v: number, [lo, hi]: Range): 'ok' | 'warn' | 'error' {
  if (v >= lo && v <= hi) return 'ok';
  if (v > hi * 3 || (lo > 0 && v < lo / 3)) return 'error';
  return 'warn';
}

/** Validate one recipe's ingredient data and per-serving plausibility. */
export function validateRecipe(
  recipe: ValidatableRecipe,
  foodById: Map<number, FoodRecord>,
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const skip = new Set(opts.skip ?? []);
  const push = (sev: 'error' | 'warn', issue: Issue) => {
    if (skip.has(issue.code)) return;
    (sev === 'error' ? errors : warnings).push(issue);
  };
  const ings = recipe.ingredients ?? [];
  const label = (ing: ValidatableIngredient) => `"${ing.raw}"`;

  ings.forEach((ing, idx) => {
    const item = ing.item || ing.raw;
    const excluded = !!ing.excludeFromNutrition;
    const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;

    // f. exclusions + completeness
    if (ing.fdcId != null && !food) {
      push(excluded ? 'warn' : 'error', { code: 'UNKNOWN_FOOD', ingredientIndex: idx, message: `${label(ing)}: fdcId ${ing.fdcId} is not in the food database` });
    }
    if (isWaterLike(item)) {
      if (!excluded && !(food && isPlainWater(food.description))) {
        push('error', {
          code: 'WATER_MATCH',
          ingredientIndex: idx,
          message: `${label(ing)}: water/ice line must be excluded or matched to plain water${food ? ` (matched "${food.description}")` : ''}`,
        });
      }
    } else if (!excluded) {
      if (ing.fdcId == null) push('error', { code: 'MISSING_MATCH', ingredientIndex: idx, message: `${label(ing)}: no food match and not excluded` });
      if (ing.grams == null || !(ing.grams > 0)) push('error', { code: 'MISSING_GRAMS', ingredientIndex: idx, message: `${label(ing)}: no weight and not excluded` });
    }

    // a. identity + false friends; b. state
    if (food && !ing.proxyOk && !(isWaterLike(item) && isPlainWater(food.description))) {
      const ff = falseFriend(item, food.description);
      if (ff) {
        push(excluded ? 'warn' : 'error', { code: 'FALSE_FRIEND', ingredientIndex: idx, message: `${label(ing)} → "${food.description}": ${ff}` });
      } else {
        const itemTok = identityTokens(item, true);
        const foodTok = identityTokens(food.description);
        if (itemTok.size && !sharesIdentity(itemTok, foodTok)) {
          push('warn', {
            code: 'IDENTITY_MISMATCH',
            ingredientIndex: idx,
            message: `${label(ing)} → "${food.description}": no shared identity word (mark a reviewed proxy with proxyOk: true)`,
          });
        }
      }
      if (!excluded) {
        const st = stateConflict(ing, food.description);
        if (st) push('error', { code: 'STATE_MISMATCH', ingredientIndex: idx, message: `${label(ing)} → "${food.description}": ${st}` });
      }
    }

    // c. grams per unit
    if (!excluded && ing.grams != null && ing.grams > 0 && ing.quantity != null && ing.quantity > 0) {
      const ur = unitRange(ing, food);
      if (ur) {
        const qty = ing.quantity2 != null && ing.quantity2 > ing.quantity ? (ing.quantity + ing.quantity2) / 2 : ing.quantity;
        const per = ing.grams / qty;
        const sev = rangeSeverity(per, ur.range);
        if (sev !== 'ok') {
          push(sev === 'error' ? 'error' : 'warn', {
            code: 'GRAMS_PER_UNIT',
            ingredientIndex: idx,
            message: `${label(ing)}: ${fmt(per)} g per ${ur.label} (expected ${ur.range[0]}–${ur.range[1]} g)`,
          });
        }
      }
    }
  });

  // g. duplicate lines
  const seen = new Map<string, number>();
  ings.forEach((ing, idx) => {
    const key = `${(ing.group ?? '').toLowerCase()}|${ing.raw.trim().toLowerCase().replace(/\s+/g, ' ')}`;
    const first = seen.get(key);
    if (first != null) {
      push('warn', { code: 'DUPLICATE_LINE', ingredientIndex: idx, message: `"${ing.raw}" repeats line ${first + 1}` });
    } else seen.set(key, idx);
  });

  // d. per-serving plausibility + dominance; e. source cross-check
  const resolved =
    opts.precomputed?.resolved ??
    ings.map((ing) => toResolved(storedScoringFields(ing as unknown as Record<string, unknown>), foodById));
  const macro = opts.precomputed?.macro ?? computeMacros(resolved, recipe.servings ?? 4);
  if (macro.contributingCount > 0) {
    const kcal = macro.perServing.energyKcal;
    const courseKey = normalizeCourse(recipe.course);
    const range = courseKey ? COURSE_KCAL[courseKey] : DEFAULT_KCAL;
    if (kcal != null) {
      const sev = rangeSeverity(kcal, range);
      if (sev !== 'ok') {
        push(sev === 'error' ? 'error' : 'warn', {
          code: 'KCAL_PER_SERVING',
          message: `${fmt(kcal)} kcal per serving (servings ${recipe.servings ?? 4}) is outside ${range[0]}–${range[1]} kcal for ${courseKey ?? 'an unknown course'}`,
        });
      }
      const src = recipe.source?.kcalPerServing;
      if (src != null && src > 0) {
        const rel = Math.abs(kcal - src) / src;
        // A third-party nutrition figure is itself often wrong (portion basis, typos), so a
        // disagreement flags the recipe for review but never blocks a build on its own.
        if (rel > 0.35) {
          push('warn', {
            code: 'SOURCE_KCAL',
            message: `${fmt(kcal)} kcal per serving vs the source's ${fmt(src)} kcal (${Math.round(rel * 100)} % apart)`,
          });
        }
      }
    }
    const sodium = macro.perServing.sodium_mg;
    if (sodium != null && sodium > 2300) {
      push('warn', { code: 'SODIUM_PER_SERVING', message: `${fmt(sodium)} mg sodium per serving (above 2,300 mg)` });
    }

    if (macro.contributingCount >= 3) {
      const kcalOf: number[] = [];
      const carbOf: number[] = [];
      resolved.forEach((r) => {
        const ok = !r.excludeFromNutrition && r.grams != null && r.grams > 0 && r.nutrients;
        kcalOf.push(ok ? ((energyKcalOf(r.nutrients!) ?? 0) * r.grams!) / 100 : 0);
        carbOf.push(ok ? ((availableCarbOf(r.nutrients!) ?? 0) * r.grams!) / 100 : 0);
      });
      const totK = kcalOf.reduce((a, b) => a + b, 0);
      const totC = carbOf.reduce((a, b) => a + b, 0);
      kcalOf.forEach((k, idx) => {
        if (totK > 0 && k / totK > 0.6) {
          push('warn', { code: 'DOMINANT_ENERGY', ingredientIndex: idx, message: `"${ings[idx].raw}" is ${Math.round((k / totK) * 100)} % of the recipe's energy` });
        }
      });
      const course = normalizeCourse(recipe.course);
      carbOf.forEach((c, idx) => {
        if (totC > 0 && c / totC > 0.7) {
          const ing = ings[idx];
          const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
          if (isExpectedCarbBase(ing.item || ing.raw, food, course)) return;
          push('warn', { code: 'DOMINANT_CARB', ingredientIndex: idx, message: `"${ings[idx].raw}" is ${Math.round((c / totC) * 100)} % of the recipe's available carbohydrate` });
        }
      });
    }
  }

  return { errors, warnings };
}
