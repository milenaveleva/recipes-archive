/**
 * House rules: the owner's ingredient rules for every recipe on the site, as a gate
 * (`checkHouseRules`, wired into validate.ts `validateRecipe`) and as auto-fixes
 * (`normalizeIngredient` / `normalizeRecipe`, applied by the kifli import and the /add
 * authoring island before a recipe is written).
 *
 * Gate codes (severity in brackets):
 *   - FORBIDDEN_INGREDIENT [error]: meat as a dish component (fish and seafood are fine; a
 *     meat broth, stock, fat or gelatin is allowed), cow's milk, butter/ghee, dairy cream /
 *     sour cream / crème fraîche, mayonnaise, any alcohol (wine vinegar, mirin, sake and
 *     rice vinegar are not), refined grains (white rice, white pasta and noodles, white
 *     flour, white bread and breadcrumbs; plain couscous and gnocchi are allowed) and every
 *     sweetener but honey. Read from the line text and the matched food.
 *   - FORBIDDEN_WORDING [error]: "handful", "≈" conversion notes, substitution annotations
 *     ("in place of", "instead of", …), and "dried"/"uncooked" on a staple (the lists say "dry").
 *   - MEAT_SUGGESTION [error]: the method or tips suggest adding meat.
 *   - NOT_DRY_STAPLE [error]: a grain, pasta or pulse listed canned/cooked instead of as the
 *     dry record, its note just "dry" and its soaking and cooking a method step
 *     ("82 g chickpeas, dry" + "Soak the chickpeas … simmer until tender").
 *   - PORTION_80 [error]: a main course's single pasta/grain line is not 80 g dry per serving.
 *   - DRINK_WATER [error; warn for a drink with no liquid]: in a drink the water and ice
 *     that are drunk count, and tea leaves / coffee are the brewed record.
 *   - OLIVE_OIL_UNIT, GINGER_UNIT, SOY_SAUCE_SALT, FORTIFIED_PLANT_MILK, EGG_COUNT [warn]: olive oil stored in another unit than tbsp/tsp,
 *     soy sauce or tamari that is not low-sodium soy sauce, FORTIFIED_PLANT_MILK a plant drink on a
 *     fortified record,
 *     fresh ginger in another unit than grams, eggs stored
 *     by weight or with a size word ("large").
 *   - DUPLICATE_RECIPE [warn]: `findDuplicateRecipes`, which needs the whole corpus: a near-identical
 *     pair, or a kifli id excluded-ids.json lists as a near-duplicate or as removed by the owner.
 *
 * Pure and isomorphic like validate.ts: the food lookup is passed in.
 */
import type { FoodRecord } from './match';
import type { Issue, ValidatableIngredient, ValidatableRecipe } from './validate';
import { normalizeCourse } from './course';
import { parseIngredientLine, estimateMetric } from './parse';
import { canonicalUnit, classifyUnit } from './units';

export interface HouseIssue extends Issue {
  severity: 'error' | 'warn';
}

/* ----------------------------------------------------------------- text --- */

/** Lowercase, accent-free text for matching. */
export function fold(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘]/g, "'");
}

/** Plain drinking water (bottled / tap) — the only food a water line may match. */
export function isPlainWater(description: string): boolean {
  return /^(water, (bottled|tap|municipal|well)|beverages, water\b)/i.test(description);
}

/** Water / ice / soda-water lines (no other food word). */
export function isWaterLike(item: string): boolean {
  const words = fold(item).replace(/\([^)]*\)/g, ' ').split(/[^a-z]+/).filter(Boolean);
  if (!words.some((w) => /^(water|ice|soda)$/.test(w))) return false;
  const ok = /^(water|ice|soda|cube|cubes|sparkling|mineral|carbonated|still|tap|filtered|crushed|cold|hot|warm|lukewarm|boiling|chilled|iced|a|some|little|of|for|the|to|plus|extra|more|about|serving|serve|or|and|very|room|temperature|few|handful|cup|cups)$/;
  return words.every((w) => ok.test(w));
}

/* ------------------------------------------------------------ lexicons --- */

/** Meat words (fish and seafood are not meat here). */
const MEAT =
  /\b(chicken|chickens|beef|pork|lamb|mutton|veal|turkey|duck|goose|venison|rabbit|boar|bacon|hams?|prosciutto|pancetta|guanciale|lardons?|salami|chorizo|sausages?|pepperoni|mortadella|bresaola|speck|meatballs?|meat|minced meat|mincemeat|liver pate|offal|tripe|oxtail|brisket|gammon|jamon|quail|pheasant|kabanos|frankfurters?|hot dogs?|grouse|partridge|pigeon|bison|elk)\b/;
/** Meat-named phrases that are allowed: broths, fats, gelatin, plant-based stand-ins, homonyms. */
const MEAT_ALLOWED = [
  /\b(chicken|beef|pork|lamb|veal|turkey|duck|goose|bone|meat|ham|game)\s+(broth|stock|bouillon|consomme|fat|dripping|drippings|lard|gelatine?|stock cubes?|cubes?|base|powder|jus)\b/g,
  /\b(vegan|vegetarian|plant[- ]based|meatless|meat[- ]free|soy|soya|tofu|seitan|veggie|vegetable|mushroom|jackfruit|imitation|faux|mock|lentil|bean|chickpea)\s+(\w+\s+)?(chicken|beef|pork|bacon|ham|sausages?|meatballs?|mince|meat|chorizo|salami|burgers?|steaks?|cutlets?)\b/g,
  /\bchicken of the woods\b|\blamb'?s lettuce\b|\blambs lettuce\b|\bbeef(steak)? tomato(es)?\b|\bduck eggs?\b|\bquail eggs?\b/g,
  /\b(coconut|crab|lobster|nut|walnut|pecan|mussel|shrimp|prawn|clam|scallop|oyster|squid|octopus|fish|crayfish|langoustine|sea urchin) ?meat\b/g,
  /\bmeat[- ]free\b|\bmeatless\b|\bwithout (any )?meat\b|\bno meat\b|\bmeaty\b|\bmeat (substitutes?|alternatives?|analogues?|replacements?)\b|\bmeat-style\b|\bmeatball[- ]sized\b/g,
];
const MEAT_CATEGORY = /^(Poultry Products|Beef Products|Pork Products|Lamb, Veal, and Game Products|Sausages and Luncheon Meats)$/;

function stripAllowedMeat(text: string): string {
  let t = text;
  for (const re of MEAT_ALLOWED) t = t.replace(re, ' ');
  return t;
}

/** The meat word a text names, or null. */
export function meatWord(text: string): string | null {
  return MEAT.exec(stripAllowedMeat(fold(text)))?.[1] ?? null;
}

const PLANT_MILK = /\b(oat|almond|soy|soya|coconut|rice|cashew|hazelnut|pea|hemp|plant[- ]based|vegan|macadamia|walnut|pistachio|quinoa|flax|spelt|nut|tiger ?nut|grain|chocolate oat)\s+(milk|drink)\b/g;
const MILK_ALLOWED = /\bbutter ?milk\b|\bmilk chocolate\b|\bmilk kefir\b|\bkefir\b|\bmilk thistle\b|\bbreast ?milk\b/g;
const NUT_BUTTER =
  /\b(peanut|almond|cashew|hazelnut|nut|seed|sesame|sunflower|pistachio|pumpkin seed|cocoa|cacao|shea|apple|coconut|soy|plant[- ]based|vegan|macadamia|walnut|pecan)\s+butter\b|\bbutter ?beans?\b|\bbutter ?nut\b|\bbutterhead\b|\bbutter lettuce\b|\bbutterbur\b/g;
const CREAM_ALLOWED =
  /\bice ?cream\b|\bcream cheese\b|\bcoconut cream\b|\bcream of\b|\bcashew cream\b|\b(plant[- ]based|vegan|soy|soya|oat|rice|almond|coconut|cashew)\s+([\w-]+\s+)?(cream|creme fraiche|sour cream)\b|\bcream crackers?\b|\bsalad cream\b|\bsour cream and onion\b/g;
const ALCOHOL =
  /\b(wines?|beers?|ales?|lagers?|stout|hard cider|alcoholic cider|scrumpy|perry|sherry|vermouth|marsala|madeira|port wine|brandy|cognac|armagnac|calvados|rum|vodka|gin|whisk(e)?y|bourbon|tequila|mezcal|liqueurs?|liquor|amaretto|kirsch|grappa|ouzo|pastis|schnapps|palinka|prosecco|champagne|cava|sangria|limoncello|cointreau|triple sec|baileys|kahlua|campari|aperol|alcohol|spirits?|absinthe|sambuca|grand marnier|pisco|cachaca|soju|shaoxing|makgeolli|unicum)\b/;
const ALCOHOL_ALLOWED =
  /\b(red |white |rice |sherry |champagne |cider |apple cider |balsamic |malt )?(wine )?vinegar\b|\bmirin\b|\bsake\b|\bginger (ale|beer)\b|\broot beer\b|\bnon[- ]alcoholic\b|\balcohol[- ]free\b|\b0\.0\b|\bde-?alcoholi[sz]ed\b/g;

const VINEGAR_ALTERNATIVE = /\b(apple )?(cider|(red |white )?wine)\b(?=\s*(or|and|\/|,)[^,;()]*\bvinegar\b)/g;

const PASTA_SHAPE =
  /\b(pasta|spaghetti(ni)?|penne|fusilli|linguine|tagliatelle|orecchiette|macaroni|lasagne|lasagna|farfalle|rigatoni|orzo|fettuccine|conchiglie|pappardelle|tortiglioni|paccheri|ditalini|bucatini|casarecce|gemelli|cavatappi|strozzapreti|trofie|tagliolini|capellini|vermicelli|ziti|mafaldine|lumache|pipe rigate|radiatori|maccheroni)\b/;
