#!/usr/bin/env node
/**
 * Classify every bundled food for the two inflammation-score inputs that composition alone
 * cannot see, and write them to src/data/fii-food-classes.json (read by src/core/fii.ts):
 *
 *   fs     — the FREE-SUGAR FRACTION of the food's total sugars (WHO 2015 free sugars:
 *            added mono- and disaccharides plus the sugars naturally in honey, syrups and
 *            fruit juices; NOT the sugars of intact fruit, vegetables or milk). Estimated by
 *            the category decision tree of Louie 2015 as refined for the WHO definition by
 *            Wanselius 2019, run per food:
 *              1. no sugar                                         → 0
 *              2. intact fruit, vegetables, legumes, nuts, grains, plain dairy and
 *                 unsweetened plant milks, unsweetened dried fruit → 0
 *              3. sugars, honey, syrups, jams, confectionery, juices, sugar-containing
 *                 non-dairy drinks, sugar in a food with no intrinsic sugar (meat, fish) → 1
 *              5. a sweetened variety of a step-2 food (canned in syrup, sweetened yogurt,
 *                 sweetened plant milk, sweet bakery) → compared with the unsweetened
 *                 reference: free = total − the reference's sugar per gram of dry matter ×
 *                 the food's dry matter (steps 5 and 7, "borrow from a similar food")
 *              6. sweetened dairy with an analysed lactose value → total − lactose
 *             10. anything else with sugar                         → 0.5 (last resort)
 *            Purées and pastes (structure broken down) take the configured purée fraction
 *            (fii-parameters.json `pureeFreeSugarFraction`), the same one an ingredient
 *            marked `prep: blended` takes — WHO-as-operationalised by Wanselius excludes
 *            purées, the UK (SACN, Swan 2018) counts them, and the inflammation evidence
 *            does not separate them from whole fruit (Thomassen 2026).
 *   fv     — true for fruit and vegetables, the foods whose sugars an ingredient-level
 *            `prep: blended` (or `juiced`) re-classifies.
 *   matrix — the food-matrix class whose composition-blind correction applies
 *            (fii-parameters.json `matrixDeltas`): milk, cheese, fermented-milk (yogurt,
 *            kefir) or soy (tofu, soy milk, tempeh, natto, edamame, soybeans).
 *   age    — the food's class for the dietary-AGE adjustment (fii-parameters.json
 *            `ageAdjustment`): meat (incl. poultry and fish), egg, starch (grains, legumes,
 *            potatoes, bakery), nut, produce; and `ageCooked`, the dry-heat method the food
 *            record already carries (a bread is baked, "dry roasted" nuts are roasted), which
 *            floors the ingredient's own cooking method.
 *   trans  — the origin of the food's trans fat: 'industrial' (partially hydrogenated oils;
 *            processed fats and the foods made with them) or 'natural' (ruminant fat in dairy
 *            and ruminant meat, plus the traces in other unprocessed foods). Only industrial
 *            trans is scored pro-inflammatory (Valenzuela 2021; Radtke 2017).
 *
 * Each entry carries the rule that decided it, so the classification is auditable; the run
 * prints the count per rule. Re-run after the food data changes.
 *
 * Usage: node scripts/build-fii-food-classes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFdc } from './lib/fdc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

log('→ loading foods…');
const foods = [
  ...read('src/data/usda-foods.json'),
  ...read('src/data/japan-foods.json'),
  ...read('src/data/france-foods.json'),
  ...read('src/data/custom-foods.json'),
];
const { pureeFreeSugarFraction: PUREE } = read('src/data/fii-parameters.json');
if (!(PUREE >= 0 && PUREE <= 1)) throw new Error('fii-parameters.json pureeFreeSugarFraction must be in [0, 1]');
log(`  ${foods.length} foods; purée free-sugar fraction ${PUREE}`);
log('→ loading USDA FDC records (analysed lactose, nutrient 213)…');
const fdc = loadFdc({ log });

const text = (f) => `${f.description ?? ''} ${f.nameJa ?? ''} ${f.nameFr ?? ''}`.toLowerCase();
const sugarOf = (f) => (Number.isFinite(f.n?.sugar_g) ? f.n.sugar_g : null);
const dryMatter = (f) => (Number.isFinite(f.n?.water_g) ? Math.max(1, 100 - f.n.water_g) : null);

// ---- vocabulary (English USDA/Ciqual descriptions + Japanese MEXT names) ----
const SWEETENER = /\b(sugars?|honey|syrups?|molasses|agave|treacle|jams?|jelly|jellies|marmalade|preserves|candies|candy|confection\w*|frosting|icing|fondant|marshmallow\w*|caramel\w*|toffee|fudge|chocolate|cocoa mix|gelatin dessert|sorbet|sweetened condensed|dulce)\b|砂糖|はちみつ|蜂蜜|シロップ|ジャム|マーマレード|水あめ|黒蜜|メープル|ようかん|まんじゅう|キャンデー|チョコレート|ゼリー/;
const JUICE = /\bjuices?\b|\bnectar\b|\bconcentrate\b|\bcoconut water\b|ジュース|果汁|ネクター|ココナッツウォーター/;
const SWEETENED = /\bsweetened\b|\bwith (added )?sugar\b|\b(heavy|light|extra heavy|extra light) syrup\b|\bsyrup pack\b|\bin syrup\b|\bjamu\b|maamareedo|缶詰|甘煮|佃煮|tsukuda煮|uzura豆|budou豆|\bcandied\b|\bglazed\b|\bhoney[- ]roasted\b|\bflavou?red\b|\bfruit\b.*\byogurt\b|\byogurt\b.*\b(fruit|vanilla|strawberry|blueberry|peach|cherry|raspberry|lemon)\b|\bice cream\b|\bpudding\b|\bcustard\b|\bmilkshake\b|\bchocolate\b|加糖|シラップ漬|甘露煮|砂糖漬|甘納豆|あん|アイスクリーム|調製豆乳/;
const UNSWEETENED = /\bunsweetened\b|\bnot sweetened\b|\bwithout added sugar\b|\bno sugar\b|\bwithout (added )?sugar\b|\bplain\b|無糖/;
const JUICE_PACK = /\bjuice pack\b|\bpacked in [a-z ]*juice\b|\bin (its own )?juice\b|果汁漬/;
const PUREE_FORM = /\bpur[eé]e\b|\bpaste\b|\bapplesauce\b|\bsauce, (apple|cranberry)\b|\bbutter, (apple|pumpkin)\b|ピューレー|ペースト|裏ごし/;
const PLANT_MILK = /\bmilk, (soy|almond|oat|rice|coconut|cashew|hemp|pea)\b|\b(soy|almond|oat|rice|cashew) (milk|drink|beverage)\b|豆乳/;
const DRINK_NOT_SUGAR = /\b(tea|coffee|espresso|water)\b|茶|コーヒー/;
const DRIED = /\bdried\b|\bdehydrated\b|\braisins?\b|\bprunes?\b|\bdates?\b|干し|乾/;
const SAVOURY_SAUCE = /\b(ketchup|catsup|barbecue|bbq|sauce|dressing|relish|chutney|salsa|pickles?|mustard|teriyaki|hoisin|marinade)\b|ケチャップ|ソース|ドレッシング|漬|たれ/;

const INTACT_PLANT_CATS = /^(Vegetables( and Vegetable Products)?|Fruits( and Fruit Juices)?|Legumes( and Legume Products)?|Nut and Seed Products|Nuts and Seeds|Cereal Grains and Pasta|Spices and Herbs|Mushrooms|Seaweeds|Potatoes and Starches)$/;
const NO_INTRINSIC_SUGAR_CATS = /^(Meats|Beef Products|Pork Products|Poultry Products|Lamb, Veal, and Game Products|Sausages and Luncheon Meats|Finfish and Shellfish Products|Fish and Shellfish)$/;
const DAIRY_CATS = /^(Dairy and Egg Products|Dairy|Eggs|Dairy substitutes)$/;
const SWEET_CATS = /^(Sweets|Sugars and Sweeteners|Confectionery)$/;
const BAKERY_CATS = /^(Baked Products|Cereals and Cereal Products|Breakfast Cereals|Snacks|Prepared Foods)$/;

// ---- step 5/7 references: sugar per gram of dry matter of the plain foods of a class ----
function medianOf(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const plainRatio = (pred) =>
  medianOf(foods.filter((f) => pred(f) && !SWEETENED.test(text(f)) && !JUICE.test(text(f)) && !SWEETENER.test(text(f)) && sugarOf(f) != null && dryMatter(f))
    .map((f) => sugarOf(f) / dryMatter(f)));
const REF = {
  fruit: plainRatio((f) => /^Fruits/.test(f.category) && !DRIED.test(text(f))),
  driedFruit: plainRatio((f) => /^Fruits/.test(f.category) && DRIED.test(text(f))),
  vegetable: plainRatio((f) => /^Vegetables/.test(f.category)),
  legume: plainRatio((f) => /^Legumes/.test(f.category)),
  nut: plainRatio((f) => /^Nut/.test(f.category)),
  grain: plainRatio((f) => f.category === 'Cereal Grains and Pasta' || (f.category === 'Cereals and Cereal Products' && (sugarOf(f) ?? 0) < 2)),
  milk: plainRatio((f) => DAIRY_CATS.test(f.category) && /\bmilk\b|牛乳/.test(text(f)) && !/\b(chocolate|condensed|dry|powder)\b/.test(text(f))),
  plantMilk: plainRatio((f) => PLANT_MILK.test(text(f)) && UNSWEETENED.test(text(f))),
};
log(`  step-5 references (g sugar per g dry matter): ${Object.entries(REF).map(([k, v]) => `${k}=${v?.toFixed(3)}`).join(' ')}`);

/**
 * Step 5 on a dry-matter basis: a sweetened food's dry matter is its base's dry matter plus
 * the added sugar, so with r = the plain reference's sugar per gram of dry matter,
 * total sugar S = r·(DM − FS) + FS, giving FS = (S − r·DM) / (1 − r). Used for products
 * whose base is a class (bakery on grain, sauces on vegetables, sweetened dairy on milk).
 */
