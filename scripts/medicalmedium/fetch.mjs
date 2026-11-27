#!/usr/bin/env node
/**
 * Fetch Medical Medium recipes into the local import cache.
 *
 *   node scripts/medicalmedium/fetch.mjs --list                 sweep the recipe index
 *   node scripts/medicalmedium/fetch.mjs <slug,slug,...> [--force]
 *   node scripts/medicalmedium/fetch.mjs --all [--force]        every slug in index.json
 *
 * --list walks the paginated index
 * https://www.medicalmedium.com/medical-medium-categories/all-medical-medium-recipes?page=N
 * until a page adds no new /blog/<slug> link, and writes
 * scripts/data-raw/medicalmedium/index.json ([{ slug, title }]).
 *
 * A recipe page https://www.medicalmedium.com/blog/<slug> is parsed into
 * scripts/data-raw/medicalmedium/raw/<slug>.json: title, hero image URL, posted date, the
 * intro paragraphs, every ingredient list (with the heading above it as its group), the
 * direction paragraphs, the "Serves" line and any "Recipe Notes"/"Tips" (`notes`). A page
 * holding several recipes keeps each as its own entry in `recipes` (see parseRecipes for how
 * recipes and their sections are recognised).
 * Images are never downloaded: imports link the source image.
 *
 * Fetched pages are treated as data only. At most 3 requests run at once, each worker
 * pausing between requests. Progress goes to stderr; stdout gets one summary JSON line.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'scripts/data-raw/medicalmedium');
const RAW_DIR = path.join(OUT, 'raw');
const ORIGIN = 'https://www.medicalmedium.com';
const LIST_URL = `${ORIGIN}/medical-medium-categories/all-medical-medium-recipes`;
const UA = 'Mozilla/5.0';
const CONCURRENCY = 3;
const PAUSE_MS = 700;
const MAX_PAGES = 60;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', eacute: 'é', hellip: '…' };
/** A numeric entity's character; an out-of-range one stays as written. */
const codePoint = (m, n) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m);
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (m, n) => codePoint(m, Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(m, parseInt(n, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
/** Plain text of an HTML fragment, whitespace collapsed. */
const text = (h) => decode(h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/* ---- index ---- */

function listingEntries(html) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="\/blog\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const slug = m[1].trim().toLowerCase();
    const title = text(m[2]);
    if (SLUG_RE.test(slug)) out.push({ slug, title });
  }
  return out;
}

async function sweepList() {
  const bySlug = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    log(`→ index page ${page}…`);
    const entries = listingEntries(await getText(`${LIST_URL}?page=${page}&prop_ModuleId=1913`));
    let added = 0;
    for (const e of entries) {
      const prior = bySlug.get(e.slug);
      if (!prior) {
        bySlug.set(e.slug, e);
        added++;
      } else if (!prior.title && e.title) prior.title = e.title;
    }
    log(`  ${entries.length} links, ${added} new (total ${bySlug.size})`);
    if (!added) break;
    await sleep(PAUSE_MS);
  }
  const index = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  log(`done: ${index.length} entries → ${path.relative(ROOT, path.join(OUT, 'index.json'))}`);
  process.stdout.write(JSON.stringify({ entries: index.length }) + '\n');
}

/* ---- one recipe page ---- */

/** The article body: from the first <h2> after the hero to the "This item posted" line. */
function articleHtml(html) {
  let start = html.indexOf('<div id="article">');
  if (start < 0) start = html.indexOf('<div class="blogpost">');
  if (start < 0) throw new Error('no article block');
  const end = html.indexOf('class="blogdisx"', start);
  return html.slice(start, end > 0 ? end : undefined);
}

/**
 * Split the article into blocks in document order: paragraphs (`p`), list items grouped
 * per list (`ul`/`ol`) and headings (`h`). Nested <p><p> wrappers are flattened.
 */
function blocks(article) {
  const out = [];
  const re = /<(h[1-6]|ul|ol|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const body = article.replace(/<div class="vidyeso">[\s\S]*?<\/div>\s*<\/div>/, '').replace(/<\/?p>\s*(?=<p)/gi, (m) => (m.startsWith('</') ? m : ''));
  for (const m of body.matchAll(re)) {
    const tag = m[1].toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = [...m[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => text(x[1])).filter(Boolean);
      if (items.length) out.push({ kind: 'list', ordered: tag === 'ol', items });
    } else {
      // A <p> that itself wraps a list: emit its leading text and the list separately.
      if (tag === 'p' && /<(ul|ol)\b/i.test(m[2])) {
        out.push(...blocks(m[2]));
        continue;
      }
      // Lines a paragraph separates with <br> are separate paragraphs, marked `soft`: a <br>
      // may also just wrap prose, so a soft line never titles a recipe.
      const parts = tag === 'p' ? m[2].split(/<br\s*\/?>/i) : [m[2]];
      const soft = parts.length > 1;
      for (const part of parts) {
        const t = text(part);
        if (t) out.push({ kind: tag.startsWith('h') ? 'heading' : 'p', text: t, ...(soft ? { soft } : {}) });
      }
    }
  }
  return out;
}

const isIngredientsLabel = (t) => /^ingredients?\s*:?$/i.test(t);
const isHowToMake = (t) => /^how to make\s*:?$/i.test(t);
const isDirectionsLabel = (t) => /^(directions|instructions|method|preparation|steps)\s*:?$/i.test(t);
const isNotesLabel = (t) => /^(recipe\s+)?(notes?|tips?)\s*:?$/i.test(t);
/** The yield of a "Serves 4" / "Makes around 20 bars" line: a number must follow within a few words. */
function servesOf(t) {
  const rest = /^(?:serves|servings|makes|yields?)\b\s*:?\s*([\s\S]+)$/i.exec(t)?.[1]?.trim();
  if (!rest) return null;
  return /^(?:[\W_]*|(?:about|around|approx\w*|up to|to|roughly)\s+)*(?:[\d½¼]|(?:one|two|three|four|five|six|eight|ten|twelve|a few)\b)/i.test(rest) ? rest : null;
}
const isFurniture = (t) => /^(this item posted:|categories:)/i.test(t);
const isSentence = (t) => /[.!?]$/.test(t);
const titleLike = (t) => t.length <= 60 && !isSentence(t);

/**
 * Group the blocks into recipes, in document order:
 * - An "Ingredients:" label (or "How to make:" before any ingredients) opens a recipe. So does
 *   an unlabelled list outside a recipe, but such an implicit recipe is dropped (its items go
 *   to `intro`) if it never gets a method: it was a bullet list in the prose ("Use this shot
 *   for: …").
 * - Ingredient section: lists, each headed by the short line above it; a short line no list
 *   follows, or an unpunctuated line in a section without lists, is an ingredient itself. An
 *   ordered list or a full sentence after the ingredients starts the method.
 * - "Directions:"/"Preparation:"/"How to make:" and "Recipe Notes:"/"Tips:" switch sections;
 *   inside them a title-like line followed by a list opens the next recipe.
 * - A "Serves"/"Makes <quantity>" line records the yield, closing the recipe once it has a
 *   method. Page furniture ("This item posted:", "Categories:") ends the parse.
 */
function parseRecipes(bl) {
  const recipes = [];
  const intro = [];
  const implicit = new WeakSet(); // recipes opened by an unlabelled list
  const hasList = new WeakSet(); // recipes whose ingredients came as a list
  let cur = null;
  let mode = 'intro'; // intro | ingredients | directions | notes | after
  let pending = null; // a short line that may head the next list, or title the next recipe
  let candidate = null; // in directions/notes: the last line, when it could title a next recipe
  const dropIfProse = () => {
    if (cur && implicit.has(cur) && !cur.directions.length) {
      recipes.splice(recipes.indexOf(cur), 1);
      intro.push(...cur.ingredients.flatMap((g) => g.items));
    }
  };
  const open = (name, isImplicit = false) => {
    dropIfProse();
    cur = { name: name ?? '', ingredients: [], directions: [], serves: null, notes: [] };
    if (isImplicit) implicit.add(cur);
    recipes.push(cur);
    mode = 'ingredients';
    pending = null;
    candidate = null;
  };
  const section = () => (mode === 'notes' ? cur.notes : cur.directions);
  /** Pop the title candidate back out of the section it was filed under. */
  const takeCandidate = () => {
    const name = candidate;
    if (name != null && section().at(-1) === name) section().pop();
    candidate = null;
    return name;
  };
  const addIngredient = (line) => {
    if (!cur.ingredients.length) cur.ingredients.push({ group: '', items: [] });
    cur.ingredients.at(-1).items.push(line);
  };
  /** A short line in the ingredient section that no list followed is itself an ingredient. */
  const flushPending = () => {
    if (mode === 'ingredients' && cur && pending && !pending.endsWith(':')) addIngredient(pending);
    pending = null;
  };
  for (const b of bl) {
    const t = b.text ?? '';
    if (isFurniture(t)) break;
    const isList = b.kind === 'list';
    const howTo = !isList && isHowToMake(t);
    if (!isList && (isIngredientsLabel(t) || (howTo && !cur?.ingredients.length))) {
      open(mode === 'notes' || mode === 'directions' ? takeCandidate() : pending);
      continue;
    }
    if (cur && !isList && isNotesLabel(t)) {
      flushPending();
      mode = 'notes';
      candidate = null;
      continue;
    }
    if (cur && !isList && (isDirectionsLabel(t) || howTo)) {
      flushPending();
      mode = 'directions';
      candidate = null;
      continue;
    }
    if (mode === 'notes' || mode === 'directions') {
      if (isList && candidate != null) {
        open(takeCandidate());
        cur.ingredients.push({ group: '', items: b.items });
        hasList.add(cur);
        continue;
      }
      const serves = isList ? null : servesOf(t);
      if (serves) {
        cur.serves = serves;
        if (mode === 'directions') mode = 'after';
        candidate = null;
        continue;
      }
      if (isList) {
        section().push(...b.items);
        candidate = null;
      } else {
        section().push(t);
        candidate = titleLike(t) && !b.soft ? t : null;
      }
      continue;
    }
    if (isList) {
      if (!cur || mode === 'after') open(pending, true);
      else if (b.ordered && cur.ingredients.length) {
        // Numbered steps after the ingredient lists: the method.
        flushPending();
        mode = 'directions';
        cur.directions.push(...b.items);
        continue;
      }
      cur.ingredients.push({ group: (pending ?? '').replace(/:$/, ''), items: b.items });
      hasList.add(cur);
      pending = null;
      continue;
    }
    const serves = servesOf(t);
    if (cur && serves) {
      flushPending();
      cur.serves = serves;
      if (cur.directions.length) mode = 'after';
      continue;
    }
    if (mode === 'ingredients') {
      if (titleLike(t)) {
        flushPending();
        pending = t;
        continue;
      }
      // An unpunctuated line in an ingredient section written without lists is an ingredient.
      if (!implicit.has(cur) && !hasList.has(cur) && !isSentence(t)) {
        flushPending();
        addIngredient(t);
        continue;
      }
      // A sentence after the ingredients with no "Directions:" label starts the method.
      if (cur.ingredients.length || pending) {
        flushPending();
        mode = 'directions';
        cur.directions.push(t);
        continue;
      }
    }
    // A short line outside a recipe may be the next recipe's title; a long one is prose.
    if (t.length <= 80 && !isSentence(t)) pending = t;
    else if (!recipes.length) intro.push(t);
    else pending = null;
  }
  dropIfProse();
  return { intro, recipes };
}

/** The hero image URL: JSON-LD `image` (string, ImageObject or array), else og:image. */
function heroImage(ld, html) {
  const pickUrl = (v) => (typeof v === 'string' ? v : typeof v?.url === 'string' ? v.url : null);
  const fromLd = Array.isArray(ld?.image) ? pickUrl(ld.image[0]) : pickUrl(ld?.image);
  const og = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html)?.[1] ?? null;
  const url = fromLd ?? (og ? decode(og) : null);
  if (!url) return null;
  try {
    return new URL(url, ORIGIN).href;
  } catch {
    return null;
  }
}

async function fetchOne(slug, force) {
  const rawPath = path.join(RAW_DIR, `${slug}.json`);
  if (!force && (await exists(rawPath))) return { slug, status: 'skipped' };
  const url = `${ORIGIN}/blog/${slug}`;
  const html = await getText(url);
  const ld = [...html.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .find((d) => d?.['@type'] === 'BlogPosting');
  const article = articleHtml(html);
  const bl = blocks(article);
  const titleBlock = bl.find((b) => b.kind === 'heading');
  const { intro, recipes } = parseRecipes(bl.filter((b) => b !== titleBlock));
  const posted = /This item posted:\s*([0-9A-Za-z-]+)/.exec(html)?.[1] ?? null;
  const record = {
    slug,
    link: url,
    title: (ld?.headline ?? titleBlock?.text ?? slug).trim(),
    image: heroImage(ld, html),
    posted,
    intro,
    recipes,
  };
  await writeFile(rawPath, JSON.stringify(record, null, 2) + '\n');
  return { slug, status: 'fetched', title: record.title, recipes: recipes.length, lines: recipes.reduce((n, r) => n + r.ingredients.reduce((k, g) => k + g.items.length, 0), 0) };
}

async function fetchMany(slugs, force) {
  await mkdir(RAW_DIR, { recursive: true });
  log(`medicalmedium fetch: ${slugs.length} page(s), ${CONCURRENCY} at a time${force ? ', --force' : ''} → ${path.relative(ROOT, RAW_DIR)}/`);
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < slugs.length) {
      const slug = slugs[next++];
      let r;
      try {
        r = await fetchOne(slug, force);
      } catch (err) {
        r = { slug, status: 'failed', error: err.message };
      }
      results.push(r);
      const tag = `[${String(results.length).padStart(String(slugs.length).length)}/${slugs.length}]`;
      if (r.status === 'failed') log(`${tag} ${slug} FAILED: ${r.error}`);
      else if (r.status === 'skipped') log(`${tag} ${slug} cached (skip; --force to refetch)`);
      else log(`${tag} ${slug} ok  recipes=${r.recipes}  lines=${r.lines}  ${r.title}`);
      if (r.status !== 'skipped') await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slugs.length) }, worker));
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = results.filter((r) => r.status === 'failed').map((r) => r.slug);
  const empty = results.filter((r) => r.status === 'fetched' && !r.recipes).map((r) => r.slug);
  log(`done: ${count('fetched')} fetched, ${count('skipped')} cached, ${failed.length} failed, ${empty.length} without a recipe block`);
  process.stdout.write(JSON.stringify({ fetched: count('fetched'), skipped: count('skipped'), failed, empty }) + '\n');
  if (failed.length) process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) return sweepList();
  const force = argv.includes('--force');
  let slugs;
  if (argv.includes('--all')) {
    slugs = JSON.parse(await readFile(path.join(OUT, 'index.json'), 'utf8')).map((e) => e.slug);
  } else {
    slugs = argv.filter((a) => !a.startsWith('--')).join(',').split(',').map((s) => s.trim()).filter(Boolean);
  }
  slugs = [...new Set(slugs)];
  const bad = slugs.filter((s) => !SLUG_RE.test(s));
  if (bad.length) throw new Error(`not slugs: ${bad.join(', ')}`);
  if (!slugs.length) throw new Error('usage: fetch.mjs --list | --all | <slug,slug,...> [--force]');
  return fetchMany(slugs, force);
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.exit(2);
});