const WHOLE = /\bwhole[- ]?(wheat|meal|grain|spelt)\b|\bwholemeal\b|\bwholegrain\b|\bwholewheat\b|\bbrown\b|\bwild\b|\bblack\b|\bred rice\b|\bspelt\b|\bbuckwheat\b|\bsoba\b|\brye\b|\blentil\b|\bchickpea\b|\bbean\b|\bpea\b|\bedamame\b|\bkonjac\b|\bshirataki\b|\bzucchini\b|\bcourgette\b|\bglass\b|\bcellophane\b|\bmung\b|\bsweet potato\b|\bkelp\b|\btofu\b|\bgluten[- ]free\b/;
const NOT_GRAIN_RICE =
  /\brice (paper|vinegar|wine|flour|milk|drink|cakes?|crackers?|syrup|bran|noodle soup)\b|\b(cauliflower|broccoli|puffed) rice\b|\briced\b|\brice[- ]based\b|\bpasta (cooking )?water\b|\bpasta sauce\b/g;
const FLOUR_OK =
  /\b(whole[- ]?(wheat|meal|grain)|wholemeal|wholegrain|wholewheat|spelt|rye|buckwheat|chickpea|gram|besan|almond|coconut|oat|rice|corn|maize|potato|tapioca|cassava|arrowroot|chestnut|hazelnut|teff|quinoa|millet|sorghum|amaranth|barley|lentil|pea|banana|semolina|durum|cornflour|cornstarch|flaxseed|linseed|psyllium|soy|soya|tigernut|acorn|gluten[- ]free)\b/;
const SWEETENER =
  /\b(sugars?|syrups?|molasses|treacle|jaggery|agave|stevia|erythritol|xylitol|sweeteners?|dextrose|glucose|fructose|sucrose|caramel|panela|muscovado|demerara|piloncillo|condensed milk|dulce de leche|maltodextrin|sucralose|aspartame|saccharin|isomalt|maltitol|monk ?fruit)\b/;
const SWEETENER_ALLOWED =
  /\b(pomegranate|date|grape|carob) molasses\b|\bsugar[- ]?snap\b|\bsnap peas?\b|\bno[- ]added[- ]sugars?\b|\bsugar[- ]free\b|\bno sugar\b|\bwithout sugar\b|\bunsweetened\b|\bsugar beets?\b|\bsugar ?(pumpkin|loaf)\b|\bsugarloaf\b/g;

const strip = (text: string, re: RegExp) => text.replace(re, ' ');

/** Why a line is forbidden by the house rules, or null. */
export function forbiddenReason(itemText: string, food?: FoodRecord): string | null {
  const t = fold(itemText);
  const d = fold(food?.description);
  const meat = meatWord(t);
  if (meat) return `meat ("${meat}")`;
  if (food && MEAT_CATEGORY.test(food.category ?? '') && !/\b(broth|stock|bouillon|fat|lard|gelatin)/.test(`${t} ${d}`)) {
    return `meat (matched "${food.description}")`;
  }

  const milkText = strip(strip(t, PLANT_MILK), MILK_ALLOWED);
  if (/\bmilk\b/.test(milkText) && !/\b(coconut|condensed)\b/.test(milkText)) return "cow's milk (use unsweetened oat milk)";
  if (/^milk,/.test(d) && !/\b(oat|almond|soy|soya|rice|coconut|cashew|hemp|pea|buttermilk|plant)\b/.test(d) && milkText === t) {
    return `cow's milk (matched "${food!.description}")`;
  }

  const butterText = strip(t, NUT_BUTTER);
  if (/\b(butter|ghee)\b/.test(butterText)) return 'butter/ghee (use extra virgin olive oil)';
  if (/^butter\b|\bghee\b|^butter oil/.test(d) && butterText === t) return `butter (matched "${food!.description}")`;

  const creamText = strip(t, CREAM_ALLOWED);
  if (/\b(cream|creme fraiche|creme|sour cream|smetana)\b/.test(creamText)) return 'dairy cream (use the plant-based version)';
  if (creamText === t && (/^cream,/.test(d) || /^sour cream|^cream, sour/.test(d)) && !/plant-based/.test(d)) {
    return `dairy cream (matched "${food!.description}")`;
  }

  if (/\bmayo(nnaise)?\b/.test(t) || /\bmayonnaise\b/.test(d)) return 'mayonnaise (use Greek yogurt)';

  // "apple cider or white wine vinegar": a cider/wine named as one of the vinegars.
  const alcoholText = strip(strip(t, VINEGAR_ALTERNATIVE), ALCOHOL_ALLOWED);
  const alc = ALCOHOL.exec(alcoholText);
  if (alc) return `alcohol ("${alc[1]}")`;
  if ((/^alcoholic beverage|\bbeer\b|\bliqueur\b/.test(d) || (/\bwine\b/.test(d) && !/vinegar/.test(d))) && alcoholText === t) {
    return `alcohol (matched "${food!.description}")`;
  }

  const refined = refinedGrain(t, d);
  if (refined) return refined;

  const sweetText = strip(t, SWEETENER_ALLOWED);
  const sweet = SWEETENER.exec(sweetText);
  if (sweet) return `sweetener ("${sweet[1]}"; honey is the only sweetener)`;
  if (/^(sugars?|syrups?|sweeteners?|molasses)\b|^candies, caramel/.test(d) && sweetText === t && !/\bhoney\b/.test(t)) {
    return `sweetener (matched "${food!.description}")`;
  }
  return null;
}

/** Why a grain/flour/bread line is a refined grain, or null. */
function refinedGrain(t: string, d: string): string | null {
  const g = strip(t, NOT_GRAIN_RICE);
  const whole = WHOLE.test(g);
  if (/\b(rice|risotto|basmati|jasmine|arborio|carnaroli|sushi rice)\b/.test(g) && !/\bnoodles?\b/.test(g) && !whole) {
    return 'white rice (use brown rice)';
  }
  if (/^rice, white\b/.test(d) && !whole) return 'white rice (use brown rice)';
  if (PASTA_SHAPE.test(g) && !whole && !/\b(sauce|gnocchi)\b/.test(g)) return 'refined pasta (use whole-wheat)';
  if (/\b(noodles?|udon|ramen|lo mein|chow mein)\b/.test(g) && !whole) return 'refined noodles (use the whole-grain version)';
  if (/^(pasta|noodles|spaghetti|macaroni)\b/.test(d) && !/whole-wheat|whole wheat|gluten-free|soba|cellophane|mung|buckwheat/.test(d) && !whole && !/\bgnocchi\b/.test(g)) {
    return 'refined pasta (use whole-wheat)';
  }
  if (/\bflour\b/.test(g) && !FLOUR_OK.test(g)) return 'refined flour (use whole-wheat flour)';
  if (/^(flour, wheat, all-purpose|wheat flour, white|flour, bread|flour, cake|flour, pastry)/.test(d) && !FLOUR_OK.test(g)) {
    return 'refined flour (use whole-wheat flour)';
  }
  if (/\bwhite bread\b|\bwhite breadcrumbs\b|\b(white|plain) (toast|baguette|rolls?|buns?)\b/.test(g) || (/\bpanko\b/.test(g) && !whole)) {
    return 'white bread (use whole-wheat)';
  }
  if (/\b(bread ?crumbs|breadcrumbs)\b/.test(g) && !whole) return 'white breadcrumbs (use whole-wheat)';
  if (/^bread, (white|crumbs)/.test(d) && !whole) return 'white bread (use whole-wheat)';
  return null;
}

/* -------------------------------------------------------------- staples --- */

/** Grains and pasta weighed for a portion. */
const GRAIN =
  /\b(pasta|spaghetti(ni)?|penne|fusilli|linguine|tagliatelle|orecchiette|macaroni|lasagne|lasagna|farfalle|rigatoni|orzo|fettuccine|conchiglie|pappardelle|tortiglioni|paccheri|ditalini|bucatini|casarecce|gemelli|cavatappi|strozzapreti|trofie|tagliolini|capellini|maccheroni|noodles?|udon|soba|rice|couscous|bulgur|bulghur|quinoa|barley|farro|freekeh|buckwheat|millet|spelt)\b/;
/** Dried pulses. */
const LEGUME =
  /\b(chickpeas?|garbanzos?|lentils?|(kidney|black|white|cannellini|borlotti|pinto|navy|haricot|butter|adzuki|aduki|mung|cranberry|black-eyed|flageolet|great northern|black turtle) beans?|split peas|black-eyed peas|dal|dhal)\b/;
const NOT_STAPLE =
  /\b(broad beans?|fava beans?|lima beans?|edamame|soy ?beans?|wax beans?|yellow beans?|rice (paper|vinegar|wine|flour|milk|drink|cakes?|crackers?|syrup|bran)|(cauliflower|broccoli|puffed) rice|riced|flour|pasta sauce|noodle soup|bean sprouts?|bean paste|baked beans|green beans|runner beans|french beans|string beans|vanilla|coffee|cocoa|jelly|sauce|hummus|crisps|chips|flakes|crackers|tortillas?|lentil pasta|chickpea pasta|bean pasta)\b/;

/** Whether a line's item is a staple (grain, pasta, rice or dried pulse). */
export function isStaple(item: string): boolean {
  const t = fold(item);
  if (NOT_STAPLE.test(t)) return false;
  return GRAIN.test(t) || LEGUME.test(t);
}
/** Whether a line's item is a grain or pasta weighed for the 80 g main-course portion. */
export function isPortionGrain(item: string): boolean {
  const t = fold(item);
  return !NOT_STAPLE.test(t) && GRAIN.test(t);
}

const COOKED_WORD = /\b(canned|tinned|cooked|pre-?cooked|precooked|leftover|drained|boiled|ready[- ]to[- ]eat|microwave(able)?|instant)\b/;
const FOOD_COOKED_STATE = /\b(cooked|boiled|canned|drained|steamed|microwaved|ready-to-heat|ready to eat)\b/;

/* ------------------------------------------------------------- wording --- */

