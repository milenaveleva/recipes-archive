import { describe, it, expect } from 'vitest';
import { computeScores, type ScoredIngredient } from './score';
import { foodFormAdjustment } from './foodAdjust';

const INFLAMMATION_BANDS = [
  'anti-inflammatory', 'mildly-anti-inflammatory', 'neutral',
  'mildly-pro-inflammatory', 'pro-inflammatory',
];

// Per-100g nutrient vectors mirroring the USDA seed data.
const LENTILS = { energyKcal: 116, protein_g: 9.02, fat_g: 0.38, satFat_g: 0.05, carbs_g: 20.13, fiber_g: 7.9, sugar_g: 1.8, sodium_mg: 2 };
const SPINACH = { energyKcal: 23, protein_g: 2.86, fat_g: 0.39, satFat_g: 0.06, carbs_g: 3.63, fiber_g: 2.2, sugar_g: 0.42, sodium_mg: 79 };

describe('computeScores (orchestration)', () => {
  const ingredients: ScoredIngredient[] = [
    { grams: 100, nutrients: LENTILS, gi: 32, fvl: true },
    { grams: 100, nutrients: SPINACH, gi: null, fvl: true },
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

    // Inflammation: computed per-food by the FII (fii.ts) and energy-weighted — present,
    // on the −2..+2 axis, with a valid band (exact values are pinned in fii.test.ts /
    // inflammation.test.ts; here we assert the block is produced alongside the others).
    expect(r.inflammation).toBeDefined();
    expect(r.inflammation!.score).toBeGreaterThanOrEqual(-2);
    expect(r.inflammation!.score).toBeLessThanOrEqual(2);
    expect(INFLAMMATION_BANDS).toContain(r.inflammation!.band);

    // Balance (NRF9.3): macro-only vectors carry no micronutrients, so only
    // protein + fibre earn points (the seen-mass rule keeps the rest unknown,
    // never fabricated) → a moderate, conservative score.
    expect(r.balance?.nrf).toBeCloseTo(36.9, 1);
    expect(r.balance?.score).toBe(5);
    expect(r.balance?.band).toBe('moderate');
  });

  it('omits glycemic when no carbohydrate source has a GI, but still scores the rest', () => {
    const r = computeScores([{ grams: 100, nutrients: SPINACH, gi: null, fvl: true }], 2);
    expect(r.glycemic).toBeUndefined();
    expect(r.nutriScore).toBeDefined(); // glycemic omission must not suppress Nutri-Score
    expect(r.inflammation).toBeDefined();
  });

  it('applies the composition-blind food-form adjustment when the ingredient carries an adjusted fdcId', () => {
    // A yogurt-like vector reads pro-inflammatory by composition (saturated fat + sodium +
    // lactose-as-free-sugar); fdcId 171284 (plain whole-milk yogurt) carries a −1.3 delta.
    const YOGURT = { energyKcal: 61, protein_g: 3.5, fat_g: 3.25, satFat_g: 2.1, monoFat_g: 0.9, polyFat_g: 0.1, carbs_g: 4.66, sugar_g: 4.66, sodium_mg: 46 };
    const plain = computeScores([{ grams: 150, nutrients: YOGURT, gi: null }], 1);
    const adjusted = computeScores([{ grams: 150, nutrients: YOGURT, gi: null, fdcId: 171284 }], 1);
    expect(foodFormAdjustment(171284)).toBe(-1.3);
    // One ingredient → the recipe score is its (adjusted) per-food tag, so the wiring +
    // sign + clamp are pinned without hard-coding the composition tag (which fii.test pins).
    const clamp = (n: number) => Math.max(-2, Math.min(2, n));
    const expected = clamp(Math.round((plain.inflammation!.score - 1.3) * 10) / 10);
    expect(adjusted.inflammation!.score).toBe(expected);
    expect(adjusted.inflammation!.score).toBeLessThan(plain.inflammation!.score); // nudged anti
  });

  it('skips excluded ingredients (e.g. water) from every score', () => {
    const lentils: ScoredIngredient = { grams: 100, nutrients: LENTILS, gi: 32, fvl: true };
    const lentilsOnly = computeScores([lentils], 2);
    const withWater = computeScores(
      [lentils, { grams: 600, excludeFromNutrition: true, nutrients: null, gi: null }],
      2,
    );
    expect(withWater.glycemic?.gi).toBe(32);
    // Excluded water contributes to no score, so inflammation matches lentils alone.
    expect(lentilsOnly.inflammation).toBeDefined();
    expect(withWater.inflammation).toEqual(lentilsOnly.inflammation);
  });
});

// Per-100g/mL vectors for non-general categories.
const COLA = { energyKcal: 43, protein_g: 0, fat_g: 0, satFat_g: 0, carbs_g: 10.6, fiber_g: 0, sugar_g: 10.6, sodium_mg: 4 };
const DIET_DRINK = { energyKcal: 0.4, protein_g: 0, fat_g: 0, satFat_g: 0, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 5 };
const OLIVE_OIL = { energyKcal: 884, protein_g: 0, fat_g: 100, satFat_g: 13.8, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 };

describe('computeScores — Nutri-Score category dispatch', () => {
  it('defaults to the general sub-algorithm', () => {
    const r = computeScores([{ grams: 100, nutrients: COLA, gi: null }], 1);
    expect(r.nutriScore?.category).toBe('general');
  });

  it('scores a sugary drink far more strictly as a beverage than as a general food', () => {
    const ing: ScoredIngredient[] = [{ grams: 100, nutrients: COLA, gi: null }];
    expect(computeScores(ing, 1).nutriScore?.grade).toBe('C'); // general default
    const bev = computeScores(ing, 1, { nutriCategory: 'beverage' });
    expect(bev.nutriScore?.category).toBe('beverage');
    expect(bev.nutriScore?.grade).toBe('E'); // stricter beverage energy/sugar scales
    expect(bev.nutriScore?.points).toBe(12);
  });

  it('applies the non-nutritive-sweetener penalty to beverages', () => {
    const diet: ScoredIngredient[] = [{ grams: 100, nutrients: DIET_DRINK, gi: null }];
    expect(computeScores(diet, 1, { nutriCategory: 'beverage' }).nutriScore?.grade).toBe('B');
    expect(computeScores(diet, 1, { nutriCategory: 'beverage', nnsPresent: true }).nutriScore?.grade).toBe('C');
  });

  it('uses the SFA/total-fat ratio for fats (olive oil B, not the general-food D)', () => {
    const oil: ScoredIngredient[] = [{ grams: 100, nutrients: OLIVE_OIL, gi: null, fvl: true }];
    expect(computeScores(oil, 1).nutriScore?.grade).toBe('D'); // general: penalised on energy + absolute satfat
    const fat = computeScores(oil, 1, { nutriCategory: 'fat-oil-nut-seed' });
    expect(fat.nutriScore?.category).toBe('fat-oil-nut-seed');
    expect(fat.nutriScore?.points).toBe(0);
    expect(fat.nutriScore?.grade).toBe('B'); // ratio-based scoring + olive-oil FVL credit
  });
});
