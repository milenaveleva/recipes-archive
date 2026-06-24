/**
 * Client-safe search + facet engine for the index page.
 *
 * Pure, framework-agnostic functions over a flat `SearchDoc[]` so they run both
 * at build time (deriving the facet chips) and in the browser (filtering the
 * pre-rendered card grid in place). No Astro/DOM dependencies — the only import
 * is the shared `slugifyTerm`/`inflammationLabel` from recipe.ts (both pure), so
 * facet slugs collapse case/punctuation exactly the way the term pages do.
 *
 * The Astro-coupled builder that turns a recipe collection entry into a
 * `SearchDoc` lives in search-build.ts, kept separate so this module stays out
 * of any accidental build-time-only dependency in the client bundle.
 */
import { slugifyTerm, inflammationLabel } from './recipe';

/** One recipe, flattened to just what search + facets need. */
export interface SearchDoc {
  slug: string;
  // Free-text fields (searched by Fuse).
  title: string;
  description: string;
  ingredients: string[];
  steps: string[];
  // Facet fields.
  tags: string[];
  category: string | null;
  lists: string[];
  cuisine: string | null;
  course: string | null;
  difficulty: string | null;
  giBand: string | null;
  glBand: string | null;
  nutriGrade: string | null;
  inflammationBand: string | null;
  balanceBand: string | null;
}

/** Active facet selection: facet-group key → chosen value slugs. */
export type Selected = Record<string, string[]>;

export interface FacetValue {
  /** Slug used in the DOM data attribute and in `Selected`. */
  value: string;
  /** Human label for the chip (first original term seen for this slug). */
  label: string;
  /** How many recipes carry this value. */
  count: number;
}

export interface FacetGroup {
  key: string;
  label: string;
  /** Primary groups show inline; the rest collapse under the "Filters" disclosure. */
  primary: boolean;
  values: FacetValue[];
}

/** Fuse.js key weights — title matters most, method text least. */
export const FUSE_KEYS = [
  { name: 'title', weight: 3 },
  { name: 'tags', weight: 2 },
  { name: 'description', weight: 1.6 },
  { name: 'ingredients', weight: 1.2 },
  { name: 'category', weight: 1 },
  { name: 'cuisine', weight: 0.8 },
  { name: 'course', weight: 0.8 },
  { name: 'lists', weight: 0.6 },
  { name: 'steps', weight: 0.5 },
] as const;

/** Shorter queries don't filter — one stray letter shouldn't empty the grid. */
export const MIN_QUERY = 2;

/** Single source of truth for the Fuse config, shared by the island and tests. */
export const FUSE_OPTIONS = {
  keys: FUSE_KEYS as unknown as { name: string; weight: number }[],
  threshold: 0.4,
  ignoreLocation: true,
  minMatchCharLength: MIN_QUERY,
};

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "low" | "medium" | "high" → "Low" | … (shared by GI and GL band chips). */
const bandLabel = titleCase;

interface FacetDef {
  key: string;
  label: string;
  primary: boolean;
  /** All values this recipe contributes to the facet (raw, pre-slug). */
  pick: (d: SearchDoc) => string[];
  /** Optional display transform for a raw value. */
  labelOf?: (value: string) => string;
  /** Value slugs in intrinsic order; ordinal groups render this way, not by count. */
  order?: string[];
}

/**
 * The facet groups, in display order. A group is only rendered when at least
 * one recipe carries a value for it, so the toolbar stays clean as the archive
 * grows into (or out of) using a given field.
 */
