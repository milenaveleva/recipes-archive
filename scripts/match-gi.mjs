#!/usr/bin/env node
/**
 * Assign a GI (+ cited source + confidence) to every carbohydrate-bearing food in
 * usda-foods.json by matching it against the Atkinson 2021 reference built by
 * scripts/build-gi.mjs (src/data/gi-reference.json), then write the result into
 * src/data/food-scoring.json. This is the scalable replacement for hand-curating
 * a GI per food: as recipes add foods, re-running this assigns them automatically.
 *
 * Matching tiers → giConfidence (following the published protocol of Lin 2012 /
 * Martin 2008 / Hernandez 2022 for adding GI to a food-composition database):
 *   high   — strong token match to a specific reference food in a compatible category
 *   medium — partial match to a specific reference food
 *   low    — no specific match; the food's category-mean GI from the tables
 *   (none) — < CARB_MIN available carb/100g: GI is undefined and omitted
 *
 * Foods already carrying a hand-verified GI (giConfidence medium/high in
 * food-scoring.json) are preserved, never downgraded by an auto-match.
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

const CARB_MIN = 2.5; // g available carb / 100 g below which GI is undefined (Lin 2012)
const GI_SOURCE_2021 = 'Atkinson 2021';

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
  'unenriched', 'enriched', 'regular', 'plain', 'fresh', 'whole', 'generic', 'drained', 'salt', 'added']);
const toks = (s) => new Set(
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

// Category-mean GI (low-confidence fallback), from the reference table.
const catGis = new Map();
for (const r of reference) (catGis.get(r.category) ?? catGis.set(r.category, []).get(r.category)).push(r.gi);
const catMean = new Map([...catGis].map(([c, v]) => [c, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]));

const refToks = reference.map((r) => ({ ...r, t: toks(r.food) }));

function assign(food) {
  const carb = food.n?.carbs_g ?? 0;
  const fiber = food.n?.fiber_g ?? 0;
  const avail = Math.max(0, carb - fiber);
  if (avail < CARB_MIN) return null; // GI undefined for near-carb-free foods

  const refCat = refCategoryFor(food.category);
  if (!refCat) return { worklist: true }; // no compatible category → needs curation
  // Only compare within the same reference category — cross-category token
  // matches (e.g. "rice vinegar" ↔ "rice") are the main source of nonsense.
  const ft = toks(food.description);
  let best = null;
  for (const r of refToks) {
    if (r.category !== refCat) continue;
    const score = jaccard(ft, r.t);
    if (!best || score > best.score) best = { r, score };
  }
  // Conservative: only auto-assign a strong, same-category match. Anything weaker
  // is left for human curation rather than guessed (a wrong GI is worse than none).
  if (best && best.score >= 0.6) return { gi: best.r.gi, source: `Atkinson 2021 (${best.r.food})`, conf: 'high' };
  if (best && best.score >= 0.45) return { gi: best.r.gi, source: `Atkinson 2021 (${best.r.food})`, conf: 'medium' };
  return { worklist: true };
}

const used = new Set();
for (const t of readdirSync(join(ROOT, 'src/content/recipes')).filter((f) => f.endsWith('.md'))) {
  const s = readFileSync(join(ROOT, 'src/content/recipes', t), 'utf8');
  for (const m of s.matchAll(/fdcId:\s*(\d+)/g)) used.add(Number(m[1]));
}

let assigned = 0, preserved = 0, skipped = 0, worklist = 0;
const report = [], toCurate = [];
for (const food of foods) {
  const key = String(food.fdcId);
  const existing = scoring[key];
  if (existing?.gi != null) { preserved++; continue; } // keep every curated value, any confidence
  const a = assign(food);
  if (!a) { skipped++; continue; }              // carb-free: GI undefined by design
  if (a.worklist) {
    worklist++;
    if (used.has(food.fdcId)) toCurate.push(`  ⚠ ${food.description.slice(0, 50)}  (fdcId ${food.fdcId})`);
    continue;
  }
  scoring[key] = { ...(existing ?? {}), gi: a.gi, giSource: a.source, giConfidence: a.conf };
  assigned++;
  if (used.has(food.fdcId)) report.push(`  [${a.conf}] ${food.description.slice(0, 42).padEnd(42)} → GI ${a.gi}  (${a.source})`);
}

log(`Auto-assigned ${assigned} strong matches | preserved ${preserved} curated | ${skipped} carb-free (no GI) | ${worklist} need curation.`);
log('— USED foods auto-assigned (verify) —');
report.sort().forEach((r) => log(r));
log(`— USED carb-bearing foods still needing a GI (${toCurate.length}) —`);
toCurate.sort().forEach((r) => log(r));

if (WRITE) {
  const ordered = Object.entries(scoring).sort((a, b) => Number(a[0]) - Number(b[0]));
  const line = (v) => JSON.stringify(v, null, 1).replace(/\n\s*/g, ' '); // spaced single-line object
  writeFileSync(join(ROOT, 'src/data/food-scoring.json'),
    '{\n' + ordered.map(([k, v]) => `  ${JSON.stringify(k)}: ${line(v)}`).join(',\n') + '\n}\n');
  log('✓ wrote src/data/food-scoring.json');
} else {
  log('(dry-run — pass --write to persist)');
}
