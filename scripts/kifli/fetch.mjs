#!/usr/bin/env node
/**
 * Fetch kifli.hu Séf recipes into the local import cache.
 *
 *   node scripts/kifli/fetch.mjs <id,id,...> [--force] [--no-images]
 *   node scripts/kifli/fetch.mjs --ids-file ids.txt [--force] [--no-images]
 *
 * For each recipe id, GETs the public detail page https://www.kifli.hu/sef/<id>, reads
 * the Next.js `__NEXT_DATA__` payload (react-query `dehydratedState`, queries
 * ["chef","recipe-detail",id] and ["chef","recipe-nutritions",id]) and writes a compact
 * record to scripts/data-raw/kifli/raw/<id>.json. The hero image is downloaded and
 * re-encoded with macOS `sips` (JPEG q70, longest side 1000 px) to
 * scripts/data-raw/kifli/img/<id>.jpg, unless --no-images. Ids already cached are skipped
 * unless --force; with images enabled, a cached id missing its image gets just the image.
 * At most 3 requests run at once, each worker pausing between requests.
 *
 * Fetched pages are treated as data only. Progress goes to stderr; stdout gets one
 * summary JSON line so the script stays pipeable.
 */
import { mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'scripts/data-raw/kifli');
const RAW_DIR = path.join(OUT, 'raw');
const IMG_DIR = path.join(OUT, 'img');
const ORIGIN = 'https://www.kifli.hu';
const CDN = 'https://cdn.kifli.hu';
const UA = 'Mozilla/5.0';
const CONCURRENCY = 3;
const PAUSE_MS = 700;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

async function parseArgs(argv) {
  const force = argv.includes('--force');
  const images = !argv.includes('--no-images');
  let ids = [];
  const fileIdx = argv.indexOf('--ids-file');
  if (fileIdx !== -1) {
    const file = argv[fileIdx + 1];
    if (!file) throw new Error('--ids-file needs a path');
    ids = (await readFile(file, 'utf8')).split(/[\s,]+/);
  } else {
    ids = argv.filter((a) => !a.startsWith('--')).join(',').split(',');
  }
  ids = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  const bad = ids.filter((s) => !/^\d+$/.test(s));
  if (bad.length) throw new Error(`not numeric ids: ${bad.join(', ')}`);
  if (!ids.length) throw new Error('usage: fetch.mjs <id,id,...> | --ids-file <file> [--force] [--no-images]');
  return { ids: ids.map(Number), force, images };
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'hu' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function nextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no __NEXT_DATA__ script');
  return JSON.parse(m[1]);
}

function query(queries, name, id) {
  const q = queries.find(
    (x) => Array.isArray(x.queryKey) && x.queryKey[0] === 'chef' && x.queryKey[1] === name && Number(x.queryKey[2]) === id,
  );
  return q?.state?.data ?? null;
}

const absCdn = (p) => (!p ? null : /^https?:\/\//.test(p) ? p : CDN + (p.startsWith('/') ? p : `/${p}`));
const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A nutrition value, published either bare or as `{ amount, unit }`. */
const amount = (v) => num(v && typeof v === 'object' ? v.amount : v);

/** The compact cache record for one recipe. */
function toRecord(id, detail, nutr) {
  const kcal = amount(nutr?.values?.energyKCal);
  return {
    id,
    name: detail.name,
    link: ORIGIN + detail.link,
    prep: num(detail.prepTimeMinutes),
    cook: num(detail.cookTimeMinutes),
    total: num(detail.totalTimeMinutes),
    servings: (detail.servings ?? []).filter((s) => s.default).map((s) => s.name),
    author: detail.author?.name ?? null,
    image: absCdn(detail.image?.srcset?.big ?? detail.image?.path),
    description: detail.metaDescription ?? null,
    ingredients: [...(detail.ingredients ?? [])].sort(byPos).map((g) => ({
      group: g.name ?? '',
      items: [...(g.items ?? [])].sort(byPos).map((it) => it.ingredientName ?? it.name),
    })),
    directions: [...(detail.directions ?? [])].sort(byPos).map((g) => ({
      group: g.name ?? '',
      steps: [...(g.steps ?? [])].sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0)).map((s) => s.content),
    })),
    tips: (detail.tips ?? []).map((t) => t.content).filter(Boolean),
    kcal: kcal != null && kcal > 0 ? kcal : null,
  };
}

