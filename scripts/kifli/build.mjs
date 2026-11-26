#!/usr/bin/env node
/**
 * Build recipe markdown from translated kifli.hu imports through the real authoring engine.
 *
 *   node scripts/kifli/build.mjs [--check|--write] [--ids a,b,...]
 *
 * Reads scripts/data-raw/kifli/en/<id>.json (the English translation, format in
 * scripts/kifli/README.md) together with scripts/data-raw/kifli/raw/<id>.json (from
 * fetch.mjs) and runs every ingredient through the /add island's engine
 * (src/components/add/addLib.ts: parse → USDA match → grams → cooking → macros → scores)
 * and src/core/markdown.ts, so an imported file is byte-for-byte what /add would author.
 *
 * Before compiling, each translation runs through the house rules' auto-fixes
 * (src/core/houseRules.ts `normalizeRecipe`: dairy/alcohol/sugar/refined-grain swaps, cooked
 * staples to dry weight, handfuls to grams, olive oil in spoons, eggs as a count, the 80 g
 * main-course grain portion, drink water and brewed records); the list of fixes is printed
 * per recipe. A recipe that still breaks a house rule afterwards is refused, never written.
 * Near-duplicates of a recipe on the site (houseRules.ts `findDuplicateRecipes`) are warned.
 *
 *   --check (default)  print per recipe our kcal/serving vs kifli's and each ingredient's
 *                      status (ok / NOMATCH / NOGRAMS / EXCL), matched food and grams,
 *                      the auto-fixes and the validation gate's findings. Writes nothing.
 *   --write            write the markdown to src/content/recipes/<slug>.md and copy the
 *                      hero image to src/content/recipes/images/<slug>.jpg. Without --ids
 *                      only ids not yet imported are written. A target file is replaced
 *                      only when it is the kifli import of the same recipe; any other
 *                      existing file is never touched (the slug gets a -<id> suffix, or
 *                      the recipe is refused).
 *   --ids a,b          limit to these kifli ids (default: every en/<id>.json).
 *
 * Progress and the check report go to stderr; stdout gets one summary JSON line.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'scripts/data-raw/kifli');
const RECIPES = path.join(ROOT, 'src/content/recipes');
const IMAGES = path.join(RECIPES, 'images');
const LIST = 'Kifli favourites';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const kifliId = (url) => {
  const m = /kifli\.hu\/sef\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
};

function parseArgs(argv) {
  const write = argv.includes('--write');
  if (write && argv.includes('--check')) throw new Error('pass --check or --write, not both');
  const i = argv.indexOf('--ids');
  let ids = null;
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--ids needs a comma-separated list');
    ids = [...new Set(argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean).map(Number))];
    if (ids.some((n) => !Number.isInteger(n))) throw new Error(`bad --ids: ${argv[i + 1]}`);
  }
  return { write, ids };
}

/* ---- compile the authoring engine (addLib + markdown) to CommonJS ---- */

