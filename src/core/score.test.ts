import { describe, it, expect } from 'vitest';
import { computeScores, type ScoredIngredient } from './score';

// Per-100g nutrient vectors mirroring the USDA seed data.
const LENTILS = { energyKcal: 116, protein_g: 9.02, fat_g: 0.38, satFat_g: 0.05, carbs_g: 20.13, fiber_g: 7.9, sugar_g: 1.8, sodium_mg: 2 };
const SPINACH = { energyKcal: 23, protein_g: 2.86, fat_g: 0.39, satFat_g: 0.06, carbs_g: 3.63, fiber_g: 2.2, sugar_g: 0.42, sodium_mg: 79 };

describe('computeScores (orchestration)', () => {
  const ingredients: ScoredIngredient[] = [
    { grams: 100, nutrients: LENTILS, gi: 32, inflammationTag: -1, fvl: true },
    { grams: 100, nutrients: SPINACH, gi: null, inflammationTag: -2, fvl: true },
  ];

  it('produces glycemic, Nutri-Score and inflammation together', () => {
    const r = computeScores(ingredients, 2);

    // GI: only lentils carry a GI; spinach carbohydrate is excluded.
    expect(r.glycemic?.gi).toBe(32);
    expect(r.glycemic?.giBand).toBe('low');
    expect(r.glycemic?.gi_source).toContain('Atkinson 2021');

    // Nutri-Score: high FVL + protein/fibre, negligible negatives → A.
    expect(r.nutriScore?.grade).toBe('A');
    expect(r.nutriScore?.points).toBe(-9); // pinned so a basis-math regression can't hide in grade A
    expect(r.nutriScore?.category).toBe('general');

    // Inflammation: (−1·100 + −2·100)/200 = −1.5 → anti-inflammatory.
    expect(r.inflammation?.score).toBe(-1.5);
    expect(r.inflammation?.band).toBe('anti-inflammatory');
  });

  it('omits glycemic when no carbohydrate source has a GI, but still scores the rest', () => {
    const r = computeScores([{ grams: 100, nutrients: SPINACH, gi: null, inflammationTag: -2, fvl: true }], 2);
    expect(r.glycemic).toBeUndefined();
    expect(r.nutriScore).toBeDefined(); // glycemic omission must not suppress Nutri-Score
    expect(r.inflammation?.band).toBe('anti-inflammatory');
  });

  it('skips excluded ingredients (e.g. water) from every score', () => {
    const r = computeScores(
      [
        { grams: 100, nutrients: LENTILS, gi: 32, inflammationTag: -1, fvl: true },
        { grams: 600, excludeFromNutrition: true, nutrients: null, gi: null, inflammationTag: 0 },
      ],
      2,
    );
    expect(r.glycemic?.gi).toBe(32);
    expect(r.inflammation?.score).toBe(-1); // only the lentils counted
  });
});
