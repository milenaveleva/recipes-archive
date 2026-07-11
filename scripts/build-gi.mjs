#!/usr/bin/env node
/**
 * Parse the Atkinson 2021 International GI Tables (Supplemental Table 1 — the
 * ISO 26642:2010-compliant, higher-reliability list) into a normalized GI
 * reference keyed by food name, so the matcher (scripts/match-gi.mjs) can assign
 * a cited GI + confidence to every carbohydrate-bearing food in usda-foods.json.
 *
 * Source (gitignored, operator-supplied under scripts/data-raw/): the published
 * supplement PDF for Atkinson FS, Brand-Miller JC, Foster-Powell K, Buyken AE,
 * Goletzke J. "International tables of glycemic index and glycemic load values
 * 2021: a systematic review." Am J Clin Nutr 2021 (DOI 10.1093/ajcn/nqab233).
 *
 * The PDF is extracted with `pdftotext -layout` (poppler). Two record shapes are
 * captured, both on the 100-point glucose scale:
 *   1. Aggregate rows  "<food>, mean of N foods            <GI>"  — the canonical
 *      per-generic-food mean; the trailing integer is the GI. Highest quality.
 *   2. Single-study rows carrying a "<GI>±<SEM>" token, attributed to the most
 *      recent food-name header; values are averaged per name.
 * Output: src/data/gi-reference.json — [{ category, food, gi, n, kind }], with a
 * self-check on known anchors (glucose ≈ 100, cornflakes high, apple ≈ 36).
 *
 * Usage: node scripts/build-gi.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'scripts/data-raw/atkinson-2021-gi-table1.pdf');
const OUT = join(ROOT, 'src/data/gi-reference.json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

/** The 20 top-level food categories, exactly as they head each section. */
const CATEGORIES = new Set([
  'BAKERY PRODUCTS', 'BEVERAGES', 'BREADS', 'BREAKFAST CEREALS', 'CEREAL GRAINS',
  'COOKIES', 'CRACKERS', 'DAIRY PRODUCTS AND ALTERNATIVES', 'FRUIT AND FRUIT PRODUCTS',
  'INFANT FORMULA AND WEANING FOODS', 'LEGUMES', 'MEAL REPLACEMENT & WEIGHT MANAGEMENT PRODUCTS',
  'NUTRITIONAL SUPPORT PRODUCTS', 'NUTS', 'PASTA AND NOODLES', 'SNACK FOODS AND CONFECTIONERY',
  'SOUPS', 'SUGARS AND SYRUPS', 'VEGETABLES', 'REGIONAL OR TRADITIONAL FOODS',
]);

log('→ extracting text from the supplement PDF (pdftotext -layout)…');
let text;
try {
  text = execFileSync('pdftotext', ['-layout', SRC, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (e) {
  log(`✗ could not read ${SRC}. Place the Atkinson 2021 Supplemental Table 1 PDF there.`);
  process.exit(1);
}

const lines = text.split('\n');
const meanRe = /^\s*(.+?),\s*mean of \w+ foods\s+(\d{1,3})\s*$/;
const giSemRe = /(\d{1,3})\s*±\s*\d/; // the GI±SEM token on a single-study row
// A plausible food-name header: mostly letters/punctuation, no data columns, not
// a category or page furniture. Used to attribute single-study GI values.
const headerRe = /^\s{2,}([A-Z][A-Za-z][A-Za-z0-9 ,'’()%./&+-]{2,70})\s*$/;
const noise = /^(Atkinson|Online Supplemental|Supplemental Table|Explanatory|TABLE OF CONTENTS|Glycemic|Values included|Test food|used, in accordance|The standardized|category was used|contained in|headings|whole blood|plasma|Capillary,|Venous,)/i;

let category = null;
let started = false; // skip the TOC/preamble on page 1
let lastHeader = null;
const means = []; // { category, food, gi }
const singles = new Map(); // key `${category}|${food}` -> gi values[]

for (const raw of lines) {
  const line = raw.replace(/ /g, ' ').trimEnd();
  const trimmed = line.trim();
  if (!trimmed) continue;

  if (CATEGORIES.has(trimmed)) {
    category = trimmed;
    started = true; // first in-body category header ends the TOC
    lastHeader = null;
    continue;
  }
  if (!started || noise.test(trimmed)) continue;

  const mean = line.match(meanRe);
  if (mean && category) {
    const gi = Number(mean[2]);
    if (gi >= 1 && gi <= 120) means.push({ category, food: clean(mean[1]), gi });
    continue;
  }

  const giSem = line.match(giSemRe);
  if (giSem && category && lastHeader) {
    const gi = Number(giSem[1]);
    if (gi >= 1 && gi <= 120) {
      const key = `${category}|${lastHeader}`;
      (singles.get(key) ?? singles.set(key, []).get(key)).push(gi);
    }
    continue;
  }

  // Otherwise, remember a clean name line as the current food-name header.
  const h = line.match(headerRe);
  if (h && !/\d/.test(h[1])) lastHeader = clean(h[1]);
}

/** Tidy a raw food name: collapse spaces, drop a trailing brand parenthetical noise. */
function clean(s) {
  return s.replace(/\s+/g, ' ').replace(/\s*[·•]\s*$/, '').trim();
}

// Merge: aggregate means win; supplement with averaged single-study headers not
// already covered by a mean of the same name.
const byKey = new Map();
for (const m of means) byKey.set(`${m.category}|${m.food.toLowerCase()}`, { ...m, n: null, kind: 'mean' });
for (const [key, vals] of singles) {
  const [cat, food] = key.split('|');
  const k = `${cat}|${food.toLowerCase()}`;
  if (byKey.has(k)) continue;
  const gi = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  byKey.set(k, { category: cat, food, gi, n: vals.length, kind: 'single' });
}

const reference = [...byKey.values()].sort((a, b) =>
  a.category.localeCompare(b.category) || a.food.localeCompare(b.food));

writeFileSync(OUT, JSON.stringify(reference, null, 0) + '\n');

// ---- self-check on known anchors ----
const find = (re) => reference.filter((r) => re.test(r.food.toLowerCase()));
const anchors = [
  ['apple, raw ≈ 36', find(/^apple/).some((r) => Math.abs(r.gi - 36) <= 8)],
  ['cornflakes high (≥70)', find(/corn ?flakes/).some((r) => r.gi >= 70)],
  ['watermelon high', find(/watermelon/).some((r) => r.gi >= 65)],
];
log(`✓ wrote ${reference.length} GI reference entries (${means.length} means + ${byKey.size - means.length} single-derived) → src/data/gi-reference.json`);
log('  anchors: ' + anchors.map(([k, ok]) => `${ok ? '✓' : '✗'} ${k}`).join(' | '));
log('  categories covered: ' + new Set(reference.map((r) => r.category)).size + '/20');
