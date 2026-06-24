/**
 * Recipe draft → committable markdown.
 *
 * Emits the exact frontmatter shape `src/content.config.ts` validates (so the
 * authored file round-trips through Zod on rebuild) plus prose method steps in
 * the body. YAML is produced with the `yaml` library for correct quoting of
 * titles/notes containing colons, quotes, or ampersands. Pure + isomorphic, so
 * it is unit-testable and runs in the authoring island.
 */
import { Document, isScalar } from 'yaml';
import type { PerServingMacros } from './types';

export interface DraftIngredient {
  raw: string;
  group?: string;
  quantity?: number | null;
  quantity2?: number | null;
  unit?: string | null;
  item: string;
  note?: string;
  grams?: number | null;
  milliliters?: number | null;
  fdcId?: number | null;
  matchConfidence?: 'high' | 'medium' | 'low' | 'none';
  excludeFromNutrition?: boolean;
}

export interface DraftNutrition {
  perServing?: PerServingMacros;
  glycemic?: {
    gi: number | null;
    gl: number | null;
    giBand?: 'low' | 'medium' | 'high';
    glBand?: 'low' | 'medium' | 'high';
    gi_source?: string;
  };
  nutriScore?: {
    grade: 'A' | 'B' | 'C' | 'D' | 'E';
    points: number;
    version?: string;
    category?: 'general' | 'beverage' | 'fat-oil-nut-seed';
    /** Beverage NNS flag — persisted so an edit recomputes the same grade. */
    nnsPresent?: boolean;
  };
  inflammation?: {
    score: number;
    band:
      | 'anti-inflammatory'
      | 'mildly-anti-inflammatory'
      | 'neutral'
      | 'mildly-pro-inflammatory'
      | 'pro-inflammatory';
    method?: string;
  };
  balance?: {
    score: number;
    band: 'poor' | 'low' | 'moderate' | 'high' | 'excellent';
    nrf: number;
    version?: string;
  };
  computedAt?: string;
  dataSources?: string[];
}

export interface RecipeDraft {
  title: string;
  slug?: string;
  description?: string;
  /** Local committed hero image, src-relative (e.g. "./images/<slug>.jpg"). */
  image?: string;
  imageUrl?: string;
  imageAlt?: string;
  source?: { name?: string; url?: string };
  author?: string;
  servings: number;
  yield?: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  cuisine?: string;
  course?: string;
  tags?: string[];
  category?: string;
  lists?: string[];
  ingredients: DraftIngredient[];
  instructions: string[];
  /** Body markdown before the numbered method (intro prose) — preserved across an edit. */
  bodyBefore?: string;
  /** Body markdown after the numbered method ("## Notes", tips) — preserved across an edit. */
  bodyAfter?: string;
  nutrition?: DraftNutrition;
  /** ISO date (YYYY-MM-DD); supplied by the caller to stay deterministic. */
  createdAt?: string;
  /** ISO date (YYYY-MM-DD) of the last edit; set when re-committing an edit. */
  updatedAt?: string;
}

/** Slug for the recipe file/route, from an explicit slug or the title. */
export function slugifyRecipe(title: string, explicit?: string): string {
  const base = (explicit ?? title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base || 'recipe';
}

/** Repo-relative path the recipe markdown should be committed to. */
export function recipeFilename(draft: RecipeDraft): string {
  return `src/content/recipes/${slugifyRecipe(draft.title, draft.slug)}.md`;
}

/** Recursively drop undefined/null, empty strings, empty arrays and objects. */
function prune<T>(value: T): T {
  if (Array.isArray(value)) {
    const arr = value.map(prune).filter((v) => !isEmpty(v));
    return arr as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const pv = prune(v);
      if (!isEmpty(pv)) out[k] = pv;
    }
    return out as T;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function cleanIngredient(ing: DraftIngredient): Record<string, unknown> {
  const out: Record<string, unknown> = {
    raw: ing.raw,
    group: ing.group,
    quantity: ing.quantity,
    quantity2: ing.quantity2,
    unit: ing.unit,
    item: ing.item,
    note: ing.note,
    grams: ing.grams,
    milliliters: ing.milliliters,
    fdcId: ing.fdcId,
    matchConfidence: ing.matchConfidence,
  };
  // The schema defaults excludeFromNutrition to false — only emit when true.
  if (ing.excludeFromNutrition) out.excludeFromNutrition = true;
  return out;
}

function methodBody(instructions: string[]): string {
  const steps = instructions
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');
  return steps ? `## Method\n\n${steps}` : '## Method';
}

/** Serialize a draft to a complete markdown file (frontmatter + method body). */
export function toRecipeMarkdown(draft: RecipeDraft): string {
  const frontmatter: Record<string, unknown> = {
    title: draft.title,
    slug: draft.slug,
    description: draft.description,
    image: draft.image,
    imageUrl: draft.imageUrl,
    imageAlt: draft.imageAlt,
    source: draft.source,
    author: draft.author,
    servings: draft.servings,
    yield: draft.yield,
    prepTime: draft.prepTime,
    cookTime: draft.cookTime,
    totalTime: draft.totalTime,
    difficulty: draft.difficulty,
    cuisine: draft.cuisine,
    course: draft.course,
    tags: draft.tags,
    category: draft.category,
    lists: draft.lists,
    ingredients: draft.ingredients.map(cleanIngredient),
    nutrition: draft.nutrition,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
  const doc = new Document(prune(frontmatter));
  // A bare YYYY-MM-DD scalar is resolved back to a Date by the build's YAML
  // parser, which fails the string schema on rebuild; force the date fields to
  // quoted strings so they round-trip (matching the hand-authored recipes).
  for (const path of [['createdAt'], ['updatedAt'], ['nutrition', 'computedAt']]) {
    const node = doc.getIn(path, true);
    if (isScalar(node) && typeof node.value === 'string') node.type = 'QUOTE_DOUBLE';
  }
  const yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  // Compose the body in order: preserved intro → method → preserved notes/tips.
  // The "## Method" block is included only when there are steps; otherwise a
  // preserved body (e.g. a prose-only method) stands on its own.
  const hasSteps = draft.instructions.some((s) => s.trim().length > 0);
  const segments = [draft.bodyBefore?.trim(), hasSteps ? methodBody(draft.instructions) : '', draft.bodyAfter?.trim()]
    .map((s) => s?.trim())
    .filter(Boolean);
  const body = segments.length ? segments.join('\n\n') : methodBody(draft.instructions);
  return `---\n${yaml}\n---\n\n${body}\n`;
}
