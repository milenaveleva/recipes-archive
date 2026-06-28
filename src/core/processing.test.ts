import { describe, it, expect } from 'vitest';
import { computeProcessing, type ProcessingItem } from './processing';

describe('computeProcessing', () => {
  it('returns undefined when nothing is classifiable', () => {
    expect(computeProcessing([])).toBeUndefined();
    // A food with energy but no NOVA group can't be placed.
    expect(computeProcessing([{ energyKcal: 200, nova: null }])).toBeUndefined();
    // A classified food with no usable energy contributes no weight.
    expect(computeProcessing([{ energyKcal: null, nova: 1 }])).toBeUndefined();
    expect(computeProcessing([{ energyKcal: 0, nova: 1 }])).toBeUndefined();
  });

  it('weights NOVA shares by energy, not by ingredient count', () => {
    // One energy-dense NOVA-1 food vs. three trivial NOVA-4 foods: energy wins.
    const items: ProcessingItem[] = [
      { energyKcal: 900, nova: 1 },
      { energyKcal: 10, nova: 4 },
      { energyKcal: 10, nova: 4 },
      { energyKcal: 10, nova: 4 },
    ];
    const r = computeProcessing(items)!;
    expect(r.minimallyProcessedPct).toBeCloseTo(96.8, 1);
    expect(r.ultraProcessedPct).toBeCloseTo(3.2, 1);
    expect(r.band).toBe('minimally-processed');
  });

  it('bundles groups 1+2 into the minimally-processed headline; pct sums to ~100', () => {
    const r = computeProcessing([
      { energyKcal: 50, nova: 1 },
      { energyKcal: 30, nova: 2 },
      { energyKcal: 15, nova: 3 },
      { energyKcal: 5, nova: 4 },
    ])!;
    expect(r.minimallyProcessedPct).toBeCloseTo(80, 1); // 50+30 of 100
    expect(r.ultraProcessedPct).toBeCloseTo(5, 1);
    expect(r.pct).toEqual({ n1: 50, n2: 30, n3: 15, n4: 5 });
    const sum = r.pct.n1 + r.pct.n2 + r.pct.n3 + r.pct.n4;
    expect(sum).toBeCloseTo(100, 1);
  });

  it('bands by the minimally-processed share (≥70 minimally, ≥40 moderately, else highly)', () => {
    const band = (n1: number, n3: number) =>
      computeProcessing([
        { energyKcal: n1, nova: 1 },
        { energyKcal: n3, nova: 3 },
      ])!.band;
    expect(band(70, 30)).toBe('minimally-processed'); // exactly 70%
    expect(band(69, 31)).toBe('moderately-processed');
    expect(band(40, 60)).toBe('moderately-processed'); // exactly 40%
    expect(band(39, 61)).toBe('highly-processed');
  });

  it('excludes unclassified and energy-less items from the denominator', () => {
    // The null-nova 1000 kcal must not dilute the shares of the classified foods.
    const r = computeProcessing([
      { energyKcal: 80, nova: 1 },
      { energyKcal: 20, nova: 4 },
      { energyKcal: 1000, nova: null },
      { energyKcal: null, nova: 3 },
    ])!;
    expect(r.minimallyProcessedPct).toBeCloseTo(80, 1);
    expect(r.ultraProcessedPct).toBeCloseTo(20, 1);
  });
});