function step5(f, refKey, r = REF[refKey]) {
  const s = sugarOf(f);
  const dm = dryMatter(f);
  if (!(s > 0) || dm == null || r == null || !(r < 1)) return { fs: 0.5, rule: 'last-resort' };
  const free = Math.min(s, Math.max(0, (s - r * dm) / (1 - r)));
  return { fs: Math.round((free / s) * 100) / 100, rule: `step5:${refKey}` };
}

// Same-fruit references for sweetened fruit: the plain raw (or dried) record of the fruit
// named by the description's first segment ("Peaches, canned, heavy syrup" → "Peaches, raw").
const fruitKey = (f) => (f.description ?? '').toLowerCase().split(',')[0].trim();
const RAW_FRUIT = new Map();
const DRIED_FRUIT = new Map();
for (const f of foods) {
  if (!/^Fruits/.test(f.category ?? '') || f.source) continue;
  const t = text(f);
  if (SWEETENED.test(t) || JUICE.test(t) || /\bcanned\b|\bfrozen\b|\bcooked\b|\bstewed\b/.test(t) || sugarOf(f) == null) continue;
  const m = /\bdried\b|\bdehydrated\b/.test(t) ? DRIED_FRUIT : /\braw\b/.test(t) ? RAW_FRUIT : null;
  if (!m) continue;
  const k = fruitKey(f);
  if (!m.has(k)) m.set(k, []);
  m.get(k).push(f);
}
const median = (fs, fn) => medianOf(fs.map(fn));

