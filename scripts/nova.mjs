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
// "baking soda". Confectionery and industrial condiments (candy, ketchup) are
// formulations, not preserved whole foods, so they belong here, not in NOVA 3;
// `confectionery|confections?` is bounded so it can't reach "confectioners' " (icing)
// sugar, a NOVA-2 culinary ingredient. Chocolate is handled by a dedicated rule below
// (its NOVA group turns on sweetened-vs-unsweetened, which a flat marker can't express).
// Word-bounded so "analog" never hits "analogous" prose and "cocoa" stays lower.
const RE_NOVA4 =
  /\b(imitation|analog(?:ue)?s?|meatless|substitutes?|instant|hydrolyzed|hydrolysed|textured vegetable protein|infant formula|soft drink|energy drink|sports drink|margarine|shortening|flavored|flavoured|candies|candy|confectionery|confections?|ketchup|catsup)\b/i;

// Nut & seed butters/pastes (peanut, almond, cashew, tahini, sunflower, sesame) are
// graded by what is added to the ground nut — grinding itself is a NOVA-1 process
// (Monteiro 2019), so a plain paste stays with the nut:
//   - sweetened, honey, hydrogenated/added-oil, omega-3 or reduced-fat/-sodium
//     reformulations → 4 (industrial formulations);
//   - salted, or a retail butter with no stated recipe (which conventionally carries
//     salt) → 3;
//   - tahini / sesame paste, or a butter stated plain / unsalted / stone-ground → 1.
// RE_NUT_BUTTER does NOT touch dairy "Butter, …" (no nut/seed word in front), the
// cocoa/nutmeg/ucuhuba "… butter" oils (no standalone "nut" token), "Fruit butters, …",
// or "butternut" squash (one word, no " butter" suffix).
const RE_NUT_BUTTER =
  /\b(?:peanut|almond|cashew|hazelnut|walnut|pecan|macadamia|pistachio|sunflower|sesame|nut|seed)\s+(?:butter|paste)\b|\btahini\b/i;
const RE_NUT_BUTTER_UPF = /\b(sweetened|honey|sugar|hydrogenated|with added|omega-3|reduced fat|reduced sodium|chocolate|spread)\b/i;
const RE_NUT_BUTTER_SALTED = /\bwith salt\b|\bsalted\b/i;
const RE_NUT_BUTTER_PLAIN = /\b(tahini|sesame butter, paste|without salt|unsalted|no salt|plain|stone ground|natural)\b/i;

// Further NOVA-4 product types the generic markers cannot see (Monteiro 2019 lists each
// as ultra-processed): distilled spirits; mass-produced packaged bread
// ("commercially prepared"); industrial pastry and wafer cones; pressurised whipped-cream
// toppings (emulsifiers, stabilisers); flavoured/fruit yoghurts; non-sugar sweeteners.
const RE_NOVA4_PRODUCT =
  /^alcoholic beverages?, distilled\b|\bbread\b.*\bcommercially prepared\b|\bpuff pastry\b|\bice cream cones?\b|\bcream topping\b|\bpressurized\b|^sweetener, (?!syrup)|\b(stevia|sucralose|aspartame|saccharin|acesulfame)\b/i;
const RE_FLAVOURED_YOGURT = /\byogh?urt\b.*\b(strawberr\w*|vanilla|fruit|blueberr\w*|raspberr\w*|peach|cherry|lemon|coffee|chocolate)\b/i;

// NOVA 3 — processed-food markers: preservation/transformation that turns a whole
// food into a durable processed one. Word-bounded to avoid sub-word hits ("bread"
// must not fire on "breadfruit"; "ham" must not fire on "graham"; "sauce" stays
// off "applesauce" because the joined token has no boundary).
// Table olives are always cured/brined (raw olives are inedibly bitter); nuts and
// seeds roasted in oil carry an added NOVA-2 fat.
const RE_NOVA3_FORM = /^olives?\b|\boil roasted\b/i;
const RE_NOVA3 =
  /\b(cheese|tofu|tempeh|natto|miso|gochujang|doenjang|kimchi|sauerkraut|pickle[sd]?|canned|cured|smoked|salted|corned|brined|fermented|sausages?|bacon|hams?|salami|pastrami|prosciutto|jerky|anchov\w*|sardines?|lox|bread|tortillas?|pita|naan|crackers?|sauces?|paste|relish|jams?|jelly|jellies|marmalade|preserves|fish sauce|oyster sauce|soy sauce|tamari|shoyu|in syrup)\b/i;

// Fermented alcoholic drinks (wine, beer, cider, sake) are processed foods (NOVA 3;
// distilled spirits are caught as NOVA 4 by RE_NOVA4_PRODUCT first), matched by
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
// Culinary ingredients USDA names under another lead noun: plant syrups filed as
// "Sweetener, syrup, …" (agave) and flavouring extracts (vanilla) used in cooking.
const RE_NOVA2_OTHER = /^sweetener, syrup\b|^vanilla extract\b/i;
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
  // otherwise-whole food is still ultra-processed). Nut/seed butters are graded here,
  // before the NOVA-2 "butter" leading-noun rule below could read them as dairy fat.
  if (RE_NOVA4.test(desc)) return 4;
  if (RE_NUT_BUTTER.test(desc)) {
    if (RE_NUT_BUTTER_UPF.test(desc)) return 4;
    return !RE_NUT_BUTTER_SALTED.test(desc) && RE_NUT_BUTTER_PLAIN.test(desc) ? 1 : 3;
  }
  if (RE_NOVA4_PRODUCT.test(desc) || RE_FLAVOURED_YOGURT.test(desc)) return 4;
  // Chocolate: a SWEETENED chocolate (dark/milk bars, the sugar-laden "mexican" baking
  // tablet) is a NOVA-4 confection; UNSWEETENED baking chocolate / cocoa liquor is pure
  // cocoa mass — a culinary ingredient that stays low, like cocoa powder. The split can't
  // live in RE_NOVA4 (a flat marker can't read the sweetened/unsweetened distinction).
  if (/\bchocolate\b/i.test(desc) && !/\bunsweetened\b/i.test(desc)) return 4;

  // Culinary ingredients: the Fats and Oils category, sugar/salt/butter-type
  // leading nouns, and vinegar anywhere. Checked before NOVA 3 so a "salted"
  // butter or an aged vinegar isn't read as a NOVA-3 ferment.
  if (category === 'Fats and Oils') return 2;
  if (RE_NOVA2_DESC.test(lead)) return 2;
  if (RE_NOVA2_OTHER.test(desc)) return 2;
  if (RE_VINEGAR.test(desc)) return 2;

  // Processed foods: alcoholic drinks, then preservation/transformation markers
  // anywhere in the name.
  if (RE_ALCOHOL.test(desc)) return 3;
  if (RE_NOVA3.test(desc) || RE_NOVA3_FORM.test(desc)) return 3;

  // Everything else is a generic whole / minimally processed reference food.
  return 1;
}