export const FACET_DEFS: FacetDef[] = [
  { key: 'tag', label: 'Tags', primary: true, pick: (d) => d.tags },
  { key: 'category', label: 'Category', primary: true, pick: (d) => (d.category ? [d.category] : []) },
  { key: 'course', label: 'Course', primary: false, pick: (d) => (d.course ? [d.course] : []), labelOf: titleCase },
  { key: 'cuisine', label: 'Cuisine', primary: false, pick: (d) => (d.cuisine ? [d.cuisine] : []), labelOf: titleCase },
  { key: 'list', label: 'Lists', primary: false, pick: (d) => d.lists },
  { key: 'difficulty', label: 'Difficulty', primary: false, pick: (d) => (d.difficulty ? [d.difficulty] : []), labelOf: titleCase, order: ['easy', 'medium', 'hard'] },
  { key: 'gi', label: 'Glycemic index', primary: false, pick: (d) => (d.giBand ? [d.giBand] : []), labelOf: bandLabel, order: ['low', 'medium', 'high'] },
  { key: 'gl', label: 'Glycemic load', primary: false, pick: (d) => (d.glBand ? [d.glBand] : []), labelOf: bandLabel, order: ['low', 'medium', 'high'] },
  { key: 'nutri', label: 'Nutri-Score', primary: false, pick: (d) => (d.nutriGrade ? [d.nutriGrade] : []), order: ['a', 'b', 'c', 'd', 'e'] },
  { key: 'inflammation', label: 'Inflammation', primary: false, pick: (d) => (d.inflammationBand ? [d.inflammationBand] : []), labelOf: inflammationLabel, order: ['anti-inflammatory', 'mildly-anti-inflammatory', 'neutral', 'mildly-pro-inflammatory', 'pro-inflammatory'] },
  { key: 'balance', label: 'Nutrient balance', primary: false, pick: (d) => (d.balanceBand ? [d.balanceBand] : []), labelOf: titleCase, order: ['excellent', 'high', 'moderate', 'low', 'poor'] },
];

/**
 * Derive the available facet groups (with per-value recipe counts) from the
 * docs. Values collapse by slug (so "Vegetarian"/"vegetarian" are one chip),
 * counted once per recipe, sorted by count then label — mirroring `tally`.
 */
export function facetsOf(docs: SearchDoc[]): FacetGroup[] {
  const groups: FacetGroup[] = [];
  for (const def of FACET_DEFS) {
    const bySlug = new Map<string, FacetValue>();
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const raw of def.pick(doc)) {
        const value = slugifyTerm(raw);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        const existing = bySlug.get(value);
        if (existing) existing.count += 1;
        else bySlug.set(value, { value, label: def.labelOf ? def.labelOf(raw) : raw, count: 1 });
      }
    }
    if (bySlug.size === 0) continue;
    const values = [...bySlug.values()];
    if (def.order) {
      // Ordinal groups (bands, grades, difficulty) read in their intrinsic order.
      const rank = (v: FacetValue) => {
        const i = def.order!.indexOf(v.value);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      values.sort((a, b) => rank(a) - rank(b));
    } else {
      values.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }
    groups.push({ key: def.key, label: def.label, primary: def.primary, values });
  }
  return groups;
}

/**
 * A doc matches the facet selection when, for every group with selected values,
 * the doc carries at least one (OR within a group, AND across groups). Empty
 * selection matches everything.
 */
export function matchesFacets(doc: SearchDoc, selected: Selected): boolean {
  for (const def of FACET_DEFS) {
    const chosen = selected[def.key];
    if (!chosen || chosen.length === 0) continue;
    const docSlugs = def.pick(doc).map(slugifyTerm);
    if (!docSlugs.some((s) => chosen.includes(s))) return false;
  }
  return true;
}

/**
 * Slugs of the docs that pass both the text search and the facets.
 * `textSlugs` is the set of slugs Fuse matched, or null when the query is
 * empty (no text constraint). Pure: the caller runs Fuse and passes the set in.
 */
export function visibleSlugs(
  docs: SearchDoc[],
  textSlugs: ReadonlySet<string> | null,
  selected: Selected,
): string[] {
  return docs
    .filter((d) => (textSlugs === null || textSlugs.has(d.slug)) && matchesFacets(d, selected))
    .map((d) => d.slug);
}