/**
 * Sweetened fruit. Canned or frozen in syrup / with sugar: Wanselius 2019 step 5 on a fresh
 * basis against the same fruit raw, FS = (S − S_us) / (1 − S_us / 100). Sweetened dried fruit:
 * the dry-matter form against the same fruit (dried, else raw), since the added sugar is
 * most of the dry matter.
 */
function sweetenedFruit(f) {
  const k = fruitKey(f);
  const s = sugarOf(f);
  if (DRIED.test(text(f))) {
    const ref = DRIED_FRUIT.get(k) ?? RAW_FRUIT.get(k);
    const r = ref ? median(ref, (x) => sugarOf(x) / dryMatter(x)) : REF.driedFruit;
    return step5(f, ref ? `same-fruit` : 'driedFruit', r);
  }
  const raw = RAW_FRUIT.get(k);
  if (!raw) return step5(f, 'fruit');
  const sUs = median(raw, sugarOf);
  const free = Math.min(s, Math.max(0, (s - sUs) / (1 - sUs / 100)));
  return { fs: Math.round((free / s) * 100) / 100, rule: 'step5:same-fruit' };
}

function lactoseOf(f) {
  const r = f.source ? null : fdc.get(f.fdcId);
  const v = r?.nutrients.get('213');
  return Number.isFinite(v) ? v : null;
}

