import { describe, it, expect } from 'vitest';
import {
  computeGlycemics,
  giBandOf,
  glBandOf,
  proteinCorrectionFactor,
  MAX_PROTEIN_REDUCTION,
  PROTEIN_SLOPE,
  PROTEIN_THRESHOLD,
} from './gi';

describe('GI / GL bands', () => {
  it('classifies GI: low ≤55, medium 56–69, high ≥70', () => {
    expect(giBandOf(55)).toBe('low');
    expect(giBandOf(56)).toBe('medium');
    expect(giBandOf(69)).toBe('medium');
    expect(giBandOf(70)).toBe('high');
  });
  it('classifies per-serving GL with meal bands: low <20, medium 20–39, high ≥40', () => {
    expect(glBandOf(0)).toBe('low');
    expect(glBandOf(19)).toBe('low');
    expect(glBandOf(20)).toBe('medium');
    expect(glBandOf(39)).toBe('medium');
    expect(glBandOf(40)).toBe('high');
    expect(glBandOf(75)).toBe('high');
  });
});

describe('computeGlycemics', () => {
  it('carb-weights the composite GI and divides GL per serving', () => {
    // potato: 30 g avail carb @ GI 78; lentils: 20 g @ GI 32.
    const g = computeGlycemics(
      [
        { availableCarb_g: 30, gi: 78 },
        { availableCarb_g: 20, gi: 32 },
      ],
      2,
    )!;
    // Σ(GI·carb)=2980, carb=50 → GI 59.6→60; total GL 29.8 ÷ 2 = 14.9→15.
    expect(g.gi).toBe(60);
    expect(g.gl).toBe(15);
    expect(g.giBand).toBe('medium');
    expect(g.glBand).toBe('low'); // 15 per serving is a low-GL meal
  });

  it('ignores carbohydrate from foods without a published GI', () => {
    const g = computeGlycemics(
      [
        { availableCarb_g: 25, gi: 70 },
        { availableCarb_g: 100, gi: null }, // unknown GI → excluded entirely
      ],
      1,
    )!;
    expect(g.gi).toBe(70); // composite is only the GI-known source
    expect(g.gl).toBe(18); // 70×25/100 = 17.5 → 18
  });

  it('returns null when no carbohydrate source has a known GI', () => {
    expect(computeGlycemics([{ availableCarb_g: 50, gi: null }], 4)).toBeNull();
    expect(computeGlycemics([], 4)).toBeNull();
  });

  it('excludes near-carb-free foods from the denominator', () => {
    const g = computeGlycemics(
      [
        { availableCarb_g: 0.2, gi: 15 }, // below epsilon → ignored
        { availableCarb_g: 40, gi: 50 },
      ],
      1,
    )!;
    expect(g.gi).toBe(50);
  });

  it('rejects a negative GI as invalid data but still counts its carb in the denominator', () => {
    const g = computeGlycemics(
      [
        { availableCarb_g: 40, gi: 50, measured: true },
        { availableCarb_g: 60, gi: -5, measured: true }, // invalid → dropped from the composite
      ],
      1,
    )!;
    expect(g.gi).toBe(50); // composite ignores the negative-GI source
    expect(g.measuredGiPct).toBe(40); // its 60 g of carb has no usable GI → 40/100 measured
  });

  it('reports measuredGiPct: the carb share whose GI is a measured table match', () => {
    expect(
      computeGlycemics([{ availableCarb_g: 30, gi: 78, measured: true }, { availableCarb_g: 20, gi: 32, measured: true }], 2)!
        .measuredGiPct,
    ).toBe(100);
    // Predicted / category-median GIs still feed the composite but are not "measured".
    const g = computeGlycemics([{ availableCarb_g: 25, gi: 70, measured: true }, { availableCarb_g: 75, gi: 55 }], 1)!;
    expect(g.measuredGiPct).toBe(25);
    expect(g.gi).toBe(59); // (70·25 + 55·75)/100 = 58.75 — both GIs count
    expect(computeGlycemics([{ availableCarb_g: 40, gi: 60, measured: false }], 1)!.measuredGiPct).toBe(0);
  });
});

describe('protein correction (mixed-meal GI)', () => {
  it('is a no-op at or below the threshold, and for zero / invalid protein', () => {
    expect(proteinCorrectionFactor(0)).toBe(1);
    expect(proteinCorrectionFactor(PROTEIN_THRESHOLD)).toBe(1);
    expect(proteinCorrectionFactor(0.1)).toBe(1);
    expect(proteinCorrectionFactor(NaN)).toBe(1);
    expect(proteinCorrectionFactor(-1)).toBe(1);
  });

  it('reduces linearly above the threshold', () => {
    // 1 g protein per g carb (Meng 2017's 50 g tuna + 50 g carb): 0.285 × 0.75 ≈ 21 % reduction.
    expect(proteinCorrectionFactor(1)).toBeCloseTo(1 - PROTEIN_SLOPE * 0.75, 6);
    expect(proteinCorrectionFactor(0.5)).toBeCloseTo(1 - PROTEIN_SLOPE * 0.25, 6);
    expect(proteinCorrectionFactor(0.75)).toBeLessThan(proteinCorrectionFactor(0.5));
  });

  it('never cuts more than the largest reported over-prediction (Dodd 2011: 45 %)', () => {
    expect(MAX_PROTEIN_REDUCTION).toBeCloseTo(1 - 1 / 1.45, 6);
    expect(proteinCorrectionFactor(5)).toBeCloseTo(1 / 1.45, 6);
    expect(proteinCorrectionFactor(100)).toBeCloseTo(1 / 1.45, 6);
  });

  it('leaves a low-protein dish at the plain carb-weighted composite', () => {
    const src = [{ availableCarb_g: 100, gi: 70 }];
    const plain = computeGlycemics(src, 2)!;
    expect(computeGlycemics(src, 2, { addedProtein_g: 0 })).toEqual(plain);
    expect(computeGlycemics(src, 2, { addedProtein_g: 20 })).toEqual(plain); // 0.2 g/g < threshold
    expect(plain.gi).toBe(70);
    expect(plain.gl).toBe(35);
  });

  it('applies the correction to GI and carries the corrected GI into GL', () => {
    // 100 g carb @ GI 70 + 100 g added protein (1 g/g): factor 1 − 0.285·0.75 = 0.78625.
    const g = computeGlycemics([{ availableCarb_g: 100, gi: 70 }], 2, { addedProtein_g: 100 })!;
    expect(g.gi).toBe(55); // 70 × 0.78625 = 55.04
    expect(g.giBand).toBe('low');
    expect(g.gl).toBe(28); // 55.04 × 100 / 100 / 2 = 27.5
  });

  it('caps the correction for a very protein-heavy dish', () => {
    const g = computeGlycemics([{ availableCarb_g: 10, gi: 100 }], 1, { addedProtein_g: 200 })!;
    expect(g.gi).toBe(69); // 100 / 1.45 = 68.97 — never lower
  });
});
