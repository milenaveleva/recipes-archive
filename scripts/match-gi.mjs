#!/usr/bin/env node
/**
 * Assign a GI (+ cited source + confidence) to EVERY food in usda-foods.json by
 * matching it against the Atkinson 2021 reference built by scripts/build-gi.mjs
 * (src/data/gi-reference.json), then write the result into src/data/food-scoring.json.
 * This is the scalable replacement for hand-curating a GI per food: as recipes add
 * foods, re-running assigns them automatically, and no food is left blank.
 *
 * Every food gets a value through a documented ladder → giConfidence (following the
 * protocol of Lin 2012 / Louie 2015 / Hernandez 2022 for adding GI to a food-
 * composition database, with a composition estimate in the spirit of Rytz 2019):
 *   high      — strong token match to a specific reference food in a compatible category
 *   medium    — partial match to a specific reference food
 *   predicted — no match, a starchy food (≥ NONSTARCHY_MAX carb/100g): available-carb-
 *               weighted blend of its sugar (as sucrose, GI 65) and its starch (at the
 *               food's category-median GI, a measured proxy for how that food family's
 *               starch digests — standing in for the Rapidly-Digestible-Starch term the
 *               full Rytz model needs but which only an in-vitro assay can supply)
 *   low       — no match, a non-starchy / minor carb source (< NONSTARCHY_MAX carb/100g:
 *               greens, aromatics, raw nuts): a low nominal GI, unless it carries ≥
 *               SUGAR_MIN sugar (a sweet melon), when the sugar/starch blend runs with a
 *               low nominal starch proxy so its sugar still reads high
 *   (0)       — no available carbohydrate (oils, water, salt): GI 0 by convention (it
 *               never reaches the composite, which ignores contributions ≤ 0.5 g)
 *
 * Staple starches (pasta, oats, couscous, brown rice, potatoes), common breads, dried pulses and a few plain foods are first
 * matched against an as-eaten STAPLES reference — the mean of the Atkinson Table 1
 * entries for the boiled/cooked food (e.g. "White spaghetti, boiled, mean of 11 foods"),
 * since GI is measured on the food as eaten and a dry and a cooked record of the same
 * food share one GI. Other matches prefer a cooked/boiled reference entry among
 * near-equal candidates for the same reason.
 *
 * Any GI already present in food-scoring.json is preserved, never overwritten — so
 * hand-curated values and prior measured matches survive a re-run untouched. The one
 * exception is --rematch-predicted, which clears and re-assigns only the estimated tiers
 * (giConfidence 'predicted' or 'low'), e.g. after the reference table or the matcher
 * improves; 'high'/'medium' matches and carb-free entries are never touched.
 *
 * Usage: node scripts/match-gi.mjs [--write] [--rematch-predicted]   (default: dry-run report to stderr)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refCategoryFor } from './lib/gi-category.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const REMATCH = process.argv.includes('--rematch-predicted');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const foods = read('src/data/usda-foods.json');
const reference = read('src/data/gi-reference.json');
const scoring = read('src/data/food-scoring.json');

const NONSTARCHY_MAX = 10; // g available carb / 100 g below which an unmatched food is a non-starchy / minor carb source (leafy greens, aromatics, raw nuts): its starch is valued at NONSTARCHY_GI, not a starchy category median
const NONSTARCHY_GI = 15;  // low nominal GI for that non-starchy starch fraction (minor and slowly available; matches the hand-set nominal for garlic/onion/celery)
const SUGAR_GI = 65;       // GI of the sugar fraction in the composition estimate — sucrose (the dominant dietary sugar, ISO reference behaviour)
const SUGAR_MIN = 5;       // g sugar / 100 g at/above which a low-carb food's sugar is glycemically significant (a sweet melon) rather than trace (a leafy green whose fibre ≈ total carb)

const STOP = new Set(['raw', 'cooked', 'boiled', 'prepared', 'with', 'without', 'and', 'or', 'the',
  'of', 'in', 'all', 'commercial', 'varieties', 'includes', 'usda', 'ns', 'as', 'to', 'from', 'made',
  'unenriched', 'enriched', 'regular', 'plain', 'fresh', 'whole', 'generic', 'drained', 'salt', 'added',
  // fat-level qualifiers describe fat content, not food identity — matching on these
  // alone pairs unrelated foods ("low fat yogurt" ↔ "low-fat apricot cake").
  'low', 'fat', 'reduced', 'skim', 'nonfat', 'lowfat',
  // state / trade descriptors that never distinguish one food from another.
  'unprepared', 'seedless', 'brand']);
// Strip naming noise before tokenising: USDA's "(Includes foods for USDA's Food
// Distribution Program)" suffix, and a reference entry's brand / manufacturer / country
// parenthetical ("(Simplot Australia, Cheltenham, Australia)"). Left in, their tokens
// dilute the Jaccard score so far that "Sweet potato, raw, unprepared (Includes …)" never
// meets "Boiled sweet potato".
const BRAND_PAREN = /\([^()]*(?:™|®|\b(?:ltd|pty|inc|co|llc|gmbh|limited|brand|australia|usa|canada|uk|italy|japan|china|new zealand)\b)[^()]*\)?/gi;
const denoise = (s) => s.replace(/\(includes foods for usda[^)]*\)?/gi, ' ').replace(BRAND_PAREN, ' ');
// Plural → singular, so "Mangos"/"mangoes", "tomatoes", "berries" meet the singular
// reference names.
const singular = (w) => (w.length > 4 && /ies$/.test(w) ? w.slice(0, -3) + 'y'
  : w.length > 4 && /(oes|ches|shes|sses|xes)$/.test(w) ? w.slice(0, -2)
    : w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
// British ↔ American spellings of the same word (the table is Australian-edited, USDA is
// American), folded to one token. "Yoghurt" stays unfolded: the table's only plain-named
// yoghurt entries are frozen-yoghurt desserts and merged multi-product rows.
// "Wholemeal" is the British "whole wheat" (USDA's "whole-wheat" tokenises to whole + wheat).
const SPELLING = new Map([['chilli', ['chili']], ['flavoured', ['flavored']], ['wholemeal', ['whole', 'wheat']], ['wholewheat', ['whole', 'wheat']]]);
const toks = (s) => new Set(
  denoise(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
    .flatMap((w) => SPELLING.get(w) ?? [w]).map(singular));
const jaccard = (a, b) => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

// Category-MEDIAN GI (robust to outliers — e.g. potatoes in VEGETABLES — unlike the
// mean), the fallback GI for a food with no specific match; plus a global median for
// foods whose USDA category maps to no reference category.
const median = (v) => {
  const a = [...v].sort((x, y) => x - y), m = a.length >> 1;
  return a.length ? (a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)) : null;
};
const catGis = new Map();
for (const r of reference) (catGis.get(r.category) ?? catGis.set(r.category, []).get(r.category)).push(r.gi);
const categoryMedian = new Map([...catGis].map(([c, v]) => [c, median(v)]));
const globalMedian = median(reference.map((r) => r.gi));

// Token-match candidates. A reference entry flagged as a GI-lowered variant ("low GI",
// "decreased GI variant") is a reformulated product, never the generic food, so it is
// kept out of matching (it still counts toward the category medians).
const GI_VARIANT = /\b(?:low|lower|reduced|decreased)[- ]GI\b|\bGI variant\b/i;
// Descriptive words that open many reference names ("White spaghetti", "Instant oats",
// "Baked potato") but are not the food itself; the head food word is the first token
// after them.
const NOT_HEAD = new Set(['white', 'wheat', 'instant', 'mixed', 'baked', 'boiled', 'cooked', 'raw', 'fresh',
  'dried', 'canned', 'frozen', 'brown', 'red', 'green', 'yellow', 'black', 'sweet', 'plain', 'natural', 'organic',
  'wild', 'large', 'small', 'whole', 'quick', 'rolled', 'steamed', 'roasted', 'toasted', 'light', 'reduced', 'low']);
// The table's one toasted-loaf study is not a generic value: a toasted record takes its
// bread's GI through STAPLES instead.
const refToks = reference.filter((r) => !GI_VARIANT.test(r.food) && !/\btoasted\b/i.test(r.food)).map((r) => {
  const t = toks(r.food);
  return { ...r, t, head: [...t].find((w) => !NOT_HEAD.has(w)) };
});

// Words that mark a different food or form: when one side carries such a word and the
// other does not, the pair is not the same food however many other tokens agree (an
// apple ↔ apple juice, blueberries ↔ blueberry jam, gluten-free ↔ wheat bread, snow
// peas ↔ shelled peas, whole ↔ pearled spelt, juice ↔ segments canned in juice).
const FORM_WORDS = ['juice', 'segment', 'jam', 'marmalade', 'gluten', 'podded', 'pearled'];
/**
 * Whether reference entry `r` can name the same food as `food` (tokens `ft`): the
 * entry's head food word must appear in the food (a "Peach, canned in heavy syrup" is
 * not canned apricots), the two must agree on every FORM_WORDS marker, and a USDA
 * mixture "X and Y, …" matches only an entry naming both X and Y (peas-and-carrots is
 * neither plain peas nor plain carrots).
 */
