/**
 * Route a food-composition record to the Atkinson 2021 GI reference category it is
 * matched within (scripts/match-gi.mjs scopes every token match to one category, since
 * cross-category matches such as "rice vinegar" ↔ "rice" are the main source of nonsense).
 *
 * Two USDA categories span several reference categories, so their foods are routed by
 * name first: "Cereal Grains and Pasta" holds both grains and pasta (PASTA_RE → PASTA AND
 * NOODLES), and "Baked Products" holds breads, crackers, cookies and cakes/pastries
 * (CRACKER_RE / BREAD_RE / COOKIE_RE → CRACKERS / BREADS / COOKIES, the rest BAKERY
 * PRODUCTS — the Atkinson cakes, pastries and sweet-bakery section). A USDA "Biscuits, …"
 * record is the American leavened quick bread (a scone-like roll), so it is a bread, while
 * "biscuit" elsewhere in a name keeps its British sense of a cookie ("water biscuits" are
 * crackers).
 */

export const PASTA_RE = /\b(pasta|noodles?|spaghetti|macaroni|vermicelli|lasagn[ae]|fettuccine|linguine|penne|udon|soba|somen)\b/i;
export const CRACKER_RE = /\b(crackers?|crispbread|matzo|melba|rusk|saltines?|water biscuits?)\b/i;
export const COOKIE_RE = /\b(cookies?|biscuits?|wafers?)\b/i;
export const BREAD_RE = /\b(breads?|bagels?|rolls?|buns?|pita|naan|chapati|roti|paratha|tortillas?|taco shells?|tostada|baguette|focaccia|croutons?|english muffins?)\b/i;
/** USDA names the American quick bread "Biscuits, <variety>". */
export const US_BISCUIT_RE = /^biscuits?\s*,/i;

/** Source categories holding baked goods, routed by food name (bakedCategoryFor). */
const BAKED_CATEGORY_RE = /baked|bakery|bread|cracker|cookie|biscuit/i;

/** USDA category → reference category, for every category without name routing. */
const CAT_MAP = [
  [/breakfast cereal/i, 'BREAKFAST CEREALS'],
  [/cereal grain|pasta|rice|grain/i, 'CEREAL GRAINS'],
  [/fruit/i, 'FRUIT AND FRUIT PRODUCTS'], [/vegetable/i, 'VEGETABLES'],
  [/legume|bean|lentil|pea/i, 'LEGUMES'], [/nut and seed|nut/i, 'NUTS'],
  [/dairy|milk|yogurt|cheese/i, 'DAIRY PRODUCTS AND ALTERNATIVES'],
  [/beverage|drink|juice/i, 'BEVERAGES'], [/sweet|sugar|syrup/i, 'SUGARS AND SYRUPS'],
  [/snack|confection/i, 'SNACK FOODS AND CONFECTIONERY'],
  [/soup/i, 'SOUPS'],
];

/** Reference category for a baked-goods record, from its name. */
function bakedCategoryFor(desc) {
  // Wonton / egg-roll wrappers are a boiled or steamed wheat dough, eaten like a noodle.
  if (/\bwrappers?\b/i.test(desc)) return 'PASTA AND NOODLES';
  // A rusk / melba toast / cracker is named after bread-like words, so crackers go first.
  if (CRACKER_RE.test(desc)) return 'CRACKERS';
  if (US_BISCUIT_RE.test(desc)) return 'BREADS';
  if (BREAD_RE.test(desc) && !/\b(stuffing|cornbread|cinnamon|raisin)\b/i.test(desc)) return 'BREADS';
  if (COOKIE_RE.test(desc)) return 'COOKIES';
  return 'BAKERY PRODUCTS';
}

/** The reference category a food is matched within, or null when none applies. */
export function refCategoryFor(food) {
  const cat = food.category ?? '';
  const desc = food.description ?? '';
  if (/cereal grain|pasta/i.test(cat) && PASTA_RE.test(desc)) return 'PASTA AND NOODLES';
  if (BAKED_CATEGORY_RE.test(cat)) return bakedCategoryFor(desc);
  return CAT_MAP.find(([re]) => re.test(cat))?.[1] ?? null;
}
