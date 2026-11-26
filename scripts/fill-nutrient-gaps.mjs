#!/usr/bin/env node
/**
 * Fill missing per-100g nutrient values in src/data/usda-foods.json with ANALYSED
 * values for the same food in the same state, following the FAO/INFOODS compilation
 * guidelines' preference for analytical data over estimates. Only four kinds of value
 * are ever added, each recorded with per-field provenance:
 *
 *   ANALYSED   — the food's own USDA FoodData Central record reports the analyte under
 *                an alternate nutrient definition the compact shape does not read
 *                ("Sugars, Total" 269.3, AOAC 2011.25 dietary fibre 293, vitamin D as its
 *                D2 + D3 components): 'ANALYSED:USDA-FDC:<fdcId>#<nutrient number>'.
 *   CALCULATED — an exact unit conversion only: energyKj ↔ energyKcal (× 4.184).
 *   ZERO       — a nutrient that is biochemically absent, by a documented rule
 *                (ZERO_RULES below; justification in src/data/README.md): 'ZERO:<rule>'.
 *   BORROWED   — an analysed value for the same food in the same state from another
 *                official table: another USDA FDC record with the identical description
 *                (the twin dedupeByDescription collapsed), or a reviewed exact match in
 *                scripts/nutrient-gap-crosswalk.json (USDA SR Legacy / Foundation,
 *                ANSES Ciqual 2020, MEXT 2023, and the analytical values only of DTU
 *                Frida 6.1, UK CoFID 2021, FSANZ AFCD Release 3 and the Swiss FCDB):
 *                'BORROWED:<SOURCE>:<code>'.
 *
 * Nothing is estimated from a similar food: a field with no such value stays missing,
 * so the engine can report the gap. Original values are never overwritten. The fills
 * are written to src/data/nutrient-gap-fills.json (fdcId → field → [value,
 * provenance]); serializeFoods (scripts/usda-brands.mjs) layers them onto each food and
 * stamps `gapFill: { field: provenance }`, so they survive every re-clean
 * (scripts/old/prune-branded.mjs) and a fresh re-ingest (scripts/old/build-usda.mjs).
 * A food's original values are its `n` minus the fields in its `gapFill`, so re-runs
 * are idempotent.
 *
 * Usage:
 *   node scripts/fill-nutrient-gaps.mjs              # compute fills, write fills file + usda-foods.json
 *   node scripts/fill-nutrient-gaps.mjs --dry-run    # report only
 *   node scripts/fill-nutrient-gaps.mjs --suggest    # print same-state candidate matches (TSV, stdout)
 *                                                    # for recipe-used foods' remaining gaps, to review
 *                                                    # into the crosswalk by hand; add --recheck to
 *                                                    # include foods reviewed as { source: null }
 *   add --gaps to print every recipe-used food's remaining gaps (TSV, stdout)
 *
 * Inputs: the git-ignored Ciqual 2020 XML and the Frida 6.1, CoFID 2021, AFCD R3 and Swiss FCDB workbooks in
 * scripts/data-raw/ (readers in scripts/lib/), and the USDA FDC bulk
 * JSON (downloaded once into scripts/data-raw/fdc/ by scripts/lib/fdc.mjs).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCiqual } from './lib/ciqual.mjs';
import { loadFdc, fdcVector } from './lib/fdc.mjs';
import { loadFrida } from './lib/frida.mjs';
import { loadCofid } from './lib/cofid.mjs';
import { loadAfcd } from './lib/afcd.mjs';
import { loadSwiss } from './lib/swiss.mjs';

const P = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const FOODS_PATH = P('../src/data/usda-foods.json');
const JAPAN_PATH = P('../src/data/japan-foods.json');
const FILLS_PATH = P('../src/data/nutrient-gap-fills.json');
const CROSSWALK_PATH = P('./nutrient-gap-crosswalk.json');
const RECIPES_DIR = P('../src/content/recipes/');
const log = (m) => process.stderr.write(`${m}\n`);
const DRY = process.argv.includes('--dry-run');
const SUGGEST = process.argv.includes('--suggest');
const GAPS = process.argv.includes('--gaps');
const RECHECK = process.argv.includes('--recheck');

/** The standard per-100g panel. */
export const PANEL = [
  'energyKcal', 'energyKj', 'water_g', 'protein_g', 'fat_g', 'satFat_g', 'monoFat_g', 'polyFat_g',
  'transFat_g', 'cholesterol_mg', 'carbs_g', 'fiber_g', 'sugar_g', 'polyol_g', 'alcohol_g',
  'caffeine_mg', 'sodium_mg', 'potassium_mg', 'calcium_mg', 'iron_mg', 'magnesium_mg',
  'phosphorus_mg', 'zinc_mg', 'copper_mg', 'manganese_mg', 'selenium_ug', 'vitA_ug', 'vitC_mg',
  'vitD_ug', 'vitE_mg', 'vitK_ug', 'thiamin_mg', 'riboflavin_mg', 'niacin_mg', 'vitB6_mg',
  'folate_ug', 'vitB12_ug', 'pantothenicAcid_mg', 'choline_mg', 'epa_g', 'dha_g',
];
const FAT_FRACTIONS = ['satFat_g', 'monoFat_g', 'polyFat_g', 'transFat_g'];
const CARB_FRACTIONS = ['sugar_g', 'fiber_g', 'polyol_g'];

