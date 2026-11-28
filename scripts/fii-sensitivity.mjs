#!/usr/bin/env node
/**
 * Sensitivity analysis of the inflammatory-potential score (src/core/fii.ts): re-scores every
 * recipe and the evidence-ordered food pairs under alternative calibration choices and
 * reports, per variant, Kendall's τ-b of the recipe ranking against the shipped parameters,
 * the share of recipes whose band changes, and how many evidence-ordered food pairs keep
 * their order. A ranking that holds across the variants is not an artefact of one hand-set
 * choice (the validation plan of reports/Recipe inflammation score methods.md).
 *
 * Variants: equal weights (the eADI-17 precedent, Kałuża 2025); weights proportional to the
 * DII overall effect scores (Shivappa 2014) where the DII has the parameter; the medium-chain
 * saturated-fat factor at 0.25 and 0.5; the blended-fruit free-sugar fraction at 0 (WHO as
 * operationalised by Wanselius 2019) and 1 (UK SACN); the z clamp at 2 and 4; the quorum at
 * 3 and 5; the coverage threshold at 0.3 and 0.7. Each variant re-derives the raw-score
 * spread its own weights imply; the per-parameter referents are shared.
 *
 * The aromatic term is left out (it is identical across variants); the matrix correction is
 * kept. A second table shows the share of recipes in each band, on those composition scores,
 * under alternative band edges.
 * Report only: it never writes files.
 *
 * Usage: node scripts/fii-sensitivity.mjs
 *   Progress goes to stderr; the table goes to stdout.
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

/** Evidence-ordered pairs (more anti first), mirrored from src/core/fii.test.ts. */
const PAIRS = [
  ['Fish, salmon, Atlantic, farmed, raw', 'Butter, without salt'],
  ['Oil, olive, salad or cooking', 'Butter, without salt'],
  ['Blueberries, raw', 'Bananas, raw'],
  ['Bananas, raw', 'Honey'],
  ['Dates, medjool', 'Sugars, granulated'],
  ['Orange juice, raw', 'Sugars, granulated'],
  ['Yogurt, plain, whole milk', 'Butter, without salt'],
  ['Spinach, raw', 'Bread, white wheat'],
  ['Nuts, almonds', 'Sugars, granulated'],
];

log('→ compiling compute engine (src/core) to CommonJS…');
const outDir = mkdtempSync(join(tmpdir(), 'recipes-core-'));
try {
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/recipeScore.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
     '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const fii = await import(pathToFileURL(join(outDir, 'core/fii.js')).href);
  const rs = await import(pathToFileURL(join(outDir, 'core/recipeScore.js')).href);
  run(fii, rs);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function robustScale(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => { const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  return (q(0.75) - q(0.25)) / 1.349;
}

function kendallTauB(a, b) {
  let c = 0, d = 0, ta = 0, tb = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const x = Math.sign(a[i] - a[j]);
      const y = Math.sign(b[i] - b[j]);
      if (x === 0 && y === 0) continue;
      if (x === 0) ta++;
      else if (y === 0) tb++;
      else if (x === y) c++;
      else d++;
    }
  }
  return (c - d) / Math.sqrt((c + d + ta) * (c + d + tb));
}

