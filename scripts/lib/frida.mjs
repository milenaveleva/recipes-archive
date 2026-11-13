/**
 * Reader for the DTU Food Institute's Danish Food Composition Database ("Frida",
 * FCDB 6.1, CC-BY 4.0): the git-ignored workbook scripts/data-raw/frida/FCDB_6.1_Dataset.xlsx
 * (https://doi.org/10.11583/DTU.32312844), mapped to the NutrientVector field names used
 * by usda-foods.json. Used by fill-nutrient-gaps.mjs to borrow missing values.
 *
 * Every Frida value names its source (sheet Data_Normalised, column Source, sometimes a
 * comma-separated list). Only values whose every source is analytical are kept:
 *   - accepted: journal/report/unpublished DTU analyses (EuroFIR reference types A, AJ,
 *     AB, R, P, PA) and named one-off analyses (type X, except sources whose title is
 *     unknown or an internal food table);
 *   - accepted conditionally: source 1003 "value calculated by converting various
 *     analytical data" (a sum such as total sugars or saturated fatty acids, or a vitamin
 *     total from its vitamers), only when every component of that sum present for the food
 *     is itself analytical by the rule above;
 *   - rejected: estimates and recipe calculations (type E: 1001, 1002, 1004, 1005), values
 *     copied from other countries' tables or handbooks (types B, F, WW — some are USDA
 *     itself, so borrowing them would be circular), food labels (L), and blank sources.
 * A rejected or absent value leaves the field missing.
 */
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

export const FRIDA_FILE = fileURLToPath(new URL('../data-raw/frida/FCDB_6.1_Dataset.xlsx', import.meta.url));

// Frida ParameterID → NutrientVector field (units already match: g, mg, µg per 100 g).
// Vitamin E is α-tocopherol (USDA's vitE_mg), not Frida's α-TE total; vitamin K is K1;
// niacin is preformed niacin, not niacin equivalents; vitamin A is derived below.
export const FIELD = {
  137: 'energyKj', 356: 'energyKcal', 268: 'water_g', 218: 'protein_g', 141: 'fat_g',
  248: 'satFat_g', 247: 'monoFat_g', 251: 'polyFat_g', 261: 'transFat_g', 115: 'cholesterol_mg',
  170: 'carbs_g', 168: 'fiber_g', 245: 'sugar_g', 244: 'polyol_g', 19: 'alcohol_g',
  121: 'caffeine_mg', 201: 'sodium_mg', 165: 'potassium_mg', 108: 'calcium_mg', 162: 'iron_mg',
  184: 'magnesium_mg', 214: 'phosphorus_mg', 274: 'zinc_mg', 166: 'copper_mg', 187: 'manganese_mg',
  230: 'selenium_ug', 47: 'vitC_mg', 126: 'vitD_ug', 276: 'vitE_mg', 164: 'vitK_ug',
  37: 'thiamin_mg', 39: 'riboflavin_mg', 294: 'niacin_mg', 40: 'vitB6_mg', 143: 'folate_ug',
  38: 'vitB12_ug', 210: 'pantothenicAcid_mg', 116: 'choline_mg',
};
const THIAMINE_ALT = 36; // the same analyte under its second parameter row
const RETINOL = 225;
const BETA_CAROTENE = 303;

const ANALYTICAL_TYPES = new Set(['A', 'AJ', 'AB', 'R', 'P', 'PA', 'X']);
const NOT_ANALYTICAL_X = new Set([1656, 1960, 1961, 1996]); // unknown / internal table / untitled
const CALC_FROM_ANALYSES = 1003;

