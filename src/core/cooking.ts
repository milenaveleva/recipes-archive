/**
 * Cooking: from an ingredient's RAW weight and raw per-100 g composition to the cooked,
 * as-eaten state every score is computed on — the ingredient-based recipe calculation
 * with yield and retention factors (Reinivuo & Laitinen 2007; EuroFIR standardised
 * recipe calculation):
 *
 *   nutrient total (cooked) = raw grams / 100 × raw per-100 g value × retention factor
 *   cooked mass             = raw grams × yield factor
 *
 * Retention factors (src/data/retention-factors.json) come from the USDA Table of
 * Nutrient Retention Factors Release 6 (2007), with Bognár 2002 for the vitamins and
 * trace minerals Release 6 does not tabulate; yield factors (src/data/cooking-yields.json)
 * from Bognár 2002 weight-yield tables or USDA raw/cooked record pairs. Both are built by
 * scripts/build-retention.mjs. Energy, macronutrients and fat fractions are not in either
 * retention table and are retained in full, and polyphenols take a generic retention
 * (POLYPHENOL_RETENTION, Rothwell 2015); the mass change is booked as
 * water.
 *
 * Fat uptake during frying is not modelled: the cooking fat is its own recipe ingredient
 * (oil, butter) and contributes in full, so no uptake term is added to the fried food.
 *
 * A food whose matched record is already a cooked/prepared form ("Pasta, cooked",
 * "Lentils, canned") is returned unchanged whatever its method — its composition is
 * already as-eaten, so applying factors again would count the cooking twice.
 *
 * Every figure is an estimate.
 */
import retentionData from '../data/retention-factors.json';
import yieldData from '../data/cooking-yields.json';
import type { NutrientVector } from './types';

export const COOKING_METHODS = [
  'raw',
  'boiled',
  'steamed',
  'baked',
  'grilled',
  'fried',
  'blanched',
  'microwaved',
] as const;
/**
 * How an ingredient is cooked. `boiled` covers simmered / poached / cooked in liquid;
 * `baked` covers oven-roasted; `fried` covers pan-fried / sautéed / stir-fried /
 * deep-fried. A missing method means `raw`.
 */
export type CookingMethod = (typeof COOKING_METHODS)[number];

/** Whether a value is one of the cooking-method enum strings. */
export function isCookingMethod(v: unknown): v is CookingMethod {
  return typeof v === 'string' && (COOKING_METHODS as readonly string[]).includes(v);
}

/**
 * Factor groups of retention-factors.json / cooking-yields.json, plus `none` — foods with
 * no cooking factors (fats and oils, spices, sweets, beverages, baked products, sauces,
 * soy products), which pass through unchanged.
 *
 * There is no meat or poultry group: the bundled food dataset carries no land meat (beef,
 * pork, lamb, poultry, sausages), so the factor tables hold none either. A meat-category
 * record falls through to `none` and is scored as-is; adding meat foods means adding a
 * `meat` group with USDA Release 6 meat retention and yield factors.
 */
export type CookingGroup =
  | 'leafy-veg' | 'root-veg' | 'other-veg' | 'tomato' | 'potato' | 'sweet-potato' | 'mushroom'
  | 'legume-dry' | 'grain' | 'oats' | 'pasta' | 'flour'
  | 'egg' | 'milk' | 'cheese'
  | 'fish-lean' | 'fish-fatty' | 'shellfish'
  | 'fruit' | 'citrus' | 'nuts-seeds'
  | 'none';

/** The food fields the group lookup reads (a FoodRecord satisfies this). */
export interface CookableFood {
  description: string;
  category?: string;
  n?: NutrientVector | null;
}

// A matched record that is already a cooked or otherwise prepared form.
const PREPARED =
  /\b(cooked|boiled|baked|roasted|dry-roasted|oil-roasted|fried|stir-fried|deep-fried|sauteed|sautéed|steamed|grilled|broiled|toasted|canned|stewed|microwaved|poached|scrambled|omelet|hard-boiled|braised|blanched|heated|prepared)\b/i;

