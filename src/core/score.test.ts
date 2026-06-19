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

// Per-100g/mL vectors for non-general categories.
const COLA = { energyKcal: 43, protein_g: 0, fat_g: 0, satFat_g: 0, carbs_g: 10.6, fiber_g: 0, sugar_g: 10.6, sodium_mg: 4 };
const DIET_DRINK = { energyKcal: 0.4, protein_g: 0, fat_g: 0, satFat_g: 0, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 5 };
const OLIVE_OIL = { energyKcal: 884, protein_g: 0, fat_g: 100, satFat_g: 13.8, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 };

describe('computeScores — Nutri-Score category dispatch', () => {
  it('defaults to the general sub-algorithm', () => {
    const r = computeScores([{ grams: 100, nutrients: COLA, gi: null, inflammationTag: 0 }], 1);
    expect(r.nutriScore?.category).toBe('general');
  });

  it('scores a sugary drink far more strictly as a beverage than as a general food', () => {
    const ing: ScoredIngredient[] = [{ grams: 100, nutrients: COLA, gi: null, inflammationTag: 0 }];
    expect(computeScores(ing, 1).nutriScore?.grade).toBe('C'); // general default
    const bev = computeScores(ing, 1, { nutriCategory: 'beverage' });
    expect(bev.nutriScore?.category).toBe('beverage');
    expect(bev.nutriScore?.grade).toBe('E'); // stricter beverage energy/sugar scales
    expect(bev.nutriScore?.points).toBe(12);
  });

  it('applies the non-nutritive-sweetener penalty to beverages', () => {
    const diet: ScoredIngredient[] = [{ grams: 100, nutrients: DIET_DRINK, gi: null, inflammationTag: 0 }];
    expect(computeScores(diet, 1, { nutriCategory: 'beverage' }).nutriScore?.grade).toBe('B');
    expect(computeScores(diet, 1, { nutriCategory: 'beverage', nnsPresent: true }).nutriScore?.grade).toBe('C');
  });

  it('uses the SFA/total-fat ratio for fats (olive oil B, not the general-food D)', () => {
    const oil: ScoredIngredient[] = [{ grams: 100, nutrients: OLIVE_OIL, gi: null, inflammationTag: -1, fvl: true }];
    expect(computeScores(oil, 1).nutriScore?.grade).toBe('D'); // general: penalised on energy + absolute satfat
    const fat = computeScores(oil, 1, { nutriCategory: 'fat-oil-nut-seed' });
    expect(fat.nutriScore?.category).toBe('fat-oil-nut-seed');
    expect(fat.nutriScore?.points).toBe(0);
    expect(fat.nutriScore?.grade).toBe('B'); // ratio-based scoring + olive-oil FVL credit
  });
});