function compileEngine() {
  const outDir = path.join(ROOT, 'node_modules/.cache', `kifli-build-${randomBytes(4).toString('hex')}`);
  mkdirSync(outDir, { recursive: true });
  log('→ compiling authoring engine (addLib.ts + core/markdown.ts) to CommonJS…');
  try {
    execFileSync(
      path.join(ROOT, 'node_modules/.bin/tsc'),
      ['src/components/add/addLib.ts', 'src/core/markdown.ts', '--outDir', outDir, '--module', 'commonjs',
       '--target', 'es2022', '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop',
       '--skipLibCheck'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // tsc still emits on type errors. The Vite-only `?url` import never resolves under
    // tsc; report anything else but carry on as long as the output exists.
    const lines = String(err.stdout ?? '').split('\n').filter((l) => l.includes('error TS') && !l.includes('?url'));
    for (const l of lines) log(`  tsc: ${l}`);
  }
  const addLibJs = path.join(outDir, 'components/add/addLib.js');
  const markdownJs = path.join(outDir, 'core/markdown.js');
  if (!existsSync(addLibJs) || !existsSync(markdownJs)) throw new Error('engine compile produced no output');

  // Resolve every `?url` asset import to an empty stub (the dataset is primed directly).
  const stub = path.join(outDir, 'url-stub.js');
  writeFileSync(stub, 'module.exports = { __esModule: true, default: "" };\n');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string' && request.endsWith('?url')) return stub;
    return resolve.call(this, request, ...rest);
  };
  const req = createRequire(import.meta.url);
  return {
    outDir,
    addLib: req(addLibJs),
    markdown: req(markdownJs),
    units: req(path.join(outDir, 'core/units.js')),
    house: req(path.join(outDir, 'core/houseRules.js')),
  };
}

/* ---- existing recipes (for slug collisions and already-imported ids) ---- */

function scanRecipes() {
  const bySlug = new Map(); // slug → kifli id of its source (null when not a kifli import)
  const byKifliId = new Map(); // kifli id → { slug, createdAt }
  const corpus = []; // { slug, kifliId, ingredients } for the near-duplicate check
  for (const file of readdirSync(RECIPES).filter((f) => f.endsWith('.md'))) {
    const slug = file.slice(0, -3);
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(RECIPES, file), 'utf8'));
    let data = null;
    try {
      data = fm ? parseYaml(fm[1]) : null;
    } catch {
      data = null;
    }
    const id = data?.source?.name === 'kifli.hu' ? kifliId(data?.source?.url) : null;
    bySlug.set(slug, id);
    if (id != null) byKifliId.set(id, { slug, createdAt: data?.createdAt });
    corpus.push({ slug, kifliId: id, ingredients: data?.ingredients ?? [] });
  }
  return { bySlug, byKifliId, corpus };
}

function baseSlug(slugifyRecipe, title) {
  const ascii = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  return slugifyRecipe(ascii);
}

/** Pick the file slug: the recipe's existing import, else the title slug, else title-<id>. */
function chooseSlug(id, title, existing, claimed, slugifyRecipe) {
  const prior = existing.byKifliId.get(id);
  if (prior) return { slug: prior.slug, replaces: true, createdAt: prior.createdAt };
  const free = (s) => !existing.bySlug.has(s) && !claimed.has(s);
  const base = baseSlug(slugifyRecipe, title);
  if (free(base)) return { slug: base, replaces: false };
  const suffixed = `${base}-${id}`;
  if (free(suffixed)) return { slug: suffixed, replaces: false };
  return { slug: null, reason: `both ${base}.md and ${suffixed}.md are taken by other recipes` };
}

/* ---- house-rule auto-fixes ---- */

/**
 * Run the translation through houseRules.normalizeRecipe and map the fixed lines back onto
 * en ingredient entries: an untouched line keeps its entry (and its `food` / `grams` hints);
 * a changed one becomes a new entry with the pinned food (`fdcId`) and weight (`forceGrams`).
 */
function normalizeEn(en, house, foodById) {
  const lines = en.ingredients.map((ing, src) => ({
    src, // origin entry, carried through the fixes
    raw: ing.en,
    fdcId: ing.fdcId ?? null,
    grams: ing.forceGrams ?? ing.grams ?? null,
    exclude: !!ing.exclude,
    cooking: ing.cooking ?? null,
    proxyOk: !!ing.proxyOk,
    group: ing.group,
  }));
  const { value, changes } = house.normalizeRecipe(
    { title: en.title, course: en.course, servings: Number(en.servings), ingredients: lines, steps: en.steps ?? [], tips: en.tips ?? [] },
    foodById,
  );
  const same = (a, b) =>
    a.raw === b.raw && (a.fdcId ?? null) === (b.fdcId ?? null) && (a.grams ?? null) === (b.grams ?? null) && !!a.exclude === !!b.exclude;
  const used = new Set();
  const ingredients = value.ingredients.map((line) => {
    const i = lines.findIndex((l, k) => !used.has(k) && same(l, line));
    if (i >= 0) {
      used.add(i);
      return en.ingredients[i];
    }
    // A reworded line keeps its search hint; a swapped ingredient (a forbidden original) does not.
    const orig = line.src != null ? en.ingredients[line.src] : null;
    const entry = { ...(orig?.hu ? { hu: orig.hu } : {}), en: line.raw, group: line.group };
    if (orig?.food && line.fdcId == null && !house.forbiddenReason(orig.en, foodById.get(orig.fdcId))) entry.food = orig.food;
    if (line.fdcId != null) entry.fdcId = line.fdcId;
    if (line.grams != null) entry.forceGrams = line.grams;
    if (line.cooking) entry.cooking = line.cooking;
    if (line.exclude) entry.exclude = true;
    if (line.proxyOk) entry.proxyOk = true;
    return entry;
  });
  return { en: { ...en, ingredients, steps: value.steps ?? en.steps, tips: value.tips ?? en.tips }, changes };
}

