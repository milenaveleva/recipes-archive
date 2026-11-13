#!/usr/bin/env node
/**
 * Ingest a curated subset of the French national food composition table (ANSES
 * Ciqual 2020) into the multi-source food database as `src/data/france-foods.json`.
 *
 * Inputs (git-ignored local build inputs under scripts/data-raw/, the Ciqual 2020
 * XML release from data.gouv.fr / Zenodo; see src/data/README.md for URL and licence):
 *   - ciqual-2020-alim.xml   — foods (alim_code, French + English names, group codes)
 *   - ciqual-2020-compo.xml  — per-100g composition (alim_code × const_code → teneur)
 *   - ciqual-2020-const.xml  — constituent dictionary (const_code → name + unit)
 * The files are windows-1252 encoded and use decimal commas.
 *
 * Only the foods in CURATED_EN are emitted: they fill specific gaps in the USDA
 * generics (oat drink, whole-wheat pasta, potato gnocchi, nutritional yeast) and are
 * all match-ready (`enCurated: true`), so the matcher merges every one of them.
 * fdcId is namespaced into the 82_000_000 band (82_000_000 + alim_code) to never
 * collide with USDA, custom or MEXT ids; `source: 'FR-CIQUAL'` records provenance,
 * and each food keeps its Ciqual `foodCode` and native `nameFr`.
 *
 * Ciqual special values: "traces" → 0, "-" → unknown, "< x" → unknown (below the
 * quantification limit, value not given) — an unknown field is omitted, the engine's
 * contract for "not zero, just unmeasured".
 *
 * Usage: node scripts/build-ciqual.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCiqual } from './lib/ciqual.mjs';

const OUT = fileURLToPath(new URL('../src/data/france-foods.json', import.meta.url));
const log = (m) => process.stderr.write(`${m}\n`);

/** Ciqual sub-group code (alim_ssgrp_code) → the closest USDA category name, so
 *  category-scoped logic (NOVA, GI category scoping) reads a national food like its
 *  USDA counterpart. Falls back to the group-level map, then 'Other'. */
const SUBGROUP_CATEGORY = {
  '0201': 'Vegetables and Vegetable Products', '0202': 'Vegetables and Vegetable Products',
  '0203': 'Legumes and Legume Products', '0204': 'Fruits and Fruit Juices',
  '0205': 'Nut and Seed Products', '0301': 'Cereal Grains and Pasta', '0302': 'Baked Products',
  '0303': 'Baked Products', '0410': 'Dairy and Egg Products', '0405': 'Finfish and Shellfish Products',
  '0406': 'Finfish and Shellfish Products', '0407': 'Finfish and Shellfish Products',
  '0408': 'Finfish and Shellfish Products', '0409': 'Finfish and Shellfish Products',
  '0601': 'Beverages', '0602': 'Beverages', '0603': 'Beverages', '0701': 'Sweets',
  '0702': 'Sweets', '0703': 'Sweets', '0704': 'Sweets', '0707': 'Breakfast Cereals',
  '0901': 'Fats and Oils', '0902': 'Fats and Oils', '0903': 'Fats and Oils',
  '0904': 'Fats and Oils', '0905': 'Fats and Oils', '1001': 'Soups, Sauces, and Gravies',
  '1002': 'Seasonings and Spices', '1003': 'Seasonings and Spices', '1004': 'Spices and Herbs',
  '1005': 'Spices and Herbs', '1006': 'Spices and Herbs', '1009': 'Seasonings and Spices',
};
const GROUP_CATEGORY = { '05': 'Dairy and Egg Products', '07': 'Sweets', '09': 'Fats and Oils' };

// Hand-verified English names for the curated Ciqual foods, keyed by alim_code.
// Written in the USDA "Head, qualifier, state" shape so the matcher ranks them
// alongside their USDA siblings. Extend this as recipes need more foods.
const CURATED_EN = {
  18905: 'Milk, oat, unsweetened (oat drink)',
  9870: 'Pasta, whole-wheat, dry',
  9871: 'Pasta, whole-wheat, cooked',
  25510: 'Gnocchi, potato, cooked',
  11009: 'Yeast, nutritional (deactivated flakes)',
};

function main() {
  const wanted = new Set(Object.keys(CURATED_EN).map(Number));
  const { foods: ciqual } = loadCiqual({ wanted, log });

  const foods = [];
  for (const id of wanted) {
    const a = ciqual.get(id);
    if (!a) throw new Error(`Ciqual food ${id} not found`);
    const { n } = a;
    if (n.energyKcal == null && n.energyKj == null) throw new Error(`Ciqual food ${id} has no energy value`);
    foods.push({
      fdcId: 82_000_000 + id,
      source: 'FR-CIQUAL',
      foodCode: String(id),
      description: CURATED_EN[id],
      nameFr: a.nameFr,
      category: SUBGROUP_CATEGORY[a.ssgrp] ?? GROUP_CATEGORY[a.grp] ?? 'Other',
      n,
      enCurated: true,
    });
  }

  foods.sort((a, b) => a.fdcId - b.fdcId);
  writeFileSync(OUT, JSON.stringify(foods) + '\n');
  log(`✓ wrote ${foods.length} curated foods → ${path.relative(process.cwd(), OUT)}`);
}

main();