/** Whether a food record's composition is already as-eaten (cooked/canned/prepared). */
export function isPreparedFood(description: string): boolean {
  return PREPARED.test(description);
}

const SHELLFISH = /\b(crustaceans?|mollusks?|molluscs?|shrimps?|prawns?|crabs?|lobsters?|mussels?|clams?|oysters?|scallops?|squid|octopus|crayfish|crawfish|cuttlefish|langoustines?)\b/i;
const MUSHROOM = /\b(mushrooms?|shiitake|chanterelles?|morels?|enoki|portabella|portobello|shimeji|maitake|truffles?|fungi)\b/i;
const LEAFY =
  /\b(spinach|kale|chard|collards?|lettuce|cabbage|bok choy|pak[- ]?choi|pak choy|arugula|rocket|greens|watercress|cress|endive|escarole|radicchio|amaranth leaves|dandelion|sorrel|purslane|lambsquarters|leaves|nettles?|mizuna|komatsuna|tatsoi)\b/i;
const ROOT =
  /\b(carrots?|beets?|beetroots?|turnips?|parsnips?|radish(es)?|daikon|celeriac|rutabagas?|onions?|shallots?|garlic|leeks?|kohlrabi|ginger ?root|horseradish|jicama|salsify|fennel|scallions?|spring onions?|taro|cassava|burdock|lotus root|water ?chestnuts?|celery)\b/i;
const CITRUS = /\b(oranges?|lemons?|limes?|grapefruits?|tangerines?|mandarins?|clementines?|pomelos?|kumquats?|yuzu|citrus)\b/i;
const PASTA = /\b(pasta|noodles?|spaghetti|macaroni|lasagna|lasagne|vermicelli|udon|soba|ramen|somen|orzo|gnocchi|fettuccine|linguine|penne|fusilli)\b/i;
const FLOUR = /\b(flour|meal|bran|germ|starch|semolina|cornmeal|masa|breadcrumbs?)\b/i;
const LEGUME_NON_PULSE = /\b(tofu|tempeh|soymilk|soy milk|miso|natto|hummus|sauce|butter|flour|protein|meat|burger|okara|yuba|spread|sprouted|frankfurter|bacon|sausage)\b/i;

/**
 * The cooking factor group for a food: by its USDA category string first, then name
 * rules within the category (leafy / root / tomato / potato within vegetables; pasta /
 * flour / oats within cereals; shellfish vs fish by fat; dry pulses vs soy products
 * within legumes). Category strings are FoodData Central's food groups, which the
 * national-table records (MEXT, Ciqual) reuse.
 */
export function cookingGroupOf(food: CookableFood | null | undefined): CookingGroup {
  if (!food) return 'none';
  const d = food.description;
  const c = food.category ?? '';
  if (/Fats and Oils/.test(c)) return 'none';
  if (/Dairy and Egg/.test(c)) {
    if (/^egg\b|\beggs?,/i.test(d)) return 'egg';
    if (/\b(butter|ghee)\b/i.test(d)) return 'none';
    if (/\bcheese\b/i.test(d)) return 'cheese';
    return 'milk';
  }
  if (/Fish|Shellfish/.test(c)) {
    if (SHELLFISH.test(d)) return 'shellfish';
    return (food.n?.fat_g ?? 0) > 5 ? 'fish-fatty' : 'fish-lean';
  }
  if (/Nut and Seed/.test(c)) return 'nuts-seeds';
  if (/Legumes/.test(c)) {
    if (/\bpeanuts?\b/i.test(d)) return 'nuts-seeds';
    if (LEGUME_NON_PULSE.test(d)) return 'none';
    return /\b(mature seeds|dry|dried|raw|lentils?|split)\b/i.test(d) ? 'legume-dry' : 'none';
  }
  if (/Cereal Grains/.test(c)) {
    if (PASTA.test(d)) return 'pasta';
    if (/\boats?\b|\boatmeal\b/i.test(d) && !FLOUR.test(d)) return 'oats';
    if (FLOUR.test(d)) return 'flour';
    return 'grain';
  }
  if (/Vegetables|Mushrooms/.test(c)) {
    if (/Mushrooms/.test(c) || MUSHROOM.test(d)) return 'mushroom';
    if (/\bsweet ?potato(es)?\b|\byams?\b/i.test(d)) return 'sweet-potato';
    if (/^potato(es)?\b/i.test(d)) return 'potato';
    if (/\btomato(es)?\b/i.test(d)) return 'tomato';
    if (LEAFY.test(d)) return 'leafy-veg';
    if (ROOT.test(d)) return 'root-veg';
    return 'other-veg';
  }
  if (/Fruits/.test(c)) return CITRUS.test(d) ? 'citrus' : 'fruit';
  return 'none';
}

