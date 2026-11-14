#!/usr/bin/env node
/**
 * Ingredient-data validation gate over every recipe: runs the shared validator
 * (src/core/validate.ts, compiled to CommonJS on demand like scripts/rescore-recipes.mjs)
 * and prints a grouped report — errors first, then warnings — to stdout, with progress on
 * stderr. Errors listed in src/data/validation-allowlist.json (recipe slug + code) are
 * reported as allowed and do not fail the run.
 *
 * Usage: node scripts/validate-recipes.mjs [--json <path>] [--quiet-warnings]
 *   --json <path>       also write a machine-readable report (per-recipe issues + counts)
 *   --quiet-warnings    print only errors (warnings still counted and written to --json)
 * Exit code: 1 when any non-allowlisted error is found, else 0.
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
const outDir = mkdtempSync(join(tmpdir(), 'recipes-validate-'));
let exitCode = 0;
try {
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/validate.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
     '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const core = await import(pathToFileURL(join(outDir, 'core/validate.js')).href);
  exitCode = run(core.default ?? core);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(exitCode);

function run({ validateRecipe }) {
  log('→ loading food data…');
  const foods = read('src/data/usda-foods.json');
  const foodById = new Map(foods.map((f) => [f.fdcId, f]));
  const allow = new Set(read('src/data/validation-allowlist.json').map((a) => `${a.slug}|${a.code}`));

  const dir = join(ROOT, 'src/content/recipes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  log(`→ validating ${files.length} recipes…`);
  const recipes = [];
  files.forEach((file, i) => {
    if (i % 50 === 0) log(`  ${i}/${files.length}`);
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, file), 'utf8'));
    if (!fm) return;
    const data = parseYaml(fm[1]);
    const slug = data.slug ?? file.replace(/\.md$/, '');
    const { errors, warnings } = validateRecipe(data, foodById);
    const tag = (i) => ({ ...i, allowed: allow.has(`${slug}|${i.code}`) });
    if (errors.length || warnings.length) {
      recipes.push({ slug, title: data.title, errors: errors.map(tag), warnings });
    }
  });
  log(`  ${files.length}/${files.length}`);

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
