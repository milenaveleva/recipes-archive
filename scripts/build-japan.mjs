#!/usr/bin/env node
/**
 * Ingest the Japanese national food composition table (MEXT, Standard Tables of
 * Food Composition in Japan 2020 / Eighth Revised Edition, Supplement 2023) into
 * the multi-source food database as `src/data/japan-foods.json`.
 *
 * Inputs (git-ignored local build inputs under scripts/data-raw/, downloaded from
 * mext.go.jp; see src/data/README.md for URLs and licence):
 *   - japan-mext-2023-ch2.xlsx  — main per-100g table (energy, macros, minerals, vitamins)
 *   - japan-mext-2023-_09.xlsx  — fatty-acids supplement (saturated / mono / poly)
 *   - japan-mext-2023-_13.xlsx  — carbohydrates supplement (component sugars)
 * joined on the 5-digit food number (食品番号).
 *
 * Names are Japanese; MEXT ships no English names. Each food keeps its native
 * name (`nameJa`) and gets a searchable `description`: a curated English name for
 * the foods recipes use (CURATED_EN), else a Hepburn romanisation of the kana.
 * The matcher's regional-term preference keys off these. fdcId is namespaced into
 * the 81_000_000 band (81_000_000 + food number) to never collide with USDA or
 * custom ids; `source: 'JP-MEXT'` records provenance.
 *
 * MEXT special values: "Tr" → 0 (trace), "(x)" → x (estimated), "-"/blank → unknown
 * (field omitted, the engine's contract for "not zero, just unmeasured").
 *
 * Usage: node scripts/build-japan.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import XLSX from 'xlsx';
import { kanaToRomaji } from './lib/romaji.mjs';

const RAW = (f) => fileURLToPath(new URL(`./data-raw/${f}`, import.meta.url));
const OUT = fileURLToPath(new URL('../src/data/japan-foods.json', import.meta.url));
const log = (m) => process.stderr.write(`${m}\n`);

/** Parse a MEXT cell to a number or null. "-"/blank → null (unmeasured), "Tr" → 0,
 *  "(12.3)" → 12.3 (estimated value, the parentheses are a provenance flag). */
