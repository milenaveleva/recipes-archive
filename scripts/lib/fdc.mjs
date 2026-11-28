/**
 * USDA FoodData Central bulk JSON reader (Foundation Foods + SR Legacy, public domain).
 * Downloads each dataset once into the git-ignored cache scripts/data-raw/fdc/ (needs
 * `curl` and `unzip`), then indexes every record as
 * { fdcId, description, dataType, category, nutrients: Map<nutrient number, amount> }.
 * Used by fill-nutrient-gaps.mjs to recover analysed values that the compact
 * usda-foods.json shape does not carry (alternate nutrient definitions, and the
 * duplicate-description twins dedupeByDescription collapses).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CACHE = fileURLToPath(new URL('../data-raw/fdc/', import.meta.url));

export const FDC_DATASETS = [
  {
    key: 'FoundationFoods',
    label: 'USDA-FOUNDATION',
    url: process.env.FDC_FOUNDATION_URL || 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2025-04-24.zip',
  },
  {
    key: 'SRLegacyFoods',
    label: 'USDA-SR',
    url: process.env.FDC_SR_LEGACY_URL || 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  },
];

function ensureJson(ds, log) {
  const dir = path.join(CACHE, ds.key);
  mkdirSync(dir, { recursive: true });
  let json = readdirSync(dir).find((f) => f.endsWith('.json'));
  if (!json) {
    const zip = path.join(dir, 'dataset.zip');
    if (!existsSync(zip)) {
      log(`→ downloading ${ds.label} (${ds.url})…`);
      execFileSync('curl', ['-sSL', '--fail', '-o', zip, ds.url], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    log(`→ unzipping ${ds.label}…`);
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    json = readdirSync(dir).find((f) => f.endsWith('.json'));
    if (!json) throw new Error(`${ds.label}: no JSON in archive`);
  }
  return path.join(dir, json);
}

/** Load both datasets → Map<fdcId, record>. */
export function loadFdc({ log = () => {} } = {}) {
  const byId = new Map();
  for (const ds of FDC_DATASETS) {
    const file = ensureJson(ds, log);
    log(`→ parsing ${ds.label} ${path.basename(file)}…`);
    const list = JSON.parse(readFileSync(file, 'utf8'))[ds.key] ?? [];
    for (const f of list) {
      const nutrients = new Map();
      for (const fn of f.foodNutrients ?? []) {
        const num = String(fn.nutrient?.number ?? '');
        if (num && Number.isFinite(fn.amount)) nutrients.set(num, fn.amount);
      }
      const category = typeof f.foodCategory === 'string' ? f.foodCategory : f.foodCategory?.description;
      if (!byId.has(f.fdcId)) byId.set(f.fdcId, { fdcId: f.fdcId, description: f.description, dataType: ds.label, category, nutrients });
    }
    log(`  ${list.length} ${ds.label} records`);
  }
  return byId;
}

/** USDA nutrient number → NutrientVector field (the mapping build-usda.mjs uses). */
export const FDC_FIELD = {
  208: 'energyKcal', 268: 'energyKj', 203: 'protein_g', 204: 'fat_g', 205: 'carbs_g', 291: 'fiber_g',
  269: 'sugar_g', 299: 'polyol_g', 255: 'water_g', 606: 'satFat_g', 605: 'transFat_g', 645: 'monoFat_g',
  646: 'polyFat_g', 601: 'cholesterol_mg', 301: 'calcium_mg', 303: 'iron_mg', 304: 'magnesium_mg',
  305: 'phosphorus_mg', 306: 'potassium_mg', 307: 'sodium_mg', 309: 'zinc_mg', 312: 'copper_mg',
  315: 'manganese_mg', 317: 'selenium_ug', 320: 'vitA_ug', 401: 'vitC_mg', 328: 'vitD_ug', 323: 'vitE_mg',
  430: 'vitK_ug', 404: 'thiamin_mg', 405: 'riboflavin_mg', 406: 'niacin_mg', 415: 'vitB6_mg',
  417: 'folate_ug', 418: 'vitB12_ug', 410: 'pantothenicAcid_mg', 421: 'choline_mg', 262: 'caffeine_mg',
  221: 'alcohol_g', 629: 'epa_g', 621: 'dha_g',
  // Medium-chain saturated fatty acids (4:0–12:0), read by the inflammation score's
  // chain-length-weighted saturated-fat term, and the three carotenoids it credits.
  607: 'fa4_0_g', 608: 'fa6_0_g', 609: 'fa8_0_g', 610: 'fa10_0_g', 611: 'fa12_0_g',
  334: 'betaCryptoxanthin_ug', 337: 'lycopene_ug', 338: 'luteinZeaxanthin_ug',
};

// Alternate nutrient definitions under which Foundation Foods report the same
// analyte: total sugars as "Sugars, Total" (269.3) and total dietary fibre by AOAC
// 2011.25 (293). Consulted only when the primary number is absent.
export const FDC_ALT_FIELD = { '269.3': 'sugar_g', 293: 'fiber_g' };

/** A record's per-100g values on our field names (primary numbers, then alternates). */
export function fdcVector(rec) {
  const n = {};
  const prov = {};
  for (const [num, field] of Object.entries(FDC_FIELD)) {
    const v = rec.nutrients.get(String(num));
    if (Number.isFinite(v)) { n[field] = v; prov[field] = String(num); }
  }
  for (const [num, field] of Object.entries(FDC_ALT_FIELD)) {
    const v = rec.nutrients.get(String(num));
    if (n[field] == null && Number.isFinite(v)) { n[field] = v; prov[field] = String(num); }
  }
  // Vitamin D (D2 + D3) is by definition the sum of its two forms; some Foundation
  // records report only the components.
  const d2 = rec.nutrients.get('325'), d3 = rec.nutrients.get('326');
  if (n.vitD_ug == null && Number.isFinite(d2) && Number.isFinite(d3)) { n.vitD_ug = d2 + d3; prov.vitD_ug = '325+326'; }
  return { n, prov };
}