function sameFood(food, ft, r) {
  if (r.head && !ft.has(r.head)) return false;
  if (FORM_WORDS.some((w) => ft.has(w) !== r.t.has(w))) return false;
  const mix = /^([a-z]+) and ([a-z]+)\b/i.exec(food.description ?? '');
  if (mix && !mix.slice(1).every((w) => r.t.has(singular(w.toLowerCase())))) return false;
  return true;
}

// As-eaten staple references: USDA description pattern → the Atkinson Table 1 entries
// (category + name pattern) for the food as eaten; the GI is their mean. Ordered — the
// first matching staple wins, so the specific forms come before the generic ones. A
// staple is 'high' confidence unless it names `conf`: 'medium' marks a close proxy (dried
// breadcrumbs valued as the white bread they are made from); `label` names a multi-entry
// mean in the cited source.
//
// Breads: the parsed bread section mixes brand-specific and modified-recipe loaves (added
// fibre, resistant starch, guar, altered proving), so each bread type is the mean of its
// plain, unmodified entries. A toasted record shares its bread's GI — GI is a property of
// the bread, and the one toasted-loaf study in the table is not a generic value.
const WHITE_BREAD = /^(White bread|Wheat bread|Enriched white bread)\b(?!.*\b(gluten|guar|pectin|fibre|fiber|resistant|starch|chickpea|oat bran|molasses|sourdough|vinegar|prove|proving|toasted|candeal|bite-sized|pre-cooked|glucan|enriched with|reducose)\b)/i;
const WHOLEMEAL_BREAD = /^(Wholemeal (\(whole wheat\) )?(wheat )?flour bread|Wholemeal wheat flour bread)/i;
/** Mean GI + citation label of the Table 1 entries a staple reference names. */
function staplesRef(st) {
  const refs = reference.filter((r) => r.category === st.cat && st.ref.test(r.food));
  if (!refs.length) throw new Error(`STAPLES reference ${st.ref} matched no ${st.cat} entry — regenerate gi-reference.json`);
  const gi = Math.round(refs.reduce((a, r) => a + r.gi, 0) / refs.length);
  const label = refs.length === 1 ? refs[0].food.slice(0, 60).trim() : `${st.label ?? st.ref.source.replace(/[\^$\\]|\(\?.*$/g, '').trim()}: mean of ${refs.length} entries`;
  return { gi, label, conf: st.conf };
}
// Boiled wheat pasta (egg-free, so a recipe's own eggs are not counted twice through the
// mixed-meal protein correction): the as-eaten reference for a flour rolled or pinched into
// pasta or noodles and boiled. Soft dumpling doughs (gnocchi) are fully gelatinised and keep
// the bread value.
const WHOLEMEAL_PASTA_DOUGH = { cat: 'PASTA AND NOODLES', ref: /^Wholemeal spaghetti, boiled$/i, conf: 'medium', label: 'wholemeal spaghetti, boiled' };
const WHITE_PASTA_DOUGH = { cat: 'PASTA AND NOODLES', ref: /^White spaghetti, boiled$/i, conf: 'medium', label: 'white spaghetti, boiled' };
const STAPLES = [
  { food: /^pasta\b.*\bgluten-free\b/i, cat: 'PASTA AND NOODLES', ref: /^Gluten-free pasta$/i },
  { food: /^pasta\b.*\b(whole-wheat|whole grain|whole wheat)\b/i, cat: 'PASTA AND NOODLES', ref: /^Wholemeal spaghetti, boiled$/i },
  { food: /^(pasta|spaghetti|macaroni)\b(?!.*\b(spinach|corn|rice|quinoa)\b)/i, cat: 'PASTA AND NOODLES', ref: /^White spaghetti, boiled$/i },
  { food: /^oats\b.*\bsteel cut\b/i, cat: 'BREAKFAST CEREALS', ref: /^Porridge made from steel-cut oats$/i },
  { food: /^oats\b/i, cat: 'BREAKFAST CEREALS', ref: /^Porridge made from rolled oats$/i },
  { food: /^couscous\b/i, cat: 'CEREAL GRAINS', ref: /^Couscous, rehydrated with hot water/i },
  { food: /^rice, brown\b(?!.*\b(parboiled|instant)\b)/i, cat: 'CEREAL GRAINS', ref: /^Brown rice(?! chips)(?!.*\b(instant|flavou?red|chicken|microwaved|parboiled)\b)/i },
  { food: /^mangos?\b.*\braw\b/i, cat: 'FRUIT AND FRUIT PRODUCTS', ref: /^Mango, raw\b/i },
  { food: /^bread, pita, whole[- ]wheat\b/i, cat: 'BREADS', ref: /^Pita bread, wholemeal/i },
  { food: /^bread, pita\b/i, cat: 'BREADS', ref: /^(Pita bread, white|Lebanese bread, white)/i, label: 'white pita / Lebanese bread' },
  { food: /^bread, naan, plain\b/i, cat: 'BREADS', ref: /^Naan bread/i },
  { food: /^bread, chapati or roti, whole wheat\b/i, cat: 'BREADS', ref: /^Roti \(unleavened flatbread\), whole wheat flour$/i },
  { food: /^bread, chapati or roti, plain\b/i, cat: 'REGIONAL OR TRADITIONAL FOODS', ref: /^(Chapati, flatbread|Chapatti)$/i, label: 'chapati' },
  { food: /^bread, pumpernickel\b/i, cat: 'BREADS', ref: /^Pumpernickel/i },
  { food: /^bread, rye\b/i, cat: 'BREADS', ref: /^(Rye breads$|Rye, made with)/i, label: 'rye bread' },
  { food: /^bread, (whole[- ]wheat|french or vienna, whole wheat)\b/i, cat: 'BREADS', ref: WHOLEMEAL_BREAD, label: 'wholemeal wheat bread' },
  { food: /^bread, (white|white wheat|french or vienna|italian)\b/i, cat: 'BREADS', ref: WHITE_BREAD, label: 'white wheat bread' },
  { food: /^bread, wheat(?!, sprouted)\b/i, cat: 'BREADS', ref: WHITE_BREAD, conf: 'medium', label: 'white wheat bread' },
  { food: /^(bread, crumbs|croutons)\b/i, cat: 'BREADS', ref: WHITE_BREAD, conf: 'medium', label: 'white wheat bread' },
  { food: /^crackers, (rusk toast|melba toast, (plain|wheat))\b/i, cat: 'BREADS', ref: /^Dried wheat bread rusk$/i },
  { food: /^crackers, (saltines\b(?!, whole wheat)|water biscuits)/i, cat: 'CRACKERS', ref: /^(Cracker|Cream cracker\b.*)$/i, label: 'plain / cream cracker', conf: 'medium' },
  { food: /^tortillas\b.*\bcorn\b/i, cat: 'BREADS', ref: /\bCorn tortilla, made from white corn/i, label: 'white corn tortilla' },
  { food: /^bread, multi-grain\b/i, cat: 'BREADS', ref: /^(Mixed grain or seed bread|Multigrain batch bread)$/i, label: 'mixed-grain bread' },
  // Potatoes: the table's "Boiled potato, mean of 29 studies" (USDA's flesh-and-skin
  // records by variety all take the cross-variety mean).
  { food: /^potatoes, ((white|red|russet), )?flesh and skin, raw\b/i, cat: 'VEGETABLES', ref: /^Boiled potato$/i },
  { food: /^squash, winter, butternut\b/i, cat: 'VEGETABLES', ref: /\bButternut pumpkin, boiled$/i },
  { food: /^corn, sweet, (yellow|white), (canned|frozen)\b/i, cat: 'VEGETABLES', ref: /^Sweet corn$/i },
  { food: /^farro, pearled\b/i, cat: 'CEREAL GRAINS', ref: /^Spelt, pearled \(Farro\b/i },
  // Dried pulses take the measured canned (cooked, drained) entry for the same bean — a
  // close proxy for the home-boiled bean, whose own GI the ISO-compliant table lacks.
  { food: /^beans, white, mature seeds\b/i, cat: 'LEGUMES', ref: /^Cannellini beans, canned, drained/i, conf: 'medium' },
  { food: /^beans, kidney, red, mature seeds, (raw|cooked)\b/i, cat: 'LEGUMES', ref: /^Red Kidney beans, canned, drained/i, conf: 'medium' },
  // Oat drink: the one measured oat milk (calcium-enriched, no added sugar declared).
  { food: /^milk, oat\b/i, cat: 'BEVERAGES', ref: /^Oat milk\b/i, conf: 'medium' },
  { food: /^grapes, (red or green|american type|muscadine)\b.*\braw\b/i, cat: 'FRUIT AND FRUIT PRODUCTS', ref: /^Grapes, (black|crimson|green)\b/i, label: 'grapes' },
  { food: /^chocolate, dark, 70-85%/i, cat: 'SNACK FOODS AND CONFECTIONERY', ref: /^Chocolate, dark, 74% Cocoa\b/i, conf: 'medium' },
  // A whole orange "with peel" is eaten (and was measured) as its flesh.
  { food: /^oranges, raw, with peel\b/i, cat: 'FRUIT AND FRUIT PRODUCTS', ref: /\bOranges, navel$/i, conf: 'medium' },
  // Flour is never eaten as flour: its as-eaten GI is that of what it becomes. Baked,
  // fried, steamed, stirred into a sauce or made into soft dumplings (gnocchi), its starch is
  // gelatinised like bread's, so the default is the matching bread; rolled or pinched into
  // pasta or noodles and boiled (ingredient `starchForm: dough`), it takes the boiled pasta
  // of the same grain (`giDough`).
  { food: /^(flour, (whole wheat|spelt, whole grain)|wheat flour, whole-grain)\b/i, cat: 'BREADS', ref: WHOLEMEAL_BREAD, conf: 'medium', label: 'wholemeal wheat bread', dough: WHOLEMEAL_PASTA_DOUGH },
  { food: /^(flour, (wheat, all-purpose|00|semolina)|wheat flour, white|wheat flours, bread)\b/i, cat: 'BREADS', ref: WHITE_BREAD, conf: 'medium', label: 'white wheat bread', dough: WHITE_PASTA_DOUGH },
].map((st) => {
  const ref = staplesRef(st);
  const dough = st.dough ? staplesRef(st.dough) : null;
  return { ...st, ...ref, dough };
});
const COOKED_REF = /\b(boiled|cooked|steamed|baked|roasted|porridge)\b/i;

const clampGi = (n) => Math.min(120, Math.max(1, Math.round(n)));

function assign(food) {
  const carb = food.n?.carbs_g ?? 0;
  const fiber = food.n?.fiber_g ?? 0;
  const avail = Math.max(0, carb - fiber);
  // Genuinely carb-free food (oils, water, salt): 0 available carbohydrate never reaches
  // the composite (the engine ignores contributions ≤0.5 g however much is used), so GI 0
  // is inert — the Louie/Hernandez convention for non-carb foods.
  if (avail <= 0) return { gi: 0, source: 'no available carbohydrate', conf: 'none' };

  // 0) As-eaten staple reference (see STAPLES).
  const staple = STAPLES.find((st) => st.food.test(food.description ?? ''));
  if (staple) {
    const dough = staple.dough
      ? { gi: staple.dough.gi, giSource: `Atkinson 2021 (${staple.dough.label})`, giConfidence: staple.dough.conf ?? 'high' }
      : undefined;
    return { gi: staple.gi, source: `Atkinson 2021 (${staple.label})`, conf: staple.conf ?? 'high', dough };
  }

  // 1) Measured match — only within the same reference category, since cross-category
  //    token matches (e.g. "rice vinegar" ↔ "rice") are the main source of nonsense.
  //    Among near-equal candidates (within 0.05), a cooked/boiled reference entry wins:
  //    GI is measured on the food as eaten.
  const refCat = refCategoryFor(food);
  const ft = toks(food.description ?? '');
  let best = null;
  if (refCat) for (const r of refToks) {
    if (r.category !== refCat || !sameFood(food, ft, r)) continue;
    const score = jaccard(ft, r.t);
    const cooked = COOKED_REF.test(r.food);
    const nearTie = best && Math.abs(score - best.score) <= 0.05;
    const better = !best || score > best.score + 0.05 ||
      (nearTie && ((cooked && !best.cooked) || (cooked === best.cooked && score > best.score)));
    if (better) best = { r, score, cooked };
  }
  const cite = (r) => `Atkinson 2021 (${r.food.slice(0, 60).trim()})`;
  if (best && best.score >= 0.6) return { gi: best.r.gi, source: cite(best.r), conf: 'high' };
  if (best && best.score >= 0.45) return { gi: best.r.gi, source: cite(best.r), conf: 'medium' };

  // 2) No match → estimate from carbohydrate quality. A low-carbohydrate food is a
  //    non-starchy / minor carb source (greens, aromatics, raw nuts) UNLESS it carries
  //    significant sugar (a sweet melon): its starch is slowly available and must NOT
  //    inherit a starchy category median (the Atkinson VEGETABLES/NUTS medians are skewed
  //    high because only starchy members get tested). A high-fibre green whose fibre ≈
  //    total carb can show a trace available-carb yet non-trace sugar, so gate the sugar
  //    voice on an absolute sugar amount, not the sugar:starch ratio.
  const lowCarb = avail < NONSTARCHY_MAX;
  const sugar = food.n?.sugar_g;
  const sugarKnown = sugar != null && Number.isFinite(sugar);
  if (lowCarb && !(sugarKnown && sugar >= SUGAR_MIN)) {
    return { gi: NONSTARCHY_GI, source: 'non-starchy / minor carb source (nominal)', conf: 'low' };
  }

  // Blend the sugar fraction (as sucrose) with the starch proxy: the food family's
  // category-median GI for a starchy food, or the low nominal for a low-carb-but-sweet
  // one (so only its sugar drives the value).
  const catMed = (refCat && categoryMedian.get(refCat)) || globalMedian;
  const starchGi = lowCarb ? NONSTARCHY_GI : catMed;
  const conf = lowCarb ? 'low' : 'predicted';
  if (sugarKnown) {
    const s = Math.min(Math.max(0, sugar), avail), starch = avail - s;
    return { gi: clampGi((s * SUGAR_GI + starch * starchGi) / avail), source: `predicted (sugar + ${lowCarb ? 'non-starchy' : (refCat ?? 'global')} starch proxy)`, conf };
  }
  // Starchy food with no sugar figure to split on: use the category median directly.
  return { gi: catMed, source: `Atkinson ${refCat ?? 'global'} category median`, conf };
}

const used = new Set();
for (const t of readdirSync(join(ROOT, 'src/content/recipes')).filter((f) => f.endsWith('.md'))) {
  const s = readFileSync(join(ROOT, 'src/content/recipes', t), 'utf8');
  for (const m of s.matchAll(/fdcId:\s*(\d+)/g)) used.add(Number(m[1]));
}

const counts = { high: 0, medium: 0, predicted: 0, low: 0, none: 0 };
let preserved = 0;
const report = [];
for (const food of foods) {
  const key = String(food.fdcId);
  // A flour's dough GI follows its staple rule even when its base GI is a preserved match.
  const doughStaple = STAPLES.find((st) => st.dough && st.food.test(food.description ?? ''));
  if (doughStaple && scoring[key]?.gi != null) {
    scoring[key] = { ...scoring[key], giDough: { gi: doughStaple.dough.gi, giSource: `Atkinson 2021 (${doughStaple.dough.label})`, giConfidence: doughStaple.dough.conf ?? 'high' } };
  }
  const existing = scoring[key];
  // --rematch-predicted clears the estimated tiers only; a curated or measured match stays.
  const estimated = existing?.giConfidence === 'predicted' || existing?.giConfidence === 'low';
  if (existing?.gi != null && !(REMATCH && estimated)) { preserved++; continue; } // never overwrite a curated or prior value
  const a = assign(food);
  const { giDough: _staleDough, ...kept } = existing ?? {};
  scoring[key] = { ...kept, gi: a.gi, giSource: a.source, giConfidence: a.conf, ...(a.dough ? { giDough: a.dough } : {}) };
  counts[a.conf]++;
  if (used.has(food.fdcId)) report.push(`  [${a.conf}] ${(food.description ?? '').slice(0, 42).padEnd(42)} → GI ${a.gi}  (${a.source})`);
}

log(`Assigned GI to every food — high ${counts.high}, medium ${counts.medium}, predicted ${counts.predicted}, low(category median) ${counts.low}, carb-free 0 (${counts.none}); preserved ${preserved} existing.`);
log('— USED foods newly assigned (verify) —');
report.sort().forEach((r) => log(r));

if (WRITE) {
  const ordered = Object.entries(scoring).sort((a, b) => Number(a[0]) - Number(b[0]));
  const line = (v) => JSON.stringify(v, null, 1).replace(/\n\s*/g, ' '); // spaced single-line object
  writeFileSync(join(ROOT, 'src/data/food-scoring.json'),
    '{\n' + ordered.map(([k, v]) => `  ${JSON.stringify(k)}: ${line(v)}`).join(',\n') + '\n}\n');
  log('✓ wrote src/data/food-scoring.json');
} else {
  log('(dry-run — pass --write to persist)');
}
