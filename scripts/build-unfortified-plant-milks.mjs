#!/usr/bin/env node
/**
 * Build unfortified plant-milk records. The house plant milks have no added vitamins or
 * minerals, but the USDA unsweetened almond, soy and oat drinks are fortified (calcium,
 * vitamins A, D, E, B12, riboflavin, and phosphate and potassium salts). Each record here
 * copies its USDA drink and replaces every fortificant with what the drink's own almonds,
 * soybeans or oats supply, by mass balance: the drink's protein ÷ the source's protein gives
 * the source's share of the drink, and each fortificant becomes the source's content × that
 * share, never more than the drink's measured value. A fortificant the drink was never
 * analysed for stays blank, and so does one the source lacks (a blank is not a zero).
 *
 * Writes the records into src/data/custom-foods.json (the curated-foods file that
 * scripts/usda-brands.mjs re-injects on every food-database rebuild; each carries its `nova`
 * and a volume portion so a rebuild keeps both, and its NOVA group is also recorded in
 * food-nova-overrides.json) and appends them to src/data/usda-foods.json, so no rebuild is
 * needed now (the next one re-sorts them into place). Copies each base drink's GI entry in
 * food-scoring.json. Idempotent: records are replaced by fdcId, entries added once.
 *
 * Usage: node scripts/build-unfortified-plant-milks.mjs
 *   Then rebuild the classes (build-fii-food-classes.mjs), the inflammation reference
 *   (build-inflammation-reference.mjs) and rescore (rescore-recipes.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const path = (p) => join(ROOT, 'src/data', p);
const r = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Nutrients that fortified plant drinks carry added (USDA ingredient lists; label claims). */
const FORTIFICANTS = ['calcium_mg', 'phosphorus_mg', 'potassium_mg', 'vitA_ug', 'vitD_ug', 'vitE_mg', 'vitB12_ug', 'riboflavin_mg'];

/** Unfortified record ← fortified USDA base drink, with the whole food it is made from. */
const MILKS = [
  { fdcId: 9000101, base: 174832, source: 170567, description: 'Milk, almond, unsweetened, unfortified', kind: 'almond' },
  { fdcId: 9000102, base: 1999630, source: 174270, description: 'Milk, soy, unsweetened, unfortified', kind: 'soy' },
  { fdcId: 9000103, base: 2257046, source: 169705, description: 'Milk, oat, unsweetened, unfortified', kind: 'oat' },
];

log('→ reading USDA foods…');
const usdaText = readFileSync(path('usda-foods.json'), 'utf8');
const byId = new Map(JSON.parse(usdaText).map((f) => [f.fdcId, f]));

const records = MILKS.map((m) => {
  const base = byId.get(m.base);
  const src = byId.get(m.source);
  if (!base || !src) throw new Error(`missing record ${m.base} or ${m.source}`);
  const share = base.n.protein_g / src.n.protein_g;
  const n = { ...base.n };
  for (const k of FORTIFICANTS) {
    if (base.n[k] == null) continue;
    if (src.n[k] == null) delete n[k];
    else n[k] = r(Math.min(base.n[k], src.n[k] * share), 3);
  }
  log(`  ${m.description}: ${(share * 100).toFixed(1)} % ${src.description.toLowerCase()} by protein; ` +
    FORTIFICANTS.filter((k) => base.n[k] != null).map((k) => `${k} ${base.n[k]}→${n[k] ?? 'blank'}`).join(', '));
  // One volume portion from the base drink's density (per100g.cup = cups per 100 g).
  const gPerCup = base.per100g?.cup ? r(100 / base.per100g.cup, 1) : null;
  return {
    custom: {
      fdcId: m.fdcId,
      description: m.description,
      category: base.category,
      nova: base.nova,
      ...(gPerCup ? { portions: [{ label: '1 cup', grams: gPerCup }] } : {}),
      n,
      source: `USDA ${m.base} with fortificants (${FORTIFICANTS.join(', ')}) replaced by USDA ${m.source} × ${r(share, 4)} (protein mass balance)`,
    },
    usda: { fdcId: m.fdcId, description: m.description, n, category: base.category, nova: base.nova, ...(base.per100g ? { per100g: base.per100g } : {}) },
  };
});
const ids = new Set(MILKS.map((m) => m.fdcId));

log('→ writing custom-foods.json…');
const custom = JSON.parse(readFileSync(path('custom-foods.json'), 'utf8')).filter((c) => !ids.has(c.fdcId));
const customOut = [...custom, ...records.map((x) => x.custom)];
writeFileSync(path('custom-foods.json'), '[\n' + customOut.map((c) => '  ' + JSON.stringify(c)).join(',\n') + '\n]\n');

log('→ appending to usda-foods.json…');
const lines = usdaText.split('\n').filter((l) => ![...ids].some((id) => l.startsWith(`  {"fdcId":${id},`)));
const close = lines.lastIndexOf(']');
let prev = close - 1;
while (prev >= 0 && lines[prev].trim() === '') prev--;
if (!lines[prev].endsWith(',')) lines[prev] += ',';
lines.splice(close, 0, records.map((x) => '  ' + JSON.stringify(x.usda)).join(',\n'));
const usdaNext = lines.join('\n');
JSON.parse(usdaNext);
writeFileSync(path('usda-foods.json'), usdaNext);

/** Insert one-line entries before an object file's closing brace, validating before writing. */
function addEntries(file, entries) {
  if (!entries.length) return;
  const text = readFileSync(path(file), 'utf8');
  const next = `${text.replace(/\s*\}\s*$/, '')},\n${entries.join(',\n')}\n}\n`;
  JSON.parse(next);
  writeFileSync(path(file), next);
}
const fmt = (o) => JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');

log('→ copying GI entries and NOVA overrides…');
const scoring = JSON.parse(readFileSync(path('food-scoring.json'), 'utf8'));
addEntries('food-scoring.json', MILKS.filter((m) => scoring[m.base] && scoring[m.fdcId] == null).map((m) => `  "${m.fdcId}": ${fmt(scoring[m.base])}`));
const nova = JSON.parse(readFileSync(path('food-nova-overrides.json'), 'utf8'));
addEntries('food-nova-overrides.json', MILKS.filter((m) => nova[m.fdcId] == null).map((m) =>
  `  "${m.fdcId}": ${fmt({ nova: byId.get(m.base).nova, reason: `${m.kind} drink, unsweetened, unfortified — formulated plant-milk substitute (ultra-processed), as USDA ${m.base}` })}`));

log(`✓ ${MILKS.length} unfortified plant milks (fdcId ${MILKS.map((m) => m.fdcId).join(', ')})`);
