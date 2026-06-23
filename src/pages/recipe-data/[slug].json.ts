/**
 * Per-recipe JSON the editor fetches to re-seed the authoring wizard.
 *
 * Exposes just the structured frontmatter fields `formFromRecipe` /
 * `rowsFromIngredients` need (plus the extracted method steps and the original
 * `createdAt`), prerendered to `/recipe-data/<slug>.json`. The recipe markdown
 * stays the single source of truth — this is a build-time projection of it.
 */
import { readFile } from 'node:fs/promises';
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import { recipeSlug } from '../../lib/recipe';

export const getStaticPaths: GetStaticPaths = async () => {
  const recipes = (await getCollection('recipes')).filter(
    (r) => import.meta.env.DEV || !r.data.draft,
  );
  return recipes.map((recipe) => ({ params: { slug: recipeSlug(recipe) }, props: { recipe } }));
};

const toISODate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The frontmatter `image:` value as originally written (e.g. "./images/x.jpg").
 * `data.image` is resolved to hashed ImageMetadata by build, losing the source
 * path, so read it from the file — letting an edit re-emit a local image that
 * isn't backed by a remote imageUrl to re-fetch.
 */
async function rawImagePath(id: string): Promise<string | undefined> {
  try {
    const text = (await readFile(`src/content/recipes/${id}.md`, 'utf8')).replace(/^\uFEFF/, '');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const m = /^image:[ \t]*(.+?)[ \t]*$/m.exec(fm);
    if (!m) return undefined;
    return m[1].replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

export const GET: APIRoute = async ({ props }) => {
  const { recipe } = props as { recipe: CollectionEntry<'recipes'> };
  const d = recipe.data;
  const payload = {
    // The actual repo file to overwrite — from the build-trusted entry id, not
    // the URL slug — so an edit always re-commits the right file.
    path: `src/content/recipes/${recipe.id}.md`,
    createdAt: d.createdAt ? toISODate(d.createdAt) : null,
    // Raw body so the editor can preserve non-method content (notes, prose).
    body: recipe.body ?? '',
    // Frontmatter fields the wizard form doesn't manage — carried through an
    // edit verbatim so saving never strips them.
    preserved: {
      difficulty: d.difficulty,
      image: d.image ? await rawImagePath(recipe.id) : undefined,
      imageAlt: d.imageAlt,
      author: d.author,
      yield: d.yield,
      slug: d.slug,
    },
    recipe: {
      title: d.title,
      description: d.description,
      servings: d.servings,
      prepTime: d.prepTime,
      cookTime: d.cookTime,
      cuisine: d.cuisine,
      course: d.course,
      category: d.category,
      tags: d.tags,
      lists: d.lists,
      imageUrl: d.imageUrl,
      source: d.source,
      ingredients: d.ingredients.map((i) => ({
        raw: i.raw,
        quantity: i.quantity,
        quantity2: i.quantity2,
        unit: i.unit,
        item: i.item,
        note: i.note,
        grams: i.grams,
        milliliters: i.milliliters,
        fdcId: i.fdcId,
        matchConfidence: i.matchConfidence,
        excludeFromNutrition: i.excludeFromNutrition,
      })),
      nutrition: d.nutrition?.nutriScore
        ? {
            nutriScore: {
              category: d.nutrition.nutriScore.category,
              nnsPresent: d.nutrition.nutriScore.nnsPresent,
            },
          }
        : undefined,
    },
  };
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
};
