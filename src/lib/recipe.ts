import type { CollectionEntry } from 'astro:content';
import { canonicalUnit } from '../core/units';

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

export interface RecipeMetaItem {
  /** Lucide glyph key in META_ICONS (src/lib/icons.ts). */
  icon: 'prep' | 'cook' | 'total' | 'serves' | 'difficulty' | 'cuisine';
  /** Accessible name for the value (the icon itself is decorative). */
  label: string;
  value: string;
}

/** The fields buildRecipeMeta reads — satisfied by both a collection entry's
 * `data` and an authoring RecipeDraft, so all renderers share one source. */
export interface RecipeMetaSource {
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  servings: number;
  difficulty?: string | null;
  cuisine?: string | null;
}

/** The prep/cook/total/serves/difficulty/cuisine summary shown as a Lucide
 * icon + value on the detail page and recipe cards. Times and the optional
 * difficulty/cuisine appear only when set; Serves is always present. Values are
 * display-ready (difficulty is capitalised) so no CSS text-transform is needed. */
export function buildRecipeMeta(data: RecipeMetaSource): RecipeMetaItem[] {
  const prep = formatDuration(data.prepTime);
  const cook = formatDuration(data.cookTime);
  const total = formatDuration(data.totalTime);
  return [
    prep && { icon: 'prep', label: 'Prep', value: prep },
    cook && { icon: 'cook', label: 'Cook', value: cook },
    total && { icon: 'total', label: 'Total', value: total },
    { icon: 'serves', label: 'Serves', value: String(data.servings) },
    data.difficulty && {
      icon: 'difficulty',
      label: 'Difficulty',
      value: data.difficulty[0].toUpperCase() + data.difficulty.slice(1),
    },
    data.cuisine && { icon: 'cuisine', label: 'Cuisine', value: data.cuisine },
  ].filter(Boolean) as RecipeMetaItem[];
}

/** Fields formatIngredientAmount reads — common to a collection ingredient and
 * an authoring DraftIngredient. `item` is the food name, used to spot liquids. */
export interface IngredientAmountSource {
  quantity?: number | null;
  quantity2?: number | null;
  unit?: string | null;
  item?: string | null;
  grams?: number | null;
  milliliters?: number | null;
}

/**
 * Food-name head nouns that mark an ingredient as a liquid (incl. oils), so it
 * displays in ml/L rather than grams. Matched against the LAST word of the name,
 * which is where the liquid identity normally sits ("orange juice", "soy milk",
 * "olive oil", "chicken stock") — so a modifier like "water" in "water chestnut"
 * or "cream" in "cream cheese" doesn't trip it.
 */
const LIQUID_HEADS = new Set([
  'milk', 'buttermilk', 'cream', 'water', 'stock', 'broth', 'bouillon',
  'consomme', 'juice', 'wine', 'beer', 'ale', 'lager', 'cider', 'sake',
  'mirin', 'liquor', 'liqueur', 'vinegar', 'sauce', 'oil', 'syrup', 'soda',
  'brine', 'dashi', 'kombucha', 'kefir', 'coffee', 'tea', 'vermouth',
  'brandy', 'rum', 'vodka', 'whiskey', 'whisky', 'gin', 'champagne', 'prosecco',
]);

/** Whether an ingredient name reads as a liquid (its head noun is a liquid). */
function isLiquid(name?: string | null): boolean {
  if (!name) return false;
  // Drop any parenthetical/alternative descriptor so the head noun is the food
  // itself ("heavy cream (sub milk)" → cream, "soy milk / oat milk" → milk),
  // then match the last word.
  const cleaned = name.replace(/\([^)]*\)/g, ' ').split(/[,/]/)[0];
  const tokens = cleaned.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const head = tokens[tokens.length - 1];
  if (!head) return false;
  const singular = head.length > 3 && head.endsWith('s') ? head.slice(0, -1) : head;
  return LIQUID_HEADS.has(head) || LIQUID_HEADS.has(singular);
}

/**
 * The amount shown beside an ingredient, the way a cook reads it: teaspoons and
 * tablespoons keep their spoon measure ("1 tbsp"); a liquid (any drink, broth,
 * juice, oil, etc., recognised by its name) or anything metered in a metric
 * volume shows ml/L; everything else shows its metric weight in grams/kg. A
 * non-liquid measured by an imperial volume like "cups" with no weight falls
 * back to its written amount ("1½ cups") — cups measure solids too, so a bare
 * volume conversion would be meaningless. Grams remain the basis for ALL
 * nutrition math regardless of what's shown. Returns null when no amount is
 * known, so the caller can fall back to the raw line.
 */
export function formatIngredientAmount(ing: IngredientAmountSource): string | null {
  const qtyText = () =>
    ing.quantity2 != null
      ? `${round(ing.quantity!, 2)}–${round(ing.quantity2, 2)}`
      : `${round(ing.quantity!, 2)}`;

  const canon = canonicalUnit(ing.unit);
  if ((canon === 'teaspoon' || canon === 'tablespoon') && ing.quantity != null) {
    return `${qtyText()} ${canon === 'tablespoon' ? 'tbsp' : 'tsp'}`;
  }
  // Liquids (recognised by name) and anything written in a metric volume show
  // ml/L; a cup of a dry good is NOT a liquid and falls through to weight.
  const metricVolume =
    canon === 'milliliter' ||
    canon === 'centiliter' ||
    canon === 'deciliter' ||
    canon === 'liter';
  if (ing.milliliters != null && ing.milliliters > 0 && (metricVolume || isLiquid(ing.item))) {
    return formatMilliliters(ing.milliliters);
  }
  if (ing.grams != null && ing.grams > 0) return formatGrams(ing.grams);
  if (ing.quantity != null) return ing.unit ? `${qtyText()} ${ing.unit}` : qtyText();
  return null;
}

