/**
 * Estimate a food's NOVA processing group from its USDA name + category.
 *
 * NOVA (Monteiro) sorts foods by the nature, extent and purpose of processing:
 *   1 — unprocessed / minimally processed (raw, dried, frozen, cooked whole foods)
 *   2 — processed culinary ingredients (oils, butter, sugar, honey, salt, vinegar)
 *   3 — processed foods (NOVA-1 foods preserved with NOVA-2 ingredients: cheese,
 *       bread, canned/brined, cured/smoked/salted fish, fermented condiments)
 *   4 — ultra-processed (industrial formulations: analogues, instant mixes, sodas)
 *
 * The bundled dataset is generic Foundation/SR-Legacy reference foods with branded
 * products already pruned (usda-brands.mjs), so it is overwhelmingly NOVA 1–2; only
 * a small tail reaches 3, and almost nothing reaches 4. Rules are therefore
 * deliberately conservative: a food stays at the LOWER group unless a clear marker
 * promotes it, matching how a generic single-ingredient reference food is normally
 * minimally processed. The handful the rules misjudge are corrected by fdcId in
 * src/data/food-nova-overrides.json (override wins). NOVA assignment has low
 * inter-rater agreement, so every value is an estimate, not a measurement.
 */

// NOVA 4 — ultra-processed markers. Checked first so an "imitation cheese" or a
// "meatless sausage" is ultra-processed, not merely processed. Most such foods are
// pruned from the dataset already; this catches the stragglers (and any future
// national-table/custom additions). Carbonated/soft drinks are pruned by name
// already, so no bare "soda" marker here — it would mis-fire on "soda bread" and
// "baking soda". Word-bounded so "analog" never hits "analogous" prose.
const RE_NOVA4 =
  /\b(imitation|analog(?:ue)?s?|meatless|substitutes?|instant|hydrolyzed|hydrolysed|textured vegetable protein|infant formula|soft drink|energy drink|sports drink|margarine|shortening|flavored|flavoured)\b/i;

// NOVA 3 — processed-food markers: preservation/transformation that turns a whole
// food into a durable processed one. Word-bounded to avoid sub-word hits ("bread"
// must not fire on "breadfruit"; "ham" must not fire on "graham"; "sauce" stays
// off "applesauce" because the joined token has no boundary).
const RE_NOVA3 =
  /\b(cheese|tofu|tempeh|natto|miso|gochujang|doenjang|kimchi|sauerkraut|pickled?|canned|cured|smoked|salted|corned|brined|fermented|sausages?|bacon|hams?|salami|pastrami|prosciutto|jerky|anchov\w*|sardines?|lox|bread|tortillas?|pita|naan|crackers?|sauces?|paste|relish|fish sauce|oyster sauce|soy sauce|tamari|shoyu|in syrup)\b/i;

// Alcoholic drinks (wine, beer, spirits) are processed/ultra-processed, matched by
// USDA's "Alcoholic beverage[s], …" leading phrase rather than the bare words
// "wine"/"beer"/"cider" — those also name the raw fruit/grain a drink is made from
// ("Grapes, wine, raw"), non-alcoholic "apple cider", and "root beer", which are
// not NOVA 3. Vinegar (incl. "wine vinegar") is diverted to NOVA 2 before this.
const RE_ALCOHOL = /^alcoholic beverages?\b/i;

// NOVA 2 — processed culinary ingredients, recognised mostly by USDA category plus
// a few leading-noun markers. Oils & fats are the whole "Fats and Oils" category
// (margarine/shortening already diverted to NOVA 4 above); dairy/animal fats
// (butter, ghee, lard, tallow) sit in other categories, so they're caught by
// leading noun — and checked before NOVA 3 so "Butter, salted" reads as a culinary
// fat, not a "salted" ferment. Sugars/honey/syrup/molasses, salt and
// starch/leavening are extracted substances used to season and cook, not foods
// eaten on their own. Vinegar is matched anywhere (USDA "Vinegar, cider" and the
// national-table "Rice vinegar" both name it, lead-first or not).
const RE_NOVA2_DESC =
  /^(sugars?|honey|syrups?|molasses|salt|sea salt|table salt|cornstarch|starch|baking soda|baking powder|cream of tartar|leavening|yeast|butter|ghee|lard|tallow|suet)\b/i;
const RE_VINEGAR = /\bvinegar\b/i;

/** Leading noun of a USDA description (the food group token before the first comma). */
function leadNoun(desc) {
  return (desc || '').split(/[,(]/)[0].trim();
}

/**
 * Estimate the NOVA group (1–4) for a compact food record ({ description, category }).
 * Pure and deterministic; callers layer fdcId overrides on top.
 */
export function classifyNova(food) {
  const desc = food?.description || '';
  const category = food?.category || '';
  const lead = leadNoun(desc);

  // Ultra-processed markers win over everything (an imitation/instant form of an
  // otherwise-whole food is still ultra-processed).
  if (RE_NOVA4.test(desc)) return 4;

  // Culinary ingredients: the Fats and Oils category, sugar/salt/butter-type
  // leading nouns, and vinegar anywhere. Checked before NOVA 3 so a "salted"
  // butter or an aged vinegar isn't read as a NOVA-3 ferment.
  if (category === 'Fats and Oils') return 2;
  if (RE_NOVA2_DESC.test(lead)) return 2;
  if (RE_VINEGAR.test(desc)) return 2;

  // Processed foods: alcoholic drinks, then preservation/transformation markers
  // anywhere in the name.
  if (RE_ALCOHOL.test(desc)) return 3;
  if (RE_NOVA3.test(desc)) return 3;

  // Everything else is a generic whole / minimally processed reference food.
  return 1;
}
