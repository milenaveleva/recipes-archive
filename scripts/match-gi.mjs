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
 * Any GI already present in food-scoring.json is preserved, never overwritten — so
 * hand-curated values and prior measured matches survive a re-run untouched.
 *
 * Usage: node scripts/match-gi.mjs [--write]   (default: dry-run report to stderr)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const foods = read('src/data/usda-foods.json');
const reference = read('src/data/gi-reference.json');
const scoring = read('src/data/food-scoring.json');

const NONSTARCHY_MAX = 10; // g available carb / 100 g below which an unmatched food is a non-starchy / minor carb source (leafy greens, aromatics, raw nuts): its starch is valued at NONSTARCHY_GI, not a starchy category median
const NONSTARCHY_GI = 15;  // low nominal GI for that non-starchy starch fraction (minor and slowly available; matches the hand-set nominal for garlic/onion/celery)
const SUGAR_GI = 65;       // GI of the sugar fraction in the composition estimate — sucrose (the dominant dietary sugar, ISO reference behaviour)
const SUGAR_MIN = 5;       // g sugar / 100 g at/above which a low-carb food's sugar is glycemically significant (a sweet melon) rather than trace (a leafy green whose fibre ≈ total carb)

/** Map a USDA `category` string to the reference table's category, for scoping. */
const CAT_MAP = [
  [/bread/i, 'BREADS'], [/breakfast cereal/i, 'BREAKFAST CEREALS'],
  [/cereal grain|pasta|rice|grain/i, 'CEREAL GRAINS'], [/pasta|noodle/i, 'PASTA AND NOODLES'],
  [/fruit/i, 'FRUIT AND FRUIT PRODUCTS'], [/vegetable/i, 'VEGETABLES'],
  [/legume|bean|lentil|pea/i, 'LEGUMES'], [/nut and seed|nut/i, 'NUTS'],
  [/dairy|milk|yogurt|cheese/i, 'DAIRY PRODUCTS AND ALTERNATIVES'],
  [/beverage|drink|juice/i, 'BEVERAGES'], [/sweet|sugar|syrup/i, 'SUGARS AND SYRUPS'],
  [/snack|cookie|cracker|confection/i, 'SNACK FOODS AND CONFECTIONERY'],
  [/soup/i, 'SOUPS'], [/baked|bakery/i, 'BAKERY PRODUCTS'],
];
const refCategoryFor = (usdaCat = '') => CAT_MAP.find(([re]) => re.test(usdaCat))?.[1] ?? null;

const STOP = new Set(['raw', 'cooked', 'boiled', 'prepared', 'with', 'without', 'and', 'or', 'the',
  'of', 'in', 'all', 'commercial', 'varieties', 'includes', 'usda', 'ns', 'as', 'to', 'from', 'made',
  'unenriched', 'enriched', 'regular', 'plain', 'fresh', 'whole', 'generic', 'drained', 'salt', 'added',
  // fat-level qualifiers describe fat content, not food identity — matching on these
  // alone pairs unrelated foods ("low fat yogurt" ↔ "low-fat apricot cake").
  'low', 'fat', 'reduced', 'skim', 'nonfat', 'lowfat']);
const toks = (s) => new Set(
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
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

const refToks = reference.map((r) => ({ ...r, t: toks(r.food) }));

const clampGi = (n) => Math.min(120, Math.max(1, Math.round(n)));

function assign(food) {
  const carb = food.n?.carbs_g ?? 0;
  const fiber = food.n?.fiber_g ?? 0;
  const avail = Math.max(0, carb - fiber);
  // Genuinely carb-free food (oils, water, salt): 0 available carbohydrate never reaches
  // the composite (the engine ignores contributions ≤0.5 g however much is used), so GI 0
  // is inert — the Louie/Hernandez convention for non-carb foods.
  if (avail <= 0) return { gi: 0, source: 'no available carbohydrate', conf: 'none' };

  // 1) Measured match — only within the same reference category, since cross-category
  //    token matches (e.g. "rice vinegar" ↔ "rice") are the main source of nonsense.
  const refCat = refCategoryFor(food.category);
  const ft = toks(food.description ?? '');
  let best = null;
  if (refCat) for (const r of refToks) {
    if (r.category !== refCat) continue;
    const score = jaccard(ft, r.t);
    if (!best || score > best.score) best = { r, score };
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
  const existing = scoring[key];
  if (existing?.gi != null) { preserved++; continue; } // never overwrite a curated or prior value
  const a = assign(food);
  scoring[key] = { ...(existing ?? {}), gi: a.gi, giSource: a.source, giConfidence: a.conf };
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
