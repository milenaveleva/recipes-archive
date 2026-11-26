/**
 * Reader for the UK Composition of Foods Integrated Dataset (CoFID 2021, McCance and
 * Widdowson's The Composition of Foods; Open Government Licence): the git-ignored
 * workbook scripts/data-raw/cofid/CoFID_2021.xlsx, mapped to the NutrientVector field
 * names used by usda-foods.json. Used by fill-nutrient-gaps.mjs to borrow missing values.
 *
 * Value notation (sheet "1.1 Notes"): "Tr" is a trace → 0; "N" is "present in significant
 * quantities but no reliable figure" → unknown; a blank is not determined → unknown. An
 * unknown field is omitted.
 *
 * CoFID records its provenance per food, not per value: a "Description" of the sample
 * ("21 samples, autumn and winter, …", "Recipe", "Literature sources", "Calculated from
 * …") and the "Main data references". Only foods whose values come from UK analyses of
 * that food are kept: the description must name analysed samples, and neither field may
 * name a recipe, calculation, estimate, label/industry data, literature, or another
 * country's table (some UK values are copied from USDA handbooks, Souci-Fachmann-Kraut or
 * the FAO East Asia table — borrowing them would be circular). Every other food is dropped
 * whole.
 *
 * Units and definitions, aligned with USDA's:
 *   - sugars: CoFID expresses sugars as monosaccharide equivalents (white sugar reads
 *     105 g); `sugar_g` is the weight of sugars, glucose + fructose + galactose +
 *     (sucrose + maltose + lactose) / 1.05, only when every individual sugar is known;
 *   - fibre: the AOAC total dietary fibre column (comparable with USDA's), never the
 *     Englyst non-starch polysaccharide (NSP) column, which excludes lignin and resistant
 *     starch and reads lower;
 *   - vitamin A: µg RAE = retinol + β-carotene equivalents / 12 (IOM 2001); vitamin E:
 *     α-tocopherol (sheet 1.6), not CoFID's α-tocopherol-equivalent total; niacin:
 *     preformed niacin (not niacin equivalents); vitamin K: K1; folate: total folate;
 *   - vitamin D: CoFID's total counts 25-hydroxy-D3 with extra potency, so it is read only
 *     when the food has no 25-hydroxy-D3 (then it is D2 + D3, as USDA's);
 *   - fatty acids: total saturated / monounsaturated / polyunsaturated / trans per 100 g
 *     food; EPA and DHA from C20:5 and C22:6 per 100 g food;
 *   - carbohydrate and energy are not read (available carbohydrate as monosaccharide
 *     equivalents and UK energy factors are not USDA's definitions).
 */
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

export const COFID_FILE = fileURLToPath(new URL('../data-raw/cofid/CoFID_2021.xlsx', import.meta.url));

// Sheet → { CoFID column code (row 2 of each sheet) → NutrientVector field }.
const FIELDS = {
  '1.3 Proximates': {
    WATER: 'water_g', PROT: 'protein_g', FAT: 'fat_g', ALCO: 'alcohol_g', AOACFIB: 'fiber_g',
    SATFOD: 'satFat_g', MONOFOD: 'monoFat_g', POLYFOD: 'polyFat_g', FODTRANS: 'transFat_g',
    CHOL: 'cholesterol_mg',
  },
  '1.4 Inorganics': {
    NA: 'sodium_mg', K: 'potassium_mg', CA: 'calcium_mg', MG: 'magnesium_mg', P: 'phosphorus_mg',
    FE: 'iron_mg', CU: 'copper_mg', ZN: 'zinc_mg', MN: 'manganese_mg', SE: 'selenium_ug',
  },
  '1.5 Vitamins': {
    VITK1: 'vitK_ug', THIA: 'thiamin_mg', RIBO: 'riboflavin_mg', NIAC: 'niacin_mg', VITB6: 'vitB6_mg',
    VITB12: 'vitB12_ug', FOLT: 'folate_ug', PANTO: 'pantothenicAcid_mg', VITC: 'vitC_mg',
  },
  '1.6 Vitamin Fractions': { ATOPH: 'vitE_mg' },
  '1.12 (PUFA per 100gFood)': { 'FOD20:5': 'epa_g', 'FOD22:6': 'dha_g' },
};
// Columns read for the derived fields.
const EXTRA = {
  '1.3 Proximates': ['TOTSUG', 'GLUC', 'FRUCT', 'GALACT', 'SUCR', 'MALT', 'LACT'],
  '1.5 Vitamins': ['RET', 'CAREQU', 'VITD'],
  '1.6 Vitamin Fractions': ['25OHD3'],
};

