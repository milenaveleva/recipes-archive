import { describe, it, expect } from 'vitest';
import { aromaticAdjustment, aromaticOf, AROMATIC_K, AROMATIC_MAX_TOTAL } from './aromatics';
import { computeScores } from './score';

const GINGER = 169231; // Ginger root, raw (dose 5 g / serving)
const GINGER_GROUND = 170926; // Spices, ginger, ground (dose 1.2 g / serving)
const TURMERIC = 172231; // Spices, turmeric, ground (dose 1 g / serving)
const GARLIC = 169230; // Garlic, raw (dose 3 g / serving)
const ONION = 170000; // Onions, raw (dose 40 g / serving)
const PEPPER = 170931; // Spices, pepper, black (dose 0.5 g / serving)

describe('aromaticAdjustment', () => {
  it('pins the calibration constants and the Shivappa 2014 effect scores', () => {
    expect(AROMATIC_K).toBe(0.5);
    expect(AROMATIC_MAX_TOTAL).toBe(0.5);
    expect(aromaticOf(TURMERIC)?.effect).toBe(-0.785);
    expect(aromaticOf(GINGER)?.effect).toBe(-0.453);
    expect(aromaticOf(GARLIC)?.effect).toBe(-0.412);
    expect(aromaticOf(ONION)?.effect).toBe(-0.301);
    expect(aromaticOf(PEPPER)?.effect).toBe(-0.131);
    expect(aromaticOf(173410)).toBeNull(); // butter is not an aromatic
  });

  it('is 0 without aromatics, servings or weight', () => {
    expect(aromaticAdjustment([], 4)).toBe(0);
    expect(aromaticAdjustment([{ fdcId: 173410, grams: 50 }], 4)).toBe(0);
    expect(aromaticAdjustment([{ fdcId: GINGER, grams: 20 }], 0)).toBe(0);
    expect(aromaticAdjustment([{ fdcId: GINGER, grams: null }], 4)).toBe(0);
  });

  it('scales with the dose per serving and saturates at one typical dose', () => {
    const at = (g: number) => aromaticAdjustment([{ fdcId: GINGER, grams: g }], 4);
    expect(at(10)).toBe(-0.11); // 2.5 g/serving = ½ dose → 0.5 · −0.453 · 0.5
    expect(at(20)).toBe(-0.23); // one dose → 0.5 · −0.453
    expect(at(400)).toBe(at(20)); // beyond a dose adds nothing
    // Monotone non-increasing in grams.
    let prev = 0;
    for (let g = 0; g <= 40; g += 1) {
      const d = at(g);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });

  it('adds forms of one aromatic before saturating', () => {
    const fresh = aromaticAdjustment([{ fdcId: GINGER, grams: 10 }], 4); // ½ dose
    const both = aromaticAdjustment([{ fdcId: GINGER, grams: 10 }, { fdcId: GINGER_GROUND, grams: 2.4 }], 4); // ½ + ½
    expect(both).toBeLessThan(fresh);
    expect(both).toBe(aromaticAdjustment([{ fdcId: GINGER, grams: 20 }], 4));
  });

  it('never exceeds the total cap, however many aromatics', () => {
    const all = aromaticAdjustment(
      [TURMERIC, GINGER, GARLIC, ONION, PEPPER].map((fdcId) => ({ fdcId, grams: 1000 })),
      1,
    );
    expect(all).toBe(-AROMATIC_MAX_TOTAL);
  });

  it('credits a ginger-sweetened drink without erasing its free-sugar load', () => {
    const HONEY = { energyKcal: 304, sugar_g: 82.1, fiber_g: 0.2, sodium_mg: 4, magnesium_mg: 2, vitC_mg: 0.5, vitE_mg: 0, monoFat_g: 0, polyFat_g: 0, satFat_g: 0 };
    const GINGER_N = { energyKcal: 80, sugar_g: 1.7, fiber_g: 2, sodium_mg: 13, magnesium_mg: 43, vitC_mg: 5, vitE_mg: 0.26, monoFat_g: 0.15, polyFat_g: 0.15, satFat_g: 0.2 };
    const drink = [
      { grams: 130, nutrients: HONEY, gi: null },
      { grams: 200, nutrients: GINGER_N, fdcId: GINGER, gi: null },
    ];
    const withCredit = computeScores(drink, 4).inflammation!;
    const withoutCredit = computeScores(drink.map((d) => ({ ...d, fdcId: null })), 4).inflammation!;
    expect(withCredit.aromaticAdjustment).toBe(-0.23);
    expect(withCredit.score).toBeLessThan(withoutCredit.score);
    expect(withCredit.score).toBeGreaterThan(0); // still pro: the honey dominates
  });

  it('reads the as-written weight (rawGrams), not the cooked mass', () => {
    const N = { energyKcal: 40, fiber_g: 1.7, sugar_g: 4.2, sodium_mg: 4 };
    const asWritten = computeScores([{ grams: 25, rawGrams: 40, nutrients: N, fdcId: ONION, gi: null }], 1);
    expect(asWritten.inflammation!.aromaticAdjustment).toBe(-0.15); // one 40 g dose → 0.5 · −0.301
  });
});
