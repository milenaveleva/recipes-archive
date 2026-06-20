import type { CollectionEntry } from 'astro:content';

export type Recipe = CollectionEntry<'recipes'>;
export type Tone = 'good' | 'mid' | 'bad' | 'unknown';

/** Canonical slug: explicit frontmatter override, else the file id. */
export function recipeSlug(entry: Recipe): string {
  return entry.data.slug ?? entry.id;
}

/* ---- durations (ISO-8601 ⇄ human) ---- */

function durationToMinutes(iso?: string): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    Number(d ?? 0) * 1440 +
    Number(h ?? 0) * 60 +
    Number(min ?? 0) +
    Math.round(Number(s ?? 0) / 60)
  );
}

export function formatDuration(iso?: string): string | null {
  const total = durationToMinutes(iso);
  if (total == null || total <= 0) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

/* ---- number formatting ---- */

/** Round to a sensible precision for display (no false precision). */
export function round(n: number | undefined | null, dp = 0): number | null {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Format a metric weight: grams under 1000, else kg. */
export function formatGrams(g?: number | null): string | null {
  if (g == null) return null;
  if (g >= 1000) return `${round(g / 1000, 2)} kg`;
  return `${round(g, g < 10 ? 1 : 0)} g`;
}

/* ---- score → tone (color band) mapping ----
 * For GI/GL: low values are good. For Nutri-Score: A is good.
 * For inflammation: anti-inflammatory is good.
 */

export function giTone(gi?: number | null): Tone {
  if (gi == null) return 'unknown';
  if (gi <= 55) return 'good';
  if (gi <= 69) return 'mid';
  return 'bad';
}

export function glTone(gl?: number | null): Tone {
  if (gl == null) return 'unknown';
  if (gl <= 10) return 'good';
  if (gl <= 19) return 'mid';
  return 'bad';
}

export function nutriTone(grade?: string | null): Tone {
  if (!grade) return 'unknown';
  if (grade === 'A' || grade === 'B') return 'good';
  if (grade === 'C') return 'mid';
  return 'bad';
}

export function inflammationTone(band?: string | null): Tone {
  if (!band) return 'unknown';
  if (band.includes('anti')) return 'good';
  if (band === 'neutral') return 'mid';
  return 'bad';
}

export function inflammationLabel(band?: string | null): string {
  if (!band) return '—';
  return band
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join('-')
    .replace('Inflammatory', 'Inflam.');
}

/* ---- collection helpers ---- */

/** Published recipes (drafts hidden in production), newest first. */
export function visibleRecipes(all: Recipe[]): Recipe[] {
  const isDev = import.meta.env.DEV;
  return all
    .filter((r) => isDev || !r.data.draft)
    .sort((a, b) => {
      const da = a.data.updatedAt ?? a.data.createdAt ?? new Date(0);
      const db = b.data.updatedAt ?? b.data.createdAt ?? new Date(0);
      return db.getTime() - da.getTime();
    });
}

function tally(all: Recipe[], pick: (r: Recipe) => string[]): [string, number][] {
  // Derive counts from slug-deduped groups so cloud chips match the generated
  // term pages exactly — e.g. 'Vegetarian' and 'vegetarian' collapse to one
  // chip linking to one page, rather than two chips pointing at the same URL.
  return groupByTerm(all, pick)
    .map(({ term, recipes }) => [term, recipes.length] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const allTags = (all: Recipe[]) => tally(all, (r) => r.data.tags);
export const allCategories = (all: Recipe[]) =>
  tally(all, (r) => (r.data.category ? [r.data.category] : []));
export const allLists = (all: Recipe[]) => tally(all, (r) => r.data.lists);

/** Group recipes by a (possibly multi-valued) term for term-page generation. */
export function groupByTerm(
  all: Recipe[],
  pick: (r: Recipe) => string[],
): { slug: string; term: string; recipes: Recipe[] }[] {
  const map = new Map<string, { slug: string; term: string; recipes: Recipe[] }>();
  for (const r of all) {
    for (const term of pick(r)) {
      const slug = slugifyTerm(term);
      if (!map.has(slug)) map.set(slug, { slug, term, recipes: [] });
      map.get(slug)!.recipes.push(r);
    }
  }
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}

/** Slugify a tag/category/list value for use in a URL segment. */
export const slugifyTerm = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/**
 * Extract numbered method steps from raw markdown body as step text, for
 * schema.org recipeInstructions. Matches ONLY ordered-list items (`1.`, `2)`)
 * so unordered bullets under a "## Notes" / "## Tips" section are not emitted
 * as cooking steps. Falls back to [] when there is no numbered list.
 */
export function extractSteps(body?: string): string[] {
  if (!body) return [];
  const steps: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*\d+[.)]\s+(.*\S)\s*$/.exec(line);
    if (m) steps.push(m[1].replace(/\*\*/g, '').replace(/`/g, '').trim());
  }
  return steps;
}
