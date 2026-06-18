#!/usr/bin/env node
/**
 * Build / expand the bundled USDA food subset (src/data/usda-foods.json).
 *
 * For each ingredient query in scripts/usda-foods.txt this fetches the best
 * Foundation / SR Legacy match from USDA FoodData Central (public domain, CC0)
 * and prunes it to the per-100g nutrient fields the macro engine reads.
 *
 * Usage:
 *   FDC_API_KEY=<your key> node scripts/build-usda.mjs
 *
 * A free key from https://fdc.nal.usda.gov/api-key-signup.html lifts the
 * DEMO_KEY rate limit; without one the script throttles and may stop early.
 * Progress streams to stderr; the JSON is written to disk at the end.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const KEY = process.env.FDC_API_KEY || 'DEMO_KEY';
const OUT = fileURLToPath(new URL('../src/data/usda-foods.json', import.meta.url));
const LIST = fileURLToPath(new URL('./usda-foods.txt', import.meta.url));

// USDA nutrient number → our NutrientVector field.
const NUTRIENT_BY_NUMBER = {
  '208': 'energyKcal',
  '203': 'protein_g',
  '204': 'fat_g',
  '606': 'satFat_g',
  '205': 'carbs_g',
  '291': 'fiber_g',
  '269': 'sugar_g',
  '299': 'polyol_g',
  '307': 'sodium_mg',
};

const log = (msg) => process.stderr.write(`${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (v) => Math.round(v * 100) / 100;

async function fetchFood(query) {
  const url = new URL(API);
  url.searchParams.set('query', query);
  url.searchParams.set('dataType', 'Foundation,SR Legacy');
  url.searchParams.set('pageSize', '1');
  url.searchParams.set('api_key', KEY);

  const res = await fetch(url);
  if (res.status === 429) {
    throw new Error(
      'rate limited — set FDC_API_KEY to a free key (https://fdc.nal.usda.gov/api-key-signup.html)',
    );
  }
  if (!res.ok) throw new Error(`FDC search failed (${res.status})`);

  const data = await res.json();
  const food = data.foods?.[0];
  if (!food) return null;

  const n = {};
  for (const fn of food.foodNutrients ?? []) {
    const key = NUTRIENT_BY_NUMBER[fn.nutrientNumber];
    if (key && typeof fn.value === 'number') n[key] = round2(fn.value);
  }
  return { fdcId: food.fdcId, description: food.description, category: food.foodCategory, n };
}

async function main() {
  const raw = await readFile(LIST, 'utf8').catch(() => {
    throw new Error(`missing query list: ${path.relative(process.cwd(), LIST)}`);
  });
  const queries = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

  log(
    `Building USDA food index from ${queries.length} queries ` +
      `(key: ${KEY === 'DEMO_KEY' ? 'DEMO_KEY — rate-limited' : 'custom'})…`,
  );

  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stderr.write(`  [${i + 1}/${queries.length}] ${q} … `);
    try {
      const food = await fetchFood(q);
      if (food) {
        out.push(food);
        process.stderr.write(`✓ ${food.description}\n`);
      } else {
        process.stderr.write('no match\n');
      }
    } catch (err) {
      process.stderr.write(`✗ ${err.message}\n`);
      if (String(err.message).includes('rate limited')) {
        log('Stopping early due to rate limiting; partial result not written.');
        process.exitCode = 1;
        return;
      }
    }
    await sleep(KEY === 'DEMO_KEY' ? 1500 : 200);
  }

  // One food per line keeps diffs readable.
  const json = `[\n${out.map((f) => `  ${JSON.stringify(f)}`).join(',\n')}\n]\n`;
  await writeFile(OUT, json);
  log(`Wrote ${out.length} foods → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  log(`Error: ${err.message}`);
  process.exitCode = 1;
});
