#!/usr/bin/env node
/**
 * Build the bundled USDA food dataset (src/data/usda-foods.json).
 *
 * Downloads the USDA FoodData Central bulk JSON for the generic reference
 * datasets — Foundation Foods + SR Legacy (public domain, CC0) — and prunes
 * every food to the per-100g nutrient fields the compute engine reads, plus
 * named portions (for count-unit ingredients) and the USDA food category.
 * The Branded set (~400k branded products, ~3 GB) is intentionally excluded:
 * it is not useful for ingredient matching. Commercial branded products that SR
 * Legacy mixes into the generic data (candy bars, named smoothies, restaurant
 * dishes, infant formula) are dropped via scripts/usda-brands.mjs, so a fresh
 * ingest reproduces the cleaned dataset rather than reintroducing brands.
 *
 * Usage:
 *   node scripts/old/build-usda.mjs
 *
 * Needs `curl` and `unzip` on PATH. Progress streams to stderr; the JSON is
 * written at the end. Override a dataset URL via FDC_FOUNDATION_URL /
 * FDC_SR_LEGACY_URL if USDA publishes a newer Foundation release.
 */
import { writeFile, readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  shouldDrop,
  assertCuratedPresent,
  serializeFoods,
  dedupeByDescription,
  dropEnergyless,
} from '../usda-brands.mjs';

const execFileP = promisify(execFile);
const OUT = fileURLToPath(new URL('../../src/data/usda-foods.json', import.meta.url));

