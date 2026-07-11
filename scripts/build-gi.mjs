#!/usr/bin/env node
/**
 * Parse the Atkinson 2021 International GI Tables (Supplemental Table 1 — the
 * ISO 26642:2010-compliant, higher-reliability list) into a normalized GI
 * reference keyed by food name, so scripts/match-gi.mjs can assign a cited GI +
 * confidence to every carbohydrate-bearing food in usda-foods.json.
 *
 * Source (gitignored, operator-supplied under scripts/data-raw/): the published
 * supplement for Atkinson FS, Brand-Miller JC, Foster-Powell K, Buyken AE,
 * Goletzke J. "International tables of glycemic index and glycemic load values
 * 2021: a systematic review." Am J Clin Nutr 2021 (DOI 10.1093/ajcn/nqab233).
 * Two input shapes are accepted, xlsx preferred (the official supplement parses
 * far more cleanly than the PDF):
 *   1. An .xlsx whose name matches /gi|glyc|atkinson/ — read with the `xlsx`
 *      dep, columns detected by header text (food name / GI / optional category).
 *   2. atkinson-2021-gi-table1.pdf — extracted with `pdftotext -layout`. Every
 *      numbered study row is read; because a long name wraps onto the lines above
 *      and below its numbered row, each name is reconstructed by gluing the row's
 *      own name cell to the nearest numberless name fragments in the same food
 *      category, then GI is averaged across all rows resolving to the same name
 *      (an official "mean of N foods" aggregate row overrides that average).
 * Both are aggregated to one [{ category, food, gi }] per food on the 100-point
 * glucose scale → src/data/gi-reference.json, with a self-check on known anchors.
 *
 * Usage: node scripts/build-gi.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import XLSX from 'xlsx';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'scripts/data-raw');
const PDF = join(RAW, 'atkinson-2021-gi-table1.pdf');
const OUT = join(ROOT, 'src/data/gi-reference.json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

/** The 20 top-level food categories, exactly as they head each PDF section. */
const CATEGORIES = new Set([
  'BAKERY PRODUCTS', 'BEVERAGES', 'BREADS', 'BREAKFAST CEREALS', 'CEREAL GRAINS',
  'COOKIES', 'CRACKERS', 'DAIRY PRODUCTS AND ALTERNATIVES', 'FRUIT AND FRUIT PRODUCTS',
  'INFANT FORMULA AND WEANING FOODS', 'LEGUMES', 'MEAL REPLACEMENT & WEIGHT MANAGEMENT PRODUCTS',
  'NUTRITIONAL SUPPORT PRODUCTS', 'NUTS', 'PASTA AND NOODLES', 'SNACK FOODS AND CONFECTIONERY',
  'SOUPS', 'SUGARS AND SYRUPS', 'VEGETABLES', 'REGIONAL OR TRADITIONAL FOODS',
]);

/** Tidy a raw food name: collapse whitespace, drop bullet noise and a trailing
 * footnote superscript (e.g. "White bread11" → "White bread", "Italy)6" → "Italy)"). */
const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[·•\-\s]+|[·•\-\s]+$/g, '')
  .replace(/([A-Za-z)%])\d{1,2}$/, '$1').trim();