/** Gate codes the house rules own: an import still carrying one of these errors is refused. */
const HOUSE_CODES = new Set([
  'FORBIDDEN_INGREDIENT', 'FORBIDDEN_WORDING', 'MEAT_SUGGESTION', 'NOT_DRY_STAPLE', 'PORTION_80', 'DRINK_WATER',
]);

/* ---- one recipe ---- */

function buildRows(en, addLib, units) {
  const { buildRow, selectMatch } = addLib;
  return en.ingredients.map((ing, i) => {
    if (!ing.en) throw new Error(`ingredient ${i + 1} has no "en" line`);
    const row = buildRow(ing.en);
    const scoreOf = (r) => r.candidates.find((c) => c.food.fdcId === r.selectedFdcId)?.score ?? -Infinity;
    if (ing.food) {
      const best = buildRow(ing.food).candidates[0];
      if (best && best.confidence !== 'low' && best.score >= scoreOf(row) && best.food.fdcId != null) {
        if (!row.candidates.some((c) => c.food.fdcId === best.food.fdcId)) row.candidates = [best, ...row.candidates];
        Object.assign(row, selectMatch(row, best.food.fdcId));
      }
    }
    if (ing.fdcId != null) Object.assign(row, selectMatch(row, ing.fdcId));
    const dim = units.classifyUnit(row.parsed.unitId ?? row.parsed.unit);
    if (ing.grams != null && (row.grams == null || (dim !== 'mass' && dim !== 'volume'))) row.grams = ing.grams;
    if (ing.forceGrams != null) row.grams = ing.forceGrams;
    if (ing.cooking) {
      row.cooking = ing.cooking;
      row.userSetCooking = true;
    }
    if (ing.exclude) row.excludeFromNutrition = true;
    if (ing.proxyOk) row.proxyFdcId = row.selectedFdcId;
    return row;
  });
}

function sourceKcal(raw, servings) {
  const s = raw.servings?.[0] ?? '';
  const n = Number.parseInt(s, 10);
  if (raw.kcal == null || !/adag/i.test(s) || !Number.isFinite(n) || n <= 0) return null;
  return Math.round((raw.kcal * n) / servings);
}

