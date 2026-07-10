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

/* ---- score normalization: every metric → a 1–10 rating ----
 * The six scores live on different native scales (GI 0–100, GL 0–20+, Nutri A–E,
 * NRF 1–10, inflammation −2…+2, processing %). To read as one coherent wall they
 * are each normalized to a 1–10 rating where 1 = healthiest and 10 = least healthy
 * — lower is always better. Each metric's own good/medium/high bands land on
 * 1–3 / 4–6 / 7–10, so the shared `ratingTone` colour always agrees with the number,
 * and the ring fills with the rating (empty + green = great, full + red = poor). The
 * two "more is better" metrics — Nutri-Score and nutrient balance — are inverted onto
 * the same scale. Raw values are kept for display, not discarded.
 */

const clampRating = (n: number): number => Math.min(10, Math.max(1, Math.round(n)));

/** 1–10 rating → tone. One banding for every dial: 1–3 good, 4–6 moderate, 7–10 poor. */
export function ratingTone(rating?: number | null): Tone {
  if (rating == null) return 'unknown';
  if (rating <= 3) return 'good';
  if (rating <= 6) return 'mid';
  return 'bad';
}

/** Glycemic index → 1–10 (low ≤55 → 1–3, medium 56–69 → 4–6, high ≥70 → 7–10). */
export function giRating(gi?: number | null): number | null {
  if (gi == null) return null;
  if (gi <= 55) return clampRating(1 + (gi / 55) * 2);
  if (gi <= 69) return clampRating(4 + ((gi - 55) / 14) * 2);
  return clampRating(7 + ((gi - 69) / 31) * 3);
}

/** Glycemic load → 1–10 (low ≤10 → 1–3, medium 11–19 → 4–6, high ≥20 → 7–10). */
export function glRating(gl?: number | null): number | null {
  if (gl == null) return null;
  if (gl <= 10) return clampRating(1 + (gl / 10) * 2);
  if (gl <= 19) return clampRating(4 + ((gl - 10) / 9) * 2);
  return clampRating(7 + ((gl - 19) / 11) * 3);
}

/** Inflammation index (−2 anti … +2 pro) → 1–10, most anti-inflammatory = best. */
export function inflammationRating(score?: number | null): number | null {
  if (score == null) return null;
  return clampRating(1 + ((score + 2) / 4) * 9);
}

/** Nutrient balance (NRF 1–10, higher better) → 1–10 concern, inverted so denser = better. */
export function balanceRating(score?: number | null): number | null {
  if (score == null) return null;
  return clampRating(11 - score);
}

/** Nutri-Score grade → 1–10 (A → 1 … E → 10), so A/B land green, C amber, D/E red. */
export function nutriRating(grade?: string | null): number | null {
  if (!grade) return null;
  const idx = nutriGrades.indexOf(grade as (typeof nutriGrades)[number]);
  return idx < 0 ? null : clampRating(1 + idx * 2.25);
}

export function inflammationLabel(band?: string | null): string {
  if (!band) return '—';
  return band
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join('-')
    .replace('Inflammatory', 'Inflam.');
}

/** Ultra-processed (NOVA 4) energy share at/above which the processing dial reads as a
 *  genuine ultra-processed concern. A presentation cut-off, not a clinical one — UPF risk
 *  is dose-response with no established threshold (Barbaresko 2024). */
export const UPF_ALARM_PCT = 30;

/**
 * Processing → 1–10 rating (1 = least processed, 10 = most). When the ultra-processed
 * (NOVA 4) share is known it governs the alarm: it is the health-relevant NOVA signal
 * (Lane 2024), not merely a low share of whole foods, so a dish lands in the 7–10 poor
 * band only when a real share of its energy is ultra-processed — regardless of the NOVA
 * 1–2 band — while a low-UPF dish that is only fermented/processed (NOVA 3: miso, cheese,
 * cured fish) sits in the 4–6 caution band, not the alarm. When the share is unknown (a
 * partially-populated nutrition object), fall back to the band alone. Within each band the
 * whole-food share positions the exact rating. The band choice is kept identical to the
 * old tone split, so `ratingTone(processingRating(…))` always agrees with the band word.
 */
