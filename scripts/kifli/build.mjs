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
import { existsSync, writeFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, RECIPES, IMAGES, log, readJson, kifliId, compileEngine, primeFoods, scanRecipes, chooseSlug, compileRecipe, report,
} from '../lib/recipe-import.mjs';

const DATA = path.join(ROOT, 'scripts/data-raw/kifli');
const LIST = 'Kifli favourites';


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

const sourceIdOf = (data) => (data?.source?.name === 'kifli.hu' ? kifliId(data?.source?.url) : null);

function sourceKcal(raw, servings) {
  const s = raw.servings?.[0] ?? '';
  const n = Number.parseInt(s, 10);
  if (raw.kcal == null || !/adag/i.test(s) || !Number.isFinite(n) || n <= 0) return null;
  return Math.round((raw.kcal * n) / servings);
}

function buildRecipe(id, engine, existing, claimed, today, foodById) {
  const { addLib, markdown, house } = engine;
  const en = readJson(path.join(DATA, 'en', `${id}.json`));
  const raw = readJson(path.join(DATA, 'raw', `${id}.json`));
  const pick = chooseSlug(id, id, en.title ?? '', existing, claimed, markdown.slugifyRecipe);
  const form = {
    prepMin: raw.prep ?? null,
    cookMin: raw.cook ?? null,
    lists: LIST,
    imageUrl: raw.image ?? '',
    sourceName: 'kifli.hu',
    sourceUrl: raw.link,
    sourceKcalPerServing: sourceKcal(raw, addLib.clampServings(Number(en.servings))),
  };
  const r = compileRecipe(en, form, engine, foodById, { createdAt: pick.createdAt ?? today, replaces: !!pick.replaces, today });
  const { draft } = r;
  draft.author = raw.author ?? undefined;
  const imgSrc = path.join(DATA, 'img', `${id}.jpg`);
  const hasImage = existsSync(imgSrc);
  // The file name is the route slug (src/lib/recipe.ts), so no frontmatter `slug` is needed.
  if (pick.slug && hasImage) {
    draft.image = `./images/${pick.slug}.jpg`;
    draft.imageAlt = draft.title;
  }

  const excluded = readJson(path.join(ROOT, 'scripts/kifli/excluded-ids.json')).ids;
  const duplicates = house
    .findDuplicateRecipes([{ slug: pick.slug ?? `kifli-${id}`, kifliId: id, ingredients: draft.ingredients }], existing.corpus.filter((c) => c.kifliId !== id), excluded)
    .map((d) => d.issue);
  r.validation.warnings.push(...duplicates.map(({ severity, ...issue }) => issue));

  return { ...r, id, raw, pick, imgSrc, hasImage };
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

  const engine = compileEngine('kifli');
  try {
    const foodById = primeFoods(engine);
    const foodDesc = (fdcId) => foodById.get(fdcId)?.description ?? '?';

    const existing = scanRecipes(sourceIdOf);
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    // Near-duplicates of a recipe already kept on the site are never rebuilt (excluded-ids.json).
    const excluded = new Set(Object.keys(readJson(path.join(ROOT, 'scripts/kifli/excluded-ids.json')).ids).map(Number));
    const targets = write && !only ? ids.filter((id) => !existing.byId.has(id) && !excluded.has(id)) : ids;
    if (write && !only) {
      const imported = ids.filter((id) => existing.byId.has(id)).length;
      const dup = ids.filter((id) => !existing.byId.has(id) && excluded.has(id)).length;
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
        report(r, foodDesc, 'kifli');
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
