#!/usr/bin/env node
/**
 * Build the open reference distribution the inflammatory-potential score standardises
 * against (src/data/inflammation-reference.json), using the REAL engine (src/core/fii.ts,
 * compiled to CommonJS in a temp dir, as scripts/rescore-recipes.mjs does), so the referent
 * and the score can never drift apart.
 *
 * Over every USDA food (src/data/usda-foods.json, polyphenol subclasses merged in), each
 * scored as a one-item dish of 100 g:
 *   - `corpus` parameters: centred on an approximation of the average diet's density per kcal (fii-parameters.json
 *     dietMean ÷ dietEnergyKcal, Shivappa 2014) and scaled by the robust spread (IQR/1.349)
 *     of the per-food per-100-kcal densities;
 *   - `carrier` components: the median per-100-kcal density among the foods that carry the
 *     component (> 0), so the typical carrier reads ≈ 1 unit (flagged `sparse` while fewer
 *     than `fallbackMinN` foods carry it);
 *   - the corpus spread of the raw score (its zero point is the parameters' own), which
 *     maps a score onto −2…+2;
 *   - the five band edges, copied from fii-parameters.json `bands` (fixed edges on the
 *     axis; the per-food quintiles are logged for comparison).
 * `limit` parameters need no referent (they are read in multiples of a WHO limit).
 *
 * Usage: node scripts/build-inflammation-reference.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

log('→ compiling compute engine (src/core) to CommonJS…');
const outDir = mkdtempSync(join(tmpdir(), 'recipes-core-'));
try {
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/recipeScore.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
     '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const fii = await import(pathToFileURL(join(outDir, 'core/fii.js')).href);
  const rs = await import(pathToFileURL(join(outDir, 'core/recipeScore.js')).href);
  build(fii, rs);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

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
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    scale = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n) || 1;
  }
  return { center, scale, n, q };
}

function build({ PARAMS, pooledDensities, rawScore, scoreComposition }, { nutrientsFor }) {
  log('→ reading composition data…');
  const foods = read('src/data/usda-foods.json');
  const polyphenols = read('src/data/polyphenols.json');
  const { fallbackMinN = 50 } = read('src/data/fii-parameters.json');
  const items = foods.map((f) => ({ grams: 100, nutrients: nutrientsFor(f, polyphenols), fdcId: f.fdcId }));
  log(`  ${foods.length} foods, ${PARAMS.parameters.length} parameters (${PARAMS.version})`);

  const pooled = items.map((it) => pooledDensities([it]));
  log('→ per-parameter referents…');
  const corpus = {};
  const carrier = {};
  for (const p of PARAMS.parameters) {
    if (p.scale === 'corpus') {
      const vals = pooled.map((d) => d?.densities.find((x) => x.key === p.key)).filter((d) => d?.present && d.density !== undefined).map((d) => d.density);
      const { scale, n } = robustStats(vals);
      // Zero point ≈ the average diet's density: Shivappa 2014 global mean intake ÷ its mean
      // energy (a ratio of means; the E-DII's own energy-adjusted reference is unpublished).
      if (!(p.dietMean > 0) || !(PARAMS.dietEnergyKcal > 0)) throw new Error(`${p.key}: corpus parameters need dietMean and dietEnergyKcal`);
      const center = (p.dietMean / PARAMS.dietEnergyKcal) * 100;
      corpus[p.key] = { center, scale, n };
      log(`  ${p.key.padEnd(16)} corpus  n=${String(n).padStart(4)} center=${center.toFixed(3)} scale=${scale.toFixed(3)}`);
    } else if (p.scale === 'carrier') {
      for (const f of Object.keys(p.fields)) {
        const vals = pooled.map((d) => d?.densities.find((x) => x.key === p.key)?.components?.[f]).filter((v) => v > 0);
        const { center, n } = robustStats(vals);
        if (p.units?.[f] > 0) {
          // A component nearly every food carries in trace amounts takes a fixed intake unit.
          carrier[f] = { median: p.units[f], n, unit: 'fixed' };
          log(`  ${`${p.key}.${f}`.padEnd(34)} carrier n=${String(n).padStart(4)} unit=${p.units[f]} (fixed)`);
          continue;
        }
        if (!(center > 0)) throw new Error(`no food carries ${p.key}.${f} — the carrier scale is undefined`);
        // A sparsely measured component still takes its measured median (flagged), never a
        // fixed constant: the scale stays tied to real content.
        carrier[f] = { median: center, n, ...(n < fallbackMinN ? { sparse: true } : {}) };
        log(`  ${`${p.key}.${f}`.padEnd(34)} carrier n=${String(n).padStart(4)} median=${center.toPrecision(4)}${n < fallbackMinN ? ' (sparse)' : ''}`);
      }
    } else {
      log(`  ${p.key.padEnd(16)} limit   unit=${p.scale.limit}`);
    }
  }

  log('→ corpus distribution of the raw score…');
  const provisional = { corpus, carrier, fiiRaw: { center: 0, scale: 1 } };
  const raws = pooled.map((d) => (d ? rawScore(d, provisional) : null)).filter(Boolean).map((r) => r.raw);
  // The zero point stays the parameters' own (the average diet's density for protective nutrients, no
  // intake for limits); only the spread of the raw score is read from the corpus, so a
  // corpus dominated by vegetables does not move a lentil or an oat toward pro.
  const { scale, n } = robustStats(raws);
  const fiiRaw = { center: 0, scale, n };
  log(`  fiiRaw n=${n} center=0 scale=${scale.toFixed(4)}`);

  log('→ per-food score distribution (bands are fixed in fii-parameters.json)…');
  const ref = { corpus, carrier, fiiRaw };
  const tags = items.map((it) => scoreComposition([it], ref)).filter(Boolean).map((s) => s.composition).sort((a, b) => a - b);
  const pct = (p) => tags[Math.floor(p * (tags.length - 1))].toFixed(2);
  log(`  food score quintile edges ${[0.2, 0.4, 0.6, 0.8].map(pct).join(' ')} (n=${tags.length}); bands ${JSON.stringify(PARAMS.bands)}`);
  const bands = PARAMS.bands;
  const out = {
    _doc: 'GENERATED by scripts/build-inflammation-reference.mjs from the compiled engine (src/core/fii.ts) — do not hand-edit. Referent of the inflammatory-potential score: robust centre/scale of each corpus parameter\'s per-100-kcal density over the USDA foods, the median density of each carrier component among the foods that carry it, the corpus spread of the raw score (maps a score onto −2…+2; zero point fixed at 0), and the five band edges copied from fii-parameters.json (read by src/core/inflammation.ts).',
    version: PARAMS.version,
    generatedFromFoods: foods.length,
    basis: 'per100kcal',
    corpus,
    carrier,
    fiiRaw,
    bands,
  };
  writeFileSync(join(ROOT, 'src/data/inflammation-reference.json'), JSON.stringify(out, null, 2) + '\n');
  log('✓ wrote src/data/inflammation-reference.json');
}
