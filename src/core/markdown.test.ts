import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { toRecipeMarkdown, recipeFilename, slugifyRecipe, type RecipeDraft } from './markdown';

const draft: RecipeDraft = {
  title: 'Spinach & Lentil Dahl',
  description: 'Cozy: a weeknight dahl.',
  servings: 4,
  prepTime: 'PT10M',
  tags: ['vegan', 'one-pot'],
  ingredients: [
    {
      raw: '1 cup red lentils, rinsed',
      quantity: 1,
      unit: 'cup',
      item: 'red lentils',
      note: 'rinsed',
      grams: 192,
      fdcId: 172420,
      matchConfidence: 'high',
    },
    { raw: 'water', item: 'water', excludeFromNutrition: true },
  ],
  instructions: ['Rinse the lentils.', 'Simmer until soft.'],
  nutrition: {
    perServing: { energyKcal: 310, protein_g: 18 },
    computedAt: '2026-06-19',
    dataSources: ['USDA FoodData Central'],
  },
  createdAt: '2026-06-19',
};

function frontmatter(md: string): Record<string, any> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) throw new Error('no frontmatter');
  return parse(m[1]);
}

describe('toRecipeMarkdown', () => {
  const md = toRecipeMarkdown(draft);

  it('wraps frontmatter in --- fences and a method body', () => {
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('\n---\n');
    expect(md).toContain('## Method');
    expect(md).toContain('1. Rinse the lentils.');
    expect(md).toContain('2. Simmer until soft.');
  });

  it('round-trips through YAML, preserving special characters', () => {
    const fm = frontmatter(md);
    expect(fm.title).toBe('Spinach & Lentil Dahl');
    expect(fm.description).toBe('Cozy: a weeknight dahl.');
    expect(fm.servings).toBe(4);
    expect(fm.tags).toEqual(['vegan', 'one-pot']);
    expect(fm.ingredients).toHaveLength(2);
    expect(fm.nutrition.perServing.energyKcal).toBe(310);
  });

  it('only emits excludeFromNutrition when true (schema default is false)', () => {
    const fm = frontmatter(md);
    expect('excludeFromNutrition' in fm.ingredients[0]).toBe(false);
    expect(fm.ingredients[1].excludeFromNutrition).toBe(true);
  });

  it('prunes absent optional fields rather than emitting nulls', () => {
    const fm = frontmatter(md);
    expect('cuisine' in fm).toBe(false);
    expect('cookTime' in fm).toBe(false);
    // the water ingredient keeps only its meaningful fields
    expect(Object.keys(fm.ingredients[1]).sort()).toEqual(['excludeFromNutrition', 'item', 'raw']);
  });
});

describe('slugifyRecipe / recipeFilename', () => {
  it('slugifies the title', () => {
    expect(slugifyRecipe('Spinach & Lentil Dahl')).toBe('spinach-lentil-dahl');
    expect(slugifyRecipe('Title', 'custom-slug')).toBe('custom-slug');
  });
  it('builds the content path', () => {
    expect(recipeFilename(draft)).toBe('src/content/recipes/spinach-lentil-dahl.md');
  });
});
