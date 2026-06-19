import { describe, it, expect } from 'vitest';
import { computeInflammation, inflammationBandOf } from './inflammation';

describe('inflammationBandOf', () => {
  it('maps a −2..+2 score onto five symmetric bands', () => {
    expect(inflammationBandOf(-1.5)).toBe('anti-inflammatory');
    expect(inflammationBandOf(-1.0)).toBe('anti-inflammatory');
    expect(inflammationBandOf(-0.5)).toBe('mildly-anti-inflammatory');
    expect(inflammationBandOf(-0.3)).toBe('mildly-anti-inflammatory');
    expect(inflammationBandOf(-0.2)).toBe('neutral');
    expect(inflammationBandOf(0)).toBe('neutral');
    expect(inflammationBandOf(0.2)).toBe('neutral');
    expect(inflammationBandOf(0.3)).toBe('mildly-pro-inflammatory');
    expect(inflammationBandOf(0.9)).toBe('mildly-pro-inflammatory');
    expect(inflammationBandOf(1.0)).toBe('pro-inflammatory');
    expect(inflammationBandOf(1.5)).toBe('pro-inflammatory');
    expect(inflammationBandOf(2.0)).toBe('pro-inflammatory');
  });
});

describe('computeInflammation', () => {
  it('mass-weights the ingredient tags', () => {
    const r = computeInflammation([
      { grams: 100, tag: -2 },
      { grams: 100, tag: 0 },
    ])!;
    expect(r.score).toBe(-1.0);
    expect(r.band).toBe('anti-inflammatory');
  });

  it('lets a heavy pro-inflammatory ingredient dominate by mass', () => {
    const r = computeInflammation([
      { grams: 50, tag: -2 },
      { grams: 150, tag: 2 },
    ])!;
    expect(r.score).toBe(1.0); // (−100 + 300)/200
    expect(r.band).toBe('pro-inflammatory');
  });

  it('returns null when no tagged ingredient has weight', () => {
    expect(computeInflammation([])).toBeNull();
    expect(computeInflammation([{ grams: 0, tag: -2 }])).toBeNull();
  });
});
