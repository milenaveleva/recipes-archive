import { describe, it, expect } from 'vitest';
import { parseIngredientLine, splitDescription, estimateMetric } from './parse';

describe('splitDescription', () => {
  it('splits a prep note after the first comma', () => {
    expect(splitDescription('onion, finely chopped')).toEqual({
      item: 'onion',
      note: 'finely chopped',
    });
  });
  it('treats a trailing parenthetical as a note', () => {
    expect(splitDescription('tomatoes (peeled)')).toEqual({ item: 'tomatoes', note: 'peeled' });
  });
  it('returns the whole string as the item when there is no note', () => {
    expect(splitDescription('red lentils')).toEqual({ item: 'red lentils' });
  });
});

describe('parseIngredientLine', () => {
  it('parses quantity, unit and splits item from note', () => {
    const r = parseIngredientLine('1 1/2 cups red lentils, rinsed');
    expect(r.quantity).toBe(1.5);
    expect(r.unitId).toBe('cup');
    expect(r.unit).toBe('cups');
    expect(r.item).toBe('red lentils');
    expect(r.note).toBe('rinsed');
    expect(r.isGroupHeader).toBe(false);
  });
  it('flags group headers', () => {
    const r = parseIngredientLine('For the sauce:');
    expect(r.isGroupHeader).toBe(true);
    expect(r.item).toBe('For the sauce:');
  });
  it('captures quantity ranges', () => {
    const r = parseIngredientLine('2-3 cloves garlic, minced');
    expect(r.quantity).toBe(2);
    expect(r.quantity2).toBe(3);
    expect(r.item).toBe('garlic');
    expect(r.note).toBe('minced');
  });
  it('handles non-numeric amounts', () => {
    const r = parseIngredientLine('Salt to taste');
    expect(r.quantity).toBeNull();
    expect(r.item.toLowerCase()).toContain('salt');
  });
});

describe('estimateMetric', () => {
  it('gives grams directly for mass units', () => {
    const r = estimateMetric(parseIngredientLine('8 ounces chicken breast'));
    expect(r.grams).toBeCloseTo(226.8, 1);
    expect(r.milliliters).toBeNull();
  });
  it('gives millilitres only for volume units (weight comes from the USDA portion)', () => {
    const r = estimateMetric(parseIngredientLine('2 tablespoons olive oil'));
    expect(r.milliliters).toBeCloseTo(29.57, 1);
    expect(r.grams).toBeNull();
  });
  it('leaves count units unresolved', () => {
    const r = estimateMetric(parseIngredientLine('2 cloves garlic'));
    expect(r.grams).toBeNull();
    expect(r.milliliters).toBeNull();
  });
});
