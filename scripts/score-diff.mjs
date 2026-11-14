#!/usr/bin/env node
/**
 * Score-change report: compares every recipe's stored `nutrition` block in the working
 * tree against the same file at a git ref (default HEAD) and lists how each dial moved —
 * GI and GL (value + band, GL basis), Nutri-Score grade, nutrient balance, inflammation
 * (score + band), processing band and kcal per serving — then summarises the band
 * transitions across the archive ("GL low→medium: 23 recipes").
 *
 * Dial ratings (1–10, lower is better) come from the site's own `buildScoreDials`
 * (src/lib/recipe.ts, bundled on demand with esbuild into a temp dir), so a "rating move"
 * here is exactly the move a reader sees on the detail page.
 *
 * A stored block without `glBasis` resolves it the way the site does (`glBasisOf`: the
 * recipe's course, else the engine's DEFAULT_GL_BASIS).
 *
 * Report only: it never writes files. Exit code: 0 when the report was produced, 1 when
 * it could not be (bad arguments, unknown ref, bundling failure).
 *
 * Usage: node scripts/score-diff.mjs [--ref <rev>] [--threshold <n>]
 *   --ref <rev>        git revision to compare against (default HEAD)
 *   --threshold <n>    list only dial moves of at least n rating points (kcal rows hidden);
 *                      the band-transition summary always covers every recipe
 *
 * Progress goes to stderr; the table and summary go to stdout, so the output pipes.
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPES = 'src/content/recipes';
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const out = (line = '') => process.stdout.write(line + '\n');

function parseArgs(argv) {
  const opts = { ref: 'HEAD', threshold: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--ref' || a.startsWith('--ref=')) opts.ref = value();
    else if (a === '--threshold' || a.startsWith('--threshold=')) {
      opts.threshold = Number(value());
      if (!Number.isFinite(opts.threshold) || opts.threshold < 0) throw new Error('--threshold must be a number ≥ 0');
    } else if (a === '-h' || a === '--help') {
      out('Usage: node scripts/score-diff.mjs [--ref <rev>] [--threshold <n>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main({ ref, threshold }) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    throw new Error(`git ref "${ref}" not found`);
  }

  log('→ bundling the dial presentation (src/lib/recipe.ts)…');
  const dials = await loadDials();

  log(`→ reading recipes (working tree vs ${ref})…`);
  const now = existsSync(join(ROOT, RECIPES))
    ? readdirSync(join(ROOT, RECIPES)).filter((f) => f.endsWith('.md'))
    : [];
  const then = git('ls-tree', '--name-only', `${ref}:${RECIPES}`).split('\n').filter((f) => f.endsWith('.md'));
  const files = [...new Set([...now, ...then])].sort();

  const rows = [];
  const transitions = new Map();
  const counted = (key) => transitions.set(key, (transitions.get(key) ?? 0) + 1);
  let changedRecipes = 0;
  let added = 0;
  let removed = 0;

  files.forEach((file, i) => {
    if ((i + 1) % 50 === 0 || i + 1 === files.length) log(`  compared ${i + 1}/${files.length}`);
    const slug = file.replace(/\.md$/, '');
    const newText = now.includes(file) ? readFileSync(join(ROOT, RECIPES, file), 'utf8') : null;
    const oldText = then.includes(file) ? git('show', `${ref}:${RECIPES}/${file}`) : null;
    const before = frontmatterOf(oldText);
    const after = frontmatterOf(newText);
    if (!before?.nutrition && !after?.nutrition) return;
    if (!before?.nutrition) { added++; return; }
    if (!after?.nutrition) { removed++; return; }

    const a = snapshot(before, dials);
    const b = snapshot(after, dials);
    let changed = false;
    for (const dial of DIALS) {
      const x = a[dial.key];
      const y = b[dial.key];
      if (x.text === y.text) continue;
      changed = true;
      for (const [label, from, to] of dial.bands(x, y)) if (from !== to) counted(`${label} ${from ?? '—'}→${to ?? '—'}`);
      const move = x.rating != null && y.rating != null ? y.rating - x.rating : null;
      if (threshold > 0 && (move == null || Math.abs(move) < threshold)) continue;
      rows.push([slug, dial.label, x.text, y.text, move == null ? '' : move > 0 ? `+${move}` : String(move)]);
    }
    if (changed) changedRecipes++;
  });

  out(`# Score changes: working tree vs ${ref}${threshold > 0 ? ` (rating moves ≥ ${threshold})` : ''}`);
  out();
  if (rows.length) printTable(['recipe', 'dial', ref, 'working tree', 'Δ rating'], rows);
  else out('(no dial changes' + (threshold > 0 ? ' at this threshold' : '') + ')');
  out();
  out('# Band transitions (all recipes)');
  out();
  const summary = [...transitions.entries()].sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]));
  if (summary.length) for (const [k, n] of summary) out(`${k}: ${n} recipe${n === 1 ? '' : 's'}`);
  else out('(none)');
  out();
  out(`${changedRecipes} recipe(s) changed, ${files.length - changedRecipes - added - removed} unchanged` +
    (added ? `, ${added} new` : '') + (removed ? `, ${removed} removed` : '') + '.');
  log('✓ done');
}

/** The dials compared, each with how to render it and which bands it reports transitions for. */
const DIALS = [
  { key: 'kcal', label: 'kcal/serving', bands: () => [] },
  { key: 'gi', label: 'GI', bands: (x, y) => [['GI', x.band, y.band]] },
  { key: 'gl', label: 'GL', bands: (x, y) => [['GL', x.band, y.band], ['GL basis', x.basis, y.basis]] },
  { key: 'nutri', label: 'Nutri-Score', bands: (x, y) => [['Nutri-Score', x.band, y.band]] },
  { key: 'balance', label: 'Balance', bands: (x, y) => [['Balance', x.band, y.band]] },
  { key: 'inflam', label: 'Inflammation', bands: (x, y) => [['Inflammation', x.band, y.band]] },
  { key: 'processing', label: 'Processing', bands: (x, y) => [['Processing', x.band, y.band]] },
];

