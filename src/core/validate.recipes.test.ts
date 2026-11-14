/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateRecipe, type Issue, type ValidatableRecipe } from './validate';
import type { FoodRecord } from './match';
import usdaFoods from '../data/usda-foods.json';
import allowlistData from '../data/validation-allowlist.json';

// Every recipe's raw markdown, loaded at build time (Vite transform — no Node fs).
const RECIPE_FILES = import.meta.glob('../content/recipes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * The ingredient-data validation gate over every recipe: any error fails the test, except
 * an error whose (recipe slug, code) pair is listed in src/data/validation-allowlist.json.
 * Warnings are reported to the console only. `node scripts/validate-recipes.mjs` prints
 * the same findings as a grouped report.
 */
const foods = usdaFoods as FoodRecord[];
const foodById = new Map(foods.map((f) => [f.fdcId as number, f]));
const allow = new Set((allowlistData as { slug: string; code: string }[]).map((a) => `${a.slug}|${a.code}`));

const files = Object.keys(RECIPE_FILES).sort();

function frontmatter(text: string): (ValidatableRecipe & { slug?: string }) | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? parseYaml(m[1]) : null;
}

describe('recipe ingredient data passes the validation gate', () => {
  it('finds recipe files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const warningCounts: Record<string, number> = {};
  for (const file of files) {
    const data = frontmatter(RECIPE_FILES[file]);
    if (!data) continue;
    const slug = data.slug ?? file.split('/').pop()!.replace(/\.md$/, '');

    it(slug, () => {
      const { errors, warnings } = validateRecipe(data, foodById);
      for (const w of warnings) warningCounts[w.code] = (warningCounts[w.code] ?? 0) + 1;
      const failing = errors.filter((e: Issue) => !allow.has(`${slug}|${e.code}`));
      expect(failing.map((e) => `[${e.code}] ${e.message}`)).toEqual([]);
    });
  }

  it('reports warning counts', () => {
    const summary = Object.entries(warningCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    console.info(`validation warnings: ${summary || 'none'}`);
  });
});
