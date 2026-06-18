import { describe, it, expect } from 'vitest';
import {
  canonicalUnit,
  classifyUnit,
  massToGrams,
  volumeToMilliliters,
  toMetric,
  fahrenheitToCelsius,
} from './units';

describe('canonicalUnit', () => {
  it('normalises abbreviations, plurals, case and trailing dots', () => {
    expect(canonicalUnit('Tbsp.')).toBe('tablespoon');
    expect(canonicalUnit('CUPS')).toBe('cup');
    expect(canonicalUnit('fl oz')).toBe('fluid ounce');
    expect(canonicalUnit('g')).toBe('gram');
    expect(canonicalUnit('lbs')).toBe('pound');
  });
  it('returns null for empty input', () => {
    expect(canonicalUnit(null)).toBeNull();
    expect(canonicalUnit('')).toBeNull();
  });
});

describe('classifyUnit', () => {
  it('classifies mass, volume and unknown count units', () => {
    expect(classifyUnit('oz')).toBe('mass');
    expect(classifyUnit('cup')).toBe('volume');
    expect(classifyUnit('clove')).toBeNull();
  });
});

describe('massToGrams', () => {
  it('converts mass units to grams', () => {
    expect(massToGrams(1, 'ounce')).toBeCloseTo(28.3495, 3);
    expect(massToGrams(1, 'lb')).toBeCloseTo(453.592, 2);
    expect(massToGrams(2, 'kg')).toBe(2000);
  });
  it('returns null for non-mass units or missing quantity', () => {
    expect(massToGrams(1, 'cup')).toBeNull();
    expect(massToGrams(null, 'g')).toBeNull();
  });
});

describe('volumeToMilliliters', () => {
  it('converts volume units to millilitres', () => {
    expect(volumeToMilliliters(1, 'cup')).toBeCloseTo(236.588, 2);
    expect(volumeToMilliliters(1, 'tbsp')).toBeCloseTo(14.7868, 3);
    expect(volumeToMilliliters(3, 'teaspoon')).toBeCloseTo(14.78676, 3);
  });
  it('returns null for non-volume units', () => {
    expect(volumeToMilliliters(1, 'ounce')).toBeNull();
  });
});

describe('toMetric', () => {
  it('routes mass to grams and volume to millilitres', () => {
    expect(toMetric(8, 'ounce')).toEqual({
      grams: expect.closeTo(226.796, 2),
      milliliters: null,
      dimension: 'mass',
    });
    const cup = toMetric(1, 'cup');
    expect(cup.dimension).toBe('volume');
    expect(cup.grams).toBeNull();
    expect(cup.milliliters).toBeCloseTo(236.588, 2);
  });
  it('yields null amounts for count words', () => {
    expect(toMetric(2, 'clove')).toEqual({ grams: null, milliliters: null, dimension: null });
  });
});

describe('fahrenheitToCelsius', () => {
  it('converts oven temperatures', () => {
    expect(fahrenheitToCelsius(32)).toBe(0);
    expect(fahrenheitToCelsius(212)).toBe(100);
    expect(fahrenheitToCelsius(350)).toBeCloseTo(176.667, 2);
  });
});