const DATASETS = [
  {
    name: 'Foundation',
    key: 'FoundationFoods',
    url:
      process.env.FDC_FOUNDATION_URL ||
      'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2025-04-24.zip',
  },
  {
    name: 'SR Legacy',
    key: 'SRLegacyFoods',
    url:
      process.env.FDC_SR_LEGACY_URL ||
      'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  },
];

// USDA nutrient number → our NutrientVector field. The full label + micronutrient
// profile (energy, macros, fat breakdown, all FDA-label vitamins & minerals) —
// enough for nutrition display and the nutrient-density balance score, without
// the per-amino-acid / per-fatty-acid / phytochemical detail that would multiply
// the file size for no scoring value.
const NUTRIENT_BY_NUMBER = {
  // Energy + macros. Newer Foundation foods report energy only under the Atwater
  // factors (958 specific / 957 general — 2048/2047 in some dataset versions),
  // not the legacy "Energy" number 208; pruneFood falls back to those so those
  // foods aren't left with null energy (which silently contributes 0 kcal to a
  // recipe). Specific factors are food-tailored, track measured energy more
  // closely than general factors, and match SR Legacy's 208 basis, so they win.
  '208': 'energyKcal',
  '268': 'energyKj',
  '203': 'protein_g',
  '204': 'fat_g',
  '205': 'carbs_g',
  '291': 'fiber_g',
  '269': 'sugar_g',
  '539': 'addedSugar_g',
  '299': 'polyol_g',
  '255': 'water_g',
  // Fat breakdown
  '606': 'satFat_g',
  '605': 'transFat_g',
  '645': 'monoFat_g',
  '646': 'polyFat_g',
  '601': 'cholesterol_mg',
  // Minerals
  '301': 'calcium_mg',
  '303': 'iron_mg',
  '304': 'magnesium_mg',
  '305': 'phosphorus_mg',
  '306': 'potassium_mg',
  '307': 'sodium_mg',
  '309': 'zinc_mg',
  '312': 'copper_mg',
  '315': 'manganese_mg',
  '317': 'selenium_ug',
  // Vitamins
  '320': 'vitA_ug', // Vitamin A, RAE (µg)
  '401': 'vitC_mg',
  '328': 'vitD_ug', // Vitamin D (D2 + D3), µg
  '323': 'vitE_mg', // alpha-tocopherol
  '430': 'vitK_ug', // phylloquinone
  '404': 'thiamin_mg', // B1
  '405': 'riboflavin_mg', // B2
  '406': 'niacin_mg', // B3
  '415': 'vitB6_mg',
  '417': 'folate_ug', // DFE
  '418': 'vitB12_ug',
  '410': 'pantothenicAcid_mg', // B5
  '421': 'choline_mg',
  // Other
  '262': 'caffeine_mg',
  '221': 'alcohol_g',
};

const log = (msg) => process.stderr.write(`${msg}\n`);
const write = (msg) => process.stderr.write(msg);
const round2 = (v) => Math.round(v * 100) / 100;

/** A readable portion label from a USDA foodPortion record. */
function portionLabel(p) {
  if (p.portionDescription && p.portionDescription !== 'Quantity not specified') {
    return p.portionDescription.trim();
  }
  const parts = [p.amount, p.modifier || p.measureUnit?.name].filter(
    (x) => x != null && x !== '' && x !== 'undetermined',
  );
  return parts.join(' ').trim();
}

/** Prune one bulk-JSON food record to our compact shape. */
function pruneFood(food) {
  const n = {};
  let atwaterSpecific; // 958 (2048 in other dataset versions)
  let atwaterGeneral; // 957 (2047 in other dataset versions)
  for (const fn of food.foodNutrients ?? []) {
    const num = String(fn.nutrient?.number ?? fn.nutrientNumber ?? '');
    const amount = fn.amount ?? fn.value;
    if (!Number.isFinite(amount)) continue;
    if (num === '958' || num === '2048') atwaterSpecific = round2(amount);
    else if (num === '957' || num === '2047') atwaterGeneral = round2(amount);
    const key = NUTRIENT_BY_NUMBER[num];
    if (key) n[key] = round2(amount);
  }
  // Energy precedence: reported kcal (208) → Atwater specific (958) → Atwater
  // general (957) → computed Atwater general from the food's own macros. The
  // fallbacks recover energy for newer Foundation foods that omit 208 (avocado,
  // raw fruits/vegetables, raw nuts, whole-milk yogurt); specific factors win
  // because they are food-tailored and match SR Legacy's 208 basis.
  if (n.energyKcal == null) {
    if (atwaterSpecific != null) n.energyKcal = atwaterSpecific;
    else if (atwaterGeneral != null) n.energyKcal = atwaterGeneral;
    // Last resort: the standard Atwater general calculation (4·protein + 9·fat +
    // 4·carbohydrate + 7·alcohol) from the food's own macros — applied only when
    // the full macro panel is present, so a partial analysis carrying just a few
    // minerals (some Foundation raw foods) is left null and dropped downstream
    // rather than under-counted from missing macros.
    else if (Number.isFinite(n.protein_g) && Number.isFinite(n.fat_g) && Number.isFinite(n.carbs_g)) {
      n.energyKcal = round2(4 * n.protein_g + 9 * n.fat_g + 4 * n.carbs_g + 7 * (n.alcohol_g ?? 0));
    }
  }
  if (Object.keys(n).length === 0) return null; // no usable nutrients — skip

  const portions = (food.foodPortions ?? [])
    .map((p) => ({ label: portionLabel(p), grams: p.gramWeight }))
    // Keep only portions with a meaningful (non-numeric-only) label and weight,
    // so count-unit ingredients never start from a bare "1"/"0 slice" stub.
    .filter((p) => p.label && /[a-z]/i.test(p.label) && Number.isFinite(p.grams) && p.grams > 0)
    .slice(0, 6);

  const category =
    typeof food.foodCategory === 'string'
      ? food.foodCategory
      : food.foodCategory?.description;

  const out = { fdcId: food.fdcId, description: food.description, n };
  if (category) out.category = category;
  if (portions.length) out.portions = portions;
  return out;
}

async function fetchDataset(ds, dir) {
  const zip = path.join(dir, `${ds.key}.zip`);
  log(`\n${ds.name}: downloading…`);
  await execFileP('curl', ['-sSL', '--fail', '-o', zip, ds.url], { maxBuffer: 1 << 30 });
  log(`${ds.name}: unzipping…`);
  await execFileP('unzip', ['-o', '-q', zip, '-d', dir]);
  const jsonName = (await readdir(dir)).find((f) => f.endsWith('.json'));
  if (!jsonName) throw new Error(`${ds.name}: no JSON in archive`);
  log(`${ds.name}: parsing ${jsonName}…`);
  const raw = await readFile(path.join(dir, jsonName), 'utf8');
  const data = JSON.parse(raw);
  const list = data[ds.key] ?? data.FoundationFoods ?? data.SRLegacyFoods ?? [];
  return list;
}

async function main() {
  // Foundation precedence over SR Legacy on the (rare) fdcId collision: it
  // carries the newer, more complete nutrient analyses. A Map keeps insertion
  // (dataset-then-input) order, so the emitted list is stable + diff-friendly.
  const byId = new Map();

  for (const ds of DATASETS) {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdc-'));
    try {
      const list = await fetchDataset(ds, dir);
      if (!list.length) {
        throw new Error(`${ds.name}: parsed 0 foods — unexpected archive/JSON shape, aborting`);
      }
      log(`${ds.name}: ${list.length} foods — pruning…`);
      let kept = 0;
      let dropped = 0;
      for (let i = 0; i < list.length; i++) {
        const pruned = pruneFood(list[i]);
        if (pruned && pruned.fdcId != null && !byId.has(pruned.fdcId)) {
          if (shouldDrop(pruned)) {
            dropped++;
          } else {
            byId.set(pruned.fdcId, pruned);
            kept++;
          }
        }
        if (i % 500 === 0) write(`\r  ${ds.name}: ${i}/${list.length} (${kept} kept, ${dropped} dropped)`);
      }
      write(`\r  ${ds.name}: ${list.length}/${list.length} (${kept} kept, ${dropped} dropped)\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const foods = [...byId.values()];
  const deduped = dedupeByDescription(foods);
  log(`\nCollapsed ${foods.length - deduped.length} exact-duplicate descriptions → ${deduped.length} foods`);
  const withEnergy = dropEnergyless(deduped);
  log(`Dropped ${deduped.length - withEnergy.length} energy-less analytical references → ${withEnergy.length} foods`);
  // Never orphan a curated food-scoring entry by filtering it out as branded.
  assertCuratedPresent(withEnergy);
  const output = serializeFoods(withEnergy); // merges curated custom foods (custom-foods.json)
  await writeFile(OUT, output);
  log(`Wrote ${JSON.parse(output).length} foods → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  log(`Error: ${err.message}`);
  process.exitCode = 1;
});
