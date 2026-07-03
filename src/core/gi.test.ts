import { describe, it, expect } from 'vitest';
import { computeGlycemics, giBandOf, glBandOf } from './gi';

describe('GI / GL bands', () => {
  it('classifies GI: low ≤55, medium 56–69, high ≥70', () => {
    expect(giBandOf(55)).toBe('low');
    expect(giBandOf(56)).toBe('medium');
    expect(giBandOf(69)).toBe('medium');
    expect(giBandOf(70)).toBe('high');
  });
  it('classifies GL: low ≤10, medium 11–19, high ≥20', () => {
    expect(glBandOf(10)).toBe('low');
    expect(glBandOf(11)).toBe('medium');
    expect(glBandOf(19)).toBe('medium');
    expect(glBandOf(20)).toBe('high');
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
    expect(g.glBand).toBe('medium');
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

  it('rejects a negative GI as invalid data but still counts its carb toward coverage', () => {
    const g = computeGlycemics(
      [
        { availableCarb_g: 40, gi: 50 },
        { availableCarb_g: 60, gi: -5 }, // invalid → dropped from the composite
      ],
      1,
    )!;
    expect(g.gi).toBe(50); // composite ignores the negative-GI source
    expect(g.carbCoveragePct).toBe(40); // but its 60 g of carb is untabulated → 40/100 covered
  });

  it('reports carbCoveragePct: full when every carb source has a GI, partial otherwise', () => {
    expect(computeGlycemics([{ availableCarb_g: 30, gi: 78 }, { availableCarb_g: 20, gi: 32 }], 2)!.carbCoveragePct).toBe(100);
    expect(computeGlycemics([{ availableCarb_g: 25, gi: 70 }, { availableCarb_g: 75, gi: null }], 1)!.carbCoveragePct).toBe(25);
  });
});