/** The WHO free-sugar fraction of one food and the tree step that decided it. */
function freeSugar(f) {
  const s = sugarOf(f);
  if (s == null || s <= 0) return { fs: 0, rule: 'no-sugar' };
  const t = text(f);
  const c = f.category ?? '';
  // Step 3: free under every definition.
  if (SWEET_CATS.test(c) && UNSWEETENED.test(t) && s < 5) return { fs: 0, rule: 'intact-plant' }; // unsweetened cocoa
  if (SWEET_CATS.test(c) || (SWEETENER.test(t) && !/\bsugar[- ]free\b|\bno sugar\b|無糖/.test(t) && !INTACT_PLANT_CATS.test(c) && !DAIRY_CATS.test(c))) {
    return { fs: 1, rule: 'sweetener' };
  }
  if (JUICE_PACK.test(t) && INTACT_PLANT_CATS.test(c)) {
    // Fruit canned in juice: the packing juice is free sugar (step 5 against the same fruit);
    // vegetables canned in their own juice (tomatoes) are canned vegetables.
    return /^Fruits/.test(c) ? sweetenedFruit(f) : { fs: 0, rule: 'intact-plant' };
  }
  if (JUICE.test(t) && !/\bwith pulp\b/.test(t)) return { fs: 1, rule: 'juice' };
  // Muscle meat and fish carry no intrinsic sugar beyond glycogen traces, so sugar there
  // was added (cures, glazes, marinades); shellfish glycogen is intrinsic.
  if (NO_INTRINSIC_SUGAR_CATS.test(c)) {
    if (/\b(mollusks?|oysters?|clams?|mussels?|scallops?|crustaceans?|shrimp|crab|lobster)\b|貝|かき|えび|かに/.test(t)) return { fs: 0, rule: 'intact-animal' };
    return s >= 1 ? { fs: 1, rule: 'added-to-animal-food' } : { fs: 0, rule: 'trace' };
  }
  if (c === 'Beverages') {
    if (PLANT_MILK.test(t)) return UNSWEETENED.test(t) ? { fs: 0, rule: 'plant-milk-unsweetened' } : step5(f, 'plantMilk');
    if (DRINK_NOT_SUGAR.test(t) && s < 0.5) return { fs: 0, rule: 'trace' };
    return { fs: 1, rule: 'non-dairy-drink' }; // UK/WHO: sugars in non-dairy drinks
  }
  // Dairy: lactose is intrinsic (WHO excludes milk sugars); sweetened dairy by step 6 or 5.
  if (DAIRY_CATS.test(c)) {
    if (PLANT_MILK.test(t) || /plant-based|soy/.test(t)) return UNSWEETENED.test(t) ? { fs: 0, rule: 'plant-milk-unsweetened' } : step5(f, 'plantMilk');
    if (!SWEETENED.test(t) && !/\bsugared\b|\bwhipped\b.*\btopping\b/.test(t)) return { fs: 0, rule: 'plain-dairy' };
    const lac = lactoseOf(f);
    if (lac != null) return { fs: Math.round((Math.max(0, s - lac) / s) * 100) / 100, rule: 'step6:total-minus-lactose' };
    return step5(f, 'milk');
  }
  // Intact plant foods: sweetened or canned-in-syrup varieties by step 5, purées at the
  // purée fraction, everything else intrinsic.
  if (INTACT_PLANT_CATS.test(c)) {
    const ref = /^Fruits/.test(c) ? (DRIED.test(t) ? 'driedFruit' : 'fruit')
      : /^Legumes/.test(c) ? 'legume' : /^Nut/.test(c) ? 'nut' : /^Cereal/.test(c) ? 'grain' : 'vegetable';
    if (/\b(almond paste|marzipan|praline|nougat|halva|halvah)\b/.test(t)) return { fs: 1, rule: 'sweetener' };
    if (SWEETENED.test(t) && !UNSWEETENED.test(t)) return /^Fruits/.test(c) ? sweetenedFruit(f) : step5(f, ref);
    if (PUREE_FORM.test(t) || /\btomato(es)?\b.*\b(sauce|products)\b/.test(t)) return { fs: PUREE, rule: 'puree' };
    if (SAVOURY_SAUCE.test(t)) return step5(f, ref);
    // Plain cooked legumes hold < 5 g sugar; ≥ 10 g in a non-flour legume dish means it was
    // simmered in sugar (Japanese nimame, sweetened bean pastes).
    if (ref === 'legume' && s >= 10 && !/\bflour\b|\bdried\b|\bmature seeds\b|\bpeanut butter\b|乾|粉/.test(t)) return step5(f, 'legume');
    return { fs: 0, rule: 'intact-plant' };
  }
  if (BAKERY_CATS.test(c)) return UNSWEETENED.test(t) ? { fs: 0, rule: 'intact-plant' } : step5(f, 'grain');
  if (c === 'Soups, Sauces, and Gravies' || c === 'Seasonings and Spices' || SAVOURY_SAUCE.test(t)) {
    if (/\bmirin\b|みりん/.test(t)) return { fs: 1, rule: 'sweetener' };
    return step5(f, 'vegetable');
  }
  if (c === 'Fats and Oils' && /\b(butter|ghee|cream)\b|bataa|バター/.test(t)) return { fs: 0, rule: 'plain-dairy' };
  return { fs: 0.5, rule: 'last-resort' };
}

