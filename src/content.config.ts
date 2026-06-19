import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The recipe archive's single source of truth.
 *
 * Each recipe is one markdown file in `src/content/recipes/`: rich YAML
 * frontmatter (uniform, machine-readable) + prose instructions in the body.
 * The same schema is written by the in-app import/manual authoring flow
 * (Phase 1) and validated here at build time. Ingredients are kept fully
 * structured (not just prose) so nutrition math, serving-scaling, and future
 * shopping-list / kifli.hu integration need no re-parsing.
 *
 * All quantities are stored in METRIC (grams precomputed); the original
 * `raw` line is always retained for provenance/auditability.
 */

// ISO-8601 duration (e.g. PT30M, PT1H15M, P1DT2H) — keeps schema.org JSON-LD clean.
const duration = z
  .string()
  .regex(
    /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/,
    'Expected an ISO-8601 duration like "PT30M" or "PT1H15M"',
  )
  .refine((v) => v !== 'P' && v !== 'PT', 'Duration must not be empty');

const band3 = z.enum(['low', 'medium', 'high']);
const nutriGrade = z.enum(['A', 'B', 'C', 'D', 'E']);
const inflammationBand = z.enum([
  'anti-inflammatory',
  'mildly-anti-inflammatory',
  'neutral',
  'mildly-pro-inflammatory',
  'pro-inflammatory',
]);
const matchConfidence = z.enum(['high', 'medium', 'low', 'none']);

const ingredient = z.object({
  /** Original ingredient line exactly as written/imported. Always present. */
  raw: z.string(),
  /** Optional group header this ingredient belongs to, e.g. "For the sauce". */
  group: z.string().optional(),
  /** Parsed amount (null when not numeric, e.g. "to taste"). */
  quantity: z.number().nullable().optional(),
  /** Upper bound for ranges, e.g. "2–3 cloves". */
  quantity2: z.number().nullable().optional(),
  /** Original unit token before metric conversion (e.g. "cup", "oz"). */
  unit: z.string().nullable().optional(),
  /** The food itself, e.g. "red lentils". */
  item: z.string(),
  /** Prep/notes, e.g. "rinsed", "finely chopped". */
  note: z.string().optional(),
  /** Metric weight used for all nutrition math. Approximate; see `raw`. */
  grams: z.number().nonnegative().nullable().optional(),
  /** Metric volume in ml when the item is genuinely measured by volume. */
  milliliters: z.number().nonnegative().nullable().optional(),
  /** Confirmed USDA FoodData Central id for the matched food. */
  fdcId: z.number().int().nullable().optional(),
  /** Confidence of the ingredient→food match (drives review flags). */
  matchConfidence: matchConfidence.optional(),
  /** Whether this item is excluded from nutrition totals (e.g. "water"). */
  excludeFromNutrition: z.boolean().default(false),
});

const perServing = z
  .object({
    energyKcal: z.number().optional(),
    energyKj: z.number().optional(),
    protein_g: z.number().optional(),
    carbs_g: z.number().optional(),
    fiber_g: z.number().optional(),
    availableCarb_g: z.number().optional(),
    sugar_g: z.number().optional(),
    fat_g: z.number().optional(),
    satFat_g: z.number().optional(),
    sodium_mg: z.number().optional(),
  })
  .partial();

const nutrition = z.object({
  perServing: perServing.optional(),
  glycemic: z
    .object({
      gi: z.number().nullable().optional(),
      gl: z.number().nullable().optional(),
      giBand: band3.optional(),
      glBand: band3.optional(),
      gi_source: z.string().optional(),
    })
    .optional(),
  nutriScore: z
    .object({
      grade: nutriGrade,
      points: z.number(),
      version: z.string().default('2023'),
      category: z
        .enum(['general', 'beverage', 'fat-oil-nut-seed'])
        .default('general'),
      /** Beverage non-nutritive-sweetener flag — a scoring input retained so an edit recomputes the same grade. */
      nnsPresent: z.boolean().optional(),
    })
    .optional(),
  inflammation: z
    .object({
      score: z.number(),
      band: inflammationBand,
      method: z.string().default('ingredient-tag v1'),
    })
    .optional(),
  /** ISO date (YYYY-MM-DD) the values were computed. */
  computedAt: z.string().optional(),
  /** Provenance of the data behind the numbers. */
  dataSources: z.array(z.string()).default([]),
});

const recipes = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: './src/content/recipes' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      /** Optional explicit slug; routing falls back to the file id otherwise. */
      slug: z.string().optional(),
      description: z.string().optional(),

      /** Local committed hero image (optimized by Astro at build). */
      image: image().optional(),
      /** Remote image URL fallback when no local image is committed. */
      imageUrl: z.string().url().optional(),
      imageAlt: z.string().optional(),

      source: z
        .object({ name: z.string().optional(), url: z.string().url().optional() })
        .optional(),
      author: z.string().optional(),

      servings: z.number().int().positive().default(4),
      yield: z.string().optional(),
      prepTime: duration.optional(),
      cookTime: duration.optional(),
      totalTime: duration.optional(),

      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      cuisine: z.string().optional(),
      course: z.string().optional(),

      tags: z.array(z.string()).default([]),
      category: z.string().optional(),
      /** Curated user lists this recipe belongs to. */
      lists: z.array(z.string()).default([]),

      ingredients: z.array(ingredient).default([]),
      nutrition: nutrition.optional(),

      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      draft: z.boolean().default(false),
    }),
});

export const collections = { recipes };
