/**
 * Shared plumbing for the recipe importers (scripts/kifli/build.mjs,
 * scripts/medicalmedium/build.mjs): compile the /add authoring engine to CommonJS, scan the
 * archive, run a translated recipe through the house rules, build engine rows from its
 * ingredient entries and print the per-recipe check report.
 *
 * An importer's translated recipe (`en`) has the shape documented in scripts/kifli/README.md:
 * `{ title, description, cuisine, course, servings, nutriCategory, ingredients: [{ en, group,
 * food, fdcId, grams, forceGrams, cooking, exclude, proxyOk, ...original-line field }], steps,
 * tips }`.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RECIPES = path.join(ROOT, 'src/content/recipes');
export const IMAGES = path.join(RECIPES, 'images');

export const log = (...a) => process.stderr.write(a.join(' ') + '\n');
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The kifli recipe id in a kifli.hu source URL, or null. */
export const kifliId = (url) => {
  const m = /kifli\.hu\/sef\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
};

/* ---- compile the authoring engine (addLib + markdown) to CommonJS ---- */

export function compileEngine(tag) {
  const outDir = path.join(ROOT, 'node_modules/.cache', `${tag}-build-${randomBytes(4).toString('hex')}`);
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

/** Load the food dataset into the compiled engine; returns the fdcId → food map. */
export function primeFoods(engine) {
  log('→ loading food data (usda-foods.json)…');
  const foods = readJson(path.join(ROOT, 'src/data/usda-foods.json'));
  engine.addLib.primeFoods(foods);
  return new Map(foods.map((f) => [f.fdcId, f]));
}

/* ---- existing recipes (for slug collisions and already-imported ids) ---- */

/**
 * Scan the archive. `sourceIdOf(frontmatter)` returns the importer's own id for a recipe it
 * imported (else null). Returns `bySlug` (slug → that id or null), `byId` (id → { slug,
 * createdAt }) and `corpus` ({ slug, kifliId, ingredients }) for the near-duplicate check.
 */
export function scanRecipes(sourceIdOf) {
  const bySlug = new Map();
  const byId = new Map();
  const corpus = [];
  for (const file of readdirSync(RECIPES).filter((f) => f.endsWith('.md'))) {
    const slug = file.slice(0, -3);
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(RECIPES, file), 'utf8'));
    let data = null;
    try {
      data = fm ? parseYaml(fm[1]) : null;
    } catch {
      data = null;
    }
    const id = data ? sourceIdOf(data) : null;
    bySlug.set(slug, id);
    if (id != null) byId.set(id, { slug, createdAt: data?.createdAt });
    const kid = data?.source?.name === 'kifli.hu' ? kifliId(data?.source?.url) : null;
    corpus.push({ slug, kifliId: kid, ingredients: data?.ingredients ?? [] });
  }
  return { bySlug, byId, corpus };
}

function baseSlug(slugifyRecipe, title) {
  const ascii = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  return slugifyRecipe(ascii);
}

/** Pick the file slug: the recipe's existing import, else the title slug, else title-<suffix>. */
export function chooseSlug(id, suffix, title, existing, claimed, slugifyRecipe) {
  const prior = existing.byId.get(id);
  if (prior) return { slug: prior.slug, replaces: true, createdAt: prior.createdAt };
  const free = (s) => !existing.bySlug.has(s) && !claimed.has(s);
  const base = baseSlug(slugifyRecipe, title);
  if (free(base)) return { slug: base, replaces: false };
  const suffixed = `${base}-${suffix}`;
  if (free(suffixed)) return { slug: suffixed, replaces: false };
  return { slug: null, reason: `both ${base}.md and ${suffixed}.md are taken by other recipes` };
}

/* ---- house-rule auto-fixes ---- */

/** Fields an importer uses to keep the source's original line on an ingredient entry. */
const ORIGINAL_FIELDS = ['hu', 'orig'];

