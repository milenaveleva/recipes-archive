#!/usr/bin/env node
/**
 * Recompute the FULL precomputed nutrition block (perServing macros + all six scores)
 * of every recipe from its stored ingredients and the bundled food data, using the
 * REAL compute engine (src/core, compiled to CommonJS on demand) via the shared
 * assembly in src/core/recipeScore.ts. The site is fully prerendered, so recipe scores
 * live in frontmatter and must be regenerated whenever the engine, the food data, or a
 * recipe's ingredients change — after which src/core/recipeScore.repro.test.ts verifies
 * every stored block still reproduces.
 *
 * The engine is compiled to a temp dir (removed on exit), so this always scores with the
 * exact TypeScript the site ships — no hand-maintained Node mirror to drift.
 *
 * Usage: node scripts/rescore-recipes.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// ---- compile the core to CommonJS in a temp dir ----
log('→ compiling compute engine (src/core) to CommonJS…');
const outDir = mkdtempSync(join(tmpdir(), 'recipes-core-'));
try {
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/recipeScore.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
     '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const core = await import(pathToFileURL(join(outDir, 'core/recipeScore.js')).href);
  await rescore(core.scoreRecipe);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

async function rescore(scoreRecipe) {
  log('→ loading food data…');
  const foods = read('src/data/usda-foods.json');
  const foodById = new Map(foods.map((f) => [f.fdcId, f]));
  const foodScoring = read('src/data/food-scoring.json');
  const polyphenols = read('src/data/polyphenols.json');

  const dir = join(ROOT, 'src/content/recipes');
  let changed = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!fm) continue;
    const data = parseYaml(fm[1]);
    if (!data?.nutrition) continue; // only recipes that carry a nutrition block

    const stored = data.nutrition.nutriScore ?? {};
    const { macro, scores } = scoreRecipe(
      (data.ingredients ?? []).map((i) => ({ grams: i.grams, fdcId: i.fdcId, excludeFromNutrition: i.excludeFromNutrition })),
      {
        servings: data.servings ?? 4,
        nutriCategory: stored.category ?? 'general',
        nnsPresent: stored.nnsPresent,
        isWater: stored.isWater,
        isCheese: stored.isCheese,
        redMeat: stored.redMeat,
      },
      foodById, foodScoring, polyphenols,
    );

    const block = serializeNutrition(macro, scores, data.nutrition.computedAt, foodById, data.ingredients ?? [], stored);
    const blockRe = /^nutrition:\n(?:  .*(?:\n|$))*/m;
    if (!blockRe.test(text)) { log(`  ${file}: ⚠ nutrition block not matched — skipped`); continue; }
    const updated = text.replace(blockRe, block);
    if (updated === text) { log(`  ${file}: unchanged`); continue; }
    writeFileSync(path, updated);
    changed++;
    log(`  ${file}: rescored (Nutri ${scores.nutriScore?.grade}, balance ${scores.balance?.score}, ` +
      `inflam ${scores.inflammation?.score}, UPF ${scores.processing?.ultraProcessedPct}%)`);
  }
  log(`✓ rescored ${changed} recipe(s)`);
}

/** Serialize the nutrition block to the committed YAML shape (2-space indent). */
function serializeNutrition(macro, scores, computedAt, foodById, ingredients, nutriInputs = {}) {
  const L = ['nutrition:'];
  const kv = (indent, k, v) => L.push(`${' '.repeat(indent)}${k}: ${v}`);

  // perServing — only present macro fields, in the engine's field order.
  L.push('  perServing:');
  const ORDER = ['energyKcal', 'energyKj', 'protein_g', 'fat_g', 'satFat_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'availableCarb_g'];
  for (const k of ORDER) if (macro.perServing[k] != null) kv(4, k, macro.perServing[k]);

  if (scores.glycemic) {
    L.push('  glycemic:');
    kv(4, 'gi', scores.glycemic.gi);
    kv(4, 'gl', scores.glycemic.gl);
    kv(4, 'giBand', scores.glycemic.giBand);
    kv(4, 'glBand', scores.glycemic.glBand);
    kv(4, 'gi_source', scores.glycemic.gi_source);
    kv(4, 'carbCoveragePct', scores.glycemic.carbCoveragePct);
  }
  if (scores.nutriScore) {
    L.push('  nutriScore:');
    kv(4, 'grade', scores.nutriScore.grade);
    kv(4, 'points', scores.nutriScore.points);
    kv(4, 'category', scores.nutriScore.category);
    kv(4, 'version', '"2023"');
    // The retained Nutri-Score inputs are pass-through provenance — the compute result
    // never carries them, so re-emit them from the stored inputs so a rescore preserves
    // the exact flags that produced the grade (keeps the block reproducible + idempotent).
    if (nutriInputs.nnsPresent != null) kv(4, 'nnsPresent', nutriInputs.nnsPresent);
    if (nutriInputs.isWater != null) kv(4, 'isWater', nutriInputs.isWater);
    if (nutriInputs.isCheese != null) kv(4, 'isCheese', nutriInputs.isCheese);
    if (nutriInputs.redMeat != null) kv(4, 'redMeat', nutriInputs.redMeat);
    if (scores.nutriScore.coverage != null) kv(4, 'coverage', scores.nutriScore.coverage);
  }
  if (scores.inflammation) {
    L.push('  inflammation:');
    kv(4, 'score', scores.inflammation.score);
    kv(4, 'band', scores.inflammation.band);
    kv(4, 'method', 'fii v3');
  }
  if (scores.balance) {
    L.push('  balance:');
    kv(4, 'score', scores.balance.score);
    kv(4, 'band', scores.balance.band);
    kv(4, 'nrf', scores.balance.nrf);
    kv(4, 'version', 'NRF9.3');
  }
  if (scores.processing) {
    L.push('  processing:');
    kv(4, 'minimallyProcessedPct', scores.processing.minimallyProcessedPct);
    kv(4, 'ultraProcessedPct', scores.processing.ultraProcessedPct);
    kv(4, 'band', scores.processing.band);
    kv(4, 'method', 'NOVA (energy-weighted)');
  }
  kv(2, 'computedAt', `"${computedAt ?? new Date().toISOString().slice(0, 10)}"`);

  // dataSources — mirror addLib.dataSourcesFor: base + national table (if used) + one per score.
  L.push('  dataSources:');
  const usesJp = (ingredients ?? []).some(
    (i) => !i.excludeFromNutrition && i.fdcId != null && foodById.get(i.fdcId)?.source === 'JP-MEXT',
  );
  const src = ['USDA FoodData Central'];
  if (usesJp) src.push('MEXT Standard Tables of Food Composition in Japan 2020');
  if (scores.glycemic) src.push('Atkinson 2021 GI tables');
  if (scores.nutriScore) src.push('Nutri-Score 2023');
  if (scores.inflammation) src.push('Food Inflammation Index (composition-derived, energy-weighted); Phenol-Explorer polyphenols');
  if (scores.balance) src.push('Nutrient-Rich Foods Index (NRF9.3)');
  if (scores.processing) src.push('NOVA food classification (energy-weighted)');
  for (const s of src) L.push(`    - ${s}`);

  return L.join('\n') + '\n';
}
