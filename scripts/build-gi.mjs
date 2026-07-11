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
 *   2. atkinson-2021-gi-table1.pdf — extracted with `pdftotext -layout`; the
 *      aggregate "mean of N foods" rows and single-study "GI±SEM" rows are read.
 * Both yield [{ category, food, gi, kind }] on the 100-point glucose scale →
 * src/data/gi-reference.json, with a self-check on known anchors.
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

/** Tidy a raw food name: collapse whitespace, drop trailing bullet noise. */
const clean = (s) => s.replace(/\s+/g, ' ').replace(/\s*[·•]\s*$/, '').trim();
/** First plausible GI integer (1–120) in a cell like "50", "50±6", "50 ± 6". */
const parseGi = (v) => {
  if (v == null) return null;
  const m = String(v).match(/(\d{1,3})/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 120 ? n : null;
};

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

/** Fallback: parse the layout-preserved PDF text. */
function parsePdf() {
  const text = execFileSync('pdftotext', ['-layout', PDF, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = text.split('\n');
  const meanRe = /^\s*(.+?),\s*mean of \w+ foods\s+(\d{1,3})\s*$/;
  const giSemRe = /(\d{1,3})\s*±\s*\d/;
  const headerRe = /^\s{2,}([A-Z][A-Za-z][A-Za-z0-9 ,'’()%./&+-]{2,70})\s*$/;
  const noise = /^(Atkinson|Online Supplemental|Supplemental Table|Explanatory|TABLE OF CONTENTS|Glycemic|Values included|Test food|used, in accordance|The standardized|category was used|contained in|headings|whole blood|plasma|Capillary,|Venous,)/i;

  let category = null, started = false, lastHeader = null;
  const means = [], singles = new Map();
  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (CATEGORIES.has(trimmed)) { category = trimmed; started = true; lastHeader = null; continue; }
    if (!started || noise.test(trimmed)) continue;
    const mean = line.match(meanRe);
    if (mean && category) { const gi = parseGi(mean[2]); if (gi != null) means.push({ category, food: clean(mean[1]), gi }); continue; }
    const giSem = line.match(giSemRe);
    if (giSem && category && lastHeader) {
      const gi = parseGi(giSem[1]);
      if (gi != null) { const k = `${category}|${lastHeader}`; (singles.get(k) ?? singles.set(k, []).get(k)).push(gi); }
      continue;
    }
    const h = line.match(headerRe);
    if (h && !/\d/.test(h[1])) lastHeader = clean(h[1]);
  }
  const records = means.map((m) => ({ ...m, kind: 'mean' }));
  const seen = new Set(records.map((r) => `${r.category}|${r.food.toLowerCase()}`));
  for (const [key, vals] of singles) {
    const [cat, food] = key.split('|');
    if (seen.has(`${cat}|${food.toLowerCase()}`)) continue;
    records.push({ category: cat, food, gi: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), kind: 'single' });
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

// dedup by category+food (case-insensitive), first wins
const byKey = new Map();
for (const r of records) { const k = `${r.category}|${r.food.toLowerCase()}`; if (!byKey.has(k)) byKey.set(k, r); }
const reference = [...byKey.values()].sort((a, b) => a.category.localeCompare(b.category) || a.food.localeCompare(b.food));
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