/**
 * Run the translation through houseRules.normalizeRecipe and map the fixed lines back onto
 * en ingredient entries: an untouched line keeps its entry (and its `food` / `grams` hints);
 * a changed one becomes a new entry with the pinned food (`fdcId`) and weight (`forceGrams`).
 */
export function normalizeEn(en, house, foodById) {
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
    const entry = {};
    for (const f of ORIGINAL_FIELDS) if (orig?.[f]) entry[f] = orig[f];
    Object.assign(entry, { en: line.raw, group: line.group });
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
export const HOUSE_CODES = new Set([
  'FORBIDDEN_INGREDIENT', 'FORBIDDEN_WORDING', 'MEAT_SUGGESTION', 'NOT_DRY_STAPLE', 'PORTION_80', 'DRINK_WATER',
]);

/* ---- engine rows ---- */

export function buildRows(en, addLib, units) {
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

/**
 * Compile one translated recipe: house-rule fixes, engine rows, nutrition, validation and the
 * draft. `form` holds the importer's own fields (source, list, image, times); groups ride along
 * on the stored lines and `tips` become a `## Tips` list.
 */
export function compileRecipe(enIn, form, engine, foodById, { createdAt, replaces, today }) {
  const { addLib, house, units } = engine;
  const fixed = normalizeEn(enIn, house, foodById);
  const en = fixed.en;
  if (!en.title) throw new Error('en JSON has no title');
  const servings = addLib.clampServings(Number(en.servings));
  const rows = buildRows(en, addLib, units);
  const fullForm = {
    ...addLib.EMPTY_FORM,
    title: en.title,
    description: en.description ?? '',
    cuisine: en.cuisine ?? '',
    course: en.course ?? '',
    servings,
    nutriCategory: en.nutriCategory ?? 'general',
    redMeat: Boolean(en.redMeat),
    instructions: (en.steps ?? []).join('\n'),
    ...form,
  };
  const resolved = addLib.rowsToResolved(rows);
  const macro = addLib.computeNutrition(rows, servings, resolved);
  const validation = addLib.validateRows(rows, fullForm, resolved, macro);
  const method = addLib.validateMethod([...(en.steps ?? []), ...(en.tips ?? [])].join('\n'));
  validation.errors.push(...method.errors);
  const houseErrors = validation.errors.filter((e) => HOUSE_CODES.has(e.code));
  const draft = addLib.buildDraft(fullForm, rows, macro, createdAt, replaces ? { computedAt: today, updatedAt: today } : {});
  const lineRows = rows.filter((r) => !r.parsed.isGroupHeader);
  lineRows.forEach((r, i) => {
    const group = en.ingredients[rows.indexOf(r)].group;
    if (group) draft.ingredients[i].group = group;
  });
  const tips = (en.tips ?? []).map((t) => t.trim()).filter(Boolean);
  if (tips.length) draft.bodyAfter = `## Tips\n\n${tips.map((t) => `- ${t}`).join('\n')}`;
  return { en, rows, macro, validation, houseErrors, fixes: fixed.changes, draft, form: fullForm };
}

/* ---- reporting ---- */

export function report(r, foodDesc, sourceLabel) {
  const ours = r.macro.perServing.energyKcal;
  const theirs = r.form.sourceKcalPerServing;
  const diff = ours != null && theirs ? ` (${ours >= theirs ? '+' : ''}${Math.round(((ours - theirs) / theirs) * 100)} %)` : '';
  log(`\n■ ${r.id}  ${r.en.title}  →  ${r.pick.slug ? `${r.pick.slug}.md${r.pick.replaces ? ' (replaces own import)' : ''}` : `REFUSED: ${r.pick.reason}`}`);
  log(`  kcal/serving: ours ${ours ?? '-'} vs ${sourceLabel} ${theirs ?? '-'}${diff}  ·  ${r.form.servings} servings  ·  image ${r.hasImage ? 'yes' : r.draft.imageUrl ? 'linked' : 'no'}`);
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
