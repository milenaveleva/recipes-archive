import { describe, it, expect } from 'vitest';
import { computeScores, type ScoredIngredient } from './score';
import { foodClassOf } from './fii';

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

    // Inflammation: the pooled composition score (fii.ts) — present,
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
    expect(r.balance?.score).toBe(6);
    expect(r.balance?.band).toBe('moderate');
  });

  it('omits glycemic when no carbohydrate source has a GI, but still scores the rest', () => {
    const r = computeScores([{ grams: 100, nutrients: SPINACH, gi: null, fvl: true }], 2);
    expect(r.glycemic).toBeUndefined();
    expect(r.nutriScore).toBeDefined(); // glycemic omission must not suppress Nutri-Score
    expect(r.inflammation).toBeDefined();
  });

  it('reads the matched food’s class: plain yogurt’s lactose is not free sugar and its matrix correction applies', () => {
    // Without an fdcId the sugar is unclassified (Louie step 10: half free) and no matrix
    // correction applies; as fdcId 171284 (plain whole-milk yogurt) the lactose is intrinsic
    // and the fermented-milk correction applies, so the score moves anti.
    const YOGURT = { energyKcal: 61, protein_g: 3.5, fat_g: 3.25, satFat_g: 2.1, monoFat_g: 0.9, polyFat_g: 0.1, carbs_g: 4.66, sugar_g: 4.66, sodium_mg: 46 };
    const plain = computeScores([{ grams: 150, nutrients: YOGURT, gi: null }], 1);
    const classified = computeScores([{ grams: 150, nutrients: YOGURT, gi: null, fdcId: 171284 }], 1);
    expect(foodClassOf(171284)).toMatchObject({ fs: 0, matrix: 'fermented-milk' });
    expect(classified.inflammation!.score).toBeLessThan(plain.inflammation!.score);
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

describe('computeScores — mixed-meal GI and NOVA markers', () => {
  // Per-100 g vectors (USDA-like): cooked white rice and grilled chicken breast.
  const RICE = { energyKcal: 130, protein_g: 2.7, fat_g: 0.3, satFat_g: 0.1, carbs_g: 28.2, fiber_g: 0.4, sugar_g: 0.1, sodium_mg: 1 };
  const CHICKEN = { energyKcal: 165, protein_g: 31, fat_g: 3.6, satFat_g: 1, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 74 };

  it('lowers the composite GI (and GL) for protein added by a protein-dominant food', () => {
    const riceOnly = computeScores([{ grams: 300, nutrients: RICE, gi: 73 }], 2);
    expect(riceOnly.glycemic?.gi).toBe(73); // rice's own protein is inside its GI — no correction
    const withChicken = computeScores(
      [{ grams: 300, nutrients: RICE, gi: 73 }, { grams: 300, nutrients: CHICKEN, gi: 0 }],
      2,
    );
    // 93 g chicken protein / 83.4 g available carb = 1.12 g/g → factor 1 − 0.285·0.87 ≈ 0.75.
    expect(withChicken.glycemic!.gi).toBeLessThan(riceOnly.glycemic!.gi);
    expect(withChicken.glycemic!.gi).toBe(55);
    expect(withChicken.glycemic!.gl).toBeLessThan(riceOnly.glycemic!.gl);
    expect(withChicken.glycemic!.gi_source).toContain('protein-adjusted');
  });

  it('does not add the protein of a food whose measured GI already includes it (yogurt + fruit)', () => {
    const YOGURT = { energyKcal: 73, protein_g: 9.95, fat_g: 1.9, satFat_g: 1.2, carbs_g: 3.94, fiber_g: 0, sugar_g: 3.6, sodium_mg: 34 };
    const BERRIES = { energyKcal: 57, protein_g: 0.7, fat_g: 0.3, satFat_g: 0, carbs_g: 14.5, fiber_g: 2.4, sugar_g: 10, sodium_mg: 1 };
    const bowl = computeScores(
      [{ grams: 200, nutrients: YOGURT, gi: 11, giMeasured: true }, { grams: 150, nutrients: BERRIES, gi: 40, giMeasured: true }],
      1,
    );
    const noYogurtProtein = computeScores(
      [{ grams: 200, nutrients: { ...YOGURT, protein_g: 0 }, gi: 11, giMeasured: true }, { grams: 150, nutrients: BERRIES, gi: 40, giMeasured: true }],
      1,
    );
    expect(bowl.glycemic!.gi).toBe(noYogurtProtein.glycemic!.gi);
    expect(bowl.glycemic!.gi).toBe(31); // plain carb-weighted composite (11·7.9 + 40·18.2) / 26.0
  });

  it('still adds protein from fish, eggs and tofu (outside the composite or nominal GI)', () => {
    const rice = computeScores([{ grams: 300, nutrients: RICE, gi: 73 }], 2).glycemic!.gi;
    const FISH = { energyKcal: 208, protein_g: 20.4, fat_g: 13.4, satFat_g: 3, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 59 };
    const EGG = { energyKcal: 143, protein_g: 12.6, fat_g: 9.5, satFat_g: 3.1, carbs_g: 0.72, fiber_g: 0, sugar_g: 0.37, sodium_mg: 142 };
    const TOFU = { energyKcal: 144, protein_g: 17.3, fat_g: 8.7, satFat_g: 1.3, carbs_g: 2.78, fiber_g: 2.3, sugar_g: 0.6, sodium_mg: 14 };
    for (const [name, n, gi] of [['fish', FISH, 0], ['egg', EGG, 15], ['tofu', TOFU, 15]] as const) {
      const r = computeScores([{ grams: 300, nutrients: RICE, gi: 73 }, { grams: 300, nutrients: n, gi, giMeasured: false }], 2);
      expect(r.glycemic!.gi, name).toBeLessThan(rice);
    }
  });

  it('ignores the protein of a food with no carbohydrate data', () => {
    const rice = computeScores([{ grams: 300, nutrients: RICE, gi: 73 }], 2).glycemic!.gi;
    const { carbs_g: _c, ...noCarb } = CHICKEN;
    const r = computeScores([{ grams: 300, nutrients: RICE, gi: 73 }, { grams: 300, nutrients: noCarb, gi: null }], 2);
    expect(r.glycemic!.gi).toBe(rice);
  });

  it('reports the measured-GI share from the per-food giMeasured flag', () => {
    const r = computeScores(
      [
        { grams: 300, nutrients: RICE, gi: 73, giMeasured: true },
        { grams: 100, nutrients: RICE, gi: 60, giMeasured: false },
      ],
      2,
    );
    expect(r.glycemic?.measuredGiPct).toBe(75);
  });

  it('promotes a food to a higher NOVA group from processing markers in its original line', () => {
    const plain = computeScores([{ grams: 200, nutrients: RICE, nova: 1, raw: '200 g rice' }], 1);
    expect(plain.processing?.ultraProcessedPct).toBe(0);
    const marked = computeScores([{ grams: 200, nutrients: RICE, nova: 1, raw: '200 g instant noodles' }], 1);
    expect(marked.processing?.ultraProcessedPct).toBe(100);
    expect(marked.processing?.band).toBe('highly-processed');
  });
});