const SUBSTITUTION = /\b(in place of|instead of|replaces? the|replacing|swap(ped)? for|classic version)\b/;
const STAPLE_STATE_WORD = /\b(dried|uncooked)\b/;

/** Wording problems on one line (raw, item, note). */
export function wordingProblems(ing: Pick<ValidatableIngredient, 'raw' | 'item' | 'note'>): string[] {
  const text = fold(`${ing.raw} ${ing.item ?? ''} ${ing.note ?? ''}`);
  const out: string[] = [];
  if (/\bhandfuls?\b/.test(text)) out.push('"handful" — write the weight in grams');
  if (/≈/.test(text)) out.push('"≈" conversion note — list the dry/raw weight itself');
  const sub = SUBSTITUTION.exec(text);
  if (sub) out.push(`substitution annotation ("${sub[1]}") — the recipe simply uses the ingredient`);
  if (STAPLE_STATE_WORD.test(text) && isStaple(ing.item || ing.raw)) {
    out.push(`"${STAPLE_STATE_WORD.exec(text)![1]}" on a staple — the note says "dry"`);
  }
  return out;
}

/* ---------------------------------------------------------------- eggs --- */

const EGG_ITEM = /^(?:whole |large |medium |small |extra-large |free-range |organic )*eggs?(?: (?:yolks?|whites?))?$/i;
const EGG_SIZE_WORD = /\b(small|medium|large|extra-large|xl|jumbo|size [smlx]+)\b/i;
export function isEggItem(item?: string | null): boolean {
  return !!item && EGG_ITEM.test(item.trim());
}

/* ---------------------------------------------------------------- drinks --- */

const STEEP_SOLID = /\btea ?bags?\b|\b(tea|rooibos|chamomile|hibiscus|mate|earl grey|sencha|oolong|darjeeling)\s+(leaves|leaf)\b|\bloose[- ]leaf\b|\bcoffee (beans?|grounds?)\b|\bground coffee\b|\bespresso beans\b|\bcoffee, ground\b/;
const LIQUID_WORD = /\b(water|ice|soda|milk|juice|tea|coffee|espresso|kefir|kombucha|lemonade|broth|smoothie|yogurt|yoghurt|cream|drink|tonic|cider|nectar|buttermilk|lassi|ayran|infusion|cordial)\b/;

/* ---------------------------------------------------------------- check --- */

const MAIN_GRAMS_PER_SERVING = 80;
const PORTION_TOLERANCE_G = 5;
const MIN_PORTION_GRAIN_G = 30;

/** Mass units a weighed line is stored in. */
const isMassUnit = (unit?: string | null) => classifyUnit(unit) === 'mass';

/** The recipe's single pasta/grain line weighed for a portion (≥ 30 g per serving), or null. */
export function portionGrainLine<T extends ValidatableIngredient>(ings: T[], servings: number): { index: number; ing: T } | null {
  const hits: number[] = [];
  ings.forEach((ing, i) => {
    if (ing.excludeFromNutrition || !isPortionGrain(ing.item || ing.raw)) return;
    if (!isMassUnit(ing.unit) || ing.grams == null) return;
    if (ing.grams / servings >= MIN_PORTION_GRAIN_G) hits.push(i);
  });
  return hits.length === 1 ? { index: hits[0], ing: ings[hits[0]] } : null;
}

/** Main-course recipes exempt from the 80 g rule (a pasta frittata uses leftover pasta as a binder). */
const PORTION_EXEMPT_TITLE = /\bfrittata\b/i;

/** The house-rule findings for one recipe. `recipe.body` (method + tips markdown) feeds MEAT_SUGGESTION. */
export function checkHouseRules(recipe: ValidatableRecipe, foodById: Map<number, FoodRecord>): HouseIssue[] {
  const out: HouseIssue[] = [];
  const ings = recipe.ingredients ?? [];
  const label = (ing: ValidatableIngredient) => `"${ing.raw}"`;
  const course = normalizeCourse(recipe.course);

  ings.forEach((ing, idx) => {
    const item = ing.item || ing.raw;
    const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
    const why = forbiddenReason(`${item} ${ing.note ?? ''}`, food);
    if (why) out.push({ severity: 'error', code: 'FORBIDDEN_INGREDIENT', ingredientIndex: idx, message: `${label(ing)}: ${why}` });
    for (const w of wordingProblems(ing)) out.push({ severity: 'error', code: 'FORBIDDEN_WORDING', ingredientIndex: idx, message: `${label(ing)}: ${w}` });
    const nd = notDryStaple(ing, food);
    if (nd) out.push({ severity: 'error', code: 'NOT_DRY_STAPLE', ingredientIndex: idx, message: `${label(ing)}: ${nd}` });

    if (/\bolive oil\b/i.test(item) && ing.quantity != null) {
      const canon = canonicalUnit(ing.unit);
      if (canon !== 'tablespoon' && canon !== 'teaspoon') {
        out.push({ severity: 'warn', code: 'OLIVE_OIL_UNIT', ingredientIndex: idx, message: `${label(ing)}: olive oil is stored in tbsp/tsp` });
      }
    }
    if (ing.fdcId != null && UNFORTIFIED_PLANT_MILK[ing.fdcId] != null) {
      out.push({ severity: 'warn', code: 'FORTIFIED_PLANT_MILK', ingredientIndex: idx, message: `${label(ing)}: plant milks are unfortified (fdcId ${UNFORTIFIED_PLANT_MILK[ing.fdcId]})` });
    }
    if (isSoySauce(item) && (ing.fdcId !== HOUSE_FOODS.lowSodiumSoySauce || !/^low-sodium soy sauce$/i.test(item.trim()))) {
      out.push({ severity: 'warn', code: 'SOY_SAUCE_SALT', ingredientIndex: idx, message: `${label(ing)}: soy sauce is low-sodium soy sauce (fdcId ${HOUSE_FOODS.lowSodiumSoySauce})` });
    }
    if (isFreshGinger(item, ing.note, ing.unit) && ing.quantity != null && canonicalUnit(ing.unit) !== 'gram') {
      out.push({ severity: 'warn', code: 'GINGER_UNIT', ingredientIndex: idx, message: `${label(ing)}: fresh ginger is stored in grams` });
    }
    if (isEggItem(item) && ing.quantity != null) {
      const dim = classifyUnit(ing.unit);
      if (dim === 'mass' || dim === 'volume' || EGG_SIZE_WORD.test(`${ing.unit ?? ''} ${item}`)) {
        out.push({ severity: 'warn', code: 'EGG_COUNT', ingredientIndex: idx, message: `${label(ing)}: eggs are stored as a count without a size word` });
      }
    }
  });

  if (course === 'main' && !PORTION_EXEMPT_TITLE.test(recipe.title ?? '')) {
    const servings = recipe.servings ?? 4;
    const grain = portionGrainLine(ings, servings);
    if (grain) {
      const want = servings * MAIN_GRAMS_PER_SERVING;
      if (Math.abs(grain.ing.grams! - want) > PORTION_TOLERANCE_G) {
        out.push({
          severity: 'error',
          code: 'PORTION_80',
          ingredientIndex: grain.index,
          message: `${label(grain.ing)}: ${grain.ing.grams} g for ${servings} servings — a main course takes ${MAIN_GRAMS_PER_SERVING} g dry per serving (${want} g)`,
        });
      }
    }
  }

  if (course === 'drink') {
    let liquid = false;
    ings.forEach((ing, idx) => {
      const item = ing.item || ing.raw;
      const t = fold(item);
      const food = ing.fdcId != null ? foodById.get(ing.fdcId) : undefined;
      if (isWaterLike(item)) {
        if (ing.excludeFromNutrition) {
          out.push({ severity: 'error', code: 'DRINK_WATER', ingredientIndex: idx, message: `${label(ing)}: water and ice in a drink are drunk — count them, matched to plain water` });
        }
        liquid = true;
        return;
      }
      if (STEEP_SOLID.test(t) && !ing.excludeFromNutrition && !(food && /\bbrewed\b/i.test(food.description))) {
        out.push({ severity: 'error', code: 'DRINK_WATER', ingredientIndex: idx, message: `${label(ing)}: list the steeped tea/coffee as the brewed beverage (e.g. "250 ml black tea, brewed from 1 tbsp loose leaves")` });
      }
      if (LIQUID_WORD.test(t) || food?.category === 'Beverages' || /\bjuice\b/i.test(food?.description ?? '')) liquid = true;
    });
    if (!liquid && ings.length) out.push({ severity: 'warn', code: 'DRINK_WATER', message: 'a drink with no liquid line (water, milk, juice, tea…)' });
  }

  if (recipe.body) out.push(...methodIssues(recipe.body));
  return out;
}

/** MEAT_SUGGESTION findings for a recipe's method and tips text. */
export function methodIssues(body: string): HouseIssue[] {
  return meatSuggestions(body).map((m) => ({
    severity: 'error' as const,
    code: 'MEAT_SUGGESTION' as const,
    message: `method/tips suggest meat ("${m}") — fish and seafood are fine, meat is not`,
  }));
}

/** Why a staple line is not stored as its dry record, or null. */
export function notDryStaple(ing: ValidatableIngredient, food?: FoodRecord): string | null {
  const item = ing.item || ing.raw;
  if (ing.excludeFromNutrition || !isStaple(item)) return null;
  const text = fold(`${item} ${ing.note ?? ''}`);
  const saysDry = /\b(dry|raw)\b/.test(text);
  const cookedWord = COOKED_WORD.exec(text) ?? (isCanned(ing.raw, ing.unit) ? ['can', 'canned'] : null);
  const foodCooked = food ? FOOD_COOKED_STATE.test(fold(food.description)) && !/\b(raw|dry|uncooked)\b/.test(fold(food.description)) : false;
  if (foodCooked) return `matched the cooked/canned record "${food!.description}" — store the dry record at its dry weight, note "dry", with the soaking and cooking as a method step ("82 g chickpeas, dry")`;
  if (cookedWord && !saysDry) return `says "${cookedWord[1]}" — store the dry weight, note "dry", with the soaking and cooking as a method step ("82 g chickpeas, dry")`;
  if (isFreshPasta(item) && !saysDry) return 'fresh pasta — store the dry pasta at its dry-matter weight with the note "dry" and the cooking as a method step';
  return null;
}

