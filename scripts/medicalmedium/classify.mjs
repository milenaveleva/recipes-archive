#!/usr/bin/env node
/**
 * Classify the fetched Medical Medium pages for import.
 *
 *   node scripts/medicalmedium/classify.mjs
 *
 * Reads every scripts/data-raw/medicalmedium/raw/<slug>.json and writes classes.json:
 * per page `{ slug, title, class, recipes, lines, pendingIds, existing, reason }` with `class` one of
 *   recipe    one recipe block with ingredients and directions
 *   multi     several recipe blocks on one page (one import per block)
 *   no-recipe no ingredient block (roundups, articles)
 *   partial   an ingredient block without directions, or directions without ingredients
 * `pendingIds` lists the import ids (source.mjs) of the page's recipe blocks not yet imported;
 * `existing` names a hand-written archive recipe citing the same page (its blocks are skipped).
 * Progress goes to stderr; stdout gets one summary JSON line.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { sourceIdOf } from './source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'scripts/data-raw/medicalmedium');
const RECIPES = path.join(ROOT, 'src/content/recipes');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// Archive recipes already sourced from a page: this importer's own imports by block id
// (source.mjs), and any other recipe citing the page by its page slug.
const imported = new Set();
const cited = new Map();
for (const f of readdirSync(RECIPES).filter((x) => x.endsWith('.md'))) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(RECIPES, f), 'utf8'));
  let data = null;
  try {
    data = fm ? parseYaml(fm[1]) : null;
  } catch {
    data = null;
  }
  const id = sourceIdOf(data);
  if (id) imported.add(id);
  const m = /medicalmedium\.com\/blog\/([a-z0-9-]+)/.exec(data?.source?.url ?? '');
  if (m && !id) cited.set(m[1], f.slice(0, -3));
}

const files = readdirSync(path.join(DATA, 'raw')).filter((f) => f.endsWith('.json')).sort();
log(`→ classifying ${files.length} page(s); ${imported.size} block(s) imported, ${cited.size} page(s) cited by other recipes`);
const out = files.map((f) => {
  const r = JSON.parse(readFileSync(path.join(DATA, 'raw', f), 'utf8'));
  const blocks = r.recipes.filter((x) => x.ingredients.some((g) => g.items.length) || x.directions.length);
  const lines = blocks.reduce((n, x) => n + x.ingredients.reduce((k, g) => k + g.items.length, 0), 0);
  const complete = blocks.filter((x) => x.ingredients.some((g) => g.items.length) && x.directions.length);
  let cls;
  let reason = '';
  if (!blocks.length) {
    cls = 'no-recipe';
    reason = 'no "Ingredients:" block';
  } else if (complete.length < blocks.length) {
    cls = 'partial';
    reason = `${blocks.length - complete.length} of ${blocks.length} block(s) lack ingredients or directions`;
  } else cls = complete.length > 1 ? 'multi' : 'recipe';
  const ids = blocks.map((_, i) => (i ? `${r.slug}--${i + 1}` : r.slug));
  const pendingIds = cls === 'recipe' || cls === 'multi' ? ids.filter((id) => !imported.has(id)) : [];
  return { slug: r.slug, title: r.title, class: cls, recipes: blocks.length, lines, pendingIds, existing: cited.get(r.slug) ?? null, reason };
});
writeFileSync(path.join(DATA, 'classes.json'), JSON.stringify(out, null, 2) + '\n');
const counts = Object.fromEntries(['recipe', 'multi', 'partial', 'no-recipe'].map((c) => [c, out.filter((x) => x.class === c).length]));
const importable = out.filter((x) => !x.existing).reduce((n, x) => n + x.pendingIds.length, 0);
log(`done: ${JSON.stringify(counts)}, ${importable} importable recipe block(s) → ${path.relative(ROOT, path.join(DATA, 'classes.json'))}`);
process.stdout.write(JSON.stringify({ ...counts, importable }) + '\n');
