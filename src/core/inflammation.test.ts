import { describe, it, expect } from 'vitest';
import { computeInflammation, computeInflammationDetail, inflammationBandOf } from './inflammation';
import { PARAMS, type FiiItem } from './fii';
import referenceData from '../data/inflammation-reference.json';

const BANDS = (referenceData as unknown as {
  bands: { antiMax: number; mildlyAntiMax: number; neutralMax: number; mildlyProMax: number };
}).bands;

const VEG: FiiItem = { grams: 300, nutrients: { energyKcal: 25, fiber_g: 2.5, vitC_mg: 40, vitE_mg: 1.5, magnesium_mg: 30, sugar_g: 2, satFat_g: 0.05, sodium_mg: 20, luteinZeaxanthin_ug: 2000 } };
const SUGAR: FiiItem = { grams: 50, nutrients: { energyKcal: 387, sugar_g: 99.8, fiber_g: 0, vitC_mg: 0, vitE_mg: 0, magnesium_mg: 0, satFat_g: 0, sodium_mg: 1 }, fdcId: 169655 };

describe('inflammationBandOf (fixed bands about the reference zero point)', () => {
  it('copies the fixed band edges from the parameter table', () => {
    expect(BANDS).toEqual(PARAMS.bands);
    expect(BANDS).toEqual({ antiMax: -1, mildlyAntiMax: -0.3, neutralMax: 0.3, mildlyProMax: 1 });
  });

  it('maps a score to its band', () => {
    expect(inflammationBandOf(-1.5)).toBe('anti-inflammatory');
    expect(inflammationBandOf(-1)).toBe('anti-inflammatory');
    expect(inflammationBandOf(-0.3)).toBe('mildly-anti-inflammatory');
    expect(inflammationBandOf(0)).toBe('neutral');
    expect(inflammationBandOf(0.3)).toBe('neutral');
    expect(inflammationBandOf(1)).toBe('mildly-pro-inflammatory');
    expect(inflammationBandOf(1.1)).toBe('pro-inflammatory');
  });
});

describe('computeInflammation (pooled dish composition)', () => {
  it('returns null when nothing can be scored', () => {
    expect(computeInflammation([])).toBeNull();
    expect(computeInflammation([{ grams: 500, nutrients: { energyKcal: 0, sodium_mg: 2 } }])).toBeNull(); // water
  });

  it('ignores water: diluting a dish with water leaves its score unchanged', () => {
    const water: FiiItem = { grams: 1000, nutrients: { energyKcal: 0, sodium_mg: 2, magnesium_mg: 1 } };
    expect(computeInflammation([VEG, SUGAR, water])!.score).toBe(computeInflammation([VEG, SUGAR])!.score);
  });

  it('moves a dish pro as its free sugar rises', () => {
    const a = computeInflammation([VEG, { ...SUGAR, grams: 5 }])!.score;
    const b = computeInflammation([VEG, { ...SUGAR, grams: 50 }])!.score;
    expect(b).toBeGreaterThan(a);
  });

  it('adds the aromatic adjustment and reports it; a non-negative adjustment is ignored', () => {
    const base = computeInflammation([VEG, SUGAR])!.score;
    const adj = computeInflammation([VEG, SUGAR], -0.3)!;
    expect(adj.aromaticAdjustment).toBe(-0.3);
    expect(adj.score).toBeCloseTo(Math.max(-2, base - 0.3), 1);
    expect(computeInflammation([VEG, SUGAR], 0.4)!.score).toBe(base);
  });

  it('exposes the per-parameter breakdown behind a score', () => {
    const d = computeInflammationDetail([VEG, SUGAR])!;
    expect(d.contributions.map((c) => c.key)).toContain('freeSugar');
    expect(d.contributions.find((c) => c.key === 'freeSugar')!.push).toBeGreaterThan(0);
  });
});

describe('dietary-AGE and ultra-processing adjustments', () => {
  const SALMON = { energyKcal: 120, satFat_g: 1, sodium_mg: 60, vitE_mg: 0.2, magnesium_mg: 25, fiber_g: 0, vitC_mg: 0 };
  it('penalises dry-heat cooking of fish more than boiling, within its cap', async () => {
    const { ageAdjustment, PARAMS: P } = await import('./fii');
    const salmon = 175167; // Atlantic salmon, farmed, raw (fish takes the meat class)
    const boiled = ageAdjustment([{ grams: 200, nutrients: SALMON, fdcId: salmon, cooking: 'boiled' }]);
    const fried = ageAdjustment([{ grams: 200, nutrients: SALMON, fdcId: salmon, cooking: 'fried' }]);
    expect(fried).toBeGreaterThan(boiled);
    expect(fried).toBeLessThanOrEqual(P.ageAdjustment.max);
  });

  it('rises with the ultra-processed energy share, and is zero below its floor', async () => {
    const { upfAdjustment, PARAMS: P } = await import('./fii');
    const N = { energyKcal: 200 };
    expect(upfAdjustment([{ grams: 100, nutrients: N, nova: 1 }])).toBe(0);
    expect(upfAdjustment([{ grams: 100, nutrients: N, nova: 4 }])).toBe(P.upfAdjustment.max);
  });
});
