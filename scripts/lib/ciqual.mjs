/**
 * Shared reader for the ANSES Ciqual 2020 XML release (git-ignored build inputs in
 * scripts/data-raw/): foods, constituents and per-100g composition, mapped to the
 * NutrientVector field names used by usda-foods.json. Used by build-ciqual.mjs (the
 * curated france-foods.json subset) and fill-nutrient-gaps.mjs (borrowing missing
 * values for USDA foods).
 *
 * The files are windows-1252 encoded and use decimal commas. Special values:
 * "traces" → 0, "-" → unknown, "< x" → unknown (below the quantification limit, value
 * not given) — an unknown field is omitted, the engine's contract for "not zero, just
 * unmeasured".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = (f) => fileURLToPath(new URL(`../data-raw/${f}`, import.meta.url));

/** Read a Ciqual XML file (windows-1252) as a string. */
export const readXml = (f) => new TextDecoder('windows-1252').decode(readFileSync(RAW(f)));

/** Iterate the records of one element type → array of { tag: trimmed text }. */
export function records(xml, element) {
  const out = [];
  const re = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`, 'g');
  for (const m of xml.matchAll(re)) {
    const rec = {};
    // Lazy body match: Ciqual writes "< 0,5" values with a raw, unescaped "<".
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) rec[f[1]] = f[2].trim();
    out.push(rec);
  }
  return out;
}

/** Parse a Ciqual `teneur` to a number or null. "-"/blank/"< x" → null (unknown),
 *  "traces" → 0, "12,3" → 12.3 (decimal comma). */
export function pv(x) {
  if (x == null) return null;
  const s = String(x).trim();
  if (s === '' || s === '-') return null;
  if (/^traces$/i.test(s)) return 0;
  if (/^</.test(s)) return null;
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Ciqual const_code → NutrientVector field (units already match: g, mg, µg per 100 g).
// Energy is the Regulation (EU) 1169/2011 value; protein is Ciqual's headline
// "N × Jones factor" value; vitamin K is K1 (phylloquinone, as USDA's vitK_ug).
export const FIELD = {
  327: 'energyKj', 328: 'energyKcal', 400: 'water_g', 25000: 'protein_g', 40000: 'fat_g',
  40302: 'satFat_g', 40303: 'monoFat_g', 40304: 'polyFat_g', 32000: 'sugar_g',
  34100: 'fiber_g', 34000: 'polyol_g', 10110: 'sodium_mg', 10190: 'potassium_mg',
  10200: 'calcium_mg', 10260: 'iron_mg', 10120: 'magnesium_mg', 10150: 'phosphorus_mg',
  10300: 'zinc_mg', 10290: 'copper_mg', 10251: 'manganese_mg', 10340: 'selenium_ug',
  55100: 'vitC_mg', 53100: 'vitE_mg', 54101: 'vitK_ug', 52100: 'vitD_ug',
  56100: 'thiamin_mg', 56200: 'riboflavin_mg', 56310: 'niacin_mg', 56400: 'pantothenicAcid_mg',
  56500: 'vitB6_mg', 56700: 'folate_ug', 56600: 'vitB12_ug', 75100: 'cholesterol_mg',
  60000: 'alcohol_g',
};
export const GLUCIDES = 31000; // available carbohydrate (sugars + starch + polyols)
export const ORGANIC_ACIDS = 65000;
export const RETINOL = 51200;
export const BETA_CAROTENE = 51330;

const round = (x) => Math.round(x * 1000) / 1000;

/** Build the per-100g NutrientVector from one food's const_code → value map. */
export function buildVector(v) {
  const n = {};
  for (const [code, field] of Object.entries(FIELD)) {
    const x = v.get(Number(code));
    if (x != null) n[field] = x;
  }
  // Ciqual reports *available* carbohydrate; the engine's carbs_g is total
  // carbohydrate (USDA "by difference", fibre included) from which it subtracts
  // fibre and polyols itself, so add the fibre back.
  const glu = v.get(GLUCIDES);
  if (glu != null) n.carbs_g = round(glu + (n.fiber_g ?? 0));
  // Vitamin A as µg RAE = retinol + β-carotene / 12 (IOM 2001); only when both are known.
  const ret = v.get(RETINOL), bc = v.get(BETA_CAROTENE);
  if (ret != null && bc != null) n.vitA_ug = round(ret + bc / 12);
  return n;
}

/**
 * Load Ciqual foods with their composition. `wanted` (a Set of alim_codes) limits the
 * composition scan to those foods; omit it to load the whole table (~3,200 foods).
 * Returns { constNames, foods: Map<alim_code, { code, nameFr, nameEn, grp, ssgrp, v, n }> },
 * where `v` is the raw const_code → value map and `n` the NutrientVector built from it.
 */
export function loadCiqual({ wanted = null, log = () => {} } = {}) {
  log('→ reading Ciqual 2020 constituents + foods…');
  const constNames = new Map(records(readXml('ciqual-2020-const.xml'), 'CONST').map((c) => [Number(c.const_code), c.const_nom_eng]));
  for (const code of [...Object.keys(FIELD).map(Number), GLUCIDES, ORGANIC_ACIDS, RETINOL, BETA_CAROTENE]) {
    if (!constNames.has(code)) throw new Error(`Ciqual constituent ${code} missing from const table`);
  }
  const alim = records(readXml('ciqual-2020-alim.xml'), 'ALIM');
  log(`  ${alim.length} foods, ${constNames.size} constituents`);

  log('→ reading Ciqual 2020 composition (≈57 MB)…');
  const values = new Map();
  let rows = 0;
  for (const c of records(readXml('ciqual-2020-compo.xml'), 'COMPO')) {
    rows++;
    const id = Number(c.alim_code);
    if (wanted && !wanted.has(id)) continue;
    const x = pv(c.teneur);
    if (x == null) continue;
    (values.get(id) ?? values.set(id, new Map()).get(id)).set(Number(c.const_code), x);
  }
  log(`  ${rows} composition rows scanned`);

  const foods = new Map();
  for (const a of alim) {
    const code = Number(a.alim_code);
    if (wanted && !wanted.has(code)) continue;
    foods.set(code, {
      code,
      nameFr: a.alim_nom_fr,
      nameEn: a.alim_nom_eng,
      grp: a.alim_grp_code,
      ssgrp: a.alim_ssgrp_code,
      v: values.get(code) ?? new Map(),
      n: buildVector(values.get(code) ?? new Map()),
    });
  }
  return { constNames, foods };
}
