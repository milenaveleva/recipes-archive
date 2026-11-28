#!/usr/bin/env node
/**
 * Build src/data/polyphenol-retention.json — polyphenol retention factors (RF = content after
 * processing ÷ content before, corrected for water change) per polyphenol subclass × domestic
 * cooking method, and per food × subclass × method, from the Phenol-Explorer retention-factor
 * tables (Rothwell 2013, Phenol-Explorer 3.0; analysed in Rothwell 2015).
 *
 * Rothwell 2015 advises using only retention factors that match at least the food and the
 * polyphenol, so src/core/cooking.ts applies them in three tiers: the food × subclass × method
 * factor when the ingredient's food is one Phenol-Explorer measured (joined through
 * src/data/phenol-crosswalk.json); else the subclass × method median across foods, when at
 * least `MIN_FOODS` foods back it; else the generic domestic-cooking median.
 *
 * Phenol-Explorer publishes the factors as browsable tables, not a download: this script
 * fetches the retention-factor index (one row per compound × process) and each row's per-food
 * table once into the git-ignored scripts/data-raw/phenol-explorer-rf/ cache (politely, one
 * request at a time), and commits only the derived medians. Each subclass's factor for a food
 * is the median over that food's compound rows (the subclass's aglycones and glycosides).
 *
 * Usage: node scripts/build-polyphenol-retention.mjs   (add --offline to use the cache only)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts/data-raw/phenol-explorer-rf');
const BASE = 'http://phenol-explorer.eu';
const OFFLINE = process.argv.includes('--offline');
const MIN_FOODS = 3;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
mkdirSync(CACHE, { recursive: true });

/** Phenol-Explorer class heading → our subclass field. */
const CLASS = {
  'Flavonoids - Anthocyanins': 'anthocyanidins_mg',
  'Flavonoids - Flavanols': 'flavan3ols_mg',
  'Flavonoids - Flavanones': 'flavanones_mg',
  'Flavonoids - Flavones': 'flavones_mg',
  'Flavonoids - Flavonols': 'flavonols_mg',
  'Other polyphenols - Tyrosols': 'tyrosols_mg',
};
/** Phenol-Explorer domestic process → our cooking method (src/core/cooking.ts). */
const METHOD = {
  boiled: 'boiled', 'soaked, boiled': 'boiled', 'dehulled, soaked, boiled': 'boiled',
  steamed: 'steamed',
  baked: 'baked', roasted: 'baked',
  grilled: 'grilled',
  fried: 'fried',
  blanched: 'blanched',
  microwaved: 'microwaved',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, file) {
  const p = join(CACHE, file);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  if (OFFLINE) throw new Error(`not cached: ${file}`);
  await sleep(400);
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(p, text);
  return text;
}
const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

log('→ reading the retention-factor index…');
const rows = []; // { cls, compound, process, id }
const first = await get('/retention-factors/polyphenols', 'index-1.html');
const pages = Math.max(1, ...[...first.matchAll(/polyphenols\?page=(\d+)/g)].map((m) => Number(m[1])));
for (let page = 1; page <= pages; page++) {
  const html = page === 1 ? first : await get(`/retention-factors/polyphenols?page=${page}`, `index-${page}.html`);
  let cls = null;
  for (const tr of html.split(/<tr\b/).slice(1)) {
    const head = /class="class-head"[^>]*>\s*<th[^>]*>([^<]*)</.exec(tr);
    if (head) { cls = strip(head[1]); continue; }
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const link = /href="\/food-processing\/(\d+)\/compounds"/.exec(tr);
    if (tds.length >= 4 && link) rows.push({ cls, compound: strip(tds[0]), process: strip(tds[1]), id: link[1] });
  }
  if (page % 5 === 0 || page === pages) log(`  index page ${page}/${pages} (${rows.length} rows)`);
}
const wanted = rows.filter((r) => CLASS[r.cls] && METHOD[r.process]);
log(`  ${rows.length} compound × process rows; ${wanted.length} in our subclasses × domestic methods`);

log('→ reading per-food factors…');
// field → method → food → [RF per compound]
const byFood = {};
let done = 0;
const pageCache = new Map();
for (const r of wanted) {
  if (!pageCache.has(r.id)) pageCache.set(r.id, await get(`/food-processing/${r.id}/compounds`, `fp-${r.id}.html`));
  const html = pageCache.get(r.id);
  const field = CLASS[r.cls];
  const method = METHOD[r.process];
  // The detail page lists every compound of this process; keep the rows under our compound's heading.
  let current = null;
  for (const tr of html.split(/<tr\b/).slice(1)) {
    const th = /<th[^>]*class="outer"[^>]*>([\s\S]*?)<\/th>/.exec(tr);
    if (th) { current = strip(th[1]); continue; }
    if (!current || !current.endsWith(` - ${r.compound}`)) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (tds.length < 7) continue;
    const food = tds[1];
    const rf = parseFloat(tds[2]);
    if (!food || !Number.isFinite(rf)) continue;
    ((byFood[field] ??= {})[method] ??= {});
    (byFood[field][method][food] ??= []).push(rf);
  }
  if (++done % 50 === 0 || done === wanted.length) log(`  ${done}/${wanted.length}`);
}

const crosswalk = JSON.parse(readFileSync(join(ROOT, 'src/data/phenol-crosswalk.json'), 'utf8'));
const r2 = (x) => Math.round(x * 100) / 100;
const classMethod = {};
const foods = {};
for (const [field, methods] of Object.entries(byFood)) {
  for (const [method, perFood] of Object.entries(methods)) {
    const foodRf = Object.fromEntries(Object.entries(perFood).map(([f, v]) => [f, median(v)]));
    const vals = Object.values(foodRf);
    if (vals.length >= MIN_FOODS) (classMethod[field] ??= {})[method] = { rf: r2(median(vals)), foods: vals.length };
    for (const [food, rf] of Object.entries(foodRf)) {
      for (const id of [crosswalk[food] ?? []].flat()) ((foods[String(id)] ??= {})[field] ??= {})[method] = r2(rf);
    }
  }
}
for (const [field, m] of Object.entries(classMethod)) log(`  ${field.padEnd(18)} ${Object.entries(m).map(([k, v]) => `${k}=${v.rf} (${v.foods})`).join(' ')}`);
log(`  ${Object.keys(foods).length} recipe-joinable foods with food-specific factors`);

writeFileSync(join(ROOT, 'src/data/polyphenol-retention.json'), JSON.stringify({
  _doc: 'GENERATED by scripts/build-polyphenol-retention.mjs from the Phenol-Explorer retention-factor tables (Rothwell 2013; Rothwell 2015) — do not hand-edit. Polyphenol retention factors (content after cooking ÷ before, water-corrected) read by src/core/cooking.ts in three tiers: `foods` (fdcId → subclass → method; the food Phenol-Explorer measured, joined through phenol-crosswalk.json), else `classMethod` (subclass → method median across at least ' + MIN_FOODS + ' foods, with the count), else `fallback` (the 0.45–0.70 median domestic-cooking range of Rothwell 2015, midpoint).',
  fallback: 0.575,
  classMethod,
  foods,
}, null, 1) + '\n');
log('✓ wrote src/data/polyphenol-retention.json');
