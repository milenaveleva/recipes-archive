#!/usr/bin/env node
/**
 * Build src/data/polyphenols.json — the polyphenol SUBCLASS contents (mg aglycone per 100 g)
 * per fdcId that the inflammation score reads (src/core/fii.ts). The randomised-trial signal
 * for polyphenols is subclass-specific (anthocyanins lower CRP, IL-6 and TNF-α across 32 RCTs,
 * Fallah 2020; cocoa and green-tea flavan-3-ols do not, Behzadi 2024, Haghighatdoost 2019;
 * olive-oil phenolics lower CRP against oleic-matched low-phenolic oil, Damasceno 2026), so
 * the score credits subclasses, not a Folin-Ciocalteu total.
 *
 * Sources:
 *   - USDA Database for the Flavonoid Content of Selected Foods, Release 3.3 (Bhagwat &
 *     Haytowitz 2018): anthocyanidins, flavan-3-ols, flavanones, flavones and flavonols,
 *     as aglycones. Exported from the release's Access file to CSV by
 *     scripts/export-usda-flavonoid.py into the git-ignored scripts/data-raw/usda-flavonoid/.
 *     Joined to our foods by NDB number — an SR Legacy record's own `ndbNumber`, or a
 *     Foundation record's 5-digit `ndbNumber` (the SR food it supersedes) — and otherwise by
 *     an identical USDA description (the same food in the same state), and finally by the
 *     hand-reviewed src/data/flavonoid-crosswalk.json.
 *   - Phenol-Explorer (Neveu 2010) "Complete composition data": the tyrosols (hydroxytyrosol,
 *     tyrosol and their secoiridoid conjugates — the olive phenolics), summed per food from
 *     the chromatography rows and joined through the hand-audited src/data/phenol-crosswalk.json.
 *     Its `_absent` rules (animal products, minerals) record a measured-by-rule zero.
 *
 * A food absent from the output has no subclass data; the score treats it as carrying none
 * (a carrier signal is credited only where measured).
 *
 * Usage: node scripts/build-polyphenols.mjs
 *   (needs scripts/data-raw/usda-flavonoid/{FLAV_DAT,FOOD_DES,NUTR_DEF}.csv,
 *    scripts/data-raw/fdc/ and src/data/complete_composition_data.csv)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const die = (m) => { log('✗ ' + m); process.exit(1); };
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const FLAV_DIR = join(ROOT, 'scripts/data-raw/usda-flavonoid');
const PE_CSV = join(ROOT, 'src/data/complete_composition_data.csv');

/** Minimal RFC-4180 CSV parse (quoted fields, "" escapes). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [k.trim(), r[i]])));
}
const csv = (name) => {
  const p = join(FLAV_DIR, name);
  if (!existsSync(p)) die(`missing ${p} — run scripts/export-usda-flavonoid.py first`);
  return parseCSV(readFileSync(p, 'utf8'));
};

// ---- USDA flavonoid subclasses ----
const CLASS_FIELD = {
  Anthocyanidins: 'anthocyanidins_mg',
  'Flavan-3-ols': 'flavan3ols_mg',
  Flavanones: 'flavanones_mg',
  Flavones: 'flavones_mg',
  Flavonols: 'flavonols_mg',
};
log('→ reading USDA Flavonoid Database R3.3…');
const nutrClass = new Map(csv('NUTR_DEF.csv').map((r) => [r.Nutr_no, CLASS_FIELD[r.Flav_Class]]));
if ([...nutrClass.values()].some((v) => !v)) die('NUTR_DEF.csv has a flavonoid class this script does not map');
const flavDesc = new Map(csv('FOOD_DES.csv').map((r) => [r.NDB_No, r.Long_Desc]));
const byNdb = new Map(); // NDB → { field: mg }
for (const r of csv('FLAV_DAT.csv')) {
  const field = nutrClass.get(r.Nutr_no);
  const v = parseFloat(r.Flav_Val);
  if (!field || !Number.isFinite(v)) continue;
  const e = byNdb.get(r.NDB_No) ?? {};
  e[field] = (e[field] ?? 0) + v;
  byNdb.set(r.NDB_No, e);
}
log(`  ${byNdb.size} foods with flavonoid values`);

log('→ joining to USDA FDC by NDB number…');
const fdcFile = (key) => {
  const dir = join(ROOT, 'scripts/data-raw/fdc', key);
  const f = readdirSync(dir).find((x) => x.endsWith('.json'));
  if (!f) die(`no FDC JSON in ${dir} — run node scripts/fill-nutrient-gaps.mjs --dry-run once to download it`);
  return JSON.parse(readFileSync(join(dir, f), 'utf8'))[key];
};
const ndbToFdc = new Map(); // NDB → [fdcId]
const addNdb = (ndb, id) => {
  const k = String(ndb).padStart(5, '0');
  if (!byNdb.has(k)) return;
  ndbToFdc.set(k, [...(ndbToFdc.get(k) ?? []), id]);
};
for (const f of fdcFile('SRLegacyFoods')) if (f.ndbNumber != null) addNdb(f.ndbNumber, f.fdcId);
// A Foundation record's 5-digit ndbNumber names the SR Legacy food it supersedes.
for (const f of fdcFile('FoundationFoods')) if (f.ndbNumber != null && Number(f.ndbNumber) < 100000) addNdb(f.ndbNumber, f.fdcId);

const foods = read('src/data/usda-foods.json');
const corpus = new Map(foods.map((f) => [f.fdcId, f]));
const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const out = {};
const owner = new Map();
const place = (id, entry, label) => {
  if (!corpus.has(id)) return false;
  if (owner.has(id)) return false; // first source wins (NDB joins run first)
  owner.set(id, label);
  out[String(id)] = entry;
  return true;
};
const round = (x) => Math.round(x * 100) / 100;
const entryOf = (vals, source) => ({ ...Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, round(v)])), source });
let ndbJoined = 0;
for (const [ndb, ids] of ndbToFdc) {
  for (const id of ids) if (place(id, entryOf(byNdb.get(ndb), `USDA Flavonoid R3.3 NDB ${ndb} (${flavDesc.get(ndb)})`), `ndb:${ndb}`)) ndbJoined++;
}
// Identical-description twins: a corpus food whose description equals a flavonoid food's.
const flavByDesc = new Map([...flavDesc].map(([ndb, d]) => [norm(d), ndb]));
let twinJoined = 0;
for (const f of foods) {
  if (owner.has(f.fdcId)) continue;
  const ndb = flavByDesc.get(norm(f.description));
  if (ndb && byNdb.has(ndb) && place(f.fdcId, entryOf(byNdb.get(ndb), `USDA Flavonoid R3.3 NDB ${ndb} (identical description)`), `twin:${ndb}`)) twinJoined++;
}
// Reviewed same-food joins for recipe-used foods the automatic joins miss.
const flavCrosswalk = read('src/data/flavonoid-crosswalk.json');
let reviewedJoined = 0;
for (const [id, { ndb, note }] of Object.entries(flavCrosswalk)) {
  if (id.startsWith('_')) continue;
  if (!byNdb.has(ndb)) die(`flavonoid-crosswalk.json: NDB ${ndb} (for ${id}) has no flavonoid values`);
  if (!corpus.has(Number(id))) die(`flavonoid-crosswalk.json: fdcId ${id} is not in usda-foods.json`);
  if (place(Number(id), entryOf(byNdb.get(ndb), `USDA Flavonoid R3.3 NDB ${ndb} (${flavDesc.get(ndb)}; reviewed: ${note})`), `reviewed:${ndb}`)) reviewedJoined++;
}
log(`  ${ndbJoined} foods joined by NDB number, ${twinJoined} by identical description, ${reviewedJoined} by the reviewed crosswalk`);

// ---- Phenol-Explorer tyrosols (olive phenolics) ----
log('→ reading Phenol-Explorer tyrosols…');
const crosswalk = read('src/data/phenol-crosswalk.json');
let tyrosolFoods = 0;
if (existsSync(PE_CSV)) {
  const num = (s) => parseFloat(String(s).replace(',', '.'));
  const tyr = new Map();
  for (const r of parseCSV(readFileSync(PE_CSV, 'utf8'))) {
    if (r.compound_sub_group !== 'Tyrosols' || r.experimental_method_group !== 'Chromatography') continue;
    if (!/mg\/100\s*(g|ml)/i.test(r.units) || /dry/i.test(r.units)) continue;
    const v = num(r.mean);
    if (Number.isFinite(v)) tyr.set(r.food, (tyr.get(r.food) ?? 0) + v);
  }
  for (const [food, mg] of tyr) {
    for (const id of [crosswalk[food] ?? []].flat()) {
      const key = String(id);
      if (!corpus.has(Number(id))) continue;
      out[key] = { ...(out[key] ?? {}), tyrosols_mg: round(mg), source: [out[key]?.source, `Phenol-Explorer tyrosols (${food})`].filter(Boolean).join('; ') };
      tyrosolFoods++;
    }
  }
} else {
  log(`  (no ${PE_CSV} — tyrosols skipped)`);
}
log(`  ${tyrosolFoods} foods with tyrosols`);

// ---- rule-based zeros (no plant matter) ----
let absent = 0;
for (const [rule, ids] of Object.entries(crosswalk._absent ?? {})) {
  if (rule.startsWith('_')) continue;
  for (const id of ids) {
    if (out[String(id)] || !corpus.has(id)) continue;
    out[String(id)] = { ...Object.fromEntries(Object.values(CLASS_FIELD).map((k) => [k, 0])), tyrosols_mg: 0, source: `Rule: ${rule} — no plant matter, so no polyphenols` };
    absent++;
  }
}
log(`  ${absent} rule-based zeros`);

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)));
writeFileSync(
  join(ROOT, 'src/data/polyphenols.json'),
  JSON.stringify({
    _doc: 'GENERATED by scripts/build-polyphenols.mjs — do not hand-edit. Polyphenol subclass contents (mg aglycone per 100 g) per USDA fdcId, merged into the nutrient vector and read by the inflammation score (src/core/fii.ts): anthocyanidins, flavan-3-ols, flavanones, flavones and flavonols from the USDA Flavonoid Database R3.3, tyrosols (olive phenolics) from Phenol-Explorer, and rule-based zeros for foods with no plant matter.',
    ...sorted,
  }, null, 1) + '\n',
);
log(`✓ wrote src/data/polyphenols.json (${Object.keys(sorted).length} foods)`);
