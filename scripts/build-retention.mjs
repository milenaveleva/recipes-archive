#!/usr/bin/env node
/**
 * Build the cooking-factor tables the engine applies to every cooked ingredient
 * (src/core/cooking.ts):
 *
 *   - src/data/retention-factors.json — per cooking group × method, the fraction of
 *     each nutrient left after cooking (true retention). Primary source: the USDA Table
 *     of Nutrient Retention Factors, Release 6 (2007); the nutrients Release 6 does not
 *     tabulate (vitamins D, E, K, pantothenic acid, Mn, Se) come from the Bognár 2002
 *     Part 2 tables; any nutrient neither covers stays at 1.0 (Bognár's own recommendation
 *     for constituents without data). Macronutrients and energy are not in Release 6 and
 *     stay at 1.0.
 *   - src/data/cooking-yields.json — per cooking group × method, cooked mass / raw mass.
 *     Sources, in order: Bognár 2002 Part 1 weight-yield rows (mean when several rows are
 *     listed), USDA raw/cooked record pairs from src/data/usda-foods.json (yield =
 *     (100 − water_raw) / (100 − water_cooked), assuming no dry-matter loss), or an
 *     explicit 1.0 assumption.
 *
 * The group × method mapping is hand-curated in scripts/cooking-factor-map.json. A method
 * a group does not list borrows the nearest listed one along PROXY_CHAIN, and the output
 * records the borrowed method in `proxyOf`.
 *
 * Input (git-ignored, under scripts/data-raw/): usda-retn06.txt, the caret-delimited
 * Release 6 file (downloaded on first run from the USDA ARS Nutrient Data Laboratory).
 *
 * Usage: node scripts/build-retention.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'scripts/data-raw/usda-retn06.txt');
const RETN_URL = 'https://www.ars.usda.gov/ARSUserFiles/80400525/Data/retn/retn06.txt';
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const METHODS = ['boiled', 'steamed', 'baked', 'grilled', 'fried', 'blanched', 'microwaved'];
/** Where a method missing from a group borrows its factors, nearest first. */
const PROXY_CHAIN = {
  boiled: [],
  steamed: ['boiled'],
  baked: ['fried', 'boiled'],
  grilled: ['baked', 'fried', 'boiled'],
  fried: ['baked', 'boiled'],
  blanched: ['boiled'],
  microwaved: ['steamed', 'boiled'],
};

/** NutrientVector field → USDA Release 6 nutrient numbers (first present wins). */
const USDA_NUTRIENTS = {
  vitA_ug: ['392', '318'], // vitamin A RE, else IU
  vitC_mg: ['401'],
  thiamin_mg: ['404'],
  riboflavin_mg: ['405'],
  niacin_mg: ['406'],
  vitB6_mg: ['415'],
  folate_ug: ['417'],
  vitB12_ug: ['418'],
  choline_mg: ['421'],
  calcium_mg: ['301'],
  iron_mg: ['303'],
  magnesium_mg: ['304'],
  phosphorus_mg: ['305'],
  potassium_mg: ['306'],
  sodium_mg: ['307'],
  zinc_mg: ['309'],
  copper_mg: ['312'],
};
/** NutrientVector field → Bognár 2002 transcription key (scripts/cooking-factor-map.json). */
const BOGNAR_NUTRIENTS = {
  vitD_ug: 'vitD_ug',
  vitE_mg: 'vitE_mg',
  vitK_ug: 'vitK_ug',
  pantothenicAcid_mg: 'pantothenicAcid_mg',
  manganese_mg: 'otherMinerals',
  selenium_ug: 'otherMinerals',
};

async function ensureRaw() {
  if (existsSync(RAW)) return;
  log(`→ downloading USDA Release 6 retention factors from ${RETN_URL}…`);
  const res = await fetch(RETN_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  mkdirSync(path.dirname(RAW), { recursive: true });
  writeFileSync(RAW, Buffer.from(await res.arrayBuffer()));
}

/** retn06.txt → Map(code → { description, factors: Map(nutrNo → fraction) }). */
function parseRetn(text) {
  const codes = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [code, , desc, nutrNo, , value] = line.split('^').map((s) => s.replace(/~/g, '').trim());
    if (!codes.has(code)) codes.set(code, { description: desc, factors: new Map() });
    codes.get(code).factors.set(nutrNo, Number(value) / 100);
  }
  return codes;
}

