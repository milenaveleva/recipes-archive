/**
 * Reader for the FSANZ Australian Food Composition Database, Release 3 (AFCD R3): the
 * git-ignored workbooks scripts/data-raw/afcd/AFCD_R3_{Food_Details,Nutrient_profiles}.xlsx,
 * mapped to the NutrientVector field names used by usda-foods.json. Used by
 * fill-nutrient-gaps.mjs to borrow missing values.
 *
 * AFCD gives each food one Derivation (Analysed, Recipe, Imputed, Label data, Borrowed —
 * "from international food composition databases" — or Estimated) and, in the free-text
 * "Sampling details", the components that were sourced differently ("Folate was imputed
 * from beef mince.", "Alcohol, fibre and caffeine were imputed zero.", "Vitamins (B1, C)
 * and minerals (K, Se) were borrowed from USDA SR Legacy …"). Only Analysed foods are kept,
 * and within one every component a sampling-details sentence reports as imputed, borrowed,
 * estimated, adjusted, assumed, calculated from other data or taken from a label is
 * dropped; a sentence that does so for the bulk of the food ("The majority of nutrient
 * data were borrowed …", "remaining nutrients …") drops the food. Blank cells are
 * unknown.
 *
 * Units and definitions, aligned with USDA's: total dietary fibre (AOAC); total sugars;
 * vitamin A as µg RAE = retinol + β-carotene equivalents / 12 (IOM 2001); vitamin E as
 * α-tocopherol; niacin preformed (not niacin equivalents); total folates; vitamin D as
 * D3 + D2 (not AFCD's D3 equivalents, which weight 25-hydroxy-D3); fatty-acid class totals
 * per 100 g food; EPA (C20:5ω3) and DHA (C22:6ω3) from mg to g. AFCD's trans fatty acids
 * are imputed and its energy and available carbohydrate use FSANZ factors and definitions,
 * so none of the three is read.
 */
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const RAW = (f) => fileURLToPath(new URL(`../data-raw/afcd/${f}`, import.meta.url));

// Normalised Nutrient_profiles column header → [field, scale to the field's unit].
const COLUMNS = {
  'Moisture (water) (g)': ['water_g', 1], 'Protein (g)': ['protein_g', 1], 'Fat, total (g)': ['fat_g', 1],
  'Total dietary fibre (g)': ['fiber_g', 1], 'Alcohol (g)': ['alcohol_g', 1], 'Total sugars (g)': ['sugar_g', 1],
  'Calcium (Ca) (mg)': ['calcium_mg', 1], 'Copper (Cu) (mg)': ['copper_mg', 1], 'Iron (Fe) (mg)': ['iron_mg', 1],
  'Magnesium (Mg) (mg)': ['magnesium_mg', 1], 'Manganese (Mn) (mg)': ['manganese_mg', 1],
  'Phosphorus (P) (mg)': ['phosphorus_mg', 1], 'Potassium (K) (mg)': ['potassium_mg', 1],
  'Selenium (Se) (ug)': ['selenium_ug', 1], 'Sodium (Na) (mg)': ['sodium_mg', 1], 'Zinc (Zn) (mg)': ['zinc_mg', 1],
  'Thiamin (B1) (mg)': ['thiamin_mg', 1], 'Riboflavin (B2) (mg)': ['riboflavin_mg', 1], 'Niacin (B3) (mg)': ['niacin_mg', 1],
  'Pantothenic acid (B5) (mg)': ['pantothenicAcid_mg', 1], 'Pyridoxine (B6) (mg)': ['vitB6_mg', 1],
  'Cobalamin (B12) (ug)': ['vitB12_ug', 1], 'Total folates (ug)': ['folate_ug', 1], 'Vitamin C (mg)': ['vitC_mg', 1],
  'Alpha tocopherol (mg)': ['vitE_mg', 1],
  'Total saturated fatty acids, equated (g)': ['satFat_g', 1],
  'Total monounsaturated fatty acids, equated (g)': ['monoFat_g', 1],
  'Total polyunsaturated fatty acids, equated (g)': ['polyFat_g', 1],
  'C20:5w3 (mg)': ['epa_g', 0.001], 'C22:6w3 (mg)': ['dha_g', 0.001],
  'Cholesterol (mg)': ['cholesterol_mg', 1], 'Caffeine (mg)': ['caffeine_mg', 1],
};
const RETINOL = 'Retinol (preformed vitamin A) (ug)';
const BCE = 'Beta-carotene equivalents (provitamin A) (ug)';
const D3 = 'Cholecalciferol (D3) (ug)';
const D2 = 'Ergocalciferol (D2) (ug)';

