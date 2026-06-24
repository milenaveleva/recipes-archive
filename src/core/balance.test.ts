import { describe, it, expect } from 'vitest';
import { computeBalance, balanceScoreOf, balanceBandOf, type BalanceInput } from './balance';

/** A zero-filled per-100g basis; tests set only the fields they exercise. */
const base = (over: Partial<BalanceInput>): BalanceInput => ({
  energyKcalPer100g: 100,
  protein_g: 0,
  fiber_g: 0,
  vitA_ug: 0,
  vitC_mg: 0,
  vitE_mg: 0,
  calcium_mg: 0,
  iron_mg: 0,
  potassium_mg: 0,
  magnesium_mg: 0,
  satFat_g: 0,
  sugar_g: 0,
  sodium_mg: 0,
  ...over,
});

describe('balanceScoreOf (NRF → 1–10 breakpoints [0,10,20,35,55,85,125,185,280])', () => {
  it('maps a net-negative balance to 1 and climbs by breakpoint', () => {
    expect(balanceScoreOf(-1)).toBe(1);
    expect(balanceScoreOf(-500)).toBe(1);
    expect(balanceScoreOf(0)).toBe(2);
    expect(balanceScoreOf(9.9)).toBe(2);
    expect(balanceScoreOf(10)).toBe(3);
    expect(balanceScoreOf(34)).toBe(4);
    expect(balanceScoreOf(35)).toBe(5); // p50≈39 of the food set → mid-scale
    expect(balanceScoreOf(84)).toBe(6);
    expect(balanceScoreOf(85)).toBe(7);
    expect(balanceScoreOf(184)).toBe(8);
    expect(balanceScoreOf(185)).toBe(9);
    expect(balanceScoreOf(279)).toBe(9);
    expect(balanceScoreOf(280)).toBe(10);
    expect(balanceScoreOf(10_000)).toBe(10); // clamped by the breakpoint count
  });

  it('treats a non-finite NRF as the floor', () => {
    expect(balanceScoreOf(NaN)).toBe(1);
  });
});

describe('balanceBandOf', () => {
  it('labels 1–2 poor, 3–4 low, 5–6 moderate, 7–8 high, 9–10 excellent', () => {
    expect([1, 2].map(balanceBandOf)).toEqual(['poor', 'poor']);
    expect([3, 4].map(balanceBandOf)).toEqual(['low', 'low']);
    expect([5, 6].map(balanceBandOf)).toEqual(['moderate', 'moderate']);
    expect([7, 8].map(balanceBandOf)).toEqual(['high', 'high']);
    expect([9, 10].map(balanceBandOf)).toEqual(['excellent', 'excellent']);
  });
});

describe('computeBalance — NRF9.3 per 100 kcal', () => {
  it('scores raw spinach (nutrient-dense, low-energy) at the top of the scale', () => {
    const r = computeBalance(
      base({
        energyKcalPer100g: 23,
        protein_g: 2.86,
        fiber_g: 2.2,
        vitA_ug: 469,
        vitC_mg: 28.1,
        vitE_mg: 2.03,
        calcium_mg: 99,
        iron_mg: 2.71,
        potassium_mg: 558,
        magnesium_mg: 79,
        satFat_g: 0.063,
        sugar_g: 0.42,
        sodium_mg: 79,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.nrf).toBeCloseTo(529.9, 0); // qualifying ~550 − LIM ~20
    expect(r!.score).toBe(10);
    expect(r!.band).toBe('excellent');
    expect(r!.version).toBe('NRF9.3');
  });

  it('scores olive oil (energy-dense, sat-fat) poorly', () => {
    const r = computeBalance(
      base({ energyKcalPer100g: 884, vitE_mg: 14.35, satFat_g: 13.8 }),
    );
    expect(r!.score).toBe(2); // little nutrient density per kcal, sat-fat limit bites
    expect(r!.band).toBe('poor');
  });

  it('caps each encouraged nutrient at 100% DV', () => {
    const oneDv = computeBalance(base({ protein_g: 50 })); // 100% DV protein at 100 kcal/100g
    const tenDv = computeBalance(base({ protein_g: 500 })); // 1000% DV — must not exceed the cap
    expect(oneDv!.nrf).toBeCloseTo(100, 5);
    expect(tenDv!.nrf).toBeCloseTo(100, 5); // capped, identical to a single DV
    expect(oneDv!.score).toBe(7);
  });

  it('normalises by energy density (per 100 kcal, not per 100 g)', () => {
    // Same protein per 100 g, but twice the energy density → half the %DV per 100 kcal.
    const lean = computeBalance(base({ energyKcalPer100g: 100, protein_g: 50 }));
    const rich = computeBalance(base({ energyKcalPer100g: 200, protein_g: 50 }));
    expect(lean!.nrf).toBeCloseTo(100, 5);
    expect(rich!.nrf).toBeCloseTo(50, 5);
  });

  it('penalises the limited nutrients (sat fat, total sugar, sodium)', () => {
    // 5000 mg sodium per 100 kcal = 217% MRV → net negative → floor score.
    const r = computeBalance(base({ sodium_mg: 5000 }));
    expect(r!.nrf).toBeCloseTo(-217.4, 0);
    expect(r!.score).toBe(1);
    expect(r!.band).toBe('poor');
  });

  it('returns null when there is no usable energy basis', () => {
    expect(computeBalance(base({ energyKcalPer100g: 0 }))).toBeNull();
    expect(computeBalance(base({ energyKcalPer100g: -5 }))).toBeNull();
    expect(computeBalance(base({ energyKcalPer100g: NaN }))).toBeNull();
  });
});
