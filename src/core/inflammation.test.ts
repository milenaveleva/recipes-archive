import { describe, it, expect } from 'vitest';
import { computeInflammation, inflammationBandOf, FLOOR_KCAL_PER_G } from './inflammation';
import referenceData from '../data/inflammation-reference.json';

const BANDS = (referenceData as {
  bands: { antiMax: number; mildlyAntiMax: number; neutralMax: number; mildlyProMax: number };
}).bands;

describe('inflammationBandOf (corpus-quantile bands)', () => {
  // The band edges are the quintile cut-points of the USDA per-food tag distribution,
  // generated into inflammation-reference.json. Pin them so a parameter/reference change
  // that shifts the bands is caught (and the recipes get rescored to match).
  it('pins the generated quintile band edges', () => {
    expect(BANDS).toEqual({ antiMax: -1, mildlyAntiMax: -0.3, neutralMax: 0.2, mildlyProMax: 0.7 });
  });

  it('maps a score to the band whose quintile it falls in', () => {
    expect(inflammationBandOf(BANDS.antiMax - 0.5)).toBe('anti-inflammatory');
    expect(inflammationBandOf(BANDS.antiMax)).toBe('anti-inflammatory');
    expect(inflammationBandOf(BANDS.mildlyAntiMax)).toBe('mildly-anti-inflammatory');
    expect(inflammationBandOf(0)).toBe('neutral');
    expect(inflammationBandOf(BANDS.neutralMax)).toBe('neutral');
    expect(inflammationBandOf(BANDS.mildlyProMax)).toBe('mildly-pro-inflammatory');
    expect(inflammationBandOf(BANDS.mildlyProMax + 0.1)).toBe('pro-inflammatory');
    expect(inflammationBandOf(2)).toBe('pro-inflammatory');
  });
});

describe('computeInflammation (energy-weighted)', () => {
  it('weights equal-energy items as a simple mean', () => {
    const r = computeInflammation([
      { grams: 100, energyKcal: 100, tag: -2 },
      { grams: 100, energyKcal: 100, tag: 0 },
    ])!;
    expect(r.score).toBe(-1.0);
    expect(r.band).toBe('anti-inflammatory');
  });

  it('weights by energy, not mass: a small energy-dense pro item outweighs a bulky low-energy anti one', () => {
    const r = computeInflammation([
      { grams: 200, energyKcal: 20, tag: -2 }, // bulky watery veg
      { grams: 50, energyKcal: 400, tag: 2 }, // a splash of fat
    ])!;
    // weights: max(20, 1·200)=200 vs max(400, 1·50)=400 → (−2·200 + 2·400)/600 = +0.67
    expect(r.score).toBeCloseTo(0.7, 5);
    expect(r.band).toBe('mildly-pro-inflammatory');
  });

  it('floors weight by mass so a near-zero-calorie anti food still counts', () => {
    const r = computeInflammation([{ grams: 100, energyKcal: 0, tag: -2 }])!;
    expect(r.score).toBe(-2); // weight = max(0, 1·100) = 100
  });

  it('uses the mass floor when a food’s energy is unknown (null)', () => {
    const r = computeInflammation([{ grams: 80, energyKcal: null, tag: 1 }])!;
    expect(r.score).toBe(1);
  });

  it('returns null when no item carries weight', () => {
    expect(computeInflammation([])).toBeNull();
    expect(computeInflammation([{ grams: 0, energyKcal: 0, tag: -2 }])).toBeNull();
  });

  it('pins the mass-floor calibration constant', () => {
    expect(FLOOR_KCAL_PER_G).toBe(1);
  });
});