// Sampling-details wording → the fields it names. Mineral symbols are case-sensitive.
const VITAMINS = ['thiamin_mg', 'riboflavin_mg', 'niacin_mg', 'pantothenicAcid_mg', 'vitB6_mg', 'vitB12_ug', 'folate_ug', 'vitC_mg', 'vitD_ug', 'vitE_mg', 'vitA_ug', 'vitK_ug'];
const MINERALS = ['calcium_mg', 'copper_mg', 'iron_mg', 'magnesium_mg', 'manganese_mg', 'phosphorus_mg', 'potassium_mg', 'selenium_ug', 'sodium_mg', 'zinc_mg'];
const FATTY = ['satFat_g', 'monoFat_g', 'polyFat_g', 'transFat_g', 'epa_g', 'dha_g'];
const PROXIMATES = ['water_g', 'protein_g', 'fat_g', 'fiber_g', 'sugar_g', 'alcohol_g'];
const TERMS = [
  [/fatty acids|\bfats\b|omega|\bFA\b|saturated/i, FATTY],
  [/trans fat/i, ['transFat_g']],
  [/(?<!trans )\bfat\b(?!ty)/i, ['fat_g']],
  [/protein|nitrogen/i, ['protein_g']], [/moisture|water/i, ['water_g']],
  [/fibre|fiber/i, ['fiber_g']], [/sugar|sucrose|fructose|glucose|lactose|maltose/i, ['sugar_g']],
  [/alcohol/i, ['alcohol_g']], [/caffeine/i, ['caffeine_mg']], [/cholesterol/i, ['cholesterol_mg']],
  [/thiamin|\bB1\b/i, ['thiamin_mg']], [/riboflavin|\bB2\b/i, ['riboflavin_mg']], [/niacin|\bB3\b/i, ['niacin_mg']],
  [/pantothen|\bB5\b/i, ['pantothenicAcid_mg']], [/pyridox|\bB6\b/i, ['vitB6_mg']], [/cobalamin|\bB12\b/i, ['vitB12_ug']],
  [/folate|folic/i, ['folate_ug']], [/vitamin C|ascorb|\(C\b|,\s*C\b|\bC\)/i, ['vitC_mg']],
  [/vitamin D|\(D\b|,\s*D\b|\bD\)|calciferol/i, ['vitD_ug']], [/vitamin E|tocopherol|\(E\b|,\s*E\b|\bE\)/i, ['vitE_mg']],
  [/retinol|carotene|vitamin A|\(A\b|,\s*A\b|\bA\)/i, ['vitA_ug']],
  [/[Cc]alcium|\bCa\b/, ['calcium_mg']], [/[Cc]opper|\bCu\b/, ['copper_mg']], [/\b[Ii]ron\b|\bFe\b/, ['iron_mg']],
  [/[Mm]agnesium|\bMg\b/, ['magnesium_mg']], [/[Mm]anganese|\bMn\b/, ['manganese_mg']], [/[Pp]hosphorus|\bP\b/, ['phosphorus_mg']],
  [/[Pp]otassium|\bK\b/, ['potassium_mg']], [/[Ss]elenium|\bSe\b/, ['selenium_ug']], [/[Ss]odium|\bNa\b/, ['sodium_mg']],
  [/[Zz]inc|\bZn\b/, ['zinc_mg']],
];
const NON_ANALYTICAL = /\b(imputed|borrowed|estimated|adjusted|assumed|label|labels|calculated from|taken from|sourced from|recipe|manufacturer)\b|\bderived from\b.*\b(USDA|database|table|label|manufacturer|literature)\b/i;
const WHOLE_FOOD = /\b(majority|remaining|all other|other nutrients|most nutrients|nutrient data|all nutrients|all data)\b/i;

