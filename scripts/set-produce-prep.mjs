#!/usr/bin/env node
/**
 * Mark the fruit and vegetables of blended or juiced recipes with `prep: blended|juiced`
 * (src/core/prep.ts decides which recipes and lines), so the inflammation score counts
 * their sugars as the WHO free-sugar definition does. Idempotent: a line that already
 * carries a `prep` is left as it is. Prints every line it marks, for review.
 *
 * Usage: node scripts/set-produce-prep.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

log('→ compiling src/core/prep.ts…');
const outDir = mkdtempSync(join(tmpdir(), 'recipes-core-'));
try {
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'),
    ['src/core/prep.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
     '--moduleResolution', 'node', '--resolveJsonModule', '--esModuleInterop', '--skipLibCheck'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  run(await import(pathToFileURL(join(outDir, 'core/prep.js')).href));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function run({ recipePrep, takesPrep }) {
  const foods = new Map(['usda-foods', 'japan-foods', 'france-foods', 'custom-foods']
    .flatMap((n) => read(`src/data/${n}.json`)).map((f) => [f.fdcId, f]));
  const dir = join(ROOT, 'src/content/recipes');
  let files = 0;
  let lines = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!fm) continue;
    const data = parseYaml(fm[1]);
    const r = recipePrep(data.course, fm[2]);
    if (!r) continue;
    const { prep, steps } = r;
    // Walk the ingredient list items in the frontmatter text, in order, alongside the parsed list.
    const ings = data.ingredients ?? [];
    const parts = fm[1].split(/(?=^  - raw: )/m);
    let i = 0;
    let touched = false;
    for (let k = 0; k < parts.length; k++) {
      if (!parts[k].startsWith('  - raw: ')) continue;
      const ing = ings[i++];
      if (!ing || ing.excludeFromNutrition || ing.prep || ing.fdcId == null) continue;
      // A garnish served whole on top is not blended.
      if (/\b(to serve|for serving|to garnish|for garnish|garnish|topping|to decorate|extra slices)\b/i.test(`${ing.raw} ${ing.note ?? ''}`)) continue;
      if (!takesPrep(data.course, foods.get(ing.fdcId)?.category, ing.item, steps)) continue;
      // Insert after the item's last indented line (before the next item or section).
      const m = /^((?:  - raw: .*\n)(?:    .*\n)*)/.exec(parts[k]);
      if (!m) continue;
      parts[k] = m[1] + `    prep: ${prep}\n` + parts[k].slice(m[1].length);
      log(`  ${file}: ${ing.raw} → prep: ${prep}`);
      lines++;
      touched = true;
    }
    if (!touched) continue;
    files++;
    if (!DRY) writeFileSync(path, `---\n${parts.join('')}\n---\n${fm[2]}`);
  }
  log(`✓ ${DRY ? 'would mark' : 'marked'} ${lines} line(s) in ${files} recipe(s)`);
}