function buildRecipe(id, engine, existing, claimed, today, foodById) {
  const { addLib, markdown, units, house } = engine;
  const fixed = normalizeEn(readJson(path.join(DATA, 'en', `${id}.json`)), house, foodById);
  const en = fixed.en;
  const raw = readJson(path.join(DATA, 'raw', `${id}.json`));
  if (!en.title) throw new Error('en JSON has no title');
  const servings = addLib.clampServings(Number(en.servings));
  const rows = buildRows(en, addLib, units);

  const form = {
    ...addLib.EMPTY_FORM,
    title: en.title,
    description: en.description ?? '',
    cuisine: en.cuisine ?? '',
    course: en.course ?? '',
    servings,
    prepMin: raw.prep ?? null,
    cookMin: raw.cook ?? null,
    nutriCategory: en.nutriCategory ?? 'general',
    redMeat: Boolean(en.redMeat),
    lists: LIST,
    imageUrl: raw.image ?? '',
    sourceName: 'kifli.hu',
    sourceUrl: raw.link,
    sourceKcalPerServing: sourceKcal(raw, servings),
    instructions: (en.steps ?? []).join('\n'),
  };

  const pick = chooseSlug(id, en.title, existing, claimed, markdown.slugifyRecipe);
  const resolved = addLib.rowsToResolved(rows);
  const macro = addLib.computeNutrition(rows, servings, resolved);
  const validation = addLib.validateRows(rows, form, resolved, macro);
  const method = addLib.validateMethod([...(en.steps ?? []), ...(en.tips ?? [])].join('\n'));
  validation.errors.push(...method.errors);
  const houseErrors = validation.errors.filter((e) => HOUSE_CODES.has(e.code));
  const createdAt = pick.createdAt ?? today;
  const draft = addLib.buildDraft(form, rows, macro, createdAt, pick.replaces ? { computedAt: today, updatedAt: today } : {});

  // Groups ride along on the stored lines (draftIngredients drops group headers only).
  const lineRows = rows.filter((r) => !r.parsed.isGroupHeader);
  lineRows.forEach((r, i) => {
    const group = en.ingredients[rows.indexOf(r)].group;
    if (group) draft.ingredients[i].group = group;
  });
  draft.author = raw.author ?? undefined;
  const imgSrc = path.join(DATA, 'img', `${id}.jpg`);
  const hasImage = existsSync(imgSrc);
  // The file name is the route slug (src/lib/recipe.ts), so no frontmatter `slug` is needed.
  if (pick.slug && hasImage) {
    draft.image = `./images/${pick.slug}.jpg`;
    draft.imageAlt = draft.title;
  }
  const tips = (en.tips ?? []).map((t) => t.trim()).filter(Boolean);
  if (tips.length) draft.bodyAfter = `## Tips\n\n${tips.map((t) => `- ${t}`).join('\n')}`;

  const excluded = readJson(path.join(ROOT, 'scripts/kifli/excluded-ids.json')).ids;
  const duplicates = house
    .findDuplicateRecipes([{ slug: pick.slug ?? `kifli-${id}`, kifliId: id, ingredients: draft.ingredients }], existing.corpus.filter((c) => c.kifliId !== id), excluded)
    .map((d) => d.issue);
  validation.warnings.push(...duplicates.map(({ severity, ...issue }) => issue));

  return { id, en, raw, rows, macro, validation, houseErrors, fixes: fixed.changes, draft, pick, imgSrc, hasImage, form };
}

/* ---- reporting ---- */

function report(r, foodDesc) {
  const ours = r.macro.perServing.energyKcal;
  const theirs = r.form.sourceKcalPerServing;
  const diff = ours != null && theirs ? ` (${ours >= theirs ? '+' : ''}${Math.round(((ours - theirs) / theirs) * 100)} %)` : '';
  log(`\n■ ${r.id}  ${r.en.title}  →  ${r.pick.slug ? `${r.pick.slug}.md${r.pick.replaces ? ' (replaces own import)' : ''}` : `REFUSED: ${r.pick.reason}`}`);
  log(`  kcal/serving: ours ${ours ?? '-'} vs kifli ${theirs ?? '-'}${diff}  ·  ${r.form.servings} servings  ·  image ${r.hasImage ? 'yes' : 'no'}`);
  r.rows.forEach((row, i) => {
    if (row.parsed.isGroupHeader) return;
    const status = row.excludeFromNutrition ? 'EXCL' : row.selectedFdcId == null ? 'NOMATCH' : row.grams == null ? 'NOGRAMS' : 'ok';
    const food = row.selectedFdcId != null ? `${foodDesc(row.selectedFdcId)} [${row.selectedFdcId}]` : '—';
    log(
      `  ${status.padEnd(7)} ${String(row.grams ?? '-').padStart(6)} g  ${row.cooking.padEnd(9)} ${r.en.ingredients[i].en}  →  ${food}`,
    );
  });
  for (const f of r.fixes) log(`  fixed   ${f}`);
  for (const e of r.validation.errors) log(`  ERROR   ${e.code}: ${e.message}`);
  for (const w of r.validation.warnings) log(`  warn    ${w.code}: ${w.message}`);
}

/* ---- main ---- */