/**
 * The fields a sampling-details text reports as not analysed for this food, or `null`
 * when it says so for the bulk of the food.
 */
export function nonAnalysedFields(text) {
  const out = new Set();
  // Clauses, not just sentences: "Sodium was analysed; all other nutrients were imputed"
  // carries two subjects.
  for (const sentence of String(text ?? '').split(/(?<=\.)\s+|\r?\n+|;\s*/)) {
    if (!NON_ANALYTICAL.test(sentence)) continue;
    if (WHOLE_FOOD.test(sentence) && !/calculated based on .*analys/i.test(sentence)) return null;
    // Calculation from the food's own analyses ("calculated based on composite analyses") is analytical.
    if (/calculated based on .*analys/i.test(sentence) && !/imputed|borrowed|estimated|adjusted|label/i.test(sentence)) continue;
    const subject = sentence.split(/\s(?:was|were|is|are|has been|have been)\s/)[0];
    if (WHOLE_FOOD.test(subject)) return null;
    // A bare group word ("vitamins", "minerals", "proximates") without a list names the whole group.
    if (/\bvitamins\b(?!\s*\()/i.test(subject)) VITAMINS.forEach((f) => out.add(f));
    if (/\bminerals\b(?!\s*\()/i.test(subject)) MINERALS.forEach((f) => out.add(f));
    if (/\bproximates\b(?!\s*\()/i.test(subject)) PROXIMATES.forEach((f) => out.add(f));
    for (const [re, fields] of TERMS) if (re.test(subject)) fields.forEach((f) => out.add(f));
  }
  return out;
}

const norm = (h) => String(h).replace(/\s+/g, ' ').trim();
const round = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Load every AFCD food; `n` holds the analytical values (empty unless the food is
 * Analysed). Returns Map<public food key, { code, nameEn, derivation, sampling, n }>.
 */
export function loadAfcd({ log = () => {} } = {}) {
  log('→ reading AFCD Release 3 workbooks…');
  const details = XLSX.utils.sheet_to_json(XLSX.readFile(RAW('AFCD_R3_Food_Details.xlsx')).Sheets['Food details'], { range: 2, defval: '' });
  const meta = new Map(details.map((d) => [d['Public Food Key'], d]));
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(RAW('AFCD_R3_Nutrient_profiles.xlsx')).Sheets['All solids & liquids per 100 g'], { header: 1, defval: '' });
  const header = rows[2].map(norm);
  const col = (h) => {
    const i = header.indexOf(h);
    if (i < 0) throw new Error(`AFCD column "${h}" missing`);
    return i;
  };
  const cols = Object.entries(COLUMNS).map(([h, [field, k]]) => [col(h), field, k]);
  const [iRet, iBce, iD3, iD2] = [RETINOL, BCE, D3, D2].map(col);
  const num = (x) => (typeof x === 'number' ? x : null);

  const foods = new Map();
  let kept = 0, dropped = 0;
  for (const r of rows.slice(3)) {
    const code = String(r[0]).trim();
    if (!code) continue;
    const d = meta.get(code) ?? {};
    const derivation = d.Derivation ?? r[2];
    const sampling = String(d['Sampling Details'] ?? '');
    const n = {};
    const skip = derivation === 'Analysed' ? nonAnalysedFields(sampling) : null;
    if (skip) {
      for (const [i, field, k] of cols) if (num(r[i]) != null && !skip.has(field)) n[field] = round(r[i] * k);
      if (num(r[iRet]) != null && num(r[iBce]) != null && !skip.has('vitA_ug')) n.vitA_ug = round(r[iRet] + r[iBce] / 12);
      if (num(r[iD3]) != null && num(r[iD2]) != null && !skip.has('vitD_ug')) n.vitD_ug = round(r[iD3] + r[iD2]);
      kept++;
    } else dropped++;
    foods.set(code, { code, nameEn: r[3], derivation, sampling, n });
  }
  log(`  ${foods.size} foods; ${kept} analysed foods kept (non-analysed components dropped), ${dropped} recipe/imputed/borrowed/label foods dropped`);
  return foods;
}
