#!/usr/bin/env node
/**
 * Ingest a Phenol-Explorer composition export into src/data/polyphenols.json (total
 * polyphenols mg/100g per USDA fdcId), the side table the FII reads (src/core/fii.ts).
 *
 * Phenol-Explorer (http://phenol-explorer.eu) "Complete composition data" export holds
 * one row per food × compound × analytical method. We take the single Folin-Ciocalteu
 * "Polyphenols, total" value per food — the standard total-polyphenol metric (Folin
 * total, per Pérez-Jiménez 2010) — rather than summing the individual compound rows:
 * the export mixes methods (plain chromatography, chromatography after
 * hydrolysis of the SAME compounds to aglycones, proanthocyanidin HPLC, the Folin
 * total), so summing across them double-counts. The export has no USDA id, so the join
 * is name→fdcId via a crosswalk you maintain; the script reports the foods it could not
 * place so coverage stays honest.
 *
 * Every output entry carries a `basis`: "analysed:folin" for a Phenol-Explorer value,
 * or "absent:<rule>" (polyphenol_mg 0) for an fdcId the crosswalk's `_absent` block lists
 * under a documented rule (e.g. animal products — polyphenols are plant metabolites).
 * Nothing is imputed: a food with neither stays absent from the output.
 *
 * Usage:
 *   node scripts/build-phenol-explorer.mjs <export.csv> <crosswalk.json> [out.json]
 *
 *   export.csv      Phenol-Explorer "Complete composition data" CSV. Columns used:
 *                   food, compound, units, mean (numeric values use a European decimal
 *                   comma, e.g. "0,103"; drinks are reported per 100 mL, treated as per
 *                   100 g at density ~1).
 *   crosswalk.json  { "<Phenol-Explorer food name>": <fdcId> | [<fdcId>, ...], ...,
 *                     "_absent": { "<rule>": [<fdcId>, ...], ... } }
 *   out.json        defaults to src/data/polyphenols.json
 *
 * Re-run after updating either input; it overwrites the file wholesale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** User-supplied CLI paths resolve against the caller's CWD; defaults against repo root. */
const fromCwd = (p) => resolve(process.cwd(), p);
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const die = (m) => { log('✗ ' + m); process.exit(1); };

const [csvPath, crosswalkPath, outArg] = process.argv.slice(2);
if (!csvPath || !crosswalkPath) {
  die('usage: node scripts/build-phenol-explorer.mjs <export.csv> <crosswalk.json> [out.json]');
}
const out = outArg ?? 'src/data/polyphenols.json';

/** Minimal RFC-4180-ish CSV parse (handles quoted fields with commas and "" escapes). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

log(`→ reading ${csvPath}…`);
const rows = parseCSV(readFileSync(fromCwd(csvPath), 'utf8'));
if (rows.length < 2) die('CSV has no data rows');
const header = rows[0].map((h) => h.trim());
const col = (re, label) => {
  const i = header.findIndex((h) => re.test(h));
  if (i < 0) die(`no ${label} column (looked for ${re}) in: ${header.join(', ')}`);
  return i;
};
const foodCol = col(/^food$|food.?name|^name$/i, 'food-name');
const compoundCol = col(/^compound$/i, 'compound'); // the specific compound, NOT compound_group
const unitsCol = col(/unit/i, 'units');
const meanCol = col(/mean|content/i, 'content');
log(`  columns: food="${header[foodCol]}", compound="${header[compoundCol]}", ` +
  `units="${header[unitsCol]}", value="${header[meanCol]}"`);

/** The single per-food Folin-Ciocalteu total (lower-cased compound name to match). */
const TOTAL_COMPOUND = 'polyphenols, total';
/** European decimal comma ("0,103" → 0.103). Phenol-Explorer values carry no thousands sep. */
const num = (s) => parseFloat(String(s).replace(',', '.'));