/** Components of the Frida sums the vector reads, keyed by the sum's ParameterID. */
function sumComponents(params) {
  const fa = (re) => params.filter((p) => /^C\d+:\d/.test(p.ParameterName) && re(p.ParameterName)).map((p) => p.ParameterID);
  return {
    245: [146, 148, 149, 179, 185, 228], // fructose, galactose, glucose, lactose, maltose, sucrose
    244: [237, 188, 160, 343, 344, 445, 446, 447], // sorbitol … glycerol
    248: fa((n) => /:0\b/.test(n)),
    247: fa((n) => /:1\b/.test(n) && !/trans/.test(n)),
    251: fa((n) => /:[2-6]\b/.test(n) && !/trans/.test(n)),
    261: fa((n) => /trans/.test(n)),
    47: [175, 177], // ascorbic + dehydroascorbic acid
    126: [128, 127, 11, 354], // D3, D2, 25-OH-D3, 25-OH-D2
    143: [145],
  };
}

/**
 * Load every Frida food with its accepted (analytical) per-100g values.
 * Returns Map<FoodID, { code, nameEn, nameDa, group, taxon, n }>.
 */
export function loadFrida({ log = () => {} } = {}) {
  log('→ reading Frida (DTU FCDB 6.1) workbook (≈13 MB)…');
  const wb = XLSX.readFile(FRIDA_FILE, { sheets: ['Food', 'Parameter', 'Source', 'Data_Normalised'] });
  const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name]);
  const params = sheet('Parameter');
  const srcType = new Map(sheet('Source').map((s) => [s.SourceID, s.EurofirRefType]));
  const analytical = (id) => ANALYTICAL_TYPES.has(srcType.get(id)) && !NOT_ANALYTICAL_X.has(id);
  const sources = (s) => String(s).split(',').map((x) => Number(x.trim())).filter(Number.isFinite);

  const rows = sheet('Data_Normalised');
  log(`  ${rows.length} composition rows`);
  const byFood = new Map(); // FoodID → Map<ParameterID, { v, src: number[] }>
  for (const r of rows) {
    if (typeof r.ResVal !== 'number') continue;
    (byFood.get(r.FoodID) ?? byFood.set(r.FoodID, new Map()).get(r.FoodID)).set(r.ParameterID, { v: r.ResVal, src: sources(r.Source) });
  }

  const comps = sumComponents(params);
  const accepted = (vals, pid) => {
    const x = vals.get(pid);
    if (!x || !x.src.length) return null;
    if (x.src.every(analytical)) return x.v;
    if (x.src.length === 1 && x.src[0] === CALC_FROM_ANALYSES && comps[pid]) {
      const present = comps[pid].map((c) => vals.get(c)).filter(Boolean);
      if (present.length && present.every((c) => c.src.length && c.src.every(analytical))) return x.v;
    }
    return null;
  };

  const foods = new Map();
  let kept = 0, dropped = 0;
  for (const f of sheet('Food')) {
    const vals = byFood.get(f.FoodID) ?? new Map();
    const n = {};
    for (const [pid, field] of Object.entries(FIELD)) {
      const v = accepted(vals, Number(pid));
      if (v != null) n[field] = v;
    }
    if (n.thiamin_mg == null) {
      const v = accepted(vals, THIAMINE_ALT);
      if (v != null) n.thiamin_mg = v;
    }
    // Vitamin A as µg RAE = retinol + β-carotene / 12 (IOM 2001), only when both are
    // analytical; Frida's own vitamin A column is retinol equivalents (β-carotene / 6).
    const ret = accepted(vals, RETINOL), bc = accepted(vals, BETA_CAROTENE);
    if (ret != null && bc != null) n.vitA_ug = Math.round((ret + bc / 12) * 1000) / 1000;
    const total = [...vals.keys()].filter((k) => FIELD[k]).length;
    kept += Object.keys(n).length;
    dropped += Math.max(0, total - Object.keys(n).length);
    foods.set(f.FoodID, {
      code: f.FoodID, nameEn: f.FoodName, nameDa: f.FødevareNavn, group: f.FoodGroup,
      taxon: f.TaxonomicName === 'NULL' ? null : f.TaxonomicName, n,
    });
  }
  log(`  ${foods.size} foods; ${kept} analytical panel values kept, ~${dropped} estimated/borrowed values dropped`);
  return foods;
}