function pv(x) {
  if (x == null) return null;
  let s = String(x).trim();
  if (s === '' || s === '-') return null;
  if (/^\(?Tr\)?$/i.test(s)) return 0;
  s = s.replace(/[()]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Read a MEXT sheet "表全体" → array of data rows (food number in col 1). */
function readSheet(file) {
  const wb = XLSX.readFile(RAW(file));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['表全体'], { header: 1, blankrows: false, defval: null });
  return rows.filter((r) => r && /^[0-9]{5}$/.test(String(r[1])));
}

/** Food-group code (first two digits of the food number) → English category. */
const CATEGORY = {
  '01': 'Cereals and Cereal Products', '02': 'Potatoes and Starches',
  '03': 'Sugars and Sweeteners', '04': 'Legumes and Legume Products',
  '05': 'Nuts and Seeds', '06': 'Vegetables', '07': 'Fruits',
  '08': 'Mushrooms', '09': 'Seaweeds', '10': 'Fish and Shellfish',
  '11': 'Meats', '12': 'Eggs', '13': 'Dairy', '14': 'Fats and Oils',
  '15': 'Confectionery', '16': 'Beverages', '17': 'Seasonings and Spices',
  '18': 'Prepared Foods',
};

// Hand-verified English names for the foods our recipes use (and close pantry
// staples), keyed by MEXT food number. The long tail falls back to romanised
// kana; extend this as recipes need more foods.
const CURATED_EN = {
  '16025': 'Mirin, hon-mirin (sweet rice seasoning)',
  '08016': 'Shimeji, buna-shimeji, raw',
  '08017': 'Shimeji, buna-shimeji, boiled',
  '08015': 'Shimeji, hatake-shimeji, raw',
  '10091': 'Katsuobushi (dried bonito)',
  '10092': 'Katsuobushi, shaved flakes (kezuribushi)',
  '17016': 'Rice vinegar',
  '17015': 'Grain vinegar',
  '04040': 'Tofu, aburaage (deep-fried), raw',
  '16023': 'Sake, refined (seishu)',
  '17007': 'Soy sauce, koikuchi (dark)',
  '17008': 'Soy sauce, usukuchi (light)',
  '17044': 'Miso, rice, light (shiro)',
  '17045': 'Miso, rice, red (aka)',
};

function buildVector(main, fat, carb) {
  // column index → NutrientVector field, per the validated MEXT 成分識別子 rows.
  const M = {
    energyKj: 5, energyKcal: 6, water_g: 7, protein_g: 9, fat_g: 12, cholesterol_mg: 11,
    carbs_g: 20, fiber_g: 18, sodium_mg: 23, potassium_mg: 24, calcium_mg: 25,
    magnesium_mg: 26, phosphorus_mg: 27, iron_mg: 28, zinc_mg: 29, copper_mg: 30,
    manganese_mg: 31, selenium_ug: 34, vitA_ug: 42, vitD_ug: 43, vitE_mg: 44,
    vitK_ug: 48, thiamin_mg: 49, riboflavin_mg: 50, niacin_mg: 51, vitB6_mg: 53,
    vitB12_ug: 54, folate_ug: 55, pantothenicAcid_mg: 56, vitC_mg: 58, alcohol_g: 59,
  };
  const n = {};
  for (const [field, col] of Object.entries(M)) {
    const v = pv(main[col]);
    if (v != null) n[field] = v;
  }
  // Fat breakdown from the fatty-acids supplement (FASAT 8, FAMS 9, FAPU 10).
  if (fat) {
    const sat = pv(fat[8]), mono = pv(fat[9]), poly = pv(fat[10]);
    if (sat != null) n.satFat_g = sat;
    if (mono != null) n.monoFat_g = mono;
    if (poly != null) n.polyFat_g = poly;
  }
  // Total sugars = sum of the component mono/di-saccharides from the carbohydrate
  // supplement (GLUS 7, FRUS 8, GALS 9, SUCS 10, MALS 11, LACS 12, TRES 13);
  // null only when none are reported (so an unmeasured food stays unknown).
  if (carb) {
    const cols = [7, 8, 9, 10, 11, 12, 13];
    let sum = 0, any = false;
    for (const c of cols) { const v = pv(carb[c]); if (v != null) { sum += v; any = true; } }
    if (any) n.sugar_g = Math.round(sum * 100) / 100;
  }
  return n;
}

function main() {
  log('→ reading MEXT main + fatty-acids + carbohydrates tables…');
  const mainRows = readSheet('japan-mext-2023-ch2.xlsx');
  const fatBy = new Map(readSheet('japan-mext-2023-_09.xlsx').map((r) => [String(r[1]), r]));
  const carbBy = new Map(readSheet('japan-mext-2023-_13.xlsx').map((r) => [String(r[1]), r]));
  log(`  ${mainRows.length} foods, ${fatBy.size} with fatty-acid data, ${carbBy.size} with carbohydrate data`);

  const foods = [];
  for (const r of mainRows) {
    const no = String(r[1]);
    const nameJa = String(r[3] ?? '').replace(/\s+/g, ' ').trim();
    const n = buildVector(r, fatBy.get(no), carbBy.get(no));
    if (n.energyKcal == null && n.energyKj == null) continue; // skip rows with no energy basis
    const description = CURATED_EN[no] ?? kanaToRomaji(nameJa);
    foods.push({
      fdcId: 81_000_000 + parseInt(no, 10),
      source: 'JP-MEXT',
      foodCode: no,
      description,
      nameJa,
      category: CATEGORY[no.slice(0, 2)] ?? 'Other',
      n,
    });
  }

  foods.sort((a, b) => a.fdcId - b.fdcId);
  writeFileSync(OUT, JSON.stringify(foods) + '\n');
  log(`✓ wrote ${foods.length} foods → ${path.relative(process.cwd(), OUT)} (${CURATED_EN && Object.keys(CURATED_EN).length} curated English names)`);
}

main();