log('→ extracting the Folin total-polyphenol value per food…');
const samples = new Map(); // food name → [values]; averaged if a food appears more than once
let skippedUnit = 0;
for (const r of rows.slice(1)) {
  if ((r[compoundCol] ?? '').trim().toLowerCase() !== TOTAL_COMPOUND) continue;
  const food = (r[foodCol] ?? '').trim();
  const val = num(r[meanCol]);
  if (!food || !(val > 0)) continue; // a polyphenol total must be a positive number
  const unit = (r[unitsCol] ?? '').toLowerCase();
  // Accept mg/100 g and mg/100 mL (≈g); skip dry-weight or anything else so the basis stays per fresh weight.
  if (!/mg\/100\s*(g|ml)/.test(unit) || /dry/.test(unit)) { skippedUnit++; continue; }
  let arr = samples.get(food);
  if (!arr) { arr = []; samples.set(food, arr); }
  arr.push(val);
}
const totals = new Map();
for (const [food, vals] of samples) totals.set(food, vals.reduce((s, v) => s + v, 0) / vals.length);
log(`  ${totals.size} foods with a Folin total-polyphenol value` +
  (skippedUnit ? ` (${skippedUnit} rows skipped on units)` : ''));

const crosswalk = JSON.parse(readFileSync(fromCwd(crosswalkPath), 'utf8'));

const result = {
  _doc: 'Total polyphenol content (mg/100g) per USDA fdcId, merged into NutrientVector.polyphenol_mg and read by the FII (src/core/fii.ts). GENERATED by scripts/build-phenol-explorer.mjs from a Phenol-Explorer "Complete composition data" export — the Folin-Ciocalteu "Polyphenols, total" value per food (basis "analysed:folin"), joined to USDA via a hand-maintained crosswalk, plus rule-based zeros for food classes with no plant matter (basis "absent:<rule>"). Re-run to refresh.',
  _source: `Phenol-Explorer (Folin total polyphenols), joined to USDA fdcId via ${crosswalkPath}.`,
};
const owner = new Map(); // fdcId → what placed it, so a double placement fails loudly
const place = (fdcId, label, entry) => {
  const id = Number(fdcId);
  if (!Number.isInteger(id)) die(`crosswalk: non-integer fdcId ${JSON.stringify(fdcId)} for ${label}`);
  if (owner.has(id)) die(`crosswalk: fdcId ${id} placed twice (${owner.get(id)} and ${label})`);
  owner.set(id, label);
  result[String(id)] = entry;
};
let placed = 0;
const unmatched = [];
for (const [food, total] of totals) {
  const ids = crosswalk[food];
  if (ids == null) { unmatched.push(food); continue; }
  for (const fdcId of [ids].flat()) {
    place(fdcId, food, {
      polyphenol_mg: Math.round(total * 10) / 10,
      basis: 'analysed:folin',
      source: `Phenol-Explorer Folin total (${food})`,
      confidence: 'high',
    });
    placed++;
  }
}
const missingNames = Object.keys(crosswalk).filter((k) => !k.startsWith('_') && !totals.has(k));
if (missingNames.length) die(`crosswalk names with no Folin total in the export: ${missingNames.join('; ')}`);

let absent = 0;
for (const [rule, ids] of Object.entries(crosswalk._absent ?? {})) {
  if (rule.startsWith('_')) continue;
  for (const fdcId of ids) {
    place(fdcId, `absent:${rule}`, {
      polyphenol_mg: 0,
      basis: `absent:${rule}`,
      source: `Rule: ${rule} — no plant matter, so no polyphenols (not a Phenol-Explorer value)`,
      confidence: 'rule',
    });
    absent++;
  }
}

writeFileSync(outArg ? fromCwd(out) : join(ROOT, out), JSON.stringify(result, null, 2) + '\n');
log(`✓ wrote ${out}: ${placed} fdcIds with an analysed value, ${absent} documented absent, ${unmatched.length} Phenol-Explorer foods unmatched`);
if (unmatched.length) {
  log('  unmatched (add to the crosswalk to include):');
  for (const f of unmatched.slice(0, 20)) log(`    - ${f}`);
  if (unmatched.length > 20) log(`    … and ${unmatched.length - 20} more`);
}