/** NutrientVector fields that carry a retention factor; every other field is kept whole. */
type RetainedField = keyof NutrientVector;

interface RetentionEntry {
  rf: Partial<Record<RetainedField, number>>;
}
interface YieldEntry {
  yield: number;
}
interface YieldOverride {
  group: string;
  method: string;
  match: string;
  yield: number;
}

const RETENTION = (retentionData as unknown as { groups: Record<string, { methods: Record<string, RetentionEntry> }> }).groups;
const YIELDS = (yieldData as unknown as { groups: Record<string, { methods: Record<string, YieldEntry> }> }).groups;
const OVERRIDES = ((yieldData as unknown as { overrides: YieldOverride[] }).overrides).map((o) => ({
  ...o,
  re: new RegExp(o.match, 'i'),
}));

/** Retention factor per nutrient for a group × method ({} = full retention). */
export function retentionFor(group: CookingGroup, method: CookingMethod): Partial<Record<RetainedField, number>> {
  if (method === 'raw' || group === 'none') return {};
  return { ...POLYPHENOL_RF, ...(RETENTION[group]?.methods[method]?.rf ?? {}) };
}

/**
 * Polyphenol retention in domestic cooking. Neither retention table covers polyphenols;
 * Rothwell 2015 (Phenol-Explorer retention factors) reports median retention 0.45–0.70
 * across domestic cooking, with food identity mattering more than the method, so every
 * cooked subclass takes the midpoint of that range rather than full retention.
 */
export const POLYPHENOL_RETENTION = 0.575;
const POLYPHENOL_RF: Partial<Record<RetainedField, number>> = Object.fromEntries(
  ['anthocyanidins_mg', 'flavan3ols_mg', 'flavanones_mg', 'flavones_mg', 'flavonols_mg', 'tyrosols_mg'].map((k) => [k, POLYPHENOL_RETENTION]),
);

/** Cooked mass ÷ raw mass for a food × method (1 = no change); name overrides win. */
export function yieldFor(food: CookableFood | null | undefined, group: CookingGroup, method: CookingMethod): number {
  if (method === 'raw' || group === 'none') return 1;
  const desc = food?.description ?? '';
  const o = OVERRIDES.find((x) => x.group === group && x.method === method && x.re.test(desc));
  if (o) return o.yield;
  return YIELDS[group]?.methods[method]?.yield ?? 1;
}

export interface CookedIngredient {
  /** Cooking group the factors came from (`none` = passed through). */
  group: CookingGroup;
  /** Cooked mass ÷ raw mass applied. */
  yieldFactor: number;
  /** As-eaten mass (g). */
  cookedGrams: number;
  /** Absolute nutrient amounts in the cooked ingredient (per-100 g fields × grams/100, retained). */
  nutrientsTotal: NutrientVector;
  /** The cooked composition per 100 g of cooked mass. */
  cookedPer100: NutrientVector;
  /** The retained nutrients per 100 g of RAW mass (losses applied, no water change). */
  retainedPer100Raw: NutrientVector;
}

/**
 * Apply a cooking method to one ingredient: per-nutrient retention on the totals, the
 * group's (or the food's name-specific) yield on the mass. `raw`, a missing method, a
 * `none`-group food and an already-prepared food record are the identity.
 */
