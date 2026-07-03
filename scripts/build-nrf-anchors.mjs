#!/usr/bin/env node
/**
 * Report the per-100-kcal NRF9.3 distribution across the SHIPPED food corpus, so the
 * integer-score breakpoints in src/core/balance.ts (SCORE_BREAKPOINTS) can be anchored
 * to the real percentile distribution of the foods that actually score recipes.
 *
 * Reads only src/data/usda-foods.json — the bundled, merged dataset the site ships and
 * the matcher scores against (it already contains the curated custom foods and the
 * enCurated national-table foods; the full japan-foods.json source pool is provenance
 * only and never scores a recipe). Each food is scored with the REAL engine
 * (src/core/balance.ts compiled to CommonJS on demand, the way scripts/rescore-recipes.mjs
 * reuses src/core), so the printed percentiles always describe the score the site ships —
 * there is no hand-maintained NRF mirror to drift.
 *
 * Prints percentiles to stderr; does NOT write any file — the operator reads the
 * percentiles and sets the breakpoints (score 5 ≈ p50, 8 ≈ p90, 9 ≈ p95, 10 ≈ top).
 *
 * Usage: node scripts/build-nrf-anchors.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const KJ_PER_KCAL = 4.184;
const energyKcalOf = (n) =>
  Number.isFinite(n?.energyKcal) ? n.energyKcal
  : Number.isFinite(n?.energyKj) ? n.energyKj / KJ_PER_KCAL
  : null;

// ---- compile the balance engine to CommonJS in a temp dir ----
log('→ compiling NRF9.3 engine (src/core/balance.ts) to CommonJS…');
const outDir = mkdtempSync(join(tmpdir(), 'recipes-nrf-'));
try {
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/balance.ts', '--rootDir', 'src', '--outDir', outDir, '--module', 'commonjs',
     '--target', 'es2022', '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const { computeBalance } = await import(pathToFileURL(join(outDir, 'core/balance.js')).href);
  await anchors(computeBalance);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

async function anchors(computeBalance) {
  log('→ loading shipped food corpus (usda-foods.json)…');
  const foods = read('src/data/usda-foods.json');
  const values = [];
  for (const f of foods) {
    const n = f.n ?? {};
    const energyKcalPer100g = energyKcalOf(n);
    if (energyKcalPer100g == null) continue; // no energy basis → no per-100-kcal NRF
    const bal = computeBalance({
      energyKcalPer100g,
      protein_g: n.protein_g,
      fiber_g: n.fiber_g,
      vitA_ug: n.vitA_ug,
      vitC_mg: n.vitC_mg,
      vitE_mg: n.vitE_mg,
      calcium_mg: n.calcium_mg,
      iron_mg: n.iron_mg,
      potassium_mg: n.potassium_mg,
      magnesium_mg: n.magnesium_mg,
      satFat_g: n.satFat_g,
      sugar_g: n.sugar_g,
      sodium_mg: n.sodium_mg,
    });
    if (bal) values.push(bal.nrf);
  }
  log(`  usda-foods.json: ${values.length} foods with an NRF value`);

  values.sort((a, b) => a - b);
  const pct = (p) => {
    const i = (values.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return values[lo] + (values[hi] - values[lo]) * (i - lo);
  };
  const r1 = (x) => Math.round(x * 10) / 10;

  log(`\n→ per-100-kcal NRF9.3 distribution (n=${values.length}):`);
  for (const p of [0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 0.99]) {
    log(`  p${String(Math.round(p * 100)).padStart(2)} = ${r1(pct(p))}`);
  }
  const negShare = values.filter((v) => v < 0).length / values.length;
  log(`  share net-negative (→ score 1): ${(negShare * 100).toFixed(1)}%`);
}
