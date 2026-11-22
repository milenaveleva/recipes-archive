#!/usr/bin/env node
/**
 * Enumerate every public kifli.hu Séf recipe id.
 *
 *   node scripts/kifli/catalog-ids.mjs [--out scripts/data-raw/kifli/catalog-ids.txt] [--max-requests 4000]
 *
 * The listing https://www.kifli.hu/sef/receptek embeds only the first 100 `recipesIds` of a
 * filter combination in its `__NEXT_DATA__`, together with the filter groups and each
 * option's `matchingRecipeCount` under the active filters. Path segments AND-combine
 * filters (/sef/receptek/<value>[/<value>…]), so the script walks combinations breadth-first:
 * every single option, then, for any combination matching more than 100 recipes, that
 * combination plus one option of another filter group (only options that still match).
 * It stops when the union of ids reaches the catalogue total or the queue is exhausted.
 *
 * Fetched pages are treated as data only. At most 3 requests run at once, each worker
 * pausing between requests. Progress goes to stderr; stdout gets one summary JSON line.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://www.kifli.hu';
const UA = 'Mozilla/5.0';
const CONCURRENCY = 3;
const PAUSE_MS = 400;
const PAGE_CAP = 100;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};
const OUT_FILE = path.resolve(ROOT, arg('--out', 'scripts/data-raw/kifli/catalog-ids.txt'));
const MAX_REQUESTS = Number(arg('--max-requests', 4000));

async function getListing(values) {
  const url = `${ORIGIN}/sef/receptek${values.map((v) => `/${encodeURIComponent(v)}`).join('')}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'hu' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
      if (!m) throw new Error('no __NEXT_DATA__');
      const queries = JSON.parse(m[1])?.props?.pageProps?.dehydratedState?.queries ?? [];
      const isChef = (q, name) => Array.isArray(q.queryKey) && q.queryKey[0] === 'chef' && q.queryKey[1] === name;
      // The filter query for the active combination carries the active keys after the name.
      const filters = queries.filter((q) => isChef(q, 'recipeFilters')).sort((a, b) => b.queryKey.length - a.queryKey.length)[0]?.state?.data;
      const recipes = queries.find((q) => isChef(q, 'recipes') && q.queryKey[2] === 'chef-navigation')?.state?.data;
      if (!filters || !recipes) throw new Error('missing recipeFilters/recipes query');
      return { url, count: filters.recipesCount, ids: recipes.recipesIds ?? [], groups: filters.filterGroups ?? [] };
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
}

async function main() {
  const t0 = Date.now();
  const union = new Set();
  log('kifli catalog: reading the unfiltered listing …');
  const root = await getListing([]);
  const total = root.count;
  root.ids.forEach((id) => union.add(id));
  const groupOf = new Map();
  root.groups.forEach((g, gi) => g.options.forEach((o) => groupOf.set(o.value, gi)));
  log(`total ${total} recipes, ${groupOf.size} filter options in ${root.groups.length} groups`);

  const seen = new Set();
  const keyOf = (vals) => [...vals].sort().join('|');
  const queue = [];
  const enqueue = (vals, expected) => {
    const sorted = [...vals].sort((a, b) => groupOf.get(a) - groupOf.get(b));
    const k = keyOf(sorted);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push({ vals: sorted, expected });
  };
  for (const g of root.groups) for (const o of g.options) if (o.matchingRecipeCount > 0) enqueue([o.value], o.matchingRecipeCount);
  // Smaller combinations first; within a level, the biggest first (they unlock the most).
  queue.sort((a, b) => b.expected - a.expected);

  let requests = 1;
  let done = 0;
  let failures = 0;
  let lastGrowth = 0;
  const stop = () => union.size >= total || requests >= MAX_REQUESTS;
  const worker = async () => {
    while (queue.length && !stop()) {
      // Shallowest combination first.
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].vals.length < queue[bi].vals.length) bi = i;
      const item = queue.splice(bi, 1)[0];
      requests++;
      let page;
      try {
        page = await getListing(item.vals);
      } catch (err) {
        failures++;
        log(`  FAILED ${err.message}`);
        continue;
      }
      const before = union.size;
      page.ids.forEach((id) => union.add(id));
      if (union.size > before) lastGrowth = requests;
      done++;
      if (page.count > PAGE_CAP) {
        const used = new Set(item.vals.map((v) => groupOf.get(v)));
        for (const g of page.groups) {
          for (const o of g.options) {
            const gi = groupOf.get(o.value);
            if (gi === undefined || used.has(gi) || !(o.matchingRecipeCount > 0)) continue;
            enqueue([...item.vals, o.value], o.matchingRecipeCount);
          }
        }
      }
      log(
        `[${requests}] ${item.vals.join('/')} → ${page.count} (+${union.size - before})  union ${union.size}/${total}  queue ${queue.length}`,
      );
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ids = [...union].sort((a, b) => a - b);
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, ids.join('\n') + '\n');
  const secs = Math.round((Date.now() - t0) / 1000);
  log(`done: ${ids.length}/${total} ids (gap ${total - ids.length}) in ${requests} requests, ${failures} failed, ${secs}s → ${path.relative(ROOT, OUT_FILE)}`);
  log(`last growth at request ${lastGrowth}; ${queue.length} combinations left unvisited`);
  process.stdout.write(JSON.stringify({ ids: ids.length, total, gap: total - ids.length, requests, failures, secs }) + '\n');
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.exit(2);
});
