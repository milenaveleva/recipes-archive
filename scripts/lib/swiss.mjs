/**
 * Reader for the Swiss Food Composition Database (Federal Food Safety and Veterinary
 * Office FSVO, generic foods, V 7.1): the git-ignored workbook
 * scripts/data-raw/swiss/Swiss_food_composition_database.xlsx, mapped to the
 * NutrientVector field names used by usda-foods.json. Used by fill-nutrient-gaps.mjs to
 * borrow missing values. Branded foods (label data) are not read.
 *
 * Every Swiss value carries a "Derivation of value" and a "Source" (one or more ids into
 * the Sources sheet). Only values whose derivation is "-" (taken unmodified from the cited
 * source; the other derivations are "Estimation", "Automated calculation" and "Calculation
 * on the basis of ingredients") AND whose every cited source is an analytical one are
 * kept. A source is analytical when it is an analysis report or laboratory/test report
 * (Swiss Vitamin Institute and FSVO determinations, UFAG test reports, the UK DH analytical
 * reports) or a journal article or thesis reporting analyses; it is rejected when it is
 * another food composition table or database (German BLS, Ciqual, Souci-Fachmann-Kraut,
 * Frida, USDA, McCance and Widdowson, Italian, Norwegian, Swedish, Finnish, Dutch,
 * Estonian, Canadian, Japanese, FAO/INFOODS tables — borrowing them would be circular),
 * a manufacturer specification or product information, a market label survey, or a
 * source without a recognisable analytical title. Values: "tr." → 0, "n.d." / "< x" /
 * blank → unknown (omitted).
 *
 * Units and definitions, aligned with USDA's: per 100 g edible portion; dietary fibre
 * total; sugars total; vitamin A as µg RAE = retinol + β-carotene activity / 12 (IOM
 * 2001), only when both are analytical; vitamin E as α-tocopherol; niacin preformed (not
 * niacin equivalents); total folate. Energy and available carbohydrate are calculated
 * values in this table, so they are not read.
 */
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

export const SWISS_FILE = fileURLToPath(new URL('../data-raw/swiss/Swiss_food_composition_database.xlsx', import.meta.url));

const COLUMNS = {
  'Fat, total (g)': 'fat_g', 'Fatty acids, saturated (g)': 'satFat_g',
  'Fatty acids, monounsaturated (g)': 'monoFat_g', 'Fatty acids, polyunsaturated (g)': 'polyFat_g',
  'Eicosapentaenoic acid EPA (g)': 'epa_g', 'Docosahexaenoic acid (DHA) (g)': 'dha_g',
  'Cholesterol (mg)': 'cholesterol_mg', 'Sugars (g)': 'sugar_g', 'Dietary fibres (g)': 'fiber_g',
  'Protein (g)': 'protein_g', 'Alcohol (g)': 'alcohol_g', 'Water (g)': 'water_g',
  'Vitamin B1 (thiamine) (mg)': 'thiamin_mg', 'Vitamin B2 (riboflavin) (mg)': 'riboflavin_mg',
  'Vitamin B6 (pyridoxine) (mg)': 'vitB6_mg', 'Vitamin B12 (cobalamin) (µg)': 'vitB12_ug',
  'Niacin (mg)': 'niacin_mg', 'Folate (µg)': 'folate_ug', 'Pantothenic acid (mg)': 'pantothenicAcid_mg',
  'Vitamin C (ascorbic acid) (mg)': 'vitC_mg', 'Vitamin D (calciferol) (µg)': 'vitD_ug',
  'Vitamin E (α-tocopherol) (mg)': 'vitE_mg', 'Potassium (K) (mg)': 'potassium_mg', 'Sodium (Na) (mg)': 'sodium_mg',
  'Calcium (Ca) (mg)': 'calcium_mg', 'Magnesium (Mg) (mg)': 'magnesium_mg', 'Phosphorus (P) (mg)': 'phosphorus_mg',
  'Iron (Fe) (mg)': 'iron_mg', 'Zinc (Zn) (mg)': 'zinc_mg', 'Selenium (Se) (µg)': 'selenium_ug',
};
const RETINOL = 'Retinol (µg)';
const BCE = 'Beta- carotene activity (µg)';