/** Resolve a `{ from: otherGroup }` indirection on a group's bognar/yield block. */
function resolveBlock(groups, gid, key) {
  let block = groups[gid][key] ?? {};
  const seen = new Set([gid]);
  while (block.from) {
    if (seen.has(block.from)) throw new Error(`${key} cycle at ${gid}`);
    seen.add(block.from);
    block = groups[block.from][key] ?? {};
  }
  return block;
}

/** The method entry for `method` in `table`, or the nearest along PROXY_CHAIN. */
function pick(table, method) {
  if (table?.[method] != null) return { entry: table[method], proxyOf: null };
  for (const alt of PROXY_CHAIN[method]) if (table?.[alt] != null) return { entry: table[alt], proxyOf: alt };
  return { entry: null, proxyOf: null };
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

function yieldOf(spec, foodById) {
  if (spec.bognar) {
    const vals = spec.bognar.map((r) => r[2]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const rows = spec.bognar.map(([t, row, v, n]) => `${t} "${row}" ${v}${n ? ` (n=${n})` : ''}`).join('; ');
    return {
      yield: round(mean, 3),
      basis: 'bognar',
      source: `Bognár 2002 ${vals.length > 1 ? 'mean of ' : ''}${rows}`,
    };
  }
  if (spec.usdaPair) {
    const [rawId, cookedId] = spec.usdaPair;
    const raw = foodById.get(rawId);
    const cooked = foodById.get(cookedId);
    const wr = raw?.n?.water_g;
    const wc = cooked?.n?.water_g;
    if (wr == null || wc == null) throw new Error(`USDA pair ${rawId}/${cookedId} missing from usda-foods.json or lacks water`);
    return {
      yield: round((100 - wr) / (100 - wc), 3),
      basis: 'usda-pair',
      source: `USDA FDC water balance ${rawId} "${raw.description}" (water ${wr} g) → ${cookedId} "${cooked.description}" (water ${wc} g)`,
    };
  }
  if (spec.assumed != null) return { yield: spec.assumed, basis: 'assumed', source: spec.note ?? 'no tabulated yield' };
  throw new Error(`unrecognised yield spec ${JSON.stringify(spec)}`);
}

async function main() {
  await ensureRaw();
  log('→ parsing USDA Release 6 retention table…');
  const retn = parseRetn(readFileSync(RAW, 'utf8'));
  log(`  ${retn.size} retention codes`);
  const map = JSON.parse(readFileSync(path.join(ROOT, 'scripts/cooking-factor-map.json'), 'utf8'));
  log('→ loading usda-foods.json (raw/cooked water pairs)…');
  const foods = JSON.parse(readFileSync(path.join(ROOT, 'src/data/usda-foods.json'), 'utf8'));
  const foodById = new Map(foods.map((f) => [f.fdcId, f]));

  const retention = {};
  const yields = {};
  const overrides = [];
  const counts = { usda: 0, bognar: 0, assumed: 0, proxied: 0 };
  const yieldCounts = { bognar: 0, 'usda-pair': 0, assumed: 0, proxied: 0 };

  for (const [gid, g] of Object.entries(map.groups)) {
    log(`→ ${gid}`);
    const bognar = resolveBlock(map.groups, gid, 'bognar');
    const yieldBlock = resolveBlock(map.groups, gid, 'yield');
    retention[gid] = { label: g.label, methods: {} };
    yields[gid] = { label: g.label, methods: {} };

    for (const method of METHODS) {
      // ---- retention ----
      const u = pick(g.usda, method);
      const code = u.entry;
      const rec = code ? retn.get(code) : null;
      if (code && !rec) throw new Error(`${gid}/${method}: USDA code ${code} not in Release 6`);
      const b = pick(bognar, method);
      const rf = {};
      const from = {};
      for (const [field, nos] of Object.entries(USDA_NUTRIENTS)) {
        const no = nos.find((n) => rec?.factors.has(n));
        if (no) { rf[field] = round(rec.factors.get(no), 2); from[field] = 'usda'; counts.usda++; }
        else { rf[field] = 1; from[field] = 'assumed'; counts.assumed++; }
      }
      for (const [field, key] of Object.entries(BOGNAR_NUTRIENTS)) {
        const v = b.entry?.[key];
        if (v != null) { rf[field] = v; from[field] = 'bognar'; counts.bognar++; }
        else { rf[field] = 1; from[field] = 'assumed'; counts.assumed++; }
      }
      if (u.proxyOf || b.proxyOf) counts.proxied++;
      const note = g.usdaNote?.[u.proxyOf ?? method] ?? g.usdaNote?.['*'];
      retention[gid].methods[method] = {
        usda: code ? `${code} ${rec.description}` : null,
        ...(u.proxyOf ? { usdaProxyOf: u.proxyOf } : {}),
        ...(note && code ? { usdaNote: note } : {}),
        bognar: b.entry ? `${bognar.table}, ${b.entry.col}` : null,
        ...(b.proxyOf ? { bognarProxyOf: b.proxyOf } : {}),
        rf,
        from,
      };

      // ---- yield ----
      const y = pick(yieldBlock, method);
      if (!y.entry) throw new Error(`${gid}/${method}: no yield entry along the proxy chain`);
      const yv = yieldOf(y.entry, foodById);
      yieldCounts[yv.basis]++;
      if (y.proxyOf) yieldCounts.proxied++;
      yields[gid].methods[method] = { ...yv, ...(y.proxyOf ? { proxyOf: y.proxyOf } : {}) };

      // Name-specific yields: an override written for this method, or for the method
      // this one proxies to.
      const base = y.proxyOf ?? method;
      for (const o of g.yieldOverrides ?? []) {
        if (o.method !== base) continue;
        overrides.push({ group: gid, method, match: o.match, ...yieldOf(o, foodById), ...(y.proxyOf ? { proxyOf: base } : {}) });
      }
    }
  }

  const sources = [
    'USDA Table of Nutrient Retention Factors, Release 6 (2007), Nutrient Data Laboratory, ARS — retn06.txt',
    'Bognár A. (2002) Tables on weight yield of food and retention factors of food constituents for the calculation of nutrient composition of cooked foods (dishes). BFE-R-02-03, Bundesforschungsanstalt für Ernährung, Karlsruhe',
    'USDA FoodData Central SR Legacy raw/cooked record pairs (water balance)',
  ];
  const retentionOut = {
    _doc: 'GENERATED by scripts/build-retention.mjs — do not edit. Nutrient retention factors (true retention: nutrient in the cooked food ÷ nutrient in the raw food, total amounts) per cooking group × method, read by src/core/cooking.ts. `rf` holds the factor per NutrientVector field and `from` its source: usda = USDA Release 6 code named in `usda`; bognar = Bognár 2002 Part 2 column named in `bognar`; assumed = no tabulated factor, 1.0. Fields not listed (energy, macronutrients, fat fractions, polyphenols) are retained in full. `usdaProxyOf` / `bognarProxyOf` name the method whose factors a method borrows when its own are not tabulated.',
    sources: sources.slice(0, 2),
    methods: METHODS,
    groups: retention,
  };
  const yieldsOut = {
    _doc: 'GENERATED by scripts/build-retention.mjs — do not edit. Cooking weight-yield factors (cooked mass ÷ raw mass) per cooking group × method, read by src/core/cooking.ts. `basis`: bognar = Bognár 2002 Part 1 row(s) (the mean when several are listed); usda-pair = USDA raw/cooked records\' water balance, (100 − water_raw) / (100 − water_cooked); assumed = no tabulated yield. `proxyOf` names the method a method borrows from. `overrides` are name-specific yields (regex `match` on the food description, case-insensitive) that take precedence within their group.',
    sources: [sources[1], sources[2]],
    methods: METHODS,
    groups: yields,
    overrides,
  };
  writeFileSync(path.join(ROOT, 'src/data/retention-factors.json'), JSON.stringify(retentionOut, null, 1) + '\n');
  writeFileSync(path.join(ROOT, 'src/data/cooking-yields.json'), JSON.stringify(yieldsOut, null, 1) + '\n');

  const cells = Object.keys(map.groups).length * METHODS.length;
  log(`✓ retention-factors.json: ${Object.keys(map.groups).length} groups × ${METHODS.length} methods = ${cells} cells ` +
    `(${counts.proxied} borrow a neighbouring method); factors: ${counts.usda} USDA, ${counts.bognar} Bognár, ${counts.assumed} assumed 1.0`);
  log(`✓ cooking-yields.json: ${cells} cells — ${yieldCounts.bognar} Bognár, ${yieldCounts['usda-pair']} USDA pair, ` +
    `${yieldCounts.assumed} assumed (${yieldCounts.proxied} borrowed); ${overrides.length} name overrides`);
}

main().catch((err) => {
  log(`✗ ${err.message}`);
  process.exit(1);
});
