#!/usr/bin/env node
/**
 * Build recipe markdown from rewritten Medical Medium imports through the real authoring engine.
 *
 *   node scripts/medicalmedium/build.mjs [--check|--write] [--ids a,b,...]
 *
 * Reads scripts/data-raw/medicalmedium/en/<id>.json (the rewrite, format in
 * scripts/medicalmedium/README.md) together with raw/<page-slug>.json from fetch.mjs, where
 * the page slug is the id without a `--<n>` suffix. Every recipe runs through the house
 * rules' auto-fixes (src/core/houseRules.ts `normalizeRecipe`) and the /add island's engine
 * (scripts/lib/recipe-import.mjs), so an imported file is what /add would author. A recipe
 * that still breaks a house rule afterwards is refused, never written.
 *
 * Images are never copied: the recipe links the source photo through `imageUrl`.
 *
 *   --check (default)  print each ingredient's status (ok / NOMATCH / NOGRAMS / EXCL), the
 *                      auto-fixes and the validation gate's findings. Writes nothing.
 *   --write            write src/content/recipes/<slug>.md. Without --ids only ids not yet
 *                      imported are written. A target file is replaced only when it is the
 *                      Medical Medium import of the same recipe; any other existing file is
 *                      never touched (the slug gets a -mm suffix, or the recipe is refused).
 *   --ids a,b          limit to these ids (default: every en/<id>.json).
 *
 * Progress and the check report go to stderr; stdout gets one summary JSON line.
 */
import { readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, RECIPES, log, readJson, compileEngine, primeFoods, scanRecipes, chooseSlug, compileRecipe, report,
} from '../lib/recipe-import.mjs';
import { LIST, SOURCE, ID_RE, pageOf, blockOf, sourceIdOf } from './source.mjs';

const DATA = path.join(ROOT, 'scripts/data-raw/medicalmedium');

function parseArgs(argv) {
  const write = argv.includes('--write');
  if (write && argv.includes('--check')) throw new Error('pass --check or --write, not both');
  const i = argv.indexOf('--ids');
  let ids = null;
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--ids needs a comma-separated list');
    ids = [...new Set(argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean))];
    const bad = ids.filter((s) => !ID_RE.test(s));
    if (bad.length) throw new Error(`bad --ids: ${bad.join(', ')}`);
  }
  return { write, ids };
}

/** A positive whole number of minutes, else null. */
const minutes = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

function buildOne(id, engine, foodById, existing, claimed, today) {
  const en = readJson(path.join(DATA, 'en', `${id}.json`));
  const raw = readJson(path.join(DATA, 'raw', `${pageOf(id)}.json`));
  const block = blockOf(id);
  // The source URL names the block for the second and later recipes of a page.
  const sourceUrl = block > 0 ? `${raw.link}#${block + 1}` : raw.link;
  const pick = chooseSlug(id, 'mm', en.title ?? '', existing, claimed, engine.markdown.slugifyRecipe);
  const form = {
    prepMin: minutes(en.prepMin),
    cookMin: minutes(en.cookMin),
    lists: LIST,
    imageUrl: raw.image ?? '',
    sourceName: SOURCE,
    sourceUrl,
    sourceKcalPerServing: null,
  };
  const r = compileRecipe(en, form, engine, foodById, { createdAt: pick.createdAt ?? today, replaces: !!pick.replaces, today });
  if (r.draft.imageUrl) r.draft.imageAlt = r.draft.title;

  const duplicates = engine.house
    .findDuplicateRecipes([{ slug: pick.slug ?? `mm-${id}`, kifliId: null, ingredients: r.draft.ingredients }], existing.corpus.filter((c) => c.slug !== pick.slug))
    .map((d) => d.issue);
  r.validation.warnings.push(...duplicates.map(({ severity, ...issue }) => issue));
  return { ...r, id, pick, hasImage: false };
}

async function main() {
  const { write, ids: only } = parseArgs(process.argv.slice(2));
  const enDir = path.join(DATA, 'en');
  const available = existsSync(enDir)
    ? readdirSync(enDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((s) => ID_RE.test(s)).sort()
    : [];
  const ids = only ?? available;
  const missing = ids.filter((id) => !available.includes(id) || !existsSync(path.join(DATA, 'raw', `${pageOf(id)}.json`)));
  if (missing.length) throw new Error(`no en/raw JSON for: ${missing.join(', ')}`);
  if (!ids.length) throw new Error(`nothing to build: ${path.relative(ROOT, enDir)}/ has no <id>.json`);

  const engine = compileEngine('medicalmedium');
  try {
    const foodById = primeFoods(engine);
    const foodDesc = (fdcId) => foodById.get(fdcId)?.description ?? '?';
    const existing = scanRecipes(sourceIdOf);
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    const targets = write && !only ? ids.filter((id) => !existing.byId.has(id)) : ids;
    if (write && !only && targets.length < ids.length) log(`→ ${ids.length - targets.length} id(s) already imported — skipped (pass --ids to rebuild them)`);
    log(`→ ${write ? 'writing' : 'checking'} ${targets.length} recipe(s)…`);

    const claimed = new Set();
    const summary = { built: 0, written: 0, refused: [], failed: [] };
    for (const [n, id] of targets.entries()) {
      const tag = `[${n + 1}/${targets.length}] ${id}`;
      let r;
      try {
        r = buildOne(id, engine, foodById, existing, claimed, today);
      } catch (err) {
        log(`\n■ ${id} FAILED: ${err.message}`);
        summary.failed.push(id);
        continue;
      }
      summary.built++;
      if (!write) {
        report(r, foodDesc, 'source');
        if (r.houseErrors.length) {
          log('  WOULD BE REFUSED: breaks the house rules after auto-fix');
          summary.refused.push(id);
        } else if (r.pick.slug) claimed.add(r.pick.slug);
        continue;
      }
      for (const f of r.fixes) log(`${tag} fixed: ${f}`);
      if (r.houseErrors.length) {
        log(`${tag} REFUSED: breaks the house rules after auto-fix`);
        for (const e of r.houseErrors) log(`    ${e.code}: ${e.message}`);
        summary.refused.push(id);
        continue;
      }
      if (!r.pick.slug) {
        log(`${tag} REFUSED: ${r.pick.reason}`);
        summary.refused.push(id);
        continue;
      }
      const mdPath = path.join(RECIPES, `${r.pick.slug}.md`);
      if (!r.pick.replaces && existsSync(mdPath)) {
        log(`${tag} REFUSED: ${path.relative(ROOT, mdPath)} exists`);
        summary.refused.push(id);
        continue;
      }
      claimed.add(r.pick.slug);
      writeFileSync(mdPath, engine.markdown.toRecipeMarkdown(r.draft));
      summary.written++;
      log(`${tag} wrote ${path.relative(ROOT, mdPath)}`);
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
