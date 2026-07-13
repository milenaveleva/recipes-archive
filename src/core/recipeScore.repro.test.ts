/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { scoreRecipe, type FoodScoring, type StoredScoringIngredient } from './recipeScore';
import type { FoodRecord } from './match';
import usdaFoods from '../data/usda-foods.json';
import foodScoringData from '../data/food-scoring.json';
import polyphenolData from '../data/polyphenols.json';

// Load every recipe's raw markdown at build time (Vite transform — no Node fs), so the
// guard runs identically under Vitest and in the browser test environment.
const RECIPE_FILES = import.meta.glob('../content/recipes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Build-time reproducibility guard: every stored `nutrition` block must recompute
 * EXACTLY from the recipe's stored ingredients + the bundled food data + the current
 * engine. Because the site ships precomputed scores in frontmatter, a drift between a
 * stored block and the live engine (an engine/data/ingredient change without a rescore)
 * would silently mislead — this fails the build until `node scripts/rescore-recipes.mjs`
 * is re-run.
 */
const foods = usdaFoods as FoodRecord[];
const foodById = new Map(foods.map((f) => [f.fdcId as number, f]));
const foodScoring = foodScoringData as Record<string, FoodScoring>;
const polyphenols = polyphenolData as Record<string, { polyphenol_mg?: number }>;

interface Frontmatter {
  servings?: number;
  ingredients?: (StoredScoringIngredient & Record<string, unknown>)[];
  nutrition?: Record<string, any>;
}

function frontmatter(text: string): Frontmatter | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? (parseYaml(m[1]) as Frontmatter) : null;
}

const files = Object.keys(RECIPE_FILES).sort();

describe('recipe nutrition blocks reproduce from the engine', () => {
  it('finds recipe files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const data = frontmatter(RECIPE_FILES[file]);
    if (!data?.nutrition) continue;

    it(`${file.split('/').pop()}`, () => {
      const stored = data.nutrition!;
      const ns = stored.nutriScore ?? {};
      const { macro, scores } = scoreRecipe(
        (data.ingredients ?? []).map((i) => ({
          grams: i.grams,
          fdcId: i.fdcId,
          excludeFromNutrition: i.excludeFromNutrition,
        })),
        {
          servings: data.servings ?? 4,
          nutriCategory: ns.category ?? 'general',
          nnsPresent: ns.nnsPresent,
          isWater: ns.isWater,
          isCheese: ns.isCheese,
          redMeat: ns.redMeat,
        },
        foodById,
        foodScoring,
        polyphenols,
      );

      // perServing macros
      if (stored.perServing) {
        for (const [k, v] of Object.entries(stored.perServing)) {
          expect(macro.perServing[k as keyof typeof macro.perServing], `perServing.${k}`).toBe(v);
        }
      }
      // glycemic
      if (stored.glycemic) {
        expect(scores.glycemic?.gi).toBe(stored.glycemic.gi);
        expect(scores.glycemic?.gl).toBe(stored.glycemic.gl);
        expect(scores.glycemic?.carbCoveragePct).toBe(stored.glycemic.carbCoveragePct);
      }
      // Nutri-Score
      if (stored.nutriScore) {
        expect(scores.nutriScore?.grade).toBe(stored.nutriScore.grade);
        expect(scores.nutriScore?.points).toBe(stored.nutriScore.points);
        expect(scores.nutriScore?.coverage).toBe(stored.nutriScore.coverage);
      }
      // inflammation
      if (stored.inflammation) {
        expect(scores.inflammation?.score).toBe(stored.inflammation.score);
        expect(scores.inflammation?.band).toBe(stored.inflammation.band);
      }
      // balance (NRF9.3)
      if (stored.balance) {
        expect(scores.balance?.score).toBe(stored.balance.score);
        expect(scores.balance?.nrf).toBe(stored.balance.nrf);
      }
      // processing (NOVA)
      if (stored.processing) {
        expect(scores.processing?.minimallyProcessedPct).toBe(stored.processing.minimallyProcessedPct);
        expect(scores.processing?.ultraProcessedPct).toBe(stored.processing.ultraProcessedPct);
        expect(scores.processing?.band).toBe(stored.processing.band);
      }
    });
  }
});

/**
 * GI-coverage guard: a recipe with meaningful available carbohydrate MUST produce a
 * glycemic block. A blank GI/GL dial means a carbohydrate ingredient carries no GI in
 * food-scoring.json — the recurring "why is GI missing" bug. This fails the build so a
 * new recipe can't ship a blank dial silently: fix by adding the food's GI (run
 * scripts/build-gi.mjs + scripts/match-gi.mjs, or curate) then rescore.
 */
/**
 * Full-coverage guard: every food in the bundled USDA set must carry a GI in
 * food-scoring.json, so no recipe — present or future — can pull in an ingredient
 * that produces a blank GI/GL dial. `scripts/match-gi.mjs` assigns one to every food
 * (measured match → composition estimate → category median/nominal → 0 for carb-free);
 * this fails the build if that invariant ever breaks (a new food added without a
 * re-run, or a matcher regression that drops a tier).
 */
describe('every USDA food carries a GI', () => {
  it('food-scoring.json has a GI for every bundled food', () => {
    const missing = foods
      .filter((f) => foodScoring[String(f.fdcId)]?.gi == null)
      .map((f) => f.fdcId);
    expect(missing).toEqual([]);
  });
});

describe('every carb-bearing recipe has a glycemic block', () => {
  const MIN_CARB_G = 5; // available carb / serving above which a GI is expected
  for (const file of files) {
    const data = frontmatter(RECIPE_FILES[file]);
    if (!data?.nutrition) continue;
    const ns = data.nutrition.nutriScore ?? {};
    it(`${file.split('/').pop()}`, () => {
      const { macro, scores } = scoreRecipe(
        (data.ingredients ?? []).map((i) => ({ grams: i.grams, fdcId: i.fdcId, excludeFromNutrition: i.excludeFromNutrition })),
        { servings: data.servings ?? 4, nutriCategory: ns.category ?? 'general', nnsPresent: ns.nnsPresent, isWater: ns.isWater, isCheese: ns.isCheese, redMeat: ns.redMeat },
        foodById, foodScoring, polyphenols,
      );
      if ((macro.perServing.availableCarb_g ?? 0) >= MIN_CARB_G) {
        expect(scores.glycemic, `${file.split('/').pop()} has ${macro.perServing.availableCarb_g} g available carb/serving but no GI — a carb ingredient is missing a GI in food-scoring.json`).toBeTruthy();
      }
    });
  }
});
