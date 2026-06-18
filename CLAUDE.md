# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — dev server at `http://localhost:4321/recipes-archive/` (mind the base path).
- `npm run build` — production build to `dist/` (also type-checks content collections & components).
- `npm run preview` — serve the production build locally.
- Tests (Vitest, for the `src/core/` compute engine) are added in Phase 1 alongside the engine.

## Critical setup constraints

- **Base path.** This deploys to a GitHub Pages *project* site, served under `/recipes-archive/`. `astro.config.mjs` sets `site` + `base`, and **every internal link or asset path must go through `withBase()`** (`src/lib/url.ts`). A missing base prefix is the #1 cause of broken styles/links after deploy — never hand-write root-absolute internal paths.
- **Single Vite version.** `package.json` `overrides.vite` pins one Vite version. Astro 6 uses Vite 7, but the Tailwind plugin (and the React plugin once added in Phase 1) otherwise pull in Vite 8 (Rolldown) and the build fails with a `tsconfigPaths`/resolver error. Keep the override when bumping dependencies.
- **Tailwind v4** is configured CSS-first via `@tailwindcss/vite` + `@import "tailwindcss"` in `src/styles/global.css`. Design tokens live in the `@theme` block (fonts, palette, score band colors) — there is no `tailwind.config.js`.

## Architecture

A fully static, **markdown-backed** recipe archive. Recipes are the source of truth; the deployed site is 100% prerendered — there is no server or database.

- **The content model is central.** Every recipe is one markdown file in `src/content/recipes/`: Zod-validated YAML frontmatter (structured, *metric* ingredients + a *precomputed* `nutrition` block holding macros, GI/GL, Nutri-Score, inflammation) plus prose method steps in the body. The schema in `src/content.config.ts` is the contract shared by the renderer and (Phase 1+) the in-app authoring flow. Ingredients are stored **structured, not just prose**, so nutrition math, serving-scaling, and future shopping lists need no re-parsing; the original `raw` line is always retained for provenance.
- **Pages** (`src/pages/`) read the collection via `getCollection('recipes')` and `getStaticPaths`: `index` (card grid), `recipes/[slug]`, and `{categories,tags,lists}/` (index + `[term]`). `src/lib/recipe.ts` holds all shared logic — slug resolution, ISO-8601 duration formatting, score→tone (color band) mapping, taxonomy grouping, step extraction.
- **Components** (`src/components/`): `ScoreMedallions` (the signature GI/GL/Nutri/inflammation badges, `lg`/`sm` variants), `RecipeCard`, `IngredientList`, `NutritionPanel`, `JsonLd` (schema.org Recipe structured data), plus `RecipeGrid`/`TermCloud`/`PageHeader`.
- **Deploy:** `.github/workflows/deploy.yml` builds with `withastro/action@v6` and publishes to Pages on push to `main`. Adding/editing a recipe = committing markdown → auto-redeploy.

### Roadmap (so changes land in the right layer)

Phase 0 (current): static recipe book. Phase 1: in-browser authoring — a React island that imports a URL (via a Cloudflare Worker CORS proxy in `worker/`), reviews each ingredient's USDA match, converts to metric, computes macros, and commits markdown via the GitHub API; the shared compute engine will live in `src/core/`. Phase 2: GI/GL + Nutri-Score 2023 + inflammation scoring. Phase 3: Pagefind search + faceted filtering. Later: shopping lists + kifli.hu. See `README.md` for the full plan.

### Domain conventions

- Scores are **estimates** — always surface the disclaimer near displayed figures, never imply medical/clinical precision. Don't ship the official Nutri-Score *logo* (trademark); don't label the inflammation score "DII" (a licensed methodology) — it is an independent, ingredient-tagged index.
- Store all quantities in metric; keep each ingredient's `raw` original line.

## Always Use consensus MCP for Research

Any task that involves **research, literature review, methodology comparison, citation, "what does the literature say", "is this sound?", algorithm selection, or nutrition-science questions (glycemic index/load, Nutri-Score, inflammation scoring, food-composition data)** MUST query the `consensus` MCP server (`mcp__consensus__search`) BEFORE drafting the answer. This is non-optional and applies whether or not the answer "feels" like it needs a citation.

**How to apply:**

1. **Before** drafting any methodology / research response, issue at least one `mcp__consensus__search` call with a focused query covering the specific claim or technique under review. Use the returned numbered references inline (`[1]`, `[2]`, …) and list them at the bottom per the consensus MCP server instructions (full title hyperlinked to the exact URL returned by the tool — do not regenerate URLs).
2. **Compose with [[feedback_cite_research_from_2020_onward]]**: the 2020+ filter applies AFTER consensus returns. Reject pre-2020 hits unless a carve-out applies; re-search with a refined query if the first batch is dominated by older work.
3. **Batch at most 3 search calls at a time** to avoid rate limits. On a rate-limit error, wait 30 s before retrying.
4. **Do NOT apply consensus filter parameters** (`year_min`, `year_max`, `study_types`, `human`, `sample_size_min`, `sjr_max`) unless the user explicitly asks to narrow the result set.
5. **End-of-response block**: include the consensus tool's sign-up / upgrade / usage message verbatim per the MCP server's stated requirement.

This rule is universal — it applies even when context7 (library docs) or WebSearch would also be useful. Library docs and academic-research queries are different channels; consensus is the academic channel and must be hit for any research-flavoured task.