/** One recipe's comparable dial values: display text, band and 1–10 rating per dial. */
function snapshot({ nutrition: n, course }, { buildScoreDials, glBasisOf }) {
  const rating = Object.fromEntries(
    buildScoreDials(n, course).map((d) => [d.key, d.present ? Number(d.value) : null]),
  );
  const gly = n.glycemic ?? {};
  const fmt = (v) => (v == null ? '—' : String(v));
  const glBasis = gly.gl != null ? glBasisOf(gly.glBasis, course) : undefined;
  return {
    kcal: { text: fmt(n.perServing?.energyKcal) },
    gi: { text: `${fmt(gly.gi)} (${fmt(gly.giBand)})`, band: gly.giBand, rating: rating.gi },
    gl: {
      text: `${fmt(gly.gl)} (${fmt(gly.glBand)}${glBasis ? `, ${glBasis}` : ''})`,
      band: gly.glBand, basis: glBasis, rating: rating.gl,
    },
    nutri: { text: fmt(n.nutriScore?.grade), band: n.nutriScore?.grade, rating: rating.nutri },
    balance: { text: `${fmt(n.balance?.score)} (${fmt(n.balance?.band)})`, band: n.balance?.band, rating: rating.balance },
    inflam: {
      text: `${fmt(n.inflammation?.score)} (${fmt(n.inflammation?.band)})`,
      band: n.inflammation?.band, rating: rating.inflam,
    },
    processing: { text: fmt(n.processing?.band), band: n.processing?.band, rating: rating.processing },
  };
}

/** The frontmatter fields the report reads: the nutrition block and the course. */
function frontmatterOf(text) {
  if (text == null) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return null;
  const data = parseYaml(fm[1]) ?? {};
  return { nutrition: data.nutrition ?? null, course: data.course ?? null };
}

function printTable(header, rows) {
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (cells) => cells.map((v, c) => v.padEnd(widths[c])).join('  ').trimEnd();
  out(line(header));
  out(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) out(line(r));
}

/** Bundle src/lib/recipe.ts (TS, JSON imports, astro types) into a temp ESM module and import it. */
async function loadDials() {
  const { build } = await import('esbuild');
  const dir = mkdtempSync(join(tmpdir(), 'recipes-dials-'));
  try {
    const outfile = join(dir, 'recipe.mjs');
    await build({
      entryPoints: [join(ROOT, 'src/lib/recipe.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'error',
      define: { 'import.meta.env.DEV': 'false' },
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  await main(parseArgs(process.argv.slice(2)));
  process.exitCode = 0;
} catch (err) {
  log(`✗ score-diff failed: ${err?.message ?? err}`);
  process.exitCode = 1;
}
