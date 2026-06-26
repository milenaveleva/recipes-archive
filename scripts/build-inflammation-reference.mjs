#!/usr/bin/env node
/**
 * Build the open reference distribution the Food Inflammation Index (FII) normalises
 * against. For each FII parameter (src/data/fii-parameters.json) it computes a robust
 * centre (median) and scale (IQR/1.349) of that nutrient across the USDA corpus
 * (src/data/usda-foods.json) — plus polyphenols merged from src/data/polyphenols.json —
 * then runs the same per-food FII arithmetic the engine uses to capture the corpus
 * centre/scale of the raw score, so a per-food score can be standardised onto the
 * −2…+2 axis. Output: src/data/inflammation-reference.json.
 *
 * This referent is computed openly from public-domain composition data; it does NOT use
 * the licensed DII per-parameter effect scores. The arithmetic here MUST mirror
 * src/core/fii.ts (kept in lockstep by src/core/fii.test.ts).
 *
 * Usage: node scripts/build-inflammation-reference.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { valueOf as valueOfShared, rawFII as rawFIIof, foodTag } from './lib/fii.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

log('→ reading composition data…');
const foods = read('src/data/usda-foods.json');
const { parameters, clampZ, fallbackMinN = 50 } = read('src/data/fii-parameters.json');
let polyphenols = {};
try {
  polyphenols = read('src/data/polyphenols.json');
} catch {
  log('  (no polyphenols.json yet — polyphenol parameter will be empty)');
}
log(`  ${foods.length} foods, ${parameters.length} FII parameters`);

/** Per-100g value for one food + parameter key, via the shared FII arithmetic. */
const valueOf = (food, key) => valueOfShared(food, key, polyphenols);

function robustStats(values) {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { center: 0, scale: 1, n: 0 };
  const q = (p) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
  };
  const center = q(0.5);
  let scale = (q(0.75) - q(0.25)) / 1.349; // IQR → robust SD estimate
  if (!(scale > 0)) {
    // Degenerate IQR (mass of identical values, e.g. mostly-zero columns): fall back
    // to the population SD; if that is also zero the column is constant → scale 1.
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    scale = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n) || 1;
  }
  return { center, scale, n };
}

log('→ per-nutrient robust centre/scale…');
const params = {};
for (const p of parameters) {
  const vals = [];
  for (const f of foods) {
    const v = valueOf(f, p.nutrient);
    if (v !== undefined) vals.push(v);
  }
  const stats = robustStats(vals);
  // When corpus coverage is too sparse to estimate a robust referent (e.g. polyphenols,
  // seeded for only a handful of foods), use the parameter's fixed open fallback so the
  // signal is normalised against a sensible absolute, not a tiny cherry-picked sample.
  if (p.fallback && stats.n < fallbackMinN) {
    params[p.nutrient] = { center: p.fallback.center, scale: p.fallback.scale, n: stats.n, fallback: true };
  } else {
    params[p.nutrient] = stats;
  }
  const pr = params[p.nutrient];
  log(`  ${p.nutrient.padEnd(13)} n=${String(pr.n).padStart(4)}  ` +
    `center=${pr.center.toFixed(2)}  scale=${pr.scale.toFixed(2)}${pr.fallback ? '  (fallback)' : ''}`);
}

log('→ corpus distribution of the raw FII…');
const raws = [];
for (const f of foods) {
  const r = rawFIIof(f, { parameters, paramStats: params, polyphenols, clampZ });
  if (r !== null) raws.push(r.raw);
}
const fiiRaw = robustStats(raws);
log(`  fiiRaw n=${fiiRaw.n}  center=${fiiRaw.center.toFixed(3)}  scale=${fiiRaw.scale.toFixed(3)}`);

log('→ per-food tag distribution → quantile band edges…');
// Band the five-band scale by quintile of the standardised per-food tag distribution
// (the reference population of single foods), so a recipe's band reflects where its
// energy-weighted score sits among foods rather than against arbitrary fixed cut-points.
// These are composition tags — the per-food food-form adjustment (foodAdjust.ts) is left
// out so the bands describe the FII's compositional distribution; it corrects only a
// handful of foods, so its effect on the quintile edges would be negligible regardless.
const tagCtx = { parameters, paramStats: params, fiiRaw, polyphenols, clampZ };
const tags = [];
for (const f of foods) {
  const t = foodTag(f, tagCtx);
  if (t) tags.push(t.tag);
}
const sortedTags = tags.sort((a, b) => a - b);
const quantile = (p) => {
  if (sortedTags.length === 0) return 0;
  const i = (sortedTags.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sortedTags[lo] + (sortedTags[hi] - sortedTags[lo]) * (i - lo);
};
const round1 = (x) => Math.round(x * 10) / 10;
const bands = {
  antiMax: round1(quantile(0.2)),
  mildlyAntiMax: round1(quantile(0.4)),
  neutralMax: round1(quantile(0.6)),
  mildlyProMax: round1(quantile(0.8)),
};
log(`  bands antiMax=${bands.antiMax} mildlyAntiMax=${bands.mildlyAntiMax} ` +
  `neutralMax=${bands.neutralMax} mildlyProMax=${bands.mildlyProMax}  (n=${tags.length})`);

const out = {
  _doc: 'GENERATED by scripts/build-inflammation-reference.mjs — do not hand-edit. Open reference distribution for the FII (src/core/fii.ts): per-nutrient robust centre/scale, the corpus centre/scale of the raw FII used to standardise a per-food score onto the −2…+2 axis, and the quintile band edges of the per-food tag distribution (read by src/core/inflammation.ts inflammationBandOf).',
  generatedFromFoods: foods.length,
  clampZ,
  params,
  fiiRaw,
  bands,
};
writeFileSync(join(ROOT, 'src/data/inflammation-reference.json'), JSON.stringify(out, null, 2) + '\n');
log('✓ wrote src/data/inflammation-reference.json');
