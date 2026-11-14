import { describe, it, expect } from 'vitest';
import { normalizeCourse, glBasisForCourse, resolveGlBasis } from './course';
import { DEFAULT_GL_BASIS } from './gi';

describe('normalizeCourse', () => {
  it('normalises case, whitespace, accents and plurals', () => {
    expect(normalizeCourse('Main Course')).toBe('main');
    expect(normalizeCourse('  main   COURSE ')).toBe('main');
    expect(normalizeCourse('Mains')).toBe('main');
    expect(normalizeCourse('Entrée')).toBe('main');
    expect(normalizeCourse('Main dish')).toBe('main');
    expect(normalizeCourse('Side Dishes')).toBe('side');
    expect(normalizeCourse('Desserts')).toBe('dessert');
    expect(normalizeCourse('Soup')).toBe('soup');
    expect(normalizeCourse('Breakfast')).toBe('breakfast');
  });

  it('maps synonyms', () => {
    expect(normalizeCourse('Starter')).toBe('appetizer');
    expect(normalizeCourse('Appetiser')).toBe('appetizer');
    expect(normalizeCourse('Beverage')).toBe('drink');
    expect(normalizeCourse('Brunch')).toBe('breakfast');
    expect(normalizeCourse('Dip')).toBe('sauce');
  });

  it('takes the first recognised entry of a list, null for unknown/empty', () => {
    expect(normalizeCourse('Main Course, Side Dish')).toBe('main');
    expect(normalizeCourse('Party food; Snack')).toBe('snack');
    expect(normalizeCourse('Party food')).toBeNull();
    expect(normalizeCourse('')).toBeNull();
    expect(normalizeCourse(undefined)).toBeNull();
    expect(normalizeCourse(null)).toBeNull();
  });
});

describe('glBasisForCourse', () => {
  it('uses meal bands only for full meals', () => {
    for (const c of ['Main Course', 'Soup', 'Salad', 'Breakfast', 'mains', 'Entrée']) {
      expect(glBasisForCourse(c), c).toBe('meal');
    }
  });

  it('uses portion bands for every other course and for an unknown one', () => {
    for (const c of ['Appetizer', 'Starter', 'Side Dish', 'Snack', 'Dessert', 'Drink', 'Sauce', 'Condiment', 'Party food', '', undefined]) {
      expect(glBasisForCourse(c), String(c)).toBe('portion');
    }
  });
});

describe('normalizeCourse synonyms (shared with the validation gate)', () => {
  it('maps the drink / dessert / soup / appetizer / condiment variants', () => {
    const cases: [string, string][] = [
      ['Mocktail', 'drink'], ['Mocktails', 'drink'], ['Juice', 'drink'], ['Cocktail', 'drink'],
      ['Baking', 'dessert'], ['Cakes', 'dessert'], ['Baked goods', 'dessert'],
      ['Broth', 'soup'], ['Stew', 'soup'],
      ['Mezze', 'appetizer'], ['Antipasti', 'appetizer'], ['Tapas', 'appetizer'],
      ['Jam', 'condiment'], ['Pickles', 'condiment'], ['Chutney', 'condiment'], ['Preserves', 'condiment'],
      ['Entrée', 'main'], ['Dinner', 'main'],
    ];
    for (const [text, key] of cases) expect(normalizeCourse(text), text).toBe(key);
  });
});

describe('resolveGlBasis', () => {
  it('keeps a valid stored basis', () => {
    expect(resolveGlBasis('meal', 'Dessert')).toBe('meal');
    expect(resolveGlBasis('portion', 'Main Course')).toBe('portion');
  });

  it('infers a missing basis from the course, else the shared default', () => {
    expect(resolveGlBasis(undefined, 'Main Course')).toBe('meal');
    expect(resolveGlBasis(null, 'Snack')).toBe('portion');
    expect(resolveGlBasis('bogus', 'Soup')).toBe('meal');
    expect(resolveGlBasis(undefined, undefined)).toBe(DEFAULT_GL_BASIS);
    expect(resolveGlBasis(undefined, 'Party food')).toBe(DEFAULT_GL_BASIS);
  });
});
