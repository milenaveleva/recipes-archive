import { describe, it, expect } from 'vitest';
import { foodFII, MIN_KCAL_PER_100G } from './fii';
import type { NutrientVector } from './types';
import usdaFoods from '../data/usda-foods.json';
import polyphenols from '../data/polyphenols.json';

describe('foodFII (per-food inflammatory potential)', () => {
  it('returns null when no parameter is present', () => {
    expect(foodFII(null)).toBeNull();
    expect(foodFII({})).toBeNull();
    expect(foodFII({ energyKcal: 80, protein_g: 10, carbs_g: 5 })).toBeNull(); // no FII parameter
  });

  it('returns null without an energy value to convert by (per-100-kcal basis)', () => {
    expect(foodFII({ fiber_g: 5, sugar_g: 3, sodium_mg: 20 })).toBeNull();
  });

  it('scores per 100 kcal: pure water gain or loss leaves the tag unchanged', () => {
    // Boiling dry pasta to ~2.1× its mass divides every per-100 g value (energy included)
    // by 2.1; on the per-kcal basis that cancels exactly.
    const dry: NutrientVector = { energyKcal: 352, fiber_g: 9.2, magnesium_mg: 143, monoFat_g: 0.3, polyFat_g: 0.9, satFat_g: 0.4, sugar_g: 2.7, sodium_mg: 8, vitE_mg: 0.4 };
    const cooked = Object.fromEntries(Object.entries(dry).map(([k, v]) => [k, (v as number) / 2.1])) as NutrientVector;
    expect(foodFII(cooked)).toEqual(foodFII(dry));
  });

  it('converts a near-zero-energy food against the energy floor, so it stays finite and bounded', () => {
    expect(MIN_KCAL_PER_100G).toBe(20);
    // Below the floor the per-kcal value is read against the floor: 6 and 10 kcal score alike.
    const herb = { fiber_g: 1, vitC_mg: 10, magnesium_mg: 10, sodium_mg: 10 };
    expect(foodFII({ ...herb, energyKcal: 6 })).toEqual(foodFII({ ...herb, energyKcal: 10 }));
    // Water (energy-free, sodium-free) is neutral: no tag at all.
    expect(foodFII({ energyKcal: 0, fiber_g: 0, magnesium_mg: 2, sodium_mg: 2, sugar_g: 0, vitC_mg: 0 })).toBeNull();
  });

  it('keeps every score within the −2…+2 axis', () => {
    const extremePro: NutrientVector = { energyKcal: 900, fat_g: 100, satFat_g: 100, transFat_g: 20, sugar_g: 100, sodium_mg: 40000 };
    const extremeAnti: NutrientVector = { energyKcal: 900, fat_g: 100, monoFat_g: 80, polyFat_g: 20, fiber_g: 80, vitC_mg: 1000, magnesium_mg: 800, polyphenol_mg: 5000 };
    expect(foodFII(extremePro)!.tag).toBeLessThanOrEqual(2);
    expect(foodFII(extremePro)!.tag).toBeGreaterThan(0);
    expect(foodFII(extremeAnti)!.tag).toBeGreaterThanOrEqual(-2);
    expect(foodFII(extremeAnti)!.tag).toBeLessThan(0);
  });

  it('scores fat as one quality term — unsaturated fat is anti, the same mass as saturated is pro', () => {
    const goodFat: NutrientVector = { energyKcal: 884, fat_g: 100, monoFat_g: 73, polyFat_g: 10, satFat_g: 14 };
    const badFat: NutrientVector = { energyKcal: 884, fat_g: 100, monoFat_g: 5, polyFat_g: 5, satFat_g: 90 };
    expect(foodFII(goodFat)!.tag).toBeLessThan(foodFII(badFat)!.tag);
  });

  it('fibre pushes a food more anti-inflammatory', () => {
    const base: NutrientVector = { energyKcal: 150, satFat_g: 1, monoFat_g: 1, polyFat_g: 1, sodium_mg: 50 };
    expect(foodFII({ ...base, fiber_g: 15 })!.tag).toBeLessThan(foodFII(base)!.tag);
  });

  it('polyphenols push a food more anti-inflammatory', () => {
    const veg: NutrientVector = { energyKcal: 40, fiber_g: 2, satFat_g: 0.1, monoFat_g: 0, polyFat_g: 0.1, sugar_g: 2, sodium_mg: 30 };
    expect(foodFII({ ...veg, polyphenol_mg: 500 })!.tag).toBeLessThan(foodFII(veg)!.tag);
  });

  it('reports coverage as the fraction of parameters present', () => {
    const sparse = foodFII({ energyKcal: 200, sugar_g: 50 })!; // 1 of 8 parameters
    const rich = foodFII({ energyKcal: 150, fiber_g: 5, monoFat_g: 2, satFat_g: 1, vitC_mg: 10, magnesium_mg: 40, sugar_g: 3, sodium_mg: 20 })!;
    expect(sparse.coverage).toBeLessThan(rich.coverage);
    expect(sparse.coverage).toBeCloseTo(1 / 8, 5);
  });

  it('shrinks a data-poor food toward neutral: below quorum coverage it can not reach ±2', () => {
    // Only free-sugar + sodium present → 2/8 params (0.25 coverage); the tag bound is
    // 2·(0.25/0.5) = 1.0, so even overwhelming pro signals can't pin it to the +2 extreme.
    const sparse = foodFII({ energyKcal: 360, sugar_g: 90, sodium_mg: 5000 })!;
    expect(sparse.coverage).toBeCloseTo(2 / 8, 5);
    expect(sparse.tag).toBeGreaterThan(0);
    expect(sparse.tag).toBeLessThanOrEqual(1.0);
  });

  // Pin the whole pipeline (parameters + committed reference distribution + engine) to a
  // few real foods, so re-tuning weights or regenerating the reference can't silently
  // shift recipe scores without updating these expectations (and rescoring recipes).
  const byId = new Map((usdaFoods as { fdcId: number; n: NutrientVector }[]).map((f) => [f.fdcId, f]));
  const poly = polyphenols as Record<string, { polyphenol_mg?: number }>;
  const tagOf = (fdcId: number): number => {
    const food = byId.get(fdcId)!;
    const p = poly[String(fdcId)]?.polyphenol_mg;
    const n: NutrientVector = p != null ? { ...food.n, polyphenol_mg: p } : food.n;
    return foodFII(n)!.tag;
  };

  it('pins representative real foods to the committed reference', () => {
    expect(tagOf(173410)).toBe(1.7); // butter, salted → pro
    expect(tagOf(170173)).toBe(1.9); // coconut milk (saturated fat) → pro
    expect(tagOf(169655)).toBe(1.5); // granulated sugar (no fibre → all free sugar) → pro
    expect(tagOf(171413)).toBe(-0.6); // olive oil (MUFA + Phenol-Explorer polyphenol) → anti
    expect(tagOf(170187)).toBe(-0.7); // walnuts (PUFA + fibre + Mg + polyphenol, energy-dense) → anti
    expect(tagOf(168462)).toBe(-2); // spinach (nutrient-dense per kcal + polyphenol) → anti
  });

  it('scores dry and cooked records of the same food alike (energy basis)', () => {
    expect(tagOf(82009870)).toBe(tagOf(82009871)); // whole-wheat pasta, dry vs cooked
    expect(tagOf(169738)).toBe(tagOf(168910)); // whole-wheat pasta (FDP), dry vs cooked
  });

  it('reads watery herbs and roots by their per-kcal density, not their water', () => {
    const pasta = tagOf(169738);
    expect(tagOf(170416)).toBeLessThan(pasta); // parsley, fresh
    expect(tagOf(169231)).toBeLessThan(pasta); // ginger root, raw
    expect(tagOf(170416)).toBe(-1.9);
    expect(tagOf(169231)).toBe(-0.3);
  });

  it('keeps honey pro (free sugar) and salt pro through its sodium', () => {
    expect(tagOf(169640)).toBeGreaterThan(1); // honey
    const salt = tagOf(173468);
    expect(salt).toBeGreaterThan(0);
    // Plain water carries no inflammatory signal (neutral, no tag); salt reads pro via sodium.
    expect(foodFII(byId.get(174158)!.n)).toBeNull();
  });
});

describe('foodFII neutral energy-free foods', () => {
  it('scores water as neutral (no tag) but still scores salt via sodium', () => {
    expect(foodFII({ energyKcal: 0, sodium_mg: 4, water_g: 100 } as never)).toBeNull();
    const salt = foodFII({ energyKcal: 0, sodium_mg: 38758 } as never);
    expect(salt).not.toBeNull();
    expect(salt!.tag).toBeGreaterThan(0);
  });
});
