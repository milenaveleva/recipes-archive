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

/* ---- score dials (value → position on its reference scale) ----
 * Each medallion is a ring that fills to where the value sits on its scale, so a
 * bare number is interpretable at a glance ("64 out of 100", not just "64"). The
 * fill is oriented so an EMPTIER ring always means healthier — lower GI/GL, more
 * anti-inflammatory. Nutri-Score is categorical, so it shows an A–E strip with
 * the grade lit instead of a partial fill (its ring is drawn full).
 */

/** Glycemic load has no fixed maximum; the dial saturates here (≥ this reads "high"). */
export const GL_DIAL_MAX = 20;
/** Nutri-Score grades, best → worst, for the A–E strip. */
export const nutriGrades = ['A', 'B', 'C', 'D', 'E'] as const;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Tone → Tailwind text color (ring arc, accents). Shared so the three renderers
 *  can't drift; the literal class strings keep them in Tailwind's content scan. */
export const toneText: Record<Tone, string> = {
  good: 'text-band-good',
  mid: 'text-band-mid',
  bad: 'text-band-bad',
  unknown: 'text-line-strong',
};
/** Tone → Tailwind background color (grade cell, status dot). */
export const toneBg: Record<Tone, string> = {
  good: 'bg-band-good',
  mid: 'bg-band-mid',
  bad: 'bg-band-bad',
  unknown: 'bg-line-strong',
};

/** Ring fill (0..1) for the glycemic index on its 0–100 scale. */
export function giFill(gi?: number | null): number {
  return gi == null ? 0 : clamp01(gi / 100);
}
/** Ring fill (0..1) for the glycemic load, saturating at `GL_DIAL_MAX`. */
export function glFill(gl?: number | null): number {
  return gl == null ? 0 : clamp01(gl / GL_DIAL_MAX);
}
/** Ring fill (0..1) for inflammation across its −2 (most anti) … +2 (most pro) range. */
export function inflammationFill(score?: number | null): number {
  return score == null ? 0 : clamp01((score + 2) / 4);
}

export interface ScoreDial {
  key: 'gi' | 'gl' | 'nutri' | 'inflam';
  label: string;
  /** Display value, e.g. "64", "C", "-0.8", or "—" when absent. */
  value: string;
  /** Band word / qualifier shown under the label (CSS-capitalized). */
  sub?: string;
  /** Reference scale or basis shown beneath ring metrics, e.g. "0–100" or "per serving". */
  scaleRef?: string;
  tone: Tone;
  /** Ring fill 0..1 (1 = full ring, used for the categorical Nutri-Score). */
  fill: number;
  /** Present only for Nutri-Score → render an A–E strip rather than `scaleRef`. */
  grades?: readonly string[];
  /** Index into `grades` of the active grade (−1 when none). */
  activeGrade?: number;
}

/** Minimal structural shape shared by the collection entry and the authoring draft. */
type NutritionLike =
  | {
      glycemic?: {
        gi?: number | null;
        gl?: number | null;
        giBand?: string | null;
        glBand?: string | null;
      } | null;
      nutriScore?: { grade?: string | null } | null;
      inflammation?: { score?: number | null; band?: string | null } | null;
    }
  | null
  | undefined;

/**
 * Build the four score dials from a nutrition block — the single source of the
 * value/tone/fill logic shared by the Astro detail page, the React edit preview,
 * and the authoring panel (so the three renderers never drift).
 */
export function buildScoreDials(nutrition: NutritionLike): ScoreDial[] {
  const gly = nutrition?.glycemic ?? undefined;
  const nutri = nutrition?.nutriScore ?? undefined;
  const inflam = nutrition?.inflammation ?? undefined;
  const grade = nutri?.grade ?? null;
  return [
    {
      key: 'gi',
      label: 'Glycemic Index',
      value: gly?.gi != null ? String(Math.round(gly.gi)) : '—',
      sub: gly?.giBand || undefined,
      scaleRef: '0–100',
      tone: giTone(gly?.gi),
      fill: giFill(gly?.gi),
    },
    {
      key: 'gl',
      label: 'Glycemic Load',
      value: gly?.gl != null ? String(Math.round(gly.gl)) : '—',
      sub: gly?.glBand || undefined,
      scaleRef: 'per serving',
      tone: glTone(gly?.gl),
      fill: glFill(gly?.gl),
    },
    {
      key: 'nutri',
      label: 'Nutrition Score',
      value: grade ?? '—',
      sub: nutri ? 'Nutri-Score' : undefined,
      tone: nutriTone(grade),
      fill: 1,
      grades: nutriGrades,
      activeGrade: grade ? nutriGrades.indexOf(grade as (typeof nutriGrades)[number]) : -1,
    },
    {
      key: 'inflam',
      label: 'Inflammation',
      value: inflam?.score != null ? (inflam.score > 0 ? `+${inflam.score}` : String(inflam.score)) : '—',
      sub: inflam ? inflammationLabel(inflam.band) : undefined,
      scaleRef: '−2 … +2',
      tone: inflammationTone(inflam?.band),
      fill: inflammationFill(inflam?.score),
    },
  ];
}

/** Whether a nutrition block carries any of the three scored figures. */
export function hasAnyScore(nutrition: NutritionLike): boolean {
  return !!(nutrition?.glycemic || nutrition?.nutriScore || nutrition?.inflammation);
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