async function main() {
  const { write, ids: only } = parseArgs(process.argv.slice(2));
  const enDir = path.join(DATA, 'en');
  const available = existsSync(enDir)
    ? readdirSync(enDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b)
    : [];
  const ids = only ?? available;
  const missing = ids.filter((id) => !available.includes(id) || !existsSync(path.join(DATA, 'raw', `${id}.json`)));
  if (missing.length) throw new Error(`no en/raw JSON for: ${missing.join(', ')}`);
  if (!ids.length) throw new Error(`nothing to build: ${path.relative(ROOT, enDir)}/ has no <id>.json`);

  const engine = compileEngine();
  try {
    log('→ loading food data (usda-foods.json)…');
    const foods = readJson(path.join(ROOT, 'src/data/usda-foods.json'));
    engine.addLib.primeFoods(foods);
    const foodById = new Map(foods.map((f) => [f.fdcId, f]));
    const foodDesc = (fdcId) => foodById.get(fdcId)?.description ?? '?';

    const existing = scanRecipes();
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    // Near-duplicates of a recipe already kept on the site are never rebuilt (excluded-ids.json).
    const excluded = new Set(Object.keys(readJson(path.join(ROOT, 'scripts/kifli/excluded-ids.json')).ids).map(Number));
    const targets = write && !only ? ids.filter((id) => !existing.byKifliId.has(id) && !excluded.has(id)) : ids;
    if (write && !only) {
      const imported = ids.filter((id) => existing.byKifliId.has(id)).length;
      const dup = ids.filter((id) => !existing.byKifliId.has(id) && excluded.has(id)).length;
      if (imported) log(`→ ${imported} id(s) already imported — skipped (pass --ids to rebuild them)`);
      if (dup) log(`→ ${dup} id(s) listed in excluded-ids.json (near-duplicates) — skipped`);
    }
    log(`→ ${write ? 'writing' : 'checking'} ${targets.length} recipe(s)…`);

    const claimed = new Set();
    const summary = { built: 0, written: 0, refused: [], failed: [] };
    for (const [n, id] of targets.entries()) {
      let r;
      try {
        r = buildRecipe(id, engine, existing, claimed, today, foodById);
      } catch (err) {
        log(`\n■ ${id} FAILED: ${err.message}`);
        summary.failed.push(id);
        continue;
      }
      summary.built++;
      // Only a recipe that would be written claims its slug, so a refused one never pushes a later one to a suffix.
      if (!write) {
        report(r, foodDesc);
        if (r.houseErrors.length) {
          log(`  WOULD BE REFUSED: breaks the house rules after auto-fix`);
          summary.refused.push(id);
        } else if (r.pick.slug) claimed.add(r.pick.slug);
        continue;
      }
      for (const f of r.fixes) log(`[${n + 1}/${targets.length}] ${id} fixed: ${f}`);
      if (r.houseErrors.length) {
        log(`[${n + 1}/${targets.length}] ${id} REFUSED: breaks the house rules after auto-fix`);
        for (const e of r.houseErrors) log(`    ${e.code}: ${e.message}`);
        summary.refused.push(id);
        continue;
      }
      if (!r.pick.slug) {
        log(`[${n + 1}/${targets.length}] ${id} REFUSED: ${r.pick.reason}`);
        summary.refused.push(id);
        continue;
      }
      const mdPath = path.join(RECIPES, `${r.pick.slug}.md`);
      const imgPath = path.join(IMAGES, `${r.pick.slug}.jpg`);
      if (!r.pick.replaces && (existsSync(mdPath) || (r.hasImage && existsSync(imgPath)))) {
        log(`[${n + 1}/${targets.length}] ${id} REFUSED: ${path.relative(ROOT, existsSync(mdPath) ? mdPath : imgPath)} exists`);
        summary.refused.push(id);
        continue;
      }
      claimed.add(r.pick.slug);
      writeFileSync(mdPath, engine.markdown.toRecipeMarkdown(r.draft));
      if (r.hasImage) copyFileSync(r.imgSrc, imgPath);
      summary.written++;
      log(`[${n + 1}/${targets.length}] ${id} wrote ${path.relative(ROOT, mdPath)}${r.hasImage ? ' + image' : ''}`);
    }
    log(
      `\ndone: ${summary.built} built${write ? `, ${summary.written} written` : ''}, ${summary.refused.length} ${write ? 'refused' : 'would be refused'}, ${summary.failed.length} failed`,
    );
    process.stdout.write(JSON.stringify(summary) + '\n');
    if (summary.failed.length || summary.refused.length) process.exitCode = 1;
  } finally {
    rmSync(engine.outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.exit(2);
});