// ---- trans-fat origin ----
const NATURAL_TRANS_CATS = /^(Dairy and Egg Products|Dairy|Eggs|Beef Products|Lamb, Veal, and Game Products|Meats|Pork Products|Poultry Products|Sausages and Luncheon Meats|Finfish and Shellfish Products|Fish and Shellfish|Vegetables( and Vegetable Products)?|Fruits( and Fruit Juices)?|Legumes( and Legume Products)?|Nut and Seed Products|Nuts and Seeds|Cereal Grains and Pasta|Spices and Herbs|Mushrooms|Seaweeds)$/;
const PROCESSED_FAT = /\b(margarine|shortening|hydrogenated|spread|frying|fried|breaded|imitation|non-?dairy|creamer|whipped topping|vegetable oil spread)\b|マーガリン|ショートニング/;
function transOrigin(f) {
  if (!(f.n?.transFat_g > 0)) return null;
  const t = text(f);
  if (NATURAL_TRANS_CATS.test(f.category ?? '') && !PROCESSED_FAT.test(t)) return 'natural';
  if (f.category === 'Fats and Oils' && /\b(butter|ghee|lard|tallow|suet|beef|mutton|chicken fat|duck fat)\b|バター|ラード|牛脂/.test(t) && !PROCESSED_FAT.test(t)) return 'natural';
  return 'industrial';
}

// ---- fruit/vegetable flag and food-matrix class ----
const FV_CATS = /^(Vegetables( and Vegetable Products)?|Fruits( and Fruit Juices)?)$/;
function matrixOf(f) {
  const t = text(f);
  const c = f.category ?? '';
  if (/\btofu\b|\bsoymilk\b|\bmilk, soy\b|\bsoy milk\b|\bedamame\b|\btempeh\b|\bnatto\b|\bsoybeans?\b|豆腐|豆乳|納豆|枝豆|daizu/.test(t)
    && !/\bsauce\b|\boil\b|\bisolate\b|\bconcentrate\b|\bprotein\b|\blecithin\b|しょうゆ|醤油|shouyu/.test(t)) return 'soy';
  if (!DAIRY_CATS.test(c) || /plant-based|vegan|imitation|substitute|\bsoy\b|\balmond\b|\boat\b|\brice\b|\bcoconut\b/.test(t)) return null;
  if (/\byogh?urt\b|\bkefir\b|yooguruto|ヨーグルト/.test(t)) return 'fermented-milk';
  if (/\bcheese\b|chiizu|チーズ/.test(t) && !/\bprocess|\bspread\b|\bcheese food\b|\bsauce\b|\bproduct\b/.test(t)) return 'cheese';
 if (/（液状乳類）/.test(t)) return /乳飲料/.test(t) ? null : 'milk';
  if (/\bmilk\b|\bbuttermilk\b/.test(t) && !/牛乳及/.test(t) && !/\bchocolate\b|\bdry\b|\bpowder\b|\bcondensed\b|\bmilkshake\b|\bcreamer\b/.test(t)) return 'milk';
  return null;
}