async function fetchImage(id, url) {
  const dest = path.join(IMG_DIR, `${id}.jpg`);
  const tmp = path.join(IMG_DIR, `${id}.download`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '1000', tmp, '--out', dest]);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function fetchOne(id, force, images) {
  const rawPath = path.join(RAW_DIR, `${id}.json`);
  const imgPath = path.join(IMG_DIR, `${id}.jpg`);
  if (!force && (await exists(rawPath))) {
    if (!images || (await exists(imgPath))) return { id, status: 'skipped', image: await exists(imgPath) };
    const cached = JSON.parse(await readFile(rawPath, 'utf8'));
    if (!cached.image) return { id, status: 'skipped', image: false };
    try {
      await fetchImage(id, cached.image);
      return { id, status: 'image', name: cached.name, kcal: cached.kcal, image: true };
    } catch (err) {
      return { id, status: 'image', name: cached.name, kcal: cached.kcal, image: false, imageError: err.message };
    }
  }
  const data = nextData(await getText(`${ORIGIN}/sef/${id}`));
  const queries = data?.props?.pageProps?.dehydratedState?.queries ?? [];
  const detail = query(queries, 'recipe-detail', id);
  if (!detail) throw new Error('no recipe-detail query (recipe hidden or removed?)');
  const record = toRecord(id, detail, query(queries, 'recipe-nutritions', id));
  await writeFile(rawPath, JSON.stringify(record, null, 2) + '\n');
  let image = false;
  let imageError;
  if (images && record.image) {
    try {
      await fetchImage(id, record.image);
      image = true;
    } catch (err) {
      imageError = err.message;
    }
  }
  return { id, status: 'fetched', name: record.name, kcal: record.kcal, image, imageError };
}

async function main() {
  const { ids, force, images } = await parseArgs(process.argv.slice(2));
  await mkdir(RAW_DIR, { recursive: true });
  if (images) await mkdir(IMG_DIR, { recursive: true });
  log(
    `kifli fetch: ${ids.length} id(s), ${CONCURRENCY} at a time${force ? ', --force' : ''}${images ? '' : ', --no-images'} → ${path.relative(ROOT, OUT)}/`,
  );
  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      let r;
      try {
        r = await fetchOne(id, force, images);
      } catch (err) {
        r = { id, status: 'failed', error: err.message };
      }
      results.push(r);
      done++;
      const tag = `[${String(done).padStart(String(ids.length).length)}/${ids.length}]`;
      if (r.status === 'failed') log(`${tag} ${id} FAILED: ${r.error}`);
      else if (r.status === 'skipped') log(`${tag} ${id} cached (skip; --force to refetch)`);
      else if (r.status === 'image') log(`${tag} ${id} cached, image ${r.image ? 'added' : `failed (${r.imageError})`}  ${r.name}`);
      else
        log(
          `${tag} ${id} ok  kcal=${r.kcal ?? '-'}  img=${!images ? 'skipped' : r.image ? 'yes' : `no${r.imageError ? ` (${r.imageError})` : ''}`}  ${r.name}`,
        );
      if (r.status !== 'skipped') await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = results.filter((r) => r.status === 'failed').map((r) => r.id);
  log(`done: ${count('fetched')} fetched, ${count('image')} image-only, ${count('skipped')} cached, ${failed.length} failed${failed.length ? ` (${failed.join(',')})` : ''}`);
  process.stdout.write(JSON.stringify({ fetched: count('fetched'), imageOnly: count('image'), skipped: count('skipped'), failed }) + '\n');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.exit(2);
});