/** A line measured in cans or tins ("1 can chickpeas", "2 tins cannellini beans") is canned. */
function isCanned(raw: string, unit?: string | null): boolean {
  return /\b(cans?|tins?)\b/.test(fold(raw)) || /^(cans?|tins?)$/i.test(unit ?? '');
}

/** Fresh pasta or noodles ("fresh tagliatelle"), which the lists give as the dry weight. */
function isFreshPasta(item: string): boolean {
  const t = fold(item);
  return /\bfresh\b/.test(t) && GRAIN.test(t) && !/\brice\b/.test(t) && !NOT_STAPLE.test(t);
}

/** Shellfish whose flesh a method calls "the meat". */
const SHELLFISH = /\b(mussels?|shrimps?|prawns?|crabs?|lobsters?|clams?|scallops?|oysters?|squid|octopus|langoustines?|crayfish|shells?)\b/;

/**
 * Meat words the method/tips text suggests, deduplicated. A bare "meat" in a sentence about
 * shellfish ("open the mussels and put the meat in a bowl") is the shellfish's flesh, unless the
 * sentence offers meat as an alternative ("meat or fish").
 */
export function meatSuggestions(body: string): string[] {
  const found = new Set<string>();
  const re = new RegExp(MEAT.source, 'g');
  for (const sentence of fold(body).split(/(?<=[.!?])\s+|\n+/)) {
    const t = stripAllowedMeat(sentence);
    for (const m of t.matchAll(re)) {
      if (m[1] === 'meat' && SHELLFISH.test(t) && !/\bmeat (or|and)\b|\b(or|and) meat\b/.test(t)) continue;
      found.add(m[1]);
    }
  }
  return [...found];
}

/* ------------------------------------------------------------ duplicates --- */

export interface CorpusRecipe {
  slug: string;
  kifliId?: number | null;
  ingredients?: ValidatableIngredient[];
}

/** Ingredient fdcId → share of the recipe's counted weight. */
function weightProfile(ings: ValidatableIngredient[] = []): Map<number, number> {
  const w = new Map<number, number>();
  for (const i of ings) {
    if (i.excludeFromNutrition || i.fdcId == null || !(i.grams! > 0)) continue;
    w.set(i.fdcId, (w.get(i.fdcId) ?? 0) + i.grams!);
  }
  const total = [...w.values()].reduce((a, b) => a + b, 0);
  for (const [k, v] of w) w.set(k, total > 0 ? v / total : 0);
  return w;
}

/** Jaccard of two fdcId sets and the histogram intersection of their weight shares. */
export function recipeSimilarity(a: ValidatableIngredient[] = [], b: ValidatableIngredient[] = []): { jaccard: number; weight: number } {
  const pa = weightProfile(a);
  const pb = weightProfile(b);
  if (!pa.size || !pb.size) return { jaccard: 0, weight: 0 };
  let inter = 0;
  let weight = 0;
  for (const [k, v] of pa) {
    if (pb.has(k)) {
      inter++;
      weight += Math.min(v, pb.get(k)!);
    }
  }
  return { jaccard: inter / (pa.size + pb.size - inter), weight };
}

export const DUPLICATE_JACCARD = 0.75;
export const DUPLICATE_WEIGHT = 0.75;

/**
 * DUPLICATE_RECIPE warnings over a set of candidates checked against a corpus: a pair whose
 * ingredient-fdcId Jaccard and weight similarity both reach 0.75, or a candidate whose kifli id
 * is listed as a near-duplicate in scripts/kifli/excluded-ids.json (`excluded`: id → kept slug).
 */
export function findDuplicateRecipes(
  candidates: CorpusRecipe[],
  corpus: CorpusRecipe[],
  excluded: Record<string, string> = {},
): { slug: string; issue: HouseIssue }[] {
  const out: { slug: string; issue: HouseIssue }[] = [];
  const seenPair = new Set<string>();
  for (const c of candidates) {
    const listed = c.kifliId != null ? excluded[String(c.kifliId)] : undefined;
    if (listed) {
      const removed = /^removed:\s*(.*)$/.exec(listed);
      const message = removed
        ? `kifli id ${c.kifliId} was removed by the owner (${removed[1]}) — listed in excluded-ids.json`
        : `kifli id ${c.kifliId} is listed in excluded-ids.json as a near-duplicate of ${listed}`;
      out.push({ slug: c.slug, issue: { severity: 'warn', code: 'DUPLICATE_RECIPE', message } });
    }
    for (const o of corpus) {
      if (o.slug === c.slug) continue;
      const key = [c.slug, o.slug].sort().join('|');
      if (seenPair.has(key)) continue;
      const s = recipeSimilarity(c.ingredients, o.ingredients);
      if (s.jaccard >= DUPLICATE_JACCARD && s.weight >= DUPLICATE_WEIGHT) {
        seenPair.add(key);
        out.push({
          slug: c.slug,
          issue: {
            severity: 'warn',
            code: 'DUPLICATE_RECIPE',
            message: `near-duplicate of ${o.slug} (ingredient overlap ${Math.round(s.jaccard * 100)} %, weight similarity ${Math.round(s.weight * 100)} %)`,
          },
        });
      }
    }
  }
  return out;
}

/* ============================================================ normalize === */

/** One ingredient line as the importers hold it before parsing and matching. */
export interface NormalizableLine {
  /** The ingredient line as written ("2 tbsp olive oil"). */
  raw: string;
  /** Pinned food, when known. */
  fdcId?: number | null;
  /** Known weight in grams, when the line carries one beyond its text. */
  grams?: number | null;
  exclude?: boolean;
  cooking?: string | null;
  proxyOk?: boolean;
  group?: string;
}

export interface NormalizableRecipe {
  title?: string;
  course?: string;
  servings?: number;
  ingredients: NormalizableLine[];
  /** Method steps, one per entry. */
  steps?: string[];
  tips?: string[];
}

export interface NormalizeResult<T> {
  value: T;
  /** Human-readable list of what was changed. */
  changes: string[];
}

/** Foods the auto-fixes pin. */
export const HOUSE_FOODS = {
  oliveOil: 171413,
  oatMilk: 9000103,
  plantCream: 82011214,
  plantSourCream: 82019693,
  greekYogurt: 171304,
  vegetableBroth: 171583,
  honey: 169640,
  water: 174158,
  blackTea: 173227,
  greenTea: 171917,
  herbalTea: 173232,
  coffee: 171890,
  wholeWheatPasta: 169738,
  brownRice: 169703,
  wholeWheatFlour: 790085,
  wholeWheatBread: 172688,
  lemonJuice: 167747,
  redWineVinegar: 172240,
  lowSodiumSoySauce: 172473,
  almondMilk: 9000101,
  soyMilk: 9000102,
} as const;

/**
 * Fortified USDA plant drinks → the unfortified record the house milks match: the house plant
 * milks carry no added vitamins or minerals (scripts/build-unfortified-plant-milks.mjs).
 * 82018905, the Ciqual oat drink, maps too: its record lacks protein and most micronutrients.
 */
export const UNFORTIFIED_PLANT_MILK: Readonly<Record<number, number>> = {
  174832: HOUSE_FOODS.almondMilk,
  1999631: HOUSE_FOODS.almondMilk,
  2257045: HOUSE_FOODS.almondMilk,
  1999630: HOUSE_FOODS.soyMilk,
  2257046: HOUSE_FOODS.oatMilk,
  82018905: HOUSE_FOODS.oatMilk,
};

