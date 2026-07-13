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
 *   node scripts/old/prune-branded.mjs            # write the cleaned file
 *   node scripts/old/prune-branded.mjs --dry-run  # report what would be dropped
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  shouldDrop,
  isExcludedFood,
  EXCLUDE_IDS,
  SUPERSEDED_IDS,
  CURATION_DROP_IDS,
  assertCuratedPresent,
  dedupeByDescription,
  dropEnergyless,
  serializeFoods,
} from '../usda-brands.mjs';

const OUT = fileURLToPath(new URL('../../src/data/usda-foods.json', import.meta.url));
const log = (msg) => process.stderr.write(`${msg}\n`);
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const foods = JSON.parse(await readFile(OUT, 'utf8'));
  log(`Loaded ${foods.length} foods from ${path.relative(process.cwd(), OUT)}`);

  const kept = foods.filter((f) => !shouldDrop(f));
  const dropped = foods.filter((f) => shouldDrop(f));
  // Attributed in shouldDrop's precedence order (denylist → superseded → curation
  // → category/dish exclusion → ALL-CAPS brand heuristic) so the counts partition `dropped`.
  const byDenylist = dropped.filter((f) => EXCLUDE_IDS.has(f.fdcId)).length;
  const bySuperseded = dropped.filter((f) => !EXCLUDE_IDS.has(f.fdcId) && SUPERSEDED_IDS.has(f.fdcId)).length;
  const byCuration = dropped.filter(
    (f) => !EXCLUDE_IDS.has(f.fdcId) && !SUPERSEDED_IDS.has(f.fdcId) && CURATION_DROP_IDS.has(f.fdcId),
  ).length;
  const byExclusion = dropped.filter(
    (f) =>
      !EXCLUDE_IDS.has(f.fdcId) && !SUPERSEDED_IDS.has(f.fdcId) && !CURATION_DROP_IDS.has(f.fdcId) && isExcludedFood(f),
  ).length;
  const byHeuristic = dropped.length - byDenylist - bySuperseded - byCuration - byExclusion;

  log(
    `Dropping ${dropped.length} foods ` +
      `(${byHeuristic} branded by ALL-CAPS heuristic, ${byDenylist} by verified denylist, ` +
      `${byExclusion} by category/dish exclusion, ${bySuperseded} superseded by a national table, ` +
      `${byCuration} by hand-curated removal) → ${kept.length} remain`,
  );

  const deduped = dedupeByDescription(kept);
  log(`Collapsing ${kept.length - deduped.length} exact-duplicate descriptions → ${deduped.length} foods`);
  const withEnergy = dropEnergyless(deduped);
  log(`Dropping ${deduped.length - withEnergy.length} energy-less analytical references → ${withEnergy.length} foods`);

  // Never orphan a curated food-scoring entry.
  assertCuratedPresent(withEnergy);

  if (dryRun) {
    log('Dry run — no file written.');
    for (const f of dropped.slice(0, 20)) log(`  drop: ${f.fdcId}  ${f.description}`);
    if (dropped.length > 20) log(`  …and ${dropped.length - 20} more`);
    return;
  }

  const output = serializeFoods(withEnergy); // merges curated custom foods (custom-foods.json)
  await writeFile(OUT, output);
  log(`Wrote ${JSON.parse(output).length} foods → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  log(`Error: ${err.message}`);
  process.exitCode = 1;
});