/**
 * Whether cooking factors actually change a food: a cooked method on a food that has a
 * factor group and is not already a prepared record. False means `applyCooking` is the
 * identity — the test behind crediting the retention/yield tables as a data source.
 */
export function cookingApplies(
  food: CookableFood | null | undefined,
  method: CookingMethod | null | undefined,
): boolean {
  if (!food || !method || method === 'raw') return false;
  if (isPreparedFood(food.description)) return false;
  return cookingGroupOf(food) !== 'none';
}

export function applyCooking(
  grams: number,
  per100Raw: NutrientVector,
  food: CookableFood | null | undefined,
  method: CookingMethod | null | undefined,
): CookedIngredient {
  const m: CookingMethod = method ?? 'raw';
  const group: CookingGroup = cookingApplies(food, m) ? cookingGroupOf(food) : 'none';
  const rf = retentionFor(group, m);
  const yieldFactor = yieldFor(food, group, m);
  const cookedGrams = grams * yieldFactor;

  const retainedPer100Raw: NutrientVector = {};
  for (const [k, v] of Object.entries(per100Raw) as [RetainedField, number | undefined][]) {
    if (v == null) continue;
    retainedPer100Raw[k] = Number.isFinite(v) ? v * (rf[k] ?? 1) : v;
  }
  // The mass change is water (evaporated or absorbed).
  if (per100Raw.water_g != null && Number.isFinite(per100Raw.water_g) && grams > 0) {
    retainedPer100Raw.water_g = per100Raw.water_g + (100 * (cookedGrams - grams)) / grams;
  }

  const nutrientsTotal: NutrientVector = {};
  const cookedPer100: NutrientVector = {};
  for (const [k, v] of Object.entries(retainedPer100Raw) as [RetainedField, number][]) {
    nutrientsTotal[k] = (v * grams) / 100;
    cookedPer100[k] = cookedGrams > 0 ? (v * grams) / cookedGrams : v;
  }
  return { group, yieldFactor, cookedGrams, nutrientsTotal, cookedPer100, retainedPer100Raw };
}

/** Line text saying the ingredient is added already cooked ("cooked rice", "leftover pasta", "1 can beans"). */
const ALREADY_COOKED_TEXT =
  /\b(?:cooked|pre-?cooked|leftover|left-over|canned|tinned)\b|\b\d+(?:[.,]\d+)?\s*(?:x\s*)?(?:cans?|tins?)\b|\b(?:cans?|tins?)\s+of\b/;

/**
 * Suggested method for a freshly matched ingredient. A line that says the ingredient is
 * already cooked or canned starts `raw`: its written weight is the as-eaten weight, so a
 * yield factor (which converts a RAW weight) must not apply on top — the author should
 * pick a cooked record for it. Otherwise dry staples (dry pulses, grains, oats, pasta)
 * are boiled unless the line says they are drained (a canned/pre-cooked form), an
 * explicit cooking word in the line names its method, and everything else starts raw.
 */
export function suggestCooking(text: string, food: CookableFood | null | undefined): CookingMethod {
  const t = text.toLowerCase();
  if (ALREADY_COOKED_TEXT.test(t)) return 'raw';
  if (food && !isPreparedFood(food.description) && !/\bdrained\b/.test(t)) {
    const g = cookingGroupOf(food);
    if (g === 'legume-dry' || g === 'grain' || g === 'oats' || g === 'pasta') return 'boiled';
  }
  if (/\bblanched\b/.test(t)) return 'blanched';
  if (/\bsteamed\b/.test(t)) return 'steamed';
  if (/\b(boiled|simmered|poached)\b/.test(t)) return 'boiled';
  if (/\b(grilled|broiled|charred)\b/.test(t)) return 'grilled';
  if (/\b(roasted|baked)\b/.test(t)) return 'baked';
  if (/\b(fried|sauteed|sautéed|stir-fried)\b/.test(t)) return 'fried';
  if (/\bmicrowaved\b/.test(t)) return 'microwaved';
  return 'raw';
}