/** Dry/raw record and its cooked or canned counterpart, for converting a cooked staple to dry by dry matter. */
interface StapleRecord {
  re: RegExp;
  name: string;
  dryId: number;
  cookedId: number;
  /** Dry-matter fallback when no food lookup is passed: (100 − water) of cooked and dry. */
  cookedDm: number;
  dryDm: number;
  legume: boolean;
  /** Pulses cooked without soaking (lentils, split peas, mung beans). */
  noSoak?: boolean;
  /** An item naming another variety than the record ("brown basmati rice", "udon") keeps the
   *  converted dry weight but is left unpinned, so the matcher resolves its own record. */
  otherVariety?: RegExp;
}
const STAPLES: StapleRecord[] = [
  { re: /\bchickpeas?\b|\bgarbanzos?\b/, name: 'chickpeas', dryId: 173756, cookedId: 173801, cookedDm: 33.1, dryDm: 88.3, legume: true },
  { re: /\bkidney beans?\b/, name: 'kidney beans', dryId: 173744, cookedId: 174285, cookedDm: 31.9, dryDm: 88.2, legume: true },
  { re: /\bblack beans?\b|\bblack turtle beans?\b/, name: 'black beans', dryId: 175186, cookedId: 175188, cookedDm: 24.4, dryDm: 89, legume: true },
  { re: /\bpinto beans?\b/, name: 'pinto beans', dryId: 175199, cookedId: 173797, cookedDm: 30, dryDm: 88.7, legume: true },
  { re: /\bborlotti beans?\b|\bcranberry beans?\b/, name: 'borlotti beans', dryId: 175189, cookedId: 173736, cookedDm: 35.4, dryDm: 87.6, legume: true },
  { re: /\bnavy beans?\b|\bharicot beans?\b/, name: 'navy beans', dryId: 173745, cookedId: 173747, cookedDm: 29.6, dryDm: 87.9, legume: true },
  { re: /\bgreat northern beans?\b/, name: 'great northern beans', dryId: 175190, cookedId: 175192, cookedDm: 30.1, dryDm: 89.3, legume: true },
  { re: /\bflageolet beans?\b|\bfrench beans?\b/, name: 'flageolet beans', dryId: 173738, cookedId: 173739, cookedDm: 33.4, dryDm: 89.2, legume: true },
  { re: /\ba[dz]u?ki beans?\b/, name: 'adzuki beans', dryId: 173727, cookedId: 173728, cookedDm: 33.7, dryDm: 86.6, legume: true },
  { re: /\bmung beans?\b/, name: 'mung beans', dryId: 174256, cookedId: 174257, cookedDm: 27.3, dryDm: 91, legume: true, noSoak: true },
  { re: /\bblack-eyed (beans?|peas)\b/, name: 'black-eyed peas', dryId: 173758, cookedId: 173760, cookedDm: 20.4, dryDm: 88, legume: true },
  { re: /\bsplit peas\b/, name: 'split peas', dryId: 172428, cookedId: 172429, cookedDm: 30.5, dryDm: 91.3, legume: true, noSoak: true },
  { re: /\b(white|cannellini|butter) beans?\b|\bbeans\b/, name: 'white beans', dryId: 175202, cookedId: 175204, cookedDm: 29.9, dryDm: 88.7, legume: true, otherVariety: /\b(mixed|baked|refried)\b/ },
  { re: /\blentils?\b|\bdh?al\b/, name: 'lentils', dryId: 172420, cookedId: 172421, cookedDm: 30.4, dryDm: 91.7, legume: true, noSoak: true, otherVariety: /\b(red|pink|yellow|beluga|black|puy|dh?al)\b/ },
  { re: /\bquinoa\b/, name: 'quinoa', dryId: 168874, cookedId: 168917, cookedDm: 28.4, dryDm: 86.7, legume: false },
  { re: /\bbulgu?h?r\b/, name: 'bulgur', dryId: 170688, cookedId: 170287, cookedDm: 22.2, dryDm: 91, legume: false },
  { re: /\bcouscous\b/, name: 'couscous', dryId: 169699, cookedId: 169700, cookedDm: 27.4, dryDm: 91.4, legume: false },
  { re: /\bbarley\b/, name: 'pearl barley', dryId: 170284, cookedId: 170285, cookedDm: 31.2, dryDm: 89.9, legume: false },
  { re: /\bmillet\b/, name: 'millet', dryId: 169702, cookedId: 168871, cookedDm: 28.6, dryDm: 91.3, legume: false },
  { re: /\bspelt\b|\bfarro\b/, name: 'spelt', dryId: 169745, cookedId: 169746, cookedDm: 33.4, dryDm: 89, legume: false, otherVariety: /\bfarro\b/ },
  { re: /\bbuckwheat\b/, name: 'buckwheat groats', dryId: 170685, cookedId: 170686, cookedDm: 24.4, dryDm: 91.6, legume: false },
  { re: /\bsoba\b/, name: 'soba noodles', dryId: 168906, cookedId: 168907, cookedDm: 27, dryDm: 93.1, legume: false },
  { re: /\bwild rice\b/, name: 'wild rice', dryId: 169726, cookedId: 168897, cookedDm: 26.1, dryDm: 92.2, legume: false },
  {
    re: /\brice\b/,
    name: 'brown rice',
    dryId: 169703,
    cookedId: 169704,
    cookedDm: 29.7,
    dryDm: 88.2,
    legume: false,
    otherVariety: /\b(basmati|jasmine|arborio|carnaroli|sushi|short[- ]grain|medium[- ]grain|black|red|glutinous|sticky|noodles?)\b/,
  },
  {
    re: GRAIN,
    name: 'whole-wheat pasta',
    dryId: 169738,
    cookedId: 168910,
    cookedDm: 38.2,
    dryDm: 91.8,
    legume: false,
    otherVariety: /\b(noodles?|udon|ramen|somen|spelt|lentil|chickpea|gluten[- ]free)\b/,
  },
];

/** USDA "Pasta, fresh-refrigerated, plain, as purchased". */
const FRESH_PASTA_ID = 169727;

/** Drained weight of one standard 400 g can of pulses. */
const CAN_DRAINED_G = 240;

/* ---- formatting ---- */

