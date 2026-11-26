#!/usr/bin/env node
/**
 * Ingredient-data validation gate over every recipe: runs the shared validator
 * (src/core/validate.ts, compiled to CommonJS on demand like scripts/rescore-recipes.mjs)
 * and prints a grouped report — errors first, then warnings — to stdout, with progress on
 * stderr. Errors listed in src/data/validation-allowlist.json (recipe slug + code) are
 * reported as allowed and do not fail the run. Each recipe's markdown body feeds the house
 * rules' meat-suggestion check, and the corpus-wide DUPLICATE_RECIPE warning
 * (src/core/houseRules.ts `findDuplicateRecipes`) pairs near-identical recipes and flags any
 * kifli id listed in scripts/kifli/excluded-ids.json.
 *
 * Usage: node scripts/validate-recipes.mjs [--json <path>] [--quiet-warnings]
 *   --json <path>       also write a machine-readable report (per-recipe issues + counts)
 *   --quiet-warnings    print only errors (warnings still counted and written to --json)
 * Exit code: 1 when any non-allowlisted error is found, else 0.
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const out = (s = '') => process.stdout.write(s + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
if (jsonIdx >= 0 && !jsonPath) {
  log('--json needs a path');
  process.exit(2);
}
const quietWarnings = args.includes('--quiet-warnings');

log('→ compiling validator (src/core) to CommonJS…');
// Compiled under node_modules/.cache so the output resolves the engine's npm imports
// (parse-ingredient, read by the house rules' line parser).
const cacheDir = join(ROOT, 'node_modules/.cache');
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, 'recipes-validate-'));
let exitCode = 0;
try {
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/validate.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
     '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const core = await import(pathToFileURL(join(outDir, 'core/validate.js')).href);
  const house = await import(pathToFileURL(join(outDir, 'core/houseRules.js')).href);
  exitCode = run(core.default ?? core, house.default ?? house);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(exitCode);

function run({ validateRecipe }, { findDuplicateRecipes }) {
  log('→ loading food data…');
  const foods = read('src/data/usda-foods.json');
  const foodById = new Map(foods.map((f) => [f.fdcId, f]));
  const allow = new Set(read('src/data/validation-allowlist.json').map((a) => `${a.slug}|${a.code}`));

  const dir = join(ROOT, 'src/content/recipes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  log(`→ validating ${files.length} recipes…`);
  const excluded = read('scripts/kifli/excluded-ids.json').ids;
  const kifliId = (url) => Number(/kifli\.hu\/sef\/(\d+)/.exec(url ?? '')?.[1]) || null;
  const recipes = [];
  const bySlug = new Map();
  const corpus = [];
  files.forEach((file, i) => {
    if (i % 50 === 0) log(`  ${i}/${files.length}`);
    const text = readFileSync(join(dir, file), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!fm) return;
    const data = parseYaml(fm[1]);
    const slug = data.slug ?? file.replace(/\.md$/, '');
    const { errors, warnings } = validateRecipe({ ...data, body: fm[2] }, foodById);
    const tag = (i) => ({ ...i, allowed: allow.has(`${slug}|${i.code}`) });
    const entry = { slug, title: data.title, errors: errors.map(tag), warnings };
    bySlug.set(slug, entry);
    corpus.push({ slug, kifliId: data.source?.name === 'kifli.hu' ? kifliId(data.source?.url) : null, ingredients: data.ingredients });
  });
  log(`  ${files.length}/${files.length}`);
  log('→ checking for near-duplicate recipes…');
  for (const { slug, issue } of findDuplicateRecipes(corpus, corpus, excluded)) {
    const { severity, ...rest } = issue;
    bySlug.get(slug).warnings.push(rest);
  }
  for (const r of bySlug.values()) if (r.errors.length || r.warnings.length) recipes.push(r);

  const counts = { errors: {}, warnings: {}, allowedErrors: {} };
  let failing = 0;
  for (const r of recipes) {
    for (const e of r.errors) {
      const bucket = e.allowed ? counts.allowedErrors : counts.errors;
      bucket[e.code] = (bucket[e.code] ?? 0) + 1;
    }
    for (const w of r.warnings) counts.warnings[w.code] = (counts.warnings[w.code] ?? 0) + 1;
    if (r.errors.some((e) => !e.allowed)) failing++;
  }

  const section = (title, pick) => {
    const rows = recipes.filter((r) => pick(r).length);
    if (!rows.length) return;
    out(`== ${title} (${rows.length} recipes) ==`);
    for (const r of rows) {
      out(`\n${r.slug}`);
      for (const i of pick(r)) out(`  [${i.code}]${i.allowed ? ' (allowed)' : ''} ${i.message}`);
    }
    out();
  };
  section('ERRORS', (r) => r.errors);
  if (!quietWarnings) section('WARNINGS', (r) => r.warnings);

  const line = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  out('== SUMMARY ==');
  out(`recipes checked: ${files.length}; recipes with errors: ${failing}`);
  out(`errors:   ${line(counts.errors)}`);
  out(`allowed:  ${line(counts.allowedErrors)}`);
  out(`warnings: ${line(counts.warnings)}`);

  if (jsonPath) {
    const target = resolve(process.cwd(), jsonPath);
    writeFileSync(target, JSON.stringify({ checked: files.length, failing, counts, recipes }, null, 2) + '\n');
    log(`→ wrote ${target}`);
  }
  return failing ? 1 : 0;
}