/** First plausible GI integer (1–120) in a cell like "50", "50±6", "50 ± 6". */
const parseGi = (v) => {
  if (v == null) return null;
  const m = String(v).match(/(\d{1,3})/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 120 ? n : null;
};

/**
 * Collapse many rows of the same food into one reference value: the table lists a
 * food once per study, so a name that recurs is averaged; an official "mean of N
 * foods" aggregate row, when present, is authoritative and used verbatim.
 */
function aggregate(records) {
  const map = new Map();
  for (const r of records) {
    const k = `${r.category}|${r.food.toLowerCase()}`;
    const e = map.get(k) ?? map.set(k, { category: r.category, food: r.food, gis: [], mean: null }).get(k);
    if (r.kind === 'mean') e.mean = r.gi;
    else e.gis.push(r.gi);
  }
  const out = [];
  for (const e of map.values()) {
    const gi = e.mean != null ? e.mean
      : e.gis.length ? Math.round(e.gis.reduce((a, b) => a + b, 0) / e.gis.length) : null;
    if (gi != null && gi >= 1 && gi <= 120) out.push({ category: e.category, food: e.food, gi });
  }
  return out;
}

/** Read the official supplement spreadsheet, columns located by header text. */
function parseXlsx(path) {
  const wb = XLSX.readFile(path);
  const records = [];
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, blankrows: false, defval: null });
    const hi = rows.findIndex(
      (r) => r.some((c) => /food|description|name/i.test(String(c ?? ''))) &&
        r.some((c) => /^\s*gi\s*$|glyc\w*\s*index/i.test(String(c ?? ''))));
    if (hi < 0) continue;
    const header = rows[hi].map((c) => String(c ?? '').trim());
    const nameCol = header.findIndex((h) => /food|description|name/i.test(h));
    const giCol = header.findIndex((h) => /^gi$/i.test(h) || /glyc\w*\s*index/i.test(h));
    const catCol = header.findIndex((h) => /categor|food\s*group/i.test(h));
    if (nameCol < 0 || giCol < 0) continue;
    log(`  sheet "${sheet}": name col ${nameCol}, GI col ${giCol}${catCol >= 0 ? `, category col ${catCol}` : ' (category from section rows)'}`);
    let cat = sheet.toUpperCase();
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      const food = String(r[nameCol] ?? '').trim();
      if (!food) continue;
      if (catCol >= 0 && r[catCol]) cat = String(r[catCol]).trim().toUpperCase();
      const gi = parseGi(r[giCol]);
      if (gi != null) records.push({ category: cat, food: clean(food), gi, kind: 'table' });
      else if (catCol < 0 && /^[A-Z][A-Z &,'-]{4,}$/.test(food)) cat = food.toUpperCase(); // section header row
    }
  }
  return records;
}

/**
 * Fallback: parse the layout-preserved PDF text. Each food is one numbered row
 * whose columns (country, year, GI±SEM, GL) sit to the right of a ~74-char name
 * column, but long names wrap onto the lines directly above/below the numbered
 * "anchor" line. Reconstruct each name by gluing the anchor's own name text to
 * the numberless name fragments nearest it (within the same food category), then
 * average the GI across every study row that resolves to the same food name.
 */