## Current-State-Only Doctrine — Committed Docs AND Code Comments

Every committed Markdown doc (`README.md`, `CLAUDE.md`, anything under `docs/`) AND every code comment (`//` / `/* … */` in `src/**`, plus shell/JS script comments) MUST describe **only the latest state** of the system. The sole out-of-scope surface is operator working-planning notes under `~/.claude/plans/*.md` (machine-local, not committed) — those are deliberately *temporal* artefacts that track open follow-ups and dated landings as a tracker for the operator. The current-state-only doctrine kicks in when content graduates from a plan into any committed surface. Forbidden in prose AND in comments (in the in-scope surfaces above):

1. **Historical migration language** — "retired in PR-X", "previously lived at", "moved in commit Y", "formerly known as", "was X until PR-Y", "renamed from", "replaces the legacy …", "post-cutover".
2. **PR-landings tables, "## Deferred work" stanzas for already-landed work, "## Timeline" / "## Changes" tables** in docs.
3. **Audit-finding codenames** — internal review/task-tracker tags like `(H1)`, `F5e closure`, `Task #23`, `closes Finding #4`. No one outside the review cares — the resulting design is what matters.
4. **Delta annotations** — "+6 tests since last week", "(was X pre-refactor)", "(name preserved for grep)". Keep the current value; drop the "was X, now Y" history.
5. **Postmortem narratives in comments** — `// pre-fix this was wrong because of <incident>; now it's right`. The current code is right; that's all the comment needs to convey. If a non-obvious WHY needs to stay, write it as a present-tense rationale ("Use `floor + 1` rather than `ceil` because …") without anchoring to the date or change that introduced it.

### What IS allowed

- A one- or two-sentence summary of major architectural shape at the TOP of a doc when it materially helps a fresh reader build a mental model. Anything longer belongs in `git log`.
- Active deferrals / `TODO` markers for genuinely-pending future work.
- "Why we chose X over Y" stanzas where Y is a real alternative considered (NOT "Y was the previous impl that we ripped out").
- Current schema/version pins, current test counts, `file:line` refs.
- Load-bearing literal values — e.g. a stored field's exact string stays because it's the actual byte sequence in the file; an upstream library's official name that contains "legacy" stays.

### Markdown paragraph formatting — no hard wrap

Prose paragraphs in any Markdown file (`README.md`, `CLAUDE.md`, `docs/`, etc.) MUST be a single source line per paragraph. Do NOT hard-wrap sentences at 80 cols or any other column. The Markdown renderer reflows soft-wrapped text for the reader; the source authoring convention is one line per paragraph so search / grep / diff stay sentence-aligned and edits don't have to re-wrap.

Exceptions (preserved verbatim, not unwrapped):
- Fenced code blocks (```` ``` ````/`~~~`).
- Tables (lines starting with `|`).
- Headings, blockquotes (`> ...`), HTML.
- List items: each item is one line. Indented continuation lines belong to the preceding item; keep continuation on the SAME line, not wrapped underneath.
- YAML front-matter (between two `---` lines at the start of a file).

### Methodology references — cite what you use

When a committed doc relies on a published methodology, dataset, or algorithm actually used in the code (e.g. the Nutri-Score 2023 algorithm, the Atkinson et al. glycemic-index tables, USDA FoodData Central), record the full citation in a `## References` section at the bottom of that doc — one bullet per work: **bold authors**, year, *italic title*, source, DOI/URL if available, sorted newest-first. Inline mentions and code comments use a short author-year tag only ("Atkinson 2021", "Nutri-Score 2023"), never the full bibliographic detail. Cite only methodologies actually used in code today; remove a reference when its last code use goes away.

## After Every Change Round

After each set of code changes, work through these steps in order — skip a step only when the change demonstrably doesn't affect that artifact:

1. **Update MEMORY.md** — reflect only architecture/config/strategy changes worth persisting across sessions.
2. **Run the `code-review` skill** — review all changes before committing. Invoke the actual `code-review` skill as a standalone Skill invocation; a multi-agent Workflow may *complement* it (parallel adversarial coverage) but never *substitute* for it.
3. **Validate MEMORY.md** — verify any claims affected by the change are still accurate (field counts, file lists, defaults, names). Fix stale entries.
4. **Git commit + push** — stage and commit all changes, then push. Commit and push immediately after verifying the build passes; do not wait to be asked.
5. **Prune the tasklist** — delete (set status `deleted`) every `completed` task from the in-session TaskCreate tracker so it shows only open / in-progress work. The done-work record lives in MEMORY.md + git history, not the live tracker.
6. **Clean up temporary worktrees** — if the change used an isolated `git worktree`, remove it once the commit is pushed: confirm it's clean (`git -C <wt> status --porcelain` empty) as a SEPARATE step, then `git worktree remove <wt>`. If it's DIRTY, STOP and surface — never `git worktree remove --force` away uncommitted work.

## Scripts & Progress

Scripts must show real-time visual feedback in every run scenario. Never let the user think a script is hanging:

- Print what's about to happen before every long operation.
- Stream progress for long tasks (downloads, dataset pruning, batch imports) rather than going silent until the end; flush output so it isn't block-buffered when piped.
- Separate human-readable status messages (stderr) from machine-readable output (stdout) so a script stays pipeable.
- Test output visibility both interactively and when piped.