/* ---- number formatting ---- */

/** Round to a sensible precision for display (no false precision). */
export function round(n: number | undefined | null, dp = 0): number | null {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Round a displayed metric amount: anything over 10 g/ml snaps to the nearest
 * 10 (so "196 g" reads "200 g", "34 g" reads "30 g") — recipe weights don't
 * warrant single-gram precision — while a value at or under 10 keeps its exact
 * figure, since small doses ("4.5 g") would be distorted by coarsening. Whole
 * spoon measures bypass this (formatIngredientAmount handles tsp/tbsp first).
 */
function roundMetric(v: number): number {
  return v > 10 ? Math.round(v / 10) * 10 : (round(v, 1) ?? v);
}

/** Format a metric weight: grams under 1000, else kg (rounded per roundMetric). */
export function formatGrams(g?: number | null): string | null {
  if (g == null) return null;
  const v = roundMetric(g);
  return v >= 1000 ? `${round(v / 1000, 2)} kg` : `${v} g`;
}

/** Format a metric liquid volume: millilitres under 1000, else litres (rounded per roundMetric). */
function formatMilliliters(ml: number): string {
  const v = roundMetric(ml);
  return v >= 1000 ? `${round(v / 1000, 2)} L` : `${v} ml`;
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

/** Nutrient-balance (1–10) tone: 7–10 good, 4–6 mid, 1–3 bad. */
export function balanceTone(score?: number | null): Tone {
  if (score == null) return 'unknown';
  if (score >= 7) return 'good';
  if (score >= 4) return 'mid';
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
  key: 'gi' | 'gl' | 'nutri' | 'balance' | 'inflam';
  label: string;
  /** One-line explanation of what the score measures, shown as a hover/focus tooltip. */
  blurb: string;
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
      balance?: { score?: number | null; band?: string | null } | null;
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
  const bal = nutrition?.balance ?? undefined;
  const grade = nutri?.grade ?? null;
  return [
    {
      key: 'gi',
      label: 'Glycemic Index',
      blurb:
        'How quickly this dish’s carbohydrate raises blood glucose (0–100, glucose = 100), carb-weighted from published values. An estimate that tends to read high for mixed meals.',
      value: gly?.gi != null ? String(Math.round(gly.gi)) : '—',
      sub: gly?.giBand || undefined,
      scaleRef: '0–100',
      tone: giTone(gly?.gi),
      fill: giFill(gly?.gi),
    },
    {
      key: 'gl',
      label: 'Glycemic Load',
      blurb:
        'Glycemic index scaled by the available carbohydrate in one serving — the total blood-glucose impact of a portion, not just its speed. Low ≤10, high ≥20.',
      value: gly?.gl != null ? String(Math.round(gly.gl)) : '—',
      sub: gly?.glBand || undefined,
      scaleRef: 'per serving',
      tone: glTone(gly?.gl),
      fill: glFill(gly?.gl),
    },
    {
      key: 'nutri',
      label: 'Nutrition Score',
      blurb:
        'Nutri-Score 2023 (A–E): fibre, protein and fruit/vegetables/legumes weighed against energy, sugar, saturated fat and salt. Built for packaged products, applied to the dish as an estimate.',
      value: grade ?? '—',
      sub: nutri ? 'Nutri-Score' : undefined,
      tone: nutriTone(grade),
      fill: 1,
      grades: nutriGrades,
      activeGrade: grade ? nutriGrades.indexOf(grade as (typeof nutriGrades)[number]) : -1,
    },
    {
      key: 'balance',
      label: 'Nutrient Balance',
      blurb:
        'Nutrient density (NRF9.3, 1–10): nine nutrients to encourage — protein, fibre, vitamins, minerals — minus three to limit (saturated fat, sugar, sodium), per 100 kcal.',
      value: bal?.score != null ? String(bal.score) : '—',
      sub: bal?.band || undefined,
      scaleRef: '1–10',
      tone: balanceTone(bal?.score),
      fill: bal?.score != null ? clamp01(bal.score / 10) : 0,
    },
    {
      key: 'inflam',
      label: 'Inflammation',
      blurb:
        'Food Inflammation Index (−2 anti to +2 pro): inflammatory potential from fat quality, fibre, antioxidants and polyphenols, energy-weighted across the dish. An estimate, not a clinical measure.',
      value: inflam?.score != null ? (inflam.score > 0 ? `+${inflam.score}` : String(inflam.score)) : '—',
      sub: inflam ? inflammationLabel(inflam.band) : undefined,
      scaleRef: '−2 … +2',
      tone: inflammationTone(inflam?.band),
      fill: inflammationFill(inflam?.score),
    },
  ];
}

/** Whether a nutrition block carries any of the scored figures. */
export function hasAnyScore(nutrition: NutritionLike): boolean {
  return !!(
    nutrition?.glycemic ||
    nutrition?.nutriScore ||
    nutrition?.inflammation ||
    nutrition?.balance
  );
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
