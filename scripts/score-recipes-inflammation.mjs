#!/usr/bin/env node
/**
 * Recompute the precomputed `nutrition.inflammation` block of every recipe that has one,
 * using the current Food Inflammation Index (shared arithmetic in scripts/lib/fii.mjs,
 * mirroring src/core/fii.ts + src/core/inflammation.ts). The site is fully prerendered, so
 * recipe scores are stored in frontmatter and must be regenerated when the method changes.
 *
 * Only the inflammation block is rewritten (score, band, method) — glycemic / Nutri-Score /
 * balance are left untouched. Per-food tags come from each matched food's composition; the
 * recipe score is the energy-weighted mean with a per-gram mass floor.
 *
 * Usage: node scripts/score-recipes-inflammation.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { foodTag, energyKcalOf, aggregateInflammation } from './lib/fii.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const DATA_SOURCE = 'Food Inflammation Index (composition-derived, energy-weighted); Phenol-Explorer polyphenols';

log('→ loading composition + FII reference…');
const byId = new Map(read('src/data/usda-foods.json').map((f) => [f.fdcId, f]));
const { parameters, clampZ } = read('src/data/fii-parameters.json');
const reference = read('src/data/inflammation-reference.json');
const polyphenols = read('src/data/polyphenols.json');
const ctx = { parameters, paramStats: reference.params, fiiRaw: reference.fiiRaw, polyphenols, clampZ };

/** Energy-weighted recipe inflammation from resolved ingredients, or null. Mirrors the
 *  engine: per-food FII tag (foodTag) + absolute kcal (energyKcalOf), aggregated by
 *  aggregateInflammation — all from the shared scripts/lib/fii.mjs. */
function recipeInflammation(ingredients) {
  const items = [];
  for (const ing of ingredients ?? []) {
    if (ing.excludeFromNutrition) continue;
    const grams = ing.grams;
    if (!(grams > 0) || ing.fdcId == null) continue;
    const food = byId.get(ing.fdcId);
    if (!food) continue;
    const t = foodTag(food, ctx);
    if (!t) continue;
    const kcalPer100 = energyKcalOf(food.n);
    const energyKcal = kcalPer100 != null ? (kcalPer100 * grams) / 100 : null;
    items.push({ grams, energyKcal, tag: t.tag });
  }
  return aggregateInflammation(items);
}

const dir = join(ROOT, 'src/content/recipes');
let changed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) continue;
  const data = parseYaml(fm[1]);
  const existing = data?.nutrition?.inflammation;
  if (!existing) continue; // only rescore recipes that already carry the block

  const next = recipeInflammation(data.ingredients);
  if (!next) {
    log(`  ${file}: no scorable ingredients — left as-is (${existing.score})`);
    continue;
  }
  const block =
    `  inflammation:\n    score: ${next.score}\n    band: ${next.band}\n    method: fii v2\n`;
  // Replace the whole inflammation block (its 4-space-indented children), in place,
  // and refresh the inflammation provenance line so dataSources can't drift from method.
  const blockRe = /^  inflammation:\n(?:    .*(?:\n|$))*/m;
  if (!blockRe.test(text)) {
    log(`  ${file}: ⚠ inflammation block not matched — skipped`);
    continue;
  }
  const updated = text
    .replace(blockRe, block)
    .replace(/^    - Inflammation index .*$/m, `    - ${DATA_SOURCE}`);
  if (updated === text) {
    log(`  ${file}: unchanged (already current)`);
    continue;
  }
  writeFileSync(path, updated);
  changed++;
  log(`  ${file}: ${existing.score} (${existing.band}) → ${next.score} (${next.band})`);
}
log(`✓ rescored ${changed} recipe(s)`);