// ---- dietary-AGE class (food class × cooking method; fii-parameters.json ageAdjustment) ----
const AGE_MEAT = /^(Meats|Beef Products|Pork Products|Poultry Products|Lamb, Veal, and Game Products|Sausages and Luncheon Meats|Finfish and Shellfish Products|Fish and Shellfish)$/;
const AGE_STARCH = /^(Cereal Grains and Pasta|Cereals and Cereal Products|Baked Products|Breakfast Cereals|Potatoes and Starches|Legumes( and Legume Products)?|Snacks)$/;
function ageClassOf(f) {
  const t = text(f);
  const c = f.category ?? '';
  let cls = null;
  if (AGE_MEAT.test(c)) cls = 'meat';
  else if ((DAIRY_CATS.test(c) || c === 'Eggs') && /\beggs?\b|卵/.test(t) && !/\beggnog\b/.test(t)) cls = 'egg';
  else if (/^Nut/.test(c) && !/\bmilk\b|\bwater\b|\boil\b/.test(t)) cls = 'nut';
  else if (AGE_STARCH.test(c)) cls = 'starch';
  else if (/^(Vegetables|Fruits|Mushrooms)/.test(c)) cls = 'produce';
  if (!cls) return null;
  // Dry heat the record itself carries (the recipe's own method can only raise it).
  const cooked = /\b(fried|deep-fried|pan-fried)\b|揚/.test(t) ? 'fried'
    : /\b(roasted|toasted|grilled|broiled)\b|焼/.test(t) ? 'grilled'
      : /\bbaked\b/.test(t) || c === 'Baked Products' ? 'baked' : null;
  return { cls, cooked };
}

log('→ classifying…');
const out = {
  _doc: 'GENERATED by scripts/build-fii-food-classes.mjs — do not hand-edit. Per fdcId: `fs` = the WHO free-sugar fraction of the food\'s total sugars (Louie 2015 / Wanselius 2019 decision tree; `fsRule` names the step that decided it), `trans` = the origin of its trans fat (industrial or natural), `fv` marks fruit and vegetables (whose sugars `prep: blended|juiced` re-classifies), `matrix` the food-matrix class (fii-parameters.json matrixDeltas), and `age`/`ageCooked` the dietary-AGE class and the dry heat the record already carries (fii-parameters.json ageAdjustment). Read by src/core/fii.ts. A food with no sugar, no trans fat and no class is omitted (nothing to classify); the engine treats a sugar-bearing food missing from the file as unclassified (Louie step 10, half free), and a test requires every recipe-used food with sugar to be classified.',
  pureeFreeSugarFraction: PUREE,
  foods: {},
};
const ruleCount = {};
for (const f of foods) {
  const fsr = freeSugar(f);
  const tr = transOrigin(f);
  const fv = FV_CATS.test(f.category ?? '') && !JUICE.test(text(f));
  const matrix = matrixOf(f);
  const age = ageClassOf(f);
  if (fsr.rule === 'no-sugar' && !tr && !fv && !matrix && !age) continue;
  ruleCount[fsr.rule] = (ruleCount[fsr.rule] ?? 0) + 1;
  const e = {};
  if (fsr.rule !== 'no-sugar') { e.fs = fsr.fs; e.fsRule = fsr.rule; }
  if (tr) e.trans = tr;
  if (fv) e.fv = true;
  if (matrix) e.matrix = matrix;
  if (age) { e.age = age.cls; if (age.cooked) e.ageCooked = age.cooked; }
  out.foods[String(f.fdcId)] = e;
}
const matrixCount = {};
for (const e of Object.values(out.foods)) if (e.matrix) matrixCount[e.matrix] = (matrixCount[e.matrix] ?? 0) + 1;
log(`  matrix classes: ${JSON.stringify(matrixCount)}`);
for (const [r, n] of Object.entries(ruleCount).sort((a, b) => b[1] - a[1])) log(`  ${r.padEnd(28)} ${n}`);
writeFileSync(join(ROOT, 'src/data/fii-food-classes.json'), JSON.stringify(out, null, 1) + '\n');
log(`✓ wrote src/data/fii-food-classes.json (${Object.keys(out.foods).length} foods)`);
