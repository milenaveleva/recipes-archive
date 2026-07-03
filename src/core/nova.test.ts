import { describe, it, expect } from 'vitest';
// classifyNova lives in the build script (scripts/nova.mjs); it is pure + deterministic,
// so it unit-tests here even though the stamping runs at dataset-build time.
import { classifyNova } from '../../scripts/nova.mjs';

const nova = (description: string, category = '') => classifyNova({ description, category });

describe('classifyNova — NOVA processing group', () => {
  it('classifies whole/minimally-processed reference foods as 1', () => {
    expect(nova('Spinach, raw', 'Vegetables and Vegetable Products')).toBe(1);
    expect(nova('Apples, raw, with skin', 'Fruits and Fruit Juices')).toBe(1);
    expect(nova('Chicken, breast, raw')).toBe(1);
  });

  it('classifies culinary ingredients as 2 (oils, sugar, salt, dairy fats, vinegar)', () => {
    expect(nova('Oil, olive, salad or cooking', 'Fats and Oils')).toBe(2);
    expect(nova('Sugars, granulated')).toBe(2);
    expect(nova('Butter, salted', 'Dairy and Egg Products')).toBe(2); // culinary fat, not a "salted" ferment
    expect(nova('Vinegar, cider')).toBe(2);
  });

  it('classifies processed foods as 3 (preservation / fermentation / bread)', () => {
    expect(nova('Cheese, cheddar')).toBe(3);
    expect(nova('Tofu, firm')).toBe(3);
    expect(nova('Miso')).toBe(3);
    expect(nova('Bacon, cooked')).toBe(3);
    expect(nova('Bread, whole-wheat')).toBe(3);
  });

  it('catches jam / jelly / marmalade as processed (3)', () => {
    expect(nova('Jams and preserves')).toBe(3);
    expect(nova('Jelly, reduced sugar')).toBe(3);
    expect(nova('Marmalade, orange')).toBe(3);
  });

  it('catches pickles in singular and plural, and the "pickled" adjective form', () => {
    expect(nova('Pickle, dill')).toBe(3);
    expect(nova('Pickles, cucumber, dill')).toBe(3); // plural form must also match
    expect(nova('Cucumber, pickled')).toBe(3);
  });

  it('classifies confectionery and industrial condiments as ultra-processed (4)', () => {
    expect(nova('Chocolate, dark, 70% cacao')).toBe(4);
    expect(nova('Candies, milk chocolate')).toBe(4);
    expect(nova('Ketchup, tomato')).toBe(4);
    expect(nova('Catsup')).toBe(4);
    expect(nova('Cheese, imitation')).toBe(4); // ultra-processed wins over the "cheese" NOVA-3 marker
  });

  it('keeps cocoa powder lower (chocolate marker is word-bounded)', () => {
    expect(nova('Cocoa, dry powder, unsweetened')).toBe(1);
  });

  it('splits chocolate by sweetened vs unsweetened — pure cocoa mass stays low, a sweetened tablet is a NOVA-4 confection', () => {
    expect(nova('Baking chocolate, unsweetened, squares')).toBe(1); // pure cocoa mass, culinary
    expect(nova('Baking chocolate, unsweetened, liquid')).toBe(1);
    expect(nova('Baking chocolate, mexican, squares')).toBe(4); // sugar-laden formulated tablet
  });

  it("does not promote confectioners' sugar (bounded confection marker) — it stays a NOVA-2 culinary sugar", () => {
    expect(nova('Sugars, confectioners, powdered')).toBe(2);
    expect(nova('Confectionery, hard candy')).toBe(4); // real confection still 4
  });
});
