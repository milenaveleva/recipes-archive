/**
 * Build-time bridge: turn recipe collection entries into the flat `SearchDoc`s
 * the index toolbar searches and facets over. Kept apart from search.ts (which
 * is client-safe) because this imports the Astro-typed `Recipe` and the
 * markdown body. Run only in `.astro` frontmatter, never in the client bundle.
 */
import type { Recipe } from './recipe';
import { recipeSlug, extractSteps, glBasisOf } from './recipe';
import { glLevelOf, type SearchDoc } from './search';

export function buildSearchDoc(entry: Recipe): SearchDoc {
  const { data } = entry;
  const n = data.nutrition;
  return {
    slug: recipeSlug(entry),
    title: data.title,
    description: data.description ?? '',
    // Food names drive useful matches; fall back to the raw line ("to taste" etc.).
    ingredients: data.ingredients.map((i) => i.item || i.raw).filter(Boolean),
    steps: extractSteps(entry.body),
    lists: data.lists,
    cuisine: data.cuisine ?? null,
    course: data.course ?? null,
    difficulty: data.difficulty ?? null,
    giBand: n?.glycemic?.giBand ?? null,
    glBand: glLevelOf(n?.glycemic?.gl, glBasisOf(n?.glycemic?.glBasis, data.course)),
    nutriGrade: n?.nutriScore?.grade ?? null,
    inflammationBand: n?.inflammation?.band ?? null,
    balanceBand: n?.balance?.band ?? null,
  };
}

export const buildSearchIndex = (recipes: Recipe[]): SearchDoc[] => recipes.map(buildSearchDoc);