function run(fii, rs) {
  const { PARAMS, bundledReference, scoreComposition, pooledDensities, rawScore } = fii;
  const base = bundledReference();
  const foods = read('src/data/usda-foods.json');
  const foodById = new Map(['usda-foods', 'japan-foods', 'france-foods', 'custom-foods']
    .flatMap((n) => read(`src/data/${n}.json`)).map((f) => [f.fdcId, f]));
  const scoring = read('src/data/food-scoring.json');
  const poly = read('src/data/polyphenols.json');

  log('→ assembling recipes…');
  const recipes = [];
  const dir = join(ROOT, 'src/content/recipes');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, file), 'utf8'));
    const data = fm ? parseYaml(fm[1]) : null;
    if (!data?.ingredients?.length) continue;
    const items = data.ingredients.map(rs.storedScoringFields)
      .filter((i) => !i.excludeFromNutrition && i.grams > 0 && i.fdcId != null)
      .map((i) => rs.toScored(i, foodById, scoring, poly))
      .filter((s) => s.grams > 0 && s.nutrients)
      .map((s) => ({ grams: s.grams, nutrients: s.nutrients, fdcId: s.fdcId, prep: s.prep }));
    if (items.length) recipes.push({ file, items });
  }
  const corpusItems = foods.map((f) => [{ grams: 100, nutrients: rs.nutrientsFor(f, poly), fdcId: f.fdcId }]);
  const corpusPooled = corpusItems.map((it) => pooledDensities(it));
  const byDesc = (d) => foods.find((f) => f.description.startsWith(d));
  log(`  ${recipes.length} recipes, ${foods.length} corpus foods`);

  const withParams = (patch) => ({ ...PARAMS, ...patch, parameters: (patch.parameters ?? PARAMS.parameters) });
  const reweight = (fn) => PARAMS.parameters.map((p) => ({ ...p, weight: fn(p) }));
  const variants = [
    ['shipped', PARAMS],
    ['equal weights', withParams({ parameters: reweight(() => 1) })],
    ['DII-proportional weights', withParams({ parameters: reweight((p) => (p.dii != null ? Math.abs(p.dii) / 0.663 : p.weight)) })],
    ['medium-chain SFA ×0.25', withParams({ mediumChainSfaFactor: 0.25 })],
    ['medium-chain SFA ×0.5', withParams({ mediumChainSfaFactor: 0.5 })],
    ['blended fruit free sugar 0 (WHO)', withParams({ pureeFreeSugarFraction: 0 })],
    ['blended fruit free sugar 1 (UK)', withParams({ pureeFreeSugarFraction: 1 })],
    ['clamp z at 2', withParams({ clampZ: 2 })],
    ['clamp z at 4', withParams({ clampZ: 4 })],
    ['quorum 3', withParams({ quorum: 3 })],
    ['quorum 5', withParams({ quorum: 5 })],
    ['coverage ≥ 0.3', withParams({ minCoverage: 0.3 })],
    ['coverage ≥ 0.7', withParams({ minCoverage: 0.7 })],
  ];

  const scoresFor = (params) => {
    const pooled = params === PARAMS ? corpusPooled : corpusItems.map((it) => pooledDensities(it, params));
    const raws = pooled.map((d) => (d ? rawScore(d, base, params) : null)).filter(Boolean).map((r) => r.raw);
    const ref = { ...base, fiiRaw: { center: 0, scale: robustScale(raws) } };
    const recipe = recipes.map((r) => scoreComposition(r.items, ref, params)?.tag ?? null);
    const pairs = PAIRS.filter(([a, b]) => {
      const fa = byDesc(a), fb = byDesc(b);
      const ta = scoreComposition([{ grams: 100, nutrients: rs.nutrientsFor(fa, poly), fdcId: fa.fdcId }], ref, params)?.tag;
      const tb = scoreComposition([{ grams: 100, nutrients: rs.nutrientsFor(fb, poly), fdcId: fb.fdcId }], ref, params)?.tag;
      return ta < tb;
    }).length;
    return { recipe, pairs };
  };
  const bandOf = (s) => (s <= PARAMS.bands.antiMax ? 0 : s <= PARAMS.bands.mildlyAntiMax ? 1 : s <= PARAMS.bands.neutralMax ? 2 : s <= PARAMS.bands.mildlyProMax ? 3 : 4);

  log('→ scoring variants…');
  const baseline = scoresFor(PARAMS);
  const rows = [];
  for (const [name, params] of variants) {
    log(`  ${name}`);
    const v = name === 'shipped' ? baseline : scoresFor(params);
    const idx = v.recipe.map((s, i) => i).filter((i) => v.recipe[i] != null && baseline.recipe[i] != null);
    const tau = kendallTauB(idx.map((i) => baseline.recipe[i]), idx.map((i) => v.recipe[i]));
    const moved = idx.filter((i) => bandOf(v.recipe[i]) !== bandOf(baseline.recipe[i])).length;
    const median = [...idx.map((i) => v.recipe[i])].sort((a, b) => a - b)[idx.length >> 1];
    rows.push({ name, tau, moved: moved / idx.length, pairs: v.pairs, median });
  }
  process.stdout.write('| Variant | Kendall τ-b vs shipped | Recipes changing band | Evidence pairs in order | Median recipe score |\n|---|---|---|---|---|\n');
  for (const r of rows) {
    process.stdout.write(`| ${r.name} | ${r.tau.toFixed(3)} | ${(r.moved * 100).toFixed(1)} % | ${r.pairs}/${PAIRS.length} | ${r.median.toFixed(1)} |\n`);
  }
  // Band shares of the shipped composition scores (before the aromatic, AGE and
  // ultra-processing adjustments) under alternative band edges (the edges are a judgment).
  const shipped = baseline.recipe.filter((x) => x != null);
  const edgeSets = [['±0.2 / ±0.8', 0.2, 0.8], ['±0.3 / ±1 (shipped edges)', 0.3, 1], ['±0.4 / ±1.2', 0.4, 1.2], ['±0.5 / ±1.5', 0.5, 1.5]];
  process.stdout.write('\n| Band edges (neutral / mildly), composition scores | Anti | Mildly anti | Neutral | Mildly pro | Pro |\n|---|---|---|---|---|---|\n');
  for (const [name, n, m] of edgeSets) {
    const c = [0, 0, 0, 0, 0];
    for (const s of shipped) c[s <= -m ? 0 : s <= -n ? 1 : s <= n ? 2 : s <= m ? 3 : 4]++;
    process.stdout.write(`| ${name} | ${c.map((x) => `${((100 * x) / shipped.length).toFixed(0)} %`).join(' | ')} |\n`);
  }
  log('✓ done');
}
