import { describe, it, expect } from 'vitest';
import { computeMacros } from './nutrition';
import type { ResolvedIngredient } from './types';

describe('computeMacros', () => {
  const foodA: ResolvedIngredient = {
    grams: 200,
    nutrients: {
      energyKcal: 100,
      protein_g: 10,
      carbs_g: 20,
      fiber_g: 5,
      sugar_g: 2,
      fat_g: 1,
      satFat_g: 0.5,
      sodium_mg: 100,
    },
  };
  const foodB: ResolvedIngredient = {
    grams: 100,
    nutrients: { energyKcal: 50, protein_g: 2, carbs_g: 4, fiber_g: 2, sodium_mg: 50 },
  };

  it('sums mass-weighted nutrients and divides by servings', () => {
    const { perServing, totals, totalGrams, contributingCount } = computeMacros(
      [foodA, foodB],
      2,
    );
    // Totals: kcal 250, protein 22, carbs 44, fiber 12, sugar 4, fat 2, sat 1, sodium 250
    expect(totals.energyKcal).toBe(250);
    expect(totalGrams).toBe(300);
    expect(contributingCount).toBe(2);

    expect(perServing.energyKcal).toBe(125);
    expect(perServing.energyKj).toBe(523); // 1046 kJ / 2, rounded
    expect(perServing.protein_g).toBe(11);
    expect(perServing.carbs_g).toBe(22);
    expect(perServing.fiber_g).toBe(6);
    expect(perServing.sugar_g).toBe(2);
    expect(perServing.fat_g).toBe(1);
    expect(perServing.satFat_g).toBe(0.5);
    expect(perServing.sodium_mg).toBe(125);
  });

  it('derives available carbohydrate as carbs − fibre − polyols', () => {
    // (20·2 + 4·1) − (5·2 + 2·1) = 44 − 12 = 32 total → 16 per serving
    const { perServing } = computeMacros([foodA, foodB], 2);
    expect(perServing.availableCarb_g).toBe(16);
  });

  it('subtracts polyols from available carbohydrate when present', () => {
    const sweetened: ResolvedIngredient = {
      grams: 100,
      nutrients: { carbs_g: 50, fiber_g: 0, polyol_g: 20 },
    };
    const { perServing } = computeMacros([sweetened], 1);
    expect(perServing.availableCarb_g).toBe(30); // 50 − 0 − 20
    // polyols are not emitted as a standalone macro field
    expect('polyol_g' in perServing).toBe(false);
  });

  it('floors available carbohydrate per ingredient, so one over-fibred match cannot eat another food carbs', () => {
    const fiberSupplement: ResolvedIngredient = {
      grams: 100,
      nutrients: { carbs_g: 5, fiber_g: 20 }, // net would be −15
    };
    const bread: ResolvedIngredient = { grams: 100, nutrients: { carbs_g: 40, fiber_g: 0 } };
    const { perServing } = computeMacros([fiberSupplement, bread], 1);
    expect(perServing.availableCarb_g).toBe(40); // max(0,−15) + 40, not 25
  });

  it('omits available carbohydrate when no food reports carbohydrate', () => {
    const fiberOnly: ResolvedIngredient = { grams: 100, nutrients: { fiber_g: 5, polyol_g: 2 } };
    const { perServing } = computeMacros([fiberOnly], 1);
    expect('availableCarb_g' in perServing).toBe(false);
  });

  it('counts weighed-but-unweighable and zero-gram ingredients as missing data', () => {
    const countUnit: ResolvedIngredient = { grams: null, nutrients: null }; // "2 cloves garlic"
    const zeroGram: ResolvedIngredient = { grams: 0, nutrients: { energyKcal: 10 } };
    const { contributingCount, missingDataCount } = computeMacros(
      [foodA, countUnit, zeroGram],
      1,
    );
    expect(contributingCount).toBe(1);
    expect(missingDataCount).toBe(2);
  });

  it('skips excluded ingredients and flags weighed-but-unmatched ones', () => {
    const water: ResolvedIngredient = { grams: 500, excludeFromNutrition: true };
    const unmatched: ResolvedIngredient = { grams: 50, nutrients: null };
    const { contributingCount, missingDataCount, totalGrams } = computeMacros(
      [foodA, water, unmatched],
      1,
    );
    expect(contributingCount).toBe(1);
    expect(missingDataCount).toBe(1);
    expect(totalGrams).toBe(200);
  });

  it('omits a macro field entirely absent from all foods', () => {
    const { perServing } = computeMacros([foodB], 1); // foodB has no fat/sugar/satFat
    expect('fat_g' in perServing).toBe(false);
    expect('sugar_g' in perServing).toBe(false);
    expect('satFat_g' in perServing).toBe(false);
    expect(perServing.protein_g).toBe(2);
  });

  it('derives kcal from kJ when only kJ is supplied', () => {
    const kjOnly: ResolvedIngredient = { grams: 100, nutrients: { energyKj: 418.4 } };
    const { perServing } = computeMacros([kjOnly], 1);
    expect(perServing.energyKcal).toBe(100);
    expect(perServing.energyKj).toBe(418);
  });

  it('coerces a zero/invalid serving count to 1', () => {
    const { perServing, totals } = computeMacros([foodA], 0);
    expect(perServing.energyKcal).toBe(totals.energyKcal);
  });
});