export function processingRating(
  minimallyProcessedPct?: number | null,
  ultraProcessedPct?: number | null,
  band?: string | null,
): number | null {
  if (minimallyProcessedPct == null || !band) return null;
  const upfKnown = ultraProcessedPct != null;
  // Poor (7–10): a real ultra-processed share, or — when UPF is unknown — a highly-processed dish.
  if (upfKnown ? ultraProcessedPct! >= UPF_ALARM_PCT : band === 'highly-processed') {
    const over = upfKnown ? Math.min(ultraProcessedPct!, 100) - UPF_ALARM_PCT : 100 - minimallyProcessedPct;
    const span = upfKnown ? 100 - UPF_ALARM_PCT : 100;
    return clampRating(7 + (over / span) * 3);
  }
  // Good (1–3): minimally processed with a low/unknown ultra-processed share.
  if (band === 'minimally-processed') return clampRating(1 + ((100 - minimallyProcessedPct) / 30) * 2);
  // Caution (4–6): everything else — moderately processed, or NOVA-3 fermented foods (miso, cheese).
  return clampRating(4 + ((70 - minimallyProcessedPct) / 70) * 2);
}

/** Display label for a processing band ('minimally-processed' → 'Minimally Processed'). */
export function processingLabel(band?: string | null): string {
  if (!band) return '—';
  return band
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/* ---- score dials (every metric → the same 1–10 dial) ----
 * Each medallion shows one 1–10 rating (see the normalization block above): the number in
 * the centre, the ring filled to `rating / 10`, and both tinted by `ratingTone`. Because 1
 * is always healthiest and 10 always least healthy, every dial reads the same way — a small
 * green ring is good, a full red ring is poor, lower is better — with no per-metric direction
 * to remember. The band word (Low, Minimally Processed …) sits under the label as `sub`.
 */

/** Nutri-Score grades, best → worst — indexed to map a grade to its 1–10 rating. */
export const nutriGrades = ['A', 'B', 'C', 'D', 'E'] as const;

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

/** Horizontal anchor for a score dial's hover tooltip. */
export type TooltipAlign = 'left' | 'center' | 'right';
/** Tooltip anchor → Tailwind position class. Shared so the Astro dial and its React
 *  mirror can't drift (same pattern as `toneText`/`toneBg`). In a 2-column grid the
 *  left/right columns anchor to their outer edge so the tooltip grows inward and can't
 *  overflow the viewport; anything else stays centred. */
export function tipAlignClass(align: TooltipAlign): string {
  return align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2';
}

export interface ScoreDial {
  key: 'gi' | 'gl' | 'nutri' | 'balance' | 'inflam' | 'processing';
  label: string;
  /** One-line explanation of what the score measures, shown as a hover/focus tooltip. */
  blurb: string;
  /** The 1–10 rating as a string ("1" … "10"), or "—" when the score is absent. */
  value: string;
  /** Whether this score has a real value; when false, `value` is the "—" placeholder.
   *  The compact strip filters on this so it never carries a dangling "GI —" chip. */
  present: boolean;
  /** Band word / qualifier shown under the label (CSS-capitalized). */
  sub?: string;
  tone: Tone;
  /** Ring fill 0..1 = `rating / 10`; 0 when the score is absent. */
  fill: number;
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
      processing?: {
        minimallyProcessedPct?: number | null;
        ultraProcessedPct?: number | null;
        band?: string | null;
      } | null;
    }
  | null
  | undefined;

/**
 * Build the six score dials from a nutrition block — the single source of the
 * rating/tone/fill logic shared by the Astro detail page, the React edit preview,
 * and the authoring panel (so the three renderers never drift). Every dial is the
 * same shape: `value` is the metric's 1–10 rating, `fill` is `rating / 10`, and
 * `tone` is `ratingTone(rating)`.
 */
export function buildScoreDials(nutrition: NutritionLike): ScoreDial[] {
  const gly = nutrition?.glycemic ?? undefined;
  const nutri = nutrition?.nutriScore ?? undefined;
  const inflam = nutrition?.inflammation ?? undefined;
  const bal = nutrition?.balance ?? undefined;
  const proc = nutrition?.processing ?? undefined;
  const grade = nutri?.grade ?? null;

  const gi = giRating(gly?.gi);
  const gl = glRating(gly?.gl);
  const nu = nutriRating(grade);
  const ba = balanceRating(bal?.score);
  const inf = inflammationRating(inflam?.score);
  const pr = processingRating(proc?.minimallyProcessedPct, proc?.ultraProcessedPct, proc?.band);

  const dial = (rating: number | null) => ({
    value: rating != null ? String(rating) : '—',
    present: rating != null,
    tone: ratingTone(rating),
    fill: rating != null ? rating / 10 : 0,
  });

  return [
    {
      key: 'gi',
      label: 'Glycemic Index',
      blurb:
        'How quickly this dish’s carbohydrate raises blood glucose (native 0–100, glucose = 100), carb-weighted from published values. Shown as 1 (best) to 10 — lower is better. An estimate that tends to read high for mixed meals.',
      sub: gly?.giBand || undefined,
      ...dial(gi),
    },
    {
      key: 'gl',
      label: 'Glycemic Load',
      blurb:
        'Glycemic index scaled by the available carbohydrate in one serving — the total blood-glucose impact of a portion, not just its speed (native low ≤10, high ≥20). Shown as 1 (best) to 10 — lower is better. An estimate.',
      sub: gly?.glBand || undefined,
      ...dial(gl),
    },
    {
      key: 'nutri',
      label: 'Nutrition Score',
      blurb:
        'Nutri-Score 2023 (native A best … E worst): fibre, protein and fruit/vegetables/legumes weighed against energy, sugar, saturated fat and salt. Mapped to 1 (grade A) … 10 (grade E) — lower is better. Built for packaged products, applied to the dish as an estimate.',
      sub: undefined,
      ...dial(nu),
    },
    {
      key: 'balance',
      label: 'Nutrient Balance',
      blurb:
        'Nutrient density (native NRF9.3, 1–10, where more is denser): nine nutrients to encourage — protein, fibre, vitamins, minerals — minus three to limit (saturated fat, sugar, sodium), per 100 kcal. Inverted here to 1 (best) … 10 so every dial reads the same way — lower is better. An estimate.',
      sub: bal?.band || undefined,
      ...dial(ba),
    },
    {
      key: 'inflam',
      label: 'Inflammation',
      blurb:
        'Food Inflammation Index (native −2 anti to +2 pro): inflammatory potential from fat quality, fibre, antioxidants and polyphenols, energy-weighted across the dish. Shown as 1 (most anti-inflammatory) to 10 — lower is better. An estimate, not a clinical measure.',
      sub: inflam ? inflammationLabel(inflam.band) : undefined,
      ...dial(inf),
    },
    {
      key: 'processing',
      label: 'Processing',
      blurb:
        'How processed the dish is (NOVA): its whole-food share (groups 1–2) set against the ultra-processed share (group 4), which drives the rating when it climbs. Shown as 1 (least processed) to 10 — lower is better. A rough estimate — processing is judged by food type.',
      sub: proc ? processingLabel(proc.band) : undefined,
      ...dial(pr),
    },
  ];
}

/** Whether a nutrition block carries any of the scored figures. Gates the detail-page
 *  rail, whose lg grid shows all six slots (an absent one as an "—" ring). */
export function hasAnyScore(nutrition: NutritionLike): boolean {
  return !!(
    nutrition?.glycemic ||
    nutrition?.nutriScore ||
    nutrition?.inflammation ||
    nutrition?.balance ||
    nutrition?.processing
  );
}

/** Whether at least one score has a real value. Gates the compact card strip, which
 *  drops absent scores — so the strip is shown only when it will have a chip to render
 *  (a block present but all-null would leave `hasAnyScore` true yet the strip empty). */
export function hasDisplayableScore(nutrition: NutritionLike): boolean {
  return buildScoreDials(nutrition).some((d) => d.present);
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
