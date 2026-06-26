import { describe, it, expect } from 'vitest';
import { foodFII } from './fii';
import type { NutrientVector } from './types';
import usdaFoods from '../data/usda-foods.json';
import polyphenols from '../data/polyphenols.json';

describe('foodFII (per-food inflammatory potential)', () => {
  it('returns null when no parameter is present', () => {
    expect(foodFII(null)).toBeNull();
    expect(foodFII({})).toBeNull();
    expect(foodFII({ protein_g: 10, carbs_g: 5 })).toBeNull(); // no FII parameter
  });

  it('keeps every score within the −2…+2 axis', () => {
    const extremePro: NutrientVector = { fat_g: 100, satFat_g: 100, transFat_g: 20, sugar_g: 100, sodium_mg: 40000 };
    const extremeAnti: NutrientVector = { fat_g: 100, monoFat_g: 80, polyFat_g: 20, fiber_g: 80, vitC_mg: 1000, magnesium_mg: 800, polyphenol_mg: 5000 };
    expect(foodFII(extremePro)!.tag).toBeLessThanOrEqual(2);
    expect(foodFII(extremePro)!.tag).toBeGreaterThan(0);
    expect(foodFII(extremeAnti)!.tag).toBeGreaterThanOrEqual(-2);
    expect(foodFII(extremeAnti)!.tag).toBeLessThan(0);
  });

  it('scores fat as one quality term — unsaturated fat is anti, the same mass as saturated is pro', () => {
    const goodFat: NutrientVector = { fat_g: 100, monoFat_g: 73, polyFat_g: 10, satFat_g: 14 };
    const badFat: NutrientVector = { fat_g: 100, monoFat_g: 5, polyFat_g: 5, satFat_g: 90 };
    expect(foodFII(goodFat)!.tag).toBeLessThan(foodFII(badFat)!.tag);
  });

  it('fibre pushes a food more anti-inflammatory', () => {
    const base: NutrientVector = { satFat_g: 1, monoFat_g: 1, polyFat_g: 1, sodium_mg: 50 };
    expect(foodFII({ ...base, fiber_g: 15 })!.tag).toBeLessThan(foodFII(base)!.tag);
  });

  it('polyphenols push a food more anti-inflammatory', () => {
    const veg: NutrientVector = { fiber_g: 2, satFat_g: 0.1, monoFat_g: 0, polyFat_g: 0.1, sugar_g: 2, sodium_mg: 30 };
    expect(foodFII({ ...veg, polyphenol_mg: 500 })!.tag).toBeLessThan(foodFII(veg)!.tag);
  });

  it('reports coverage as the fraction of parameters present', () => {
    const sparse = foodFII({ sugar_g: 50 })!; // 1 of 8 parameters
    const rich = foodFII({ fiber_g: 5, monoFat_g: 2, satFat_g: 1, vitC_mg: 10, magnesium_mg: 40, sugar_g: 3, sodium_mg: 20 })!;
    expect(sparse.coverage).toBeLessThan(rich.coverage);
    expect(sparse.coverage).toBeCloseTo(1 / 8, 5);
  });

  // Pin the whole pipeline (parameters + committed reference distribution + engine) to a
  // few real foods, so re-tuning weights or regenerating the reference can't silently
  // shift recipe scores without updating these expectations (and rescoring recipes).
  it('pins representative real foods to the committed reference', () => {
    const byId = new Map((usdaFoods as { fdcId: number; n: NutrientVector }[]).map((f) => [f.fdcId, f]));
    const poly = polyphenols as Record<string, { polyphenol_mg?: number }>;
    const tagOf = (fdcId: number): number => {
      const food = byId.get(fdcId)!;
      const p = poly[String(fdcId)]?.polyphenol_mg;
      const n: NutrientVector = p != null ? { ...food.n, polyphenol_mg: p } : food.n;
      return foodFII(n)!.tag;
    };
    expect(tagOf(173410)).toBe(1.7); // butter, salted → pro
    expect(tagOf(170173)).toBe(1.7); // coconut milk (saturated fat) → pro
    expect(tagOf(169655)).toBe(1.5); // granulated sugar → pro
    expect(tagOf(171413)).toBe(-1.2); // olive oil (MUFA) → anti
    expect(tagOf(170187)).toBe(-2); // walnuts (PUFA + fibre + Mg) → anti
    expect(tagOf(168462)).toBe(-1.5); // spinach (+ polyphenol seed) → anti
  });
});