const FRACTION_TEXT: [number, string][] = [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']];
function qty(n: number): string {
  const whole = Math.floor(n + 1e-9);
  const rest = n - whole;
  if (rest < 0.02) return String(whole);
  const f = FRACTION_TEXT.find(([v]) => Math.abs(rest - v) < 0.02);
  if (f) return `${whole || ''}${f[1]}`;
  return String(Math.round(n * 100) / 100);
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const roundG = (n: number) => (n >= 20 ? Math.round(n) : round1(n));

function lineText(amount: string | null, item: string, note?: string | null): string {
  const n = note?.trim();
  return `${amount ? `${amount} ` : ''}${item}${n ? `, ${n}` : ''}`.replace(/\s+/g, ' ').trim();
}

/** Soy sauce, tamari or shoyu (not a soy-sauce-based product such as a marinade or kecap manis). */
export function isSoySauce(item?: string | null): boolean {
  return !!item && /\b(soy sauce|soya sauce|tamari|shoyu)\b/i.test(item) && !/\b(sweet|kecap|manis|marinade|glaze|dressing|mushroom)\b/i.test(item);
}

/** Fresh ginger root (not ground ginger, a spice measured by the spoon). */
export function isFreshGinger(item?: string | null, note?: string | null, unit?: string | null): boolean {
  if (!item || !/\bginger\b/i.test(item)) return false;
  if (/\b(ground|powder(ed)?|dried|crystalli[sz]ed|candied|pickled|syrup|ale|beer|juice|tea|paste|biscuits?|snaps|cookies?|bread)\b/i.test(item)) return false;
  // A bare "ginger" in spoons is the ground spice in most recipes; only call it fresh when the
  // line says so (fresh, grated, root, piece, slice, knob, thumb) or measures it by length.
  return /\b(fresh|freshly|grated|root|piece|pieces|slices?|knob|thumb|minced|chopped|young)\b/i.test(`${item} ${note ?? ''} ${unit ?? ''}`) || /^(cm|inch(es)?|in)$/i.test(unit ?? '');
}

/** Lines whose missing amount is deliberate (to taste, optional, a garnish). */
const NO_AMOUNT_LINE = /\b(to taste|optional|to serve|for serving|garnish|as needed|if needed|a little|a pinch)\b/i;

/** Grams of olive oil per tablespoon. */
export const OLIVE_OIL_G_PER_TBSP = 13.5;

/** Olive-oil amount in spoons: tbsp in ½ steps, tsp (½ steps) under ½ tbsp. */
export function oliveOilAmount(grams: number): { amount: string; grams: number } {
  const tbsp = grams / OLIVE_OIL_G_PER_TBSP;
  if (tbsp < 0.5) {
    const tsp = Math.max(0.5, Math.round(tbsp * 3 * 2) / 2);
    return { amount: `${qty(tsp)} tsp`, grams: round1((tsp / 3) * OLIVE_OIL_G_PER_TBSP) };
  }
  const t = Math.round(tbsp * 2) / 2;
  return { amount: `${qty(t)} tbsp`, grams: round1(t * OLIVE_OIL_G_PER_TBSP) };
}

/** Approximate weight of a line from its text (mass units exact; spoons/cups by a density). */
function lineGrams(parsed: ReturnType<typeof parseIngredientLine>, gPerMl: number): number | null {
  const est = estimateMetric(parsed);
  if (est.grams != null) return est.grams;
  if (est.milliliters != null) return est.milliliters * gPerMl;
  return null;
}

/** Grams for "N handfuls" of an item. */
function handfulGrams(item: string): number {
  const t = fold(item);
  if (/\b(parsley|cilantro|coriander|basil|mint|dill|chives?|herbs?|tarragon|chervil|sage|thyme|oregano)\b/.test(t)) return 10;
  if (/\b(spinach|rocket|arugula|lettuce|leaves|greens|kale|chard|watercress|salad|lamb'?s lettuce|sprouts)\b/.test(t)) return 30;
  if (/\b(nuts?|almonds?|walnuts?|pecans?|cashews?|hazelnuts?|pistachios?|seeds?|peanuts?|pine nuts|raisins?|cranberries)\b/.test(t)) return 30;
  if (/\b(berries|blueberries|raspberries|strawberries|cherries|grapes|tomatoes)\b/.test(t)) return 70;
  return 30;
}

/** Remove substitution annotations and "≈" notes from a line's text. */
function stripAnnotations(raw: string): string {
  return raw
    .replace(/\s*\([^)]*\b(in place of|instead of|replaces?|replacing|swap(ped)?|classic version)\b[^)]*\)/gi, '')
    .replace(/\s*[,;–-]\s*(in place of|instead of|replacing|swapped for)\b[^,;]*/gi, '')
    .replace(/\s*\(\s*≈[^)]*\)/g, '')
    .replace(/\s*≈\s*[\d.,]+\s*\w*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words of a butter note that make no sense on oil. */
const BUTTER_NOTE = /^(melted|softened|cold|cubed|diced|chilled|at room temperature|room temperature|unsalted|salted|cut into (small )?(pieces|cubes)|grated|for greasing|plus extra for greasing)$/i;

interface LineContext {
  course: ReturnType<typeof normalizeCourse>;
  foodById?: Map<number, FoodRecord>;
}

/** Dry-matter fraction of a record (from its water), or the fallback. */
function dmOf(foodById: Map<number, FoodRecord> | undefined, id: number, fallback: number): number {
  const w = foodById?.get(id)?.n?.water_g;
  return w != null ? 100 - w : fallback;
}

export interface NormalizedLine extends NormalizableLine {
  /** Extra lines the fix adds right after this one (lemon juice with a wine swap). */
  extra?: NormalizableLine[];
  /** The line is dropped (alcohol in a drink). */
  drop?: boolean;
  /** A method step the fix needs ("Soak the chickpeas overnight…"). */
  step?: string;
}

/**
 * Auto-fix one ingredient line to the house rules: forbidden ingredients swapped, cooked
 * staples to their dry weight, handfuls to grams, olive oil to spoons, eggs to a count, state
 * words to the note, and substitution annotations removed. The swap is never annotated.
 */
export function normalizeIngredient(
  line: NormalizableLine,
  ctx: { course?: string; foodById?: Map<number, FoodRecord> } = {},
): NormalizeResult<NormalizedLine> {
  const c: LineContext = { course: normalizeCourse(ctx.course), foodById: ctx.foodById };
  const reasons: string[] = [];
  let cur: NormalizedLine = { ...line };
  const set = (next: Partial<NormalizedLine>, why: string) => {
    cur = { ...cur, ...next };
    if (!reasons.includes(why)) reasons.push(why);
  };
  // One entry per line: the original and the final text, with the rules that changed it.
  const result = (): NormalizeResult<NormalizedLine> => ({
    value: cur,
    changes: reasons.length ? [`"${line.raw}" → ${cur.drop ? '(removed)' : `"${cur.raw}"`} (${reasons.join('; ')})`] : [],
  });

  const stripped = stripAnnotations(cur.raw);
  if (stripped !== cur.raw) set({ raw: stripped }, 'annotation removed');

  let p = parseIngredientLine(cur.raw);
  if (p.isGroupHeader || !p.item) return result();
  const t = fold(`${p.item} ${p.note ?? ''}`);
  const food = cur.fdcId != null ? c.foodById?.get(cur.fdcId) : undefined;
  const why = forbiddenReason(t, food);
  if (why) {
    const swapped = swapForbidden(p, t, why, c);
    if (swapped) {
      set(swapped, why.replace(/ \(use [^)]*\)$/, '').replace(/ \(".*$/, '').replace(/ \(matched.*$/, ''));
      p = parseIngredientLine(cur.raw);
    }
  }

  // Cooked / canned staple → its dry record by dry matter.
  if (!cur.drop && !cur.exclude && isStaple(p.item)) {
    const text = fold(`${p.item} ${p.note ?? ''} ${line.raw}`);
    const approx = /≈\s*([\d.,]+)\s*(g|kg)\s*(uncooked|dry|raw)/i.exec(line.raw);
    const notDry = !/\b(dry|raw)\b/.test(fold(`${p.item} ${p.note ?? ''}`));
    const fresh = notDry && isFreshPasta(p.item);
    const cooked = ((COOKED_WORD.test(text) || isCanned(line.raw, p.unit)) && notDry) || fresh;
    const rec0 = STAPLES.find((s) => s.re.test(fold(p.item)));
    // A staple with no dry/cooked record pair is left for the gate to report.
    if ((cooked || approx) && rec0) {
      // Fresh pasta converts from its own as-purchased record (≈ 31 % water).
      const rec = fresh && !approx ? { ...rec0, cookedId: FRESH_PASTA_ID, cookedDm: 69 } : rec0;
      let cookedG = lineGrams(p, 1);
      // "1 can (400 g) chickpeas" weighs the can's contents; the drained pulses are 60 % of it.
      if (cookedG != null && /\b(cans?|tins?)\b/i.test(line.raw) && rec.legume) cookedG *= CAN_DRAINED_G / 400;
      if (cookedG == null && p.quantity != null && (/^(cans?|tins?)$/i.test(p.unit ?? '') || /^(cans?|tins?)\b/i.test(p.item))) {
        cookedG = p.quantity * CAN_DRAINED_G;
      }
      if (cookedG == null && cur.grams != null) cookedG = cur.grams;
      const dryG = approx
        ? Number(approx[1].replace(',', '.')) * (approx[2].toLowerCase() === 'kg' ? 1000 : 1)
        : cookedG != null
          ? (cookedG * dmOf(c.foodById, rec.cookedId, rec.cookedDm)) / dmOf(c.foodById, rec.dryId, rec.dryDm)
          : null;
      if (dryG != null) {
        const g = Math.round(dryG);
        const name = cleanStapleName(p.item, rec);
        const soak = rec.legume && !rec.noSoak;
        const fdcId = rec.otherVariety?.test(fold(name)) ? null : rec.dryId;
        set(
          { raw: lineText(`${g} g`, name, 'dry'), fdcId, grams: g, cooking: 'boiled', proxyOk: undefined, step: stapleStep(name, rec, soak) },
          'cooked staple → dry weight by dry matter',
        );
        p = parseIngredientLine(cur.raw);
      }
    }
  }

  // "handful" → grams.
  if (/\bhandfuls?\b/i.test(cur.raw)) {
    const item = p.item.replace(/^handfuls?\s+(of\s+)?/i, '').trim();
    const n = p.quantity ?? 1;
    // A written weight ("2 handfuls spinach (about 50 g)") wins and leaves the note.
    const about = /\b(?:about|approx\.?|roughly)\s*([\d.]+)\s*g\b/i.exec(p.note ?? '');
    const note = about ? (p.note ?? '').replace(about[0], '').replace(/^[\s,;]+|[\s,;]+$/g, '') || null : p.note;
    const g = about ? Number(about[1]) : cur.grams != null && cur.grams > 0 ? cur.grams : n * handfulGrams(item);
    const raw = lineText(`${roundG(g)} g`, item, note);
    set({ raw, grams: roundG(g) }, 'handful → grams');
    p = parseIngredientLine(cur.raw);
  }

  // Olive oil → spoons.
  if (/\bolive oil\b/i.test(p.item) && p.quantity != null) {
    const canon = canonicalUnit(p.unitId ?? p.unit);
    if (canon !== 'tablespoon' && canon !== 'teaspoon') {
      const g = lineGrams(p, 0.91) ?? cur.grams;
      if (g != null && g > 0) {
        const o = oliveOilAmount(g);
        const raw = lineText(o.amount, p.item, p.note);
        set({ raw, grams: o.grams }, 'olive oil in spoons');
        p = parseIngredientLine(cur.raw);
      }
    }
  }

  // A fortified plant drink → its unfortified record.
  if (cur.fdcId != null && UNFORTIFIED_PLANT_MILK[cur.fdcId] != null) {
    // Same food without its fortificants, so a reviewed proxyOk carries over.
    set({ fdcId: UNFORTIFIED_PLANT_MILK[cur.fdcId] }, 'plant milk → unfortified record');
  }

  // Soy sauce and tamari → low-sodium soy sauce (≈ 35 % less sodium), on its record.
  if (isSoySauce(p.item) && (cur.fdcId !== HOUSE_FOODS.lowSodiumSoySauce || !/^low-sodium soy sauce$/i.test(p.item.trim()))) {
    const note = p.note?.replace(/\(?\s*(low[- ]sodium|reduced[- ]salt)( preferred)?\s*\)?,?\s*/gi, '').replace(/^,\s*|,\s*$/g, '').trim() || null;
    const amount = p.quantity != null ? `${qty(p.quantity)}${p.quantity2 != null ? `–${qty(p.quantity2)}` : ''}${p.unit ? ` ${p.unit}` : ''}` : null;
    set({ raw: lineText(amount, 'low-sodium soy sauce', note), fdcId: HOUSE_FOODS.lowSodiumSoySauce, proxyOk: undefined }, 'soy sauce → low-sodium');
    p = parseIngredientLine(cur.raw);
  }

  // Fresh ginger → grams (a spoon of grated ginger or "5 cm" is no measure; ground ginger is a spice).
  if (p.quantity != null && isFreshGinger(p.item, p.note, p.unit) && !NO_AMOUNT_LINE.test(cur.raw) && canonicalUnit(p.unitId ?? p.unit) !== 'gram' && cur.grams != null && cur.grams > 0) {
    const g = cur.grams >= 5 ? Math.round(cur.grams) : Math.round(cur.grams * 10) / 10;
    set({ raw: lineText(`${g} g`, p.item, p.note), grams: g }, 'fresh ginger in grams');
    p = parseIngredientLine(cur.raw);
  }

  // Eggs → a count without size words.
  const eggItem = p.item.replace(EGG_SIZE_WORD, '').replace(/\s+/g, ' ').trim();
  if (p.quantity != null && (isEggItem(p.item) || (EGG_SIZE_WORD.test(p.unit ?? '') && isEggItem(eggItem)))) {
    const dim = classifyUnit(p.unitId ?? p.unit);
    const sized = EGG_SIZE_WORD.test(`${p.unit ?? ''} ${p.item}`);
    if (dim === 'mass' || dim === 'volume' || sized) {
      const yolkOrWhite = /\b(yolks?|whites?)\b/i.test(eggItem);
      const per = /\byolks?\b/i.test(eggItem) ? 17 : /\bwhites?\b/i.test(eggItem) ? 33 : 50;
      const g = dim === 'mass' || dim === 'volume' ? lineGrams(p, 1.03) : null;
      const count = g != null ? Math.max(1, Math.round(g / per)) : p.quantity;
      const name = yolkOrWhite ? eggItem.replace(/^(whole )?/, '').replace(/\beggs? (yolk|white)\b/i, (_, w) => `egg ${w}`) : count === 1 ? 'egg' : 'eggs';
      const item = yolkOrWhite ? (count === 1 ? name.replace(/s$/, '') : /s$/.test(name) ? name : `${name}s`) : name;
      const raw = lineText(qty(count), item, p.note);
      set({ raw, grams: g != null ? roundG(g) : cur.grams }, 'eggs as a count');
      p = parseIngredientLine(cur.raw);
    }
  }

  // State words to the note: "dried/uncooked" on a staple → "dry"; a leading "dry"/"unsweetened"/herb "fresh".
  const stated = stateToNote(p);
  if (stated && stated !== cur.raw) set({ raw: stated }, 'state word to the note');

  return result();
}

/** The staple's name for a dry line ("canned chickpeas" → "chickpeas", "cooked rice" → "brown rice"). */
function cleanStapleName(item: string, rec: StapleRecord): string {
  let name = item
    .replace(/\b(canned|tinned|cooked|pre-?cooked|precooked|leftover|drained|boiled|ready[- ]to[- ]eat|microwave(able)?|instant|dried|dry|uncooked|fresh|cans?|tins?|of)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const f = fold(name);
  if (/\brice\b/.test(f) && !WHOLE.test(f)) name = name.replace(/\b(white\s+)?rice\b/i, 'brown rice');
  if (GRAIN.test(f) && !/\brice\b/.test(f) && !rec.legume && rec.name === 'whole-wheat pasta' && !WHOLE.test(f)) name = `whole-wheat ${name}`;
  return name || rec.name;
}

/** The method step that cooks a dry staple (the line itself says only "dry"). */
export function stapleStep(name: string, rec: Pick<StapleRecord, 'legume'>, soak: boolean): string {
  if (rec.legume && soak) {
    return `Soak the ${name} in plenty of cold water overnight, then drain, cover with fresh water and simmer until tender, about 1–1½ hours; drain.`;
  }
  if (rec.legume) return `Simmer the ${name} in plenty of water until tender, about 20–30 minutes; drain.`;
  return `Cook the ${name} in plenty of boiling salted water until tender; drain.`;
}

/** Move a state word to the note: "dried chickpeas" → "chickpeas, dry"; "fresh basil" → "basil, fresh". */
function stateToNote(p: ReturnType<typeof parseIngredientLine>): string | null {
  const amount = p.quantity != null ? `${qty(p.quantity)}${p.quantity2 != null ? `–${qty(p.quantity2)}` : ''}${p.unit ? ` ${p.unit}` : ''}` : null;
  const item = p.item.trim();
  const origNote = p.note?.trim() ?? '';
  let note = origNote;
  const staple = isStaple(item);
  // "uncooked" / "dried" in the note of a staple → "dry"
  if (staple && /\b(dried|uncooked)\b/i.test(note)) note = note.replace(/\((uncooked|dried)( weight)?\)/gi, 'dry').replace(/\b(uncooked|dried)( weight)?\b/gi, 'dry');
  const lead = /^(dry|dried|uncooked|unsweetened)\s+(.+)$/i.exec(item);
  const herb = /^fresh\s+((?:flat-leaf |curly |thai |lemon |wild )?(?:parsley|basil|coriander|cilantro|mint|dill|chives?|thyme|rosemary|sage|oregano|tarragon|marjoram|bay lea(?:f|ves)|chervil|lovage|herbs?)\b.*)$/i.exec(item);
  let newItem = item;
  let word: string | null = null;
  if (lead && (staple || /^unsweetened$/i.test(lead[1]))) {
    newItem = lead[2];
    word = /^unsweetened$/i.test(lead[1]) ? 'unsweetened' : 'dry';
  } else if (herb) {
    newItem = herb[1];
    word = 'fresh';
  } else if (staple && /\b(dried|uncooked)\b/i.test(item)) {
    newItem = item.replace(/\s*\b(dried|uncooked)\b\s*/i, ' ').trim();
    word = 'dry';
  }
  // Only a moved word rewrites the line, so an untouched line keeps its own wording.
  if (!word && note === origNote) return null;
  if (word && !new RegExp(`^${word}\\b`, 'i').test(note)) note = note ? `${word}, ${note}` : word;
  note = note.replace(/\bdry,\s*dry\b/gi, 'dry');
  const out = lineText(amount, newItem, note || null);
  return out === p.raw.trim() ? null : out;
}

/** The replacement for a forbidden line, or null when no automatic swap applies. */
function swapForbidden(
  p: ReturnType<typeof parseIngredientLine>,
  t: string,
  why: string,
  c: LineContext,
): Partial<NormalizedLine> | null {
  const amount = p.quantity != null ? `${qty(p.quantity)}${p.quantity2 != null ? `–${qty(p.quantity2)}` : ''}${p.unit ? ` ${p.unit}` : ''}` : null;
  const note = p.note?.trim() || null;
  const ml = estimateMetric(p).milliliters;
  const sameAmount = (item: string, fdcId: number, gPerMl: number | null, extra: Partial<NormalizedLine> = {}) => ({
    raw: lineText(amount, item, note),
    fdcId,
    grams: gPerMl != null && ml != null ? roundG(ml * gPerMl) : estimateMetric(p).grams ?? null,
    proxyOk: undefined,
    ...extra,
  });

  if (why.startsWith('butter')) {
    const butterG = lineGrams(p, 0.959);
    if (butterG == null) return { raw: lineText(null, 'extra virgin olive oil', note && !BUTTER_NOTE.test(note) ? note : null), fdcId: HOUSE_FOODS.oliveOil, grams: null };
    const o = oliveOilAmount(butterG * 0.75);
    return { raw: lineText(o.amount, 'extra virgin olive oil', note && !BUTTER_NOTE.test(note) ? note : null), fdcId: HOUSE_FOODS.oliveOil, grams: o.grams, proxyOk: undefined };
  }
  if (why.startsWith("cow's milk")) return sameAmount('unsweetened oat milk', HOUSE_FOODS.oatMilk, 1.03);
  if (why.startsWith('dairy cream')) {
    if (/\bsour cream\b|\bsmetana\b/.test(t)) return sameAmount('plant-based sour cream', HOUSE_FOODS.plantSourCream, 1.0);
    if (/\bcreme fraiche\b/.test(t)) return sameAmount('plant-based crème fraîche', HOUSE_FOODS.plantCream, 1.0);
    if (/\bwhip(ping|ped)?\b/.test(t)) return sameAmount('plant-based whipping cream', HOUSE_FOODS.plantCream, 1.0);
    return sameAmount('plant-based cooking cream', HOUSE_FOODS.plantCream, 1.0);
  }
  if (why.startsWith('mayonnaise')) return sameAmount('Greek yogurt', HOUSE_FOODS.greekYogurt, 1.03);
  if (why.startsWith('alcohol')) {
    if (c.course === 'drink') return { drop: true, raw: p.raw };
    const wine = /\b(wines?|sherry|vermouth|marsala|madeira|port|prosecco|champagne|cava|shaoxing)\b/.test(t);
    const red = /\bred\b|\bport\b|\bmarsala\b/.test(t);
    const base = sameAmount('vegetable broth', HOUSE_FOODS.vegetableBroth, 1.0);
    if (!wine || ml == null) return base;
    const tbsp = Math.max(0.5, Math.round((ml / 100) * 2) / 2);
    const extra: NormalizableLine = red
      ? { raw: `${qty(tbsp)} tbsp red wine vinegar`, fdcId: HOUSE_FOODS.redWineVinegar }
      : { raw: `${qty(tbsp)} tbsp lemon juice`, fdcId: HOUSE_FOODS.lemonJuice };
    return { ...base, extra: [{ ...extra, cooking: undefined }] };
  }
  if (why.startsWith('white rice')) {
    const item = /\brice\b/i.test(p.item) ? p.item.replace(/\b(white\s+)?((?:\w+\s+)?rice)\b/i, (_m, _w, r) => `brown ${r}`) : `brown ${p.item}`;
    return { raw: lineText(amount, item.replace(/\bbrown (long-grain|short-grain)\b/i, '$1 brown'), note), fdcId: null };
  }
  if (why.startsWith('refined pasta')) {
    return { raw: lineText(amount, `whole-wheat ${p.item.replace(/\b(white|regular|durum wheat|semolina|egg)\s+/i, '')}`, note), fdcId: HOUSE_FOODS.wholeWheatPasta };
  }
  if (why.startsWith('refined noodles')) {
    if (/\brice\b/.test(t)) return { raw: lineText(amount, p.item.replace(/\b(white\s+)?rice\b/i, 'brown rice'), note), fdcId: HOUSE_FOODS.brownRice, proxyOk: true };
    return { raw: lineText(amount, `whole-wheat ${p.item.replace(/\b(egg|wheat|white)\s+/i, '')}`, note), fdcId: HOUSE_FOODS.wholeWheatPasta, proxyOk: true };
  }
  if (why.startsWith('refined flour')) {
    return { raw: lineText(amount, 'whole-wheat flour', note), fdcId: HOUSE_FOODS.wholeWheatFlour };
  }
  if (why.startsWith('white bread') || why.startsWith('white breadcrumbs')) {
    if (/\bcrumbs\b|\bbreadcrumbs\b|\bpanko\b/.test(t)) return { raw: lineText(amount, 'whole-wheat breadcrumbs', note), fdcId: HOUSE_FOODS.wholeWheatBread, proxyOk: true };
    return { raw: lineText(amount, p.item.replace(/\b(white|plain)\s+/i, 'whole-wheat '), note), fdcId: HOUSE_FOODS.wholeWheatBread };
  }
  if (why.startsWith('sweetener')) {
    const honeyNote = note && !/\b(sifted|packed|granulated|caster|for dusting)\b/i.test(note) ? note : null;
    return { raw: lineText(amount, 'honey', honeyNote), fdcId: HOUSE_FOODS.honey, grams: estimateMetric(p).grams ?? null };
  }
  // Meat: no automatic swap (a meat line needs a human decision).
  return null;
}

/** Alcohol named in a method step (wine, beer, spirits; not the generic "alcohol"). */
const STEP_ALCOHOL = new RegExp(
  `\\b(dry |white |red )*${ALCOHOL.source.replace(/\|alcohol\|spirits\?/, '').replace(/^\\b/, '')}(?! vinegar)`,
  'gi',
);

/** The swap kind of a forbiddenReason ("butter/ghee (use …)", "butter (matched …)" → "butter"). */
function kindOf(why: string): string {
  return /^butter/.test(why) ? 'butter' : why.split(/[ (/]/)[0];
}

/** Method-step word swaps that follow an ingredient swap (only for words outside allowed phrases). */
const STEP_SWAPS: [RegExp, string, RegExp][] = [
  [/\bmelt the butter\b/gi, 'heat the olive oil', /$^/],
  [/\b(melted )?butter\b/gi, 'olive oil', NUT_BUTTER],
  [/\bghee\b/gi, 'olive oil', /$^/],
  [/\bmayonnaise\b|\bmayo\b/gi, 'Greek yogurt', /$^/],
  [STEP_ALCOHOL, 'broth', ALCOHOL_ALLOWED],
  [/\b(caster |brown |granulated |icing |powdered )?sugar\b/gi, 'honey', SWEETENER_ALLOWED],
  [/\b(maple |golden |agave |rice )?syrup\b/gi, 'honey', SWEETENER_ALLOWED],
];

/**
 * Auto-fix a whole recipe: every line through normalizeIngredient, plus the recipe-level rules —
 * a main course's single pasta/grain line set to servings × 80 g dry (servings never change),
 * and in a drink the water/ice counted, tea/coffee merged into its brewed record, and strained
 * infusers excluded. Method steps follow the swaps and gain the step a dry staple needs.
 */
export function normalizeRecipe(
  recipe: NormalizableRecipe,
  foodById?: Map<number, FoodRecord>,
): NormalizeResult<NormalizableRecipe> {
  const changes: string[] = [];
  const course = normalizeCourse(recipe.course);
  const servings = recipe.servings && recipe.servings > 0 ? recipe.servings : 4;
  let ings: NormalizableLine[] = [];
  const newSteps: string[] = [];
  const swappedKinds = new Set<string>();
  const droppedWords: string[] = [];

  for (const line of recipe.ingredients) {
    const r = normalizeIngredient(line, { course: recipe.course, foodById });
    changes.push(...r.changes);
    const { extra, drop, step, ...value } = r.value;
    if (r.changes.length) {
      const p = parseIngredientLine(line.raw);
      const why = forbiddenReason(`${p.item} ${p.note ?? ''}`, line.fdcId != null ? foodById?.get(line.fdcId) : undefined);
      if (why && !drop) swappedKinds.add(kindOf(why));
      const word = drop ? ALCOHOL.exec(fold(p.item))?.[1] : null;
      if (word) droppedWords.push(word);
    }
    if (drop) continue;
    if (step && !newSteps.includes(step)) newSteps.push(step);
    ings.push(value);
    for (const e of extra ?? []) {
      ings.push({ ...e, group: line.group, cooking: line.cooking });
      changes.push(`added "${e.raw}"`);
    }
  }

  // Main-course pasta/grain portion: servings × 80 g dry.
  if (course === 'main' && !PORTION_EXEMPT_TITLE.test(recipe.title ?? '')) {
    const parsed = ings.map((l) => {
      const p = parseIngredientLine(l.raw);
      return { raw: l.raw, item: p.item, unit: p.unit, note: p.note, grams: estimateMetric(p).grams ?? (classifyUnit(p.unitId ?? p.unit) === 'mass' ? l.grams : null), excludeFromNutrition: l.exclude };
    });
    const grain = portionGrainLine(parsed, servings);
    const want = servings * MAIN_GRAMS_PER_SERVING;
    if (grain && Math.abs(grain.ing.grams! - want) > PORTION_TOLERANCE_G) {
      const old = ings[grain.index];
      const p = parseIngredientLine(old.raw);
      const raw = lineText(`${want} g`, p.item, p.note);
      ings[grain.index] = { ...old, raw, grams: want };
      changes.push(`"${old.raw}" → "${raw}" (${MAIN_GRAMS_PER_SERVING} g dry per serving × ${servings})`);
    }
  }

  let steps = [...(recipe.steps ?? [])];
  if (course === 'drink') ({ ings, steps } = normalizeDrink(ings, steps, changes));

  // Method steps follow the ingredient swaps.
  const kinds = swappedKinds;
  const stepSwaps = STEP_SWAPS.filter(([, to]) =>
    (/olive oil/.test(to) && kinds.has('butter')) ||
    (to === 'Greek yogurt' && kinds.has('mayonnaise')) ||
    (to === 'broth' && kinds.has('alcohol')) ||
    (to === 'honey' && kinds.has('sweetener')),
  );
  steps = steps.map((s) => {
    let out = s;
    for (const [re, to, allowed] of stepSwaps) {
      out = out.replace(re, (m, ...rest) => {
        const offset = rest[rest.length - 2] as number;
        const window = fold(out.slice(Math.max(0, offset - 20), offset + m.length + 12));
        const a = new RegExp(allowed.source, allowed.flags.replace('g', ''));
        if (a.test(window)) return m;
        return /^[A-Z]/.test(m) ? to[0].toUpperCase() + to.slice(1) : to;
      });
    }
    if (out !== s) changes.push(`method: "${s.slice(0, 60)}${s.length > 60 ? '…' : ''}" follows the swap`);
    return out;
  });
  // An alcohol dropped from a drink leaves the method too: its sentences are removed.
  if (droppedWords.length) {
    const named = new RegExp(`\\b(${droppedWords.join('|')})\\b`, 'i');
    steps = steps
      .map((s) => {
        const kept = s.split(/(?<=[.!?])\s+/).filter((sentence) => !named.test(fold(sentence))).join(' ');
        if (kept !== s) changes.push(`method: removed the ${droppedWords.join('/')} from "${s.slice(0, 60)}${s.length > 60 ? '…' : ''}"`);
        return kept;
      })
      .filter((s) => s.trim());
  }
  const added = newSteps.filter((st) => !steps.some((s) => s.startsWith(st.slice(0, 30))));
  steps.unshift(...added);
  for (const st of added) changes.push(`method: added "${st.slice(0, 60)}…"`);

  return { value: { ...recipe, ingredients: ings, steps, tips: recipe.tips }, changes };
}

/** Strained infusers: whole spices, sprigs and slices that flavour the drink and are left behind. */
const INFUSER = /\b(cinnamon sticks?|star anise|whole cloves|cloves|cardamom pods?|sprigs?|ginger slices|slices? (of )?(fresh )?ginger|bay leaves|vanilla (pods?|beans?)|peppercorns|lemongrass( stalks?)?)\b/;

function normalizeDrink(ings: NormalizableLine[], steps: string[], changes: string[]): { ings: NormalizableLine[]; steps: string[] } {
  const strained = steps.some((s) => /\b(strain|sieve|remove the|discard|fish out)\b/i.test(s));
  let out = ings.map((l) => {
    const p = parseIngredientLine(l.raw);
    if (isWaterLike(p.item)) {
      const ml = estimateMetric(p).milliliters;
      const g = estimateMetric(p).grams ?? (ml != null ? ml : /\bcubes?\b/i.test(p.item) && p.quantity != null ? p.quantity * 25 : l.grams ?? null);
      if (l.exclude || l.fdcId !== HOUSE_FOODS.water) {
        changes.push(`"${l.raw}": water/ice counted (matched to plain water)`);
        return { ...l, exclude: false, fdcId: HOUSE_FOODS.water, grams: g != null ? roundG(g) : l.grams, cooking: 'raw' };
      }
      return l;
    }
    if (strained && !l.exclude && INFUSER.test(fold(p.item))) {
      changes.push(`"${l.raw}": strained infuser excluded from nutrition`);
      return { ...l, exclude: true };
    }
    return l;
  });

  // Steeped tea/coffee + its water → the brewed record.
  const steepIdx = out.findIndex((l) => !l.exclude && STEEP_SOLID.test(fold(parseIngredientLine(l.raw).item)));
  if (steepIdx >= 0) {
    const steep = out[steepIdx];
    const sp = parseIngredientLine(steep.raw);
    const st = fold(sp.item);
    const coffee = /\bcoffee|espresso\b/.test(st);
    const green = /\b(green|sencha|matcha)\b/.test(st);
    const herbal = /\b(rooibos|chamomile|hibiscus|herbal|mint|fruit)\b/.test(st);
    const waters = out
      .map((l, i) => ({ l, i, p: parseIngredientLine(l.raw) }))
      .filter(({ p }) => isWaterLike(p.item) && !/\bice\b/i.test(p.item) && !/\bsoda|sparkling\b/i.test(p.item));
    const w = waters.sort((a, b) => (estimateMetric(b.p).milliliters ?? 0) - (estimateMetric(a.p).milliliters ?? 0))[0];
    if (w) {
      const ml = estimateMetric(w.p).milliliters ?? w.l.grams ?? null;
      const kind = coffee ? 'coffee' : green ? 'green tea' : herbal ? `${sp.item.replace(/\s*(tea ?bags?|leaves|leaf|loose[- ]leaf)\b/gi, '').trim() || 'herbal'} tea` : 'black tea';
      const fdcId = coffee ? HOUSE_FOODS.coffee : green ? HOUSE_FOODS.greenTea : herbal ? HOUSE_FOODS.herbalTea : HOUSE_FOODS.blackTea;
      const from = lineText(sp.quantity != null ? `${qty(sp.quantity)}${sp.unit ? ` ${sp.unit}` : ''}` : null, sp.item, null);
      const raw = `${w.p.quantity != null ? `${qty(w.p.quantity)}${w.p.unit ? ` ${w.p.unit}` : ''} ` : ''}${kind}, brewed from ${from}`;
      const brewed: NormalizableLine = { ...w.l, raw, fdcId, grams: ml != null ? roundG(ml) : w.l.grams, exclude: false, cooking: 'raw', proxyOk: undefined };
      changes.push(`"${steep.raw}" + "${w.l.raw}" → "${raw}"`);
      out = out.map((l, i) => (i === w.i ? brewed : l)).filter((_, i) => i !== steepIdx);
    } else {
      changes.push(`"${steep.raw}": steeped solid excluded (no water line to brew it with)`);
      out = out.map((l, i) => (i === steepIdx ? { ...l, exclude: true } : l));
    }
  }
  return { ings: out, steps };
}
