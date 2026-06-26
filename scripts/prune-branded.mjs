#!/usr/bin/env node
/**
 * Re-clean the committed USDA dataset (src/data/usda-foods.json) in place,
 * dropping commercial branded products via scripts/usda-brands.mjs — without
 * re-downloading the multi-hundred-MB bulk archives.
 *
 * Produces the same result as a fresh `build-usda.mjs` ingest (both apply the
 * identical filter), so it's the fast way to apply changes to the brand filter
 * or its denylist/keep-list to the existing file.
 *
 * Usage:
 *   node scripts/prune-branded.mjs            # write the cleaned file
 *   node scripts/prune-branded.mjs --dry-run  # report what would be dropped
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  shouldDrop,
  isExcludedFood,
  EXCLUDE_IDS,
  SUPERSEDED_IDS,
  assertCuratedPresent,
  serializeFoods,
} from './usda-brands.mjs';

const OUT = fileURLToPath(new URL('../src/data/usda-foods.json', import.meta.url));
const log = (msg) => process.stderr.write(`${msg}\n`);
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const foods = JSON.parse(await readFile(OUT, 'utf8'));
  log(`Loaded ${foods.length} foods from ${path.relative(process.cwd(), OUT)}`);

  const kept = foods.filter((f) => !shouldDrop(f));
  const dropped = foods.filter((f) => shouldDrop(f));
  // Mutually exclusive, in shouldDrop's precedence order (denylist → exclusion
  // rule → ALL-CAPS heuristic), so the three counts sum to dropped.length.
  const byDenylist = dropped.filter((f) => EXCLUDE_IDS.has(f.fdcId)).length;
  const bySuperseded = dropped.filter((f) => !EXCLUDE_IDS.has(f.fdcId) && SUPERSEDED_IDS.has(f.fdcId)).length;
  const byExclusion = dropped.filter(
    (f) => !EXCLUDE_IDS.has(f.fdcId) && !SUPERSEDED_IDS.has(f.fdcId) && isExcludedFood(f),
  ).length;
  const byHeuristic = dropped.length - byDenylist - bySuperseded - byExclusion;

  log(
    `Dropping ${dropped.length} foods ` +
      `(${byHeuristic} branded by ALL-CAPS heuristic, ${byDenylist} by verified denylist, ` +
      `${byExclusion} by category/dish exclusion, ${bySuperseded} superseded by a national table) → ${kept.length} remain`,
  );

  // Never orphan a curated food-scoring entry.
  assertCuratedPresent(kept);

  if (dryRun) {
    log('Dry run — no file written.');
    for (const f of dropped.slice(0, 20)) log(`  drop: ${f.fdcId}  ${f.description}`);
    if (dropped.length > 20) log(`  …and ${dropped.length - 20} more`);
    return;
  }

  const output = serializeFoods(kept); // merges curated custom foods (custom-foods.json)
  await writeFile(OUT, output);
  log(`Wrote ${JSON.parse(output).length} foods → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  log(`Error: ${err.message}`);
  process.exitCode = 1;
});
