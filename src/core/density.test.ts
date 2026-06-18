import { describe, it, expect } from 'vitest';
import { densityFor, volumeToGrams } from './density';

describe('densityFor', () => {
  it('matches the most specific (longest) key', () => {
    expect(densityFor('extra virgin olive oil')).toBe(0.91); // "olive oil" beats "oil"
    expect(densityFor('packed brown sugar')).toBe(0.93); // "brown sugar" beats "sugar"
    expect(densityFor('granulated sugar')).toBe(0.85);
    expect(densityFor('all-purpose flour')).toBe(0.53);
  });
  it('does not match a key embedded inside a larger word', () => {
    expect(densityFor('buttermilk')).toBe(1.03); // not the "milk" entry via substring
  });
  it('matches a single-word key only at the head noun, not a modifier', () => {
    expect(densityFor('rice vinegar')).toBeNull(); // "rice" is a modifier, not the food
    expect(densityFor('salt-free seasoning')).toBeNull();
    expect(densityFor('sugar snap peas')).toBeNull();
    expect(densityFor('milk chocolate')).toBeNull();
    expect(densityFor('coconut milk')).toBe(1.03); // "milk" IS the head noun here
  });
  it('returns null for unknown ingredients', () => {
    expect(densityFor('unicorn dust')).toBeNull();
  });
});

describe('volumeToGrams', () => {
  it('estimates weight from volume via density', () => {
    // 1 cup flour ≈ 236.588 ml × 0.53 ≈ 125 g
    expect(volumeToGrams(236.588, 'all-purpose flour')).toBeCloseTo(125.4, 1);
    expect(volumeToGrams(100, 'water')).toBe(100);
  });
  it('returns null when density is unknown', () => {
    expect(volumeToGrams(100, 'saffron threads')).toBeNull();
  });
});