/** Round to 4 significant figures (at or beyond the precision of the source tables). */
const sig = (x) => (x === 0 ? 0 : Number(x.toPrecision(4)));
const has = (n, k) => n[k] != null && Number.isFinite(n[k]);

// ---------------------------------------------------------------- name matching (suggest only)

const STOP = new Set(['and', 'or', 'with', 'without', 'the', 'of', 'in', 'a', 'to', 'from', 'for', 'as',
  'includes', 'usda', 'commodity', 'food', 'distribution', 'program', 'foods', 'all', 'ns', 'nfs',
  'unenriched', 'regular', 'plain', 'average', 'unspecified', 'prepacked', 'commercial', 'product',
  'products', 'generic']);
const singular = (w) => (w.length > 3 && /ies$/.test(w) ? w.slice(0, -3) + 'y'
  : w.length > 4 && /(oes|ches|shes|sses|xes)$/.test(w) ? w.slice(0, -2)
    : w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
const tokens = (s) => new Set(
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(singular));

/** Preparation-state class: the axis two "same food" records must agree on. */
function stateOf(desc) {
  const d = (desc || '').toLowerCase();
  if (/\b(canned|in brine|in syrup|jarred)\b/.test(d)) return 'canned';
  if (/\b(dried|dry|dehydrated|desiccated|powder|powdered|sun-dried|freeze-dried)\b/.test(d) && !/\bdry roasted\b/.test(d)) return 'dried';
  if (/\b(cooked|boiled|steamed|baked|roasted|grilled|fried|stewed|braised|sauteed|poached|toasted|broiled|blanched)\b/.test(d)) return 'cooked';
  if (/\bfrozen\b/.test(d)) return 'frozen';
  return 'raw';
}
function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// ---------------------------------------------------------------- zero rules

// Plant-only foods: a plant category (or a plant oil / plain plant beverage / pure plant
// culinary ingredient) whose name names no animal ingredient.
const PLANT_CATS = new Set(['Fruits and Fruit Juices', 'Vegetables and Vegetable Products', 'Nut and Seed Products',
  'Cereal Grains and Pasta', 'Legumes and Legume Products', 'Spices and Herbs', 'Mushrooms']);
const ANIMAL_WORD = /\b(eggs?|butter|cheese|cream|milk|whey|honey|anchov\w*|fish|bonito|meat|chicken|beef|pork|lard|bacon|gelatin|yogurt|ghee|tallow|suet|oysters?|shrimp|crab|clams?|mussels?|squid|octopus|caviar|roe)\b/i;
const PLANT_DAIRY_WORD = /\b(peanut|almond|cashew|sesame|nut|seed|cocoa|coconut|shea|soy|oat|rice|apple|fruit)\s+(butter|cream|milk|cheese)\b|\bbutter\s?(nut|beans?)\b|\bcream of tartar\b|\bmilk,\s*(soy|almond|oat|rice|coconut)\b/i;
export function isPlant(f) {
  const d = f.description || '';
  if (ANIMAL_WORD.test(d.replace(PLANT_DAIRY_WORD, ''))) return false;
  if (PLANT_CATS.has(f.category)) return true;
  if (f.category === 'Fats and Oils') return /^oil,/i.test(d) && !/\b(fish|cod liver|herring|salmon|menhaden|sardine|whale|seal)\b/i.test(d);
  if (f.category === 'Beverages') return /\b(juice|tea|coffee)\b/i.test(d);
  return false;
}
// Plain animal foods: fish/shellfish, eggs and dairy with no plant ingredient, coating
// or flavouring named.
const ANIMAL_CATS = new Set(['Finfish and Shellfish Products', 'Fish and Shellfish', 'Dairy and Egg Products']);
const NOT_PLAIN = /\b(fruit|berr\w*|strawberr\w*|vanilla|chocolate|cocoa|coffee|with|sauce|breaded|batter|cereal|flavou?red|sweetened|honey|nuts?|spread|dessert|pudding|substitute|imitation|mix)\b/i;
export const isPlainAnimal = (f) => ANIMAL_CATS.has(f.category) && !NOT_PLAIN.test(f.description || '');
// Plant foods that can carry B12 (seaweeds, ferments, fortified products) or vitamin D
// (UV-exposed mushrooms, fortified products) — never zeroed.
const B12_SOURCE = /\b(seaweed|nori|laver|kelp|wakame|kombu|hijiki|spirulina|alga\w*|tempeh|natto|miso|fermented|fortified|vitamin|yeast|sauerkraut|kimchi|soy sauce|tamari)\b/i;
const ALGAL_SOURCE = /\b(seaweed|nori|laver|kelp|wakame|kombu|hijiki|spirulina|chlorella|alga\w*)\b/i;
const VITD_SOURCE = /\b(mushrooms?|shiitake|maitake|chanterelles?|morels?|enoki|shimeji|fortified|vitamin|yeast)\b/i;
const CAFFEINE_SOURCE = /\b(coffee|espresso|tea|matcha|cocoa|cacao|chocolate|cola|guarana|mate|yerba|kola|energy)\b/i;
// Ethanol occurs in alcoholic drinks and in fermented foods (yeast/bacterial
// fermentation leaves traces), and in extracts made with alcohol.
const ETHANOL_SOURCE = /\b(alcohol\w*|wine|beer|ale|lager|sake|mirin|liqueur|spirits?|rum|vodka|whiske?y|brandy|cognac|gin|sherry|vermouth|cider|kombucha|kefir|kvass|miso|soy sauce|tamari|shoyu|extract|fermented|vinegar|yeast|bread|sourdough|yogurt|cheese|sauerkraut|kimchi|pickle[sd]?|tempeh|natto|cocoa|cacao|chocolate|vanilla|fish sauce|gochujang|doenjang|buttermilk|cr[eè]me fra[iî]che|sour cream)\b/i;

/**
 * field → [[rule name, predicate(food, originalValues)]]: the field is zero when any
 * predicate holds. Each rule states biochemical absence, not "probably low".
 */
export const ZERO_RULES = {
  // Sugars, fibre and polyols are components of total carbohydrate.
  sugar_g: [['carb-free', (f, n) => n.carbs_g === 0]],
  polyol_g: [['carb-free', (f, n) => n.carbs_g === 0]],
  // Fatty-acid fractions are components of total fat.
  satFat_g: [['fat-free', (f, n) => n.fat_g === 0]],
  monoFat_g: [['fat-free', (f, n) => n.fat_g === 0]],
  polyFat_g: [['fat-free', (f, n) => n.fat_g === 0]],
  transFat_g: [['fat-free', (f, n) => n.fat_g === 0]],
  // EPA and DHA are made by marine microalgae and reach food through the aquatic food
  // chain (or animal conversion); land plants lack the desaturases to form them.
  epa_g: [['fat-free', (f, n) => n.fat_g === 0], ['plant-food', (f) => isPlant(f) && !ALGAL_SOURCE.test(f.description)]],
  dha_g: [['fat-free', (f, n) => n.fat_g === 0], ['plant-food', (f) => isPlant(f) && !ALGAL_SOURCE.test(f.description)]],
  // Dietary fibre is plant cell-wall carbohydrate (Codex 2009 definition); plain animal
  // foods (fish, shellfish, eggs, unflavoured dairy) carry none.
  fiber_g: [['carb-free', (f, n) => n.carbs_g === 0], ['animal-food', (f) => isPlainAnimal(f)]],
  // Cholesterol is an animal sterol (plants make phytosterols); B12 is made only by
  // bacteria/archaea and reaches food via animal tissue, ferments, algae or fortification;
  // vitamin D2/D3 needs UV-exposed ergosterol (fungi) or animal 7-dehydrocholesterol.
  cholesterol_mg: [['plant-food', (f) => isPlant(f)]],
  vitB12_ug: [['plant-food', (f) => isPlant(f) && !B12_SOURCE.test(f.description)]],
  vitD_ug: [['plant-food', (f) => isPlant(f) && f.category !== 'Mushrooms' && !VITD_SOURCE.test(f.description)]],
  // Caffeine is a purine alkaloid of coffee, tea, cocoa, cola, guarana, mate and kola only.
  caffeine_mg: [['no-caffeine-plant', (f) => !CAFFEINE_SOURCE.test(f.description)]],
  // Ethanol arises only from fermentation (or is added).
  alcohol_g: [['not-fermented', (f) => !ETHANOL_SOURCE.test(f.description) && f.category !== 'Beverages']],
};

// ---------------------------------------------------------------- inputs

function usedIds() {
  const used = new Set();
  for (const t of readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.md'))) {
    for (const m of readFileSync(RECIPES_DIR + t, 'utf8').matchAll(/fdcId:\s*(\d+)/g)) used.add(Number(m[1]));
  }
  return used;
}

/** The food's original values: its `n` minus every field a previous run filled. */
function originals(f) {
  const n = { ...f.n };
  for (const k of Object.keys(f.gapFill ?? {})) delete n[k];
  return n;
}
const isUsdaRecord = (f) => !f.source && f.fdcId < 9_000_000;
const normDesc = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------- fill passes

function analysedPass(f, n, fill, fdc) {
  if (!isUsdaRecord(f)) return;
  const rec = fdc.get(f.fdcId);
  if (!rec) return;
  const { n: v, prov } = fdcVector(rec);
  for (const k of PANEL) {
    if (!has(n, k) && !fill[k] && has(v, k)) fill[k] = [sig(v[k]), `ANALYSED:USDA-FDC:${f.fdcId}#${prov[k]}`];
  }
}

function calcPass(n, fill) {
  const get = (k) => (has(n, k) ? n[k] : fill[k]?.[0]);
  if (!has(n, 'energyKj') && !fill.energyKj && Number.isFinite(get('energyKcal'))) fill.energyKj = [sig(get('energyKcal') * 4.184), 'CALCULATED:kcal×4.184'];
  if (!has(n, 'energyKcal') && !fill.energyKcal && Number.isFinite(get('energyKj'))) fill.energyKcal = [sig(get('energyKj') / 4.184), 'CALCULATED:kJ÷4.184'];
}

function zeroPass(food, n, fill) {
  const vals = { ...n, ...Object.fromEntries(Object.entries(fill).map(([k, [v]]) => [k, v])) };
  for (const [k, rules] of Object.entries(ZERO_RULES)) {
    if (has(n, k) || fill[k]) continue;
    const hit = rules.find(([, pred]) => pred(food, vals));
    if (hit) fill[k] = [0, `ZERO:${hit[0]}`];
  }
}

function borrowFrom(n, fill, v, tag, exclude = []) {
  for (const k of PANEL) if (!has(n, k) && !fill[k] && has(v, k) && !exclude.includes(k)) fill[k] = [sig(v[k]), `BORROWED:${tag}`];
}

// ---------------------------------------------------------------- main

function main() {
  const foods = JSON.parse(readFileSync(FOODS_PATH, 'utf8'));
  const crosswalk = JSON.parse(readFileSync(CROSSWALK_PATH, 'utf8'));
  const used = usedIds();
  log(`Loaded ${foods.length} foods (${used.size} used by recipes), ${Object.keys(crosswalk).filter((k) => k !== '_doc').length} crosswalk entries`);

  const fdc = loadFdc({ log });
  const { foods: ciqual } = loadCiqual({ log });
  const frida = loadFrida({ log });
  const cofid = loadCofid({ log });
  const afcd = loadAfcd({ log });
  const swiss = loadSwiss({ log });
  const japan = new Map(JSON.parse(readFileSync(JAPAN_PATH, 'utf8')).map((j) => [j.foodCode, j]));
  const byId = new Map(foods.map((f) => [f.fdcId, f]));

  // Identical-description FDC twins of each USDA food (other analyses of the same food).
  const fdcByDesc = new Map();
  for (const r of fdc.values()) (fdcByDesc.get(normDesc(r.description)) ?? fdcByDesc.set(normDesc(r.description), []).get(normDesc(r.description))).push(r);

  const lookup = (source, code) => {
    if (source === 'FR-CIQUAL') return ciqual.get(Number(code))?.n;
    if (source === 'JP-MEXT') return japan.get(String(code))?.n;
    if (source === 'DK-FRIDA') return frida.get(Number(code))?.n;
    // The new tables keep their rejected (non-analytical) foods with an empty vector; a
    // crosswalk entry pointing at one must fail loudly, not borrow nothing.
    const analytical = (r) => (r && Object.keys(r.n ?? {}).length ? r.n : undefined);
    if (source === 'UK-COFID') return analytical(cofid.get(String(code)));
    if (source === 'AU-AFCD') return analytical(afcd.get(String(code)));
    if (source === 'CH-SWISS') return analytical(swiss.get(String(code)));
    if (source === 'USDA-SR' || source === 'USDA-FOUNDATION') {
      const r = fdc.get(Number(code));
      if (r) return fdcVector(r).n;
      const f = byId.get(Number(code));
      return f && originals(f);
    }
    throw new Error(`unknown crosswalk source ${source}`);
  };

  const fills = {};
  const remaining = new Map(); // fdcId → [missing fields]
  const before = Object.fromEntries(PANEL.map((k) => [k, { all: 0, used: 0 }]));
  const after = Object.fromEntries(PANEL.map((k) => [k, { all: 0, used: 0 }]));
  const bySource = {};
  for (const f of foods) {
    const n = originals(f);
    const fill = {};
    analysedPass(f, n, fill, fdc);
    calcPass(n, fill);
    zeroPass(f, n, fill);
    if (isUsdaRecord(f)) {
      for (const twin of fdcByDesc.get(normDesc(f.description)) ?? []) {
        if (twin.fdcId !== f.fdcId) borrowFrom(n, fill, fdcVector(twin).n, `${twin.dataType}:${twin.fdcId}`);
      }
    }
    for (const e of [].concat(crosswalk[String(f.fdcId)] ?? [])) {
      if (!e.source) continue; // a reviewed rejection: no same-food match exists
      if (e.match !== 'exact') throw new Error(`crosswalk ${f.fdcId}: only exact same-food, same-state matches may be borrowed`);
      const v = lookup(e.source, e.code);
      if (!v) throw new Error(`crosswalk ${f.fdcId}: source ${e.source}:${e.code} not found`);
      borrowFrom(n, fill, v, `${e.source}:${e.code}`, e.exclude);
    }
    calcPass(n, fill); // a borrowed kJ/kcal can complete the pair

    const isUsed = used.has(f.fdcId);
    const miss = [];
    for (const k of PANEL) {
      if (!has(n, k)) { before[k].all++; if (isUsed) before[k].used++; }
      if (!has(n, k) && !fill[k]) { after[k].all++; if (isUsed) after[k].used++; miss.push(k); }
    }
    if (isUsed && miss.length) remaining.set(f.fdcId, miss);
    if (Object.keys(fill).length) fills[f.fdcId] = Object.fromEntries(PANEL.filter((k) => fill[k]).map((k) => [k, fill[k]]));
    for (const [, prov] of Object.values(fill)) {
      const [m, src] = prov.split(':');
      const key = m === 'BORROWED' || m === 'ANALYSED' ? `${m}:${src}` : m === 'ZERO' ? prov : m;
      bySource[key] ??= { all: 0, used: 0 };
      bySource[key].all++;
      if (isUsed) bySource[key].used++;
    }
  }

  log('\nfield                 missing before → after (all foods)   (recipe-used foods)');
  for (const k of PANEL) {
    log(`  ${k.padEnd(20)} ${String(before[k].all).padStart(5)} → ${String(after[k].all).padStart(5)}        ${String(before[k].used).padStart(4)} → ${String(after[k].used).padStart(4)}`);
  }
  log('\nfilled values by method/source (all foods / recipe-used):');
  for (const [k, c] of Object.entries(bySource).sort()) log(`  ${k.padEnd(40)} ${String(c.all).padStart(6)} / ${c.used}`);

  if (GAPS) {
    const out = ['fdcId\tdescription\tmissing fields'];
    for (const [id, miss] of remaining) out.push(`${id}\t${byId.get(id).description}\t${miss.join(',')}`);
    process.stdout.write(out.join('\n') + '\n');
  }

  if (SUGGEST) {
    const pool = [
      ...[...ciqual.values()].map((c) => ({ src: 'FR-CIQUAL', code: c.code, name: c.nameEn, n: c.n })),
      ...[...frida.values()].map((c) => ({ src: 'DK-FRIDA', code: c.code, name: c.nameEn, n: c.n })),
      ...[...cofid.values()].map((c) => ({ src: 'UK-COFID', code: c.code, name: c.nameEn, n: c.n })),
      ...[...afcd.values()].map((c) => ({ src: 'AU-AFCD', code: c.code, name: c.nameEn, n: c.n })),
      ...[...swiss.values()].map((c) => ({ src: 'CH-SWISS', code: c.code, name: c.nameEn, n: c.n })),
      ...[...fdc.values()].map((r) => ({ src: r.dataType, code: r.fdcId, name: r.description, n: fdcVector(r).n })),
    ].map((x) => ({ ...x, t: tokens(x.name), state: stateOf(x.name) }));
    const out = ['fdcId\tUSDA description\tmissing\tscore\tsource\tcode\tcandidate name\tfills'];
    for (const [id, miss] of remaining) {
      const f = byId.get(id);
      const reviewed = [].concat(crosswalk[String(id)] ?? []);
      if (reviewed.some((e) => e.source) || (reviewed.length && !RECHECK)) continue;
      const ft = tokens(f.description), st = stateOf(f.description);
      const lead = singular((f.description.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop()) ?? '');
      const cands = pool
        .filter((x) => x.code !== id && x.state === st && x.t.has(lead) && miss.some((k) => has(x.n, k)))
        // never offer a national-table food its own source record
        // (a national-table food's fdcId is its namespace prefix + the table's own code)
        .filter((x) => !(f.source && x.src === f.source && String(f.fdcId).endsWith(String(x.code))))
        .map((x) => ({ x, s: jaccard(ft, x.t) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 4);
      for (const { x, s } of cands) out.push(`${id}\t${f.description}\t${miss.length}\t${s.toFixed(2)}\t${x.src}\t${x.code}\t${x.name}\t${miss.filter((k) => has(x.n, k)).length}`);
    }
    process.stdout.write(out.join('\n') + '\n');
  }

  if (DRY || SUGGEST || GAPS) { log('Report only — nothing written.'); return; }
  const ids = Object.keys(fills).sort((a, b) => Number(a) - Number(b));
  writeFileSync(FILLS_PATH, `{\n${ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(fills[id])}`).join(',\n')}\n}\n`);
  log(`✓ wrote ${ids.length} foods' fills → src/data/nutrient-gap-fills.json`);

  // Re-serialize through the shared merge path, which layers the fills on (imported
  // only now, since usda-brands reads the fills file at module load).
  return import('./usda-brands.mjs').then(({ serializeFoods }) => {
    writeFileSync(FOODS_PATH, serializeFoods(foods));
    log('✓ re-serialized src/data/usda-foods.json with the fills applied');
  });
}

Promise.resolve()
  .then(main)
  .catch((err) => { log(`Error: ${err.stack ?? err.message}`); process.exitCode = 1; });