function parsePdf() {
  const text = execFileSync('pdftotext', ['-layout', PDF, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = text.split('\n').map((l) => l.replace(/ /g, ' ').replace(/\s+$/, ''));

  const NAME_COL = 74;            // columns 0..73 hold the "Food Number and Item" cell
  const MAX_DIST = 4;             // a wrapped name never sits >4 lines from its anchor
  const meanRe = /^(.+?),\s*mean of [\w-]+ (?:foods|studies)\s+(\d{1,3})\s*$/;
  const giSemRe = /(\d{1,3})\s*±\s*\d/;                 // the GI±SEM data cell
  const numRe = /^\s{0,8}(\d{1,4})\s+/;                 // food-number column (left ≤8 cols), not an in-name number
  const noise = /^(Atkinson |Online Supplemental|Supplemental Table|Explanatory|TABLE OF CONTENTS|Glycemic index|Values included|Test food|used, in accordance|The standardized|A standardized|category was used|contained in|headings|whole blood|plasma|Capillary|Venous|Country of|Food Number|Year of|production|test\d|Subjects|Reference|Timepoints|Sample|analysis|method|Avail|carb|portion|\(Glu ?= ?100\)|SEM|Ref\.|GI\d|FOOTNOTES|Average available carbohydrate)/i;

  // Tag each line with its current top-level category.
  const cat = new Array(lines.length).fill(null);
  let category = null;
  for (let i = 0; i < lines.length; i++) {
    if (CATEGORIES.has(lines[i].trim())) category = lines[i].trim();
    cat[i] = category;
  }

  const nameCell = (line) => clean(line.slice(0, NAME_COL).replace(numRe, ''));
  const anchors = [];             // { i, gi, cat, parts: [{ i, text }] }
  const frags = [];               // { i, cat, text } — numberless name-only lines
  const means = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    if (!trimmed || !cat[i] || CATEGORIES.has(trimmed)) continue;
    const mean = trimmed.match(meanRe);
    if (mean) { const gi = parseGi(mean[2]); if (gi != null) means.push({ category: cat[i], food: clean(mean[1]), gi, kind: 'mean' }); continue; }
    const giSem = line.match(giSemRe);
    if (giSem && numRe.test(line)) {          // anchor row: a food number plus a GI±SEM cell
      const gi = parseGi(giSem[1]);
      if (gi != null) anchors.push({ i, gi, cat: cat[i], parts: [{ i, text: nameCell(line) }] });
      continue;
    }
    // Filter column headers / running footer / notes only after ruling out data rows,
    // so a real food whose name starts like a header word ("Semolina") is not dropped.
    if (noise.test(trimmed)) continue;
    const nm = nameCell(line);                // a wrapped name fragment (no number, no GI)
    if (nm && /[A-Za-z]/.test(nm) && !numRe.test(line)) frags.push({ i, cat: cat[i], text: nm });
  }

  // Attach each wrapped fragment to the closest anchor in its own category that has
  // no other anchor between them — the food block the fragment physically sits in.
  // Only the immediate anchor above and below are candidates, so a fragment can never
  // glue across a neighbouring food; ties prefer the anchor above (number is centered).
  for (const f of frags) {
    let up = -1, down = -1;
    for (let k = 0; k < anchors.length; k++) {
      const a = anchors[k];
      if (a.cat !== f.cat) continue;
      if (a.i < f.i) up = k;                 // ascending order → last one below f is nearest above
      else { down = k; break; }              // first anchor after f is nearest below
    }
    let best = -1;
    for (const k of [up, down]) {
      if (k < 0) continue;
      const d = Math.abs(anchors[k].i - f.i);
      if (d <= MAX_DIST && (best < 0 || d < Math.abs(anchors[best].i - f.i))) best = k;
    }
    if (best >= 0) anchors[best].parts.push(f);
  }

  const records = means;
  for (const a of anchors) {
    const food = clean(a.parts.sort((x, y) => x.i - y.i).map((p) => p.text).join(' '));
    if (food && /[A-Za-z]/.test(food)) records.push({ category: a.cat, food, gi: a.gi, kind: 'table' });
  }
  return records;
}

// ---- pick the source: prefer an xlsx supplement, else the PDF ----
const xlsxName = readdirSync(RAW).find((f) => /\.xlsx$/i.test(f) && /gi|glyc|atkinson/i.test(f));
let records;
if (xlsxName) {
  log(`→ reading spreadsheet supplement scripts/data-raw/${xlsxName}…`);
  records = parseXlsx(join(RAW, xlsxName));
  if (!records.length) log('⚠ no rows parsed from the xlsx — check the header names; falling back to the PDF.');
}
if (!records?.length) {
  log('→ extracting the supplement PDF (pdftotext -layout)…');
  try { records = parsePdf(); }
  catch { log(`✗ no GI source found. Put the Atkinson 2021 supplement (xlsx preferred) in scripts/data-raw/.`); process.exit(1); }
}

// One entry per category+food: average repeated study rows, prefer official means.
const reference = aggregate(records).sort((a, b) => a.category.localeCompare(b.category) || a.food.localeCompare(b.food));
writeFileSync(OUT, JSON.stringify(reference, null, 0) + '\n');

// ---- self-check on known anchors ----
const find = (re) => reference.filter((r) => re.test(r.food.toLowerCase()));
const anchors = [
  ['apple ≈ 36', find(/^apple/).some((r) => Math.abs(r.gi - 36) <= 8)],
  ['cornflakes high (≥70)', find(/corn ?flakes/).some((r) => r.gi >= 70)],
  ['carrots low', find(/^carrot/).some((r) => r.gi <= 45)],
];
log(`✓ wrote ${reference.length} GI reference entries → src/data/gi-reference.json`);
log('  anchors: ' + anchors.map(([k, ok]) => `${ok ? '✓' : '✗'} ${k}`).join(' | '));
log('  categories covered: ' + new Set(reference.map((r) => r.category)).size);