const ANALYTICAL_SOURCE = /analys|analyse|analytical|bestimmung|determination|laborbericht|prüfbericht|untersuchung|beitrag zur kenntnis|zusammensetzung|composition of|content|journal|food chem|mitt\.|dissertation|scientific reports|\bet al\b/i;
const TABLE_SOURCE = /database|tablas? de|evaluation of analytic|lebensmittelschl|ciqual|r[ée]p[ée]rtoire|souci|banca dati|frida|composition data|composition table|composition databa|nährwerttabelle|nutrient database|usda|department of agriculture|fooddata|mccance|fichier canadien|\bfao\b|nevo|nutridata|livsmedel|fineli|standard tables|inran|datensammlung|spezifikation|produktinformation|matvaretabell|undefined/i;

/** True when a Sources-sheet title is an analytical source (not a table, label or company). */
export const isAnalyticalSource = (title) => ANALYTICAL_SOURCE.test(title ?? '') && !TABLE_SOURCE.test(title ?? '');

/** Parse a Swiss value: number, "tr." → 0, "n.d." / "< x" / blank → null. */
export function sv(x) {
  if (typeof x === 'number') return x;
  const s = String(x ?? '').trim();
  if (/^tr\.?$/i.test(s)) return 0;
  // A numeric cell stored as text; "<x" (below detection) and "n.d." stay unknown.
  if (/^\d+(?:[.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

/**
 * Load every Swiss generic food with its analytical values. Returns
 * Map<ID, { code, nameEn, category, n }>.
 */
export function loadSwiss({ log = () => {} } = {}) {
  log('→ reading Swiss Food Composition Database workbook…');
  const wb = XLSX.readFile(SWISS_FILE, { sheets: ['Generic Foods', 'Sources'] });
  const titles = new Map(XLSX.utils.sheet_to_json(wb.Sheets.Sources, { range: 2, defval: '' }).map((s) => [String(s.ID), String(s.Sources)]));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Generic Foods'], { header: 1, defval: '' });
  const header = rows[2];
  const col = (h) => {
    const i = header.indexOf(h);
    if (i < 0 || header[i + 1] !== 'Derivation of value' || header[i + 2] !== 'Source') throw new Error(`Swiss column "${h}" missing`);
    return i;
  };
  const cols = Object.entries(COLUMNS).map(([h, field]) => [col(h), field]);
  const [iRet, iBce] = [col(RETINOL), col(BCE)];

  const foods = new Map();
  let kept = 0, dropped = 0;
  for (const r of rows.slice(3)) {
    if (r[0] === '') continue;
    const accepted = (i) => {
      const v = sv(r[i]);
      if (v == null) return null;
      const ids = String(r[i + 2]).split(';').map((s) => s.trim()).filter(Boolean);
      if (r[i + 1] !== '-' || !ids.length || !ids.every((id) => isAnalyticalSource(titles.get(id)))) { dropped++; return null; }
      return v;
    };
    const n = {};
    for (const [i, field] of cols) {
      const v = accepted(i);
      if (v != null) n[field] = v;
    }
    const ret = accepted(iRet), bce = accepted(iBce);
    if (ret != null && bce != null) n.vitA_ug = Math.round((ret + bce / 12) * 1000) / 1000;
    kept += Object.keys(n).length;
    foods.set(String(r[0]), { code: String(r[0]), nameEn: r[3], category: r[5], n });
  }
  log(`  ${foods.size} foods; ${kept} analytical panel values kept, ${dropped} estimated/calculated/borrowed values dropped`);
  return foods;
}