const ANALYSED_SAMPLE = /\bsamples?\b|\bsub-samples?\b|\banaly[sz]|\b\d+\s+(cans|brands|products|packs|loaves|jars|bottles)\b/i;
const NOT_ANALYTICAL = /recipe|literature|calculat|estimat|label|imput|assum|industry|manufactur|USDA|\bSR\s?\d|Haytowitz|Marsh\b|Wu Leung|Souci|Holland|Agriculture Handbook|food composition table|as for\b|\bas \d+-\d+/i;

/** Parse a CoFID cell: number, "Tr" → 0, "N"/blank → null. */
export function cv(x) {
  if (typeof x === 'number') return x;
  const s = String(x ?? '').trim();
  if (s === '' || s === 'N') return null;
  if (s === 'Tr') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when the food's documented provenance is UK analyses of that food. */
export const isAnalysedFood = (desc, refs) => ANALYSED_SAMPLE.test(desc) && !NOT_ANALYTICAL.test(`${desc} ${refs}`);

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * Load every CoFID food; `n` holds the analytical values (empty for a food whose
 * provenance is not analytical). Returns Map<food code, { code, nameEn, desc, refs, analysed, n }>.
 */
export function loadCofid({ log = () => {} } = {}) {
  log('→ reading CoFID 2021 workbook…');
  const wb = XLSX.readFile(COFID_FILE, { sheets: Object.keys(FIELDS) });
  const raw = new Map(); // code → { meta, col code → cell }
  for (const sheet of Object.keys(FIELDS)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
    const codes = rows[1];
    const wanted = new Set([...Object.keys(FIELDS[sheet]), ...(EXTRA[sheet] ?? [])]);
    for (const c of wanted) if (!codes.includes(c)) throw new Error(`CoFID ${sheet}: column ${c} missing`);
    for (const r of rows.slice(3)) {
      const code = String(r[0]).trim();
      if (!code) continue;
      const rec = raw.get(code) ?? raw.set(code, { nameEn: r[1], desc: String(r[2]), refs: String(r[5]), v: {} }).get(code);
      codes.forEach((c, i) => { if (wanted.has(c)) rec.v[c] = cv(r[i]); });
    }
  }

  const foods = new Map();
  let analysed = 0;
  for (const [code, { nameEn, desc, refs, v }] of raw) {
    const ok = isAnalysedFood(desc, refs);
    const n = {};
    if (ok) {
      analysed++;
      for (const map of Object.values(FIELDS)) {
        for (const [c, field] of Object.entries(map)) if (v[c] != null) n[field] = v[c];
      }
      const mono = ['GLUC', 'FRUCT', 'GALACT'].map((c) => v[c]);
      const di = ['SUCR', 'MALT', 'LACT'].map((c) => v[c]);
      if ([...mono, ...di].every((x) => x != null)) n.sugar_g = round(mono.reduce((a, b) => a + b, 0) + di.reduce((a, b) => a + b, 0) / 1.05);
      if (v.RET != null && v.CAREQU != null) n.vitA_ug = round(v.RET + v.CAREQU / 12);
      // Only when 25-hydroxy-D3 is a known zero/trace: an unknown ('N'/blank) metabolite may
      // be inside CoFID's potency-weighted total, which USDA's D2 + D3 does not weight.
      if (v.VITD != null && v['25OHD3'] === 0) n.vitD_ug = v.VITD;
    }
    foods.set(code, { code, nameEn, desc, refs, analysed: ok, n });
  }
  log(`  ${foods.size} foods; ${analysed} with analytical provenance kept, ${foods.size - analysed} recipe/calculated/borrowed foods dropped`);
  return foods;
}
