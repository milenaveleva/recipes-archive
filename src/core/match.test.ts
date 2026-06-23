import { describe, it, expect } from 'vitest';
import { searchFoods, foodToNutrientVector, portionGrams, type FoodRecord } from './match';

const FOODS: FoodRecord[] = [
  { fdcId: 1, description: 'Lentils, mature seeds, cooked, boiled, without salt', n: { energyKcal: 116, carbs_g: 20 } },
  { fdcId: 2, description: 'Spinach, raw', n: { energyKcal: 23, carbs_g: 3.6 } },
  { fdcId: 3, description: 'Onions, raw', n: { energyKcal: 40, carbs_g: 9.3 } },
  { fdcId: 4, description: 'Tomatoes, red, ripe, raw', n: { energyKcal: 18, carbs_g: 3.9 } },
  {
    fdcId: 5,
    description: 'Egg, whole, raw, fresh',
    n: { energyKcal: 143, protein_g: 12.56 },
    portions: [{ label: '1 large', grams: 50 }],
  },
];

describe('searchFoods', () => {
  it('matches a singular query against a plural USDA description (stemming)', () => {
    const top = searchFoods('finely chopped onion', FOODS)[0];
    expect(top.food.fdcId).toBe(3);
    expect(top.confidence).toBe('high');
  });

  it('matches "tomatoes" against "Tomatoes, red, ripe, raw"', () => {
    expect(searchFoods('crushed tomatoes', FOODS)[0].food.fdcId).toBe(4);
  });

  it('requires every query token (AND) — "peanut butter" excludes plain butter or peanuts', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Peanut butter, smooth style, with salt', n: {} },
      { fdcId: 2, description: 'Butter, salted', n: {} },
      { fdcId: 3, description: 'Peanuts, all types, raw', n: {} },
    ];
    const ids = searchFoods('peanut butter', foods).map((m) => m.food.fdcId);
    expect(ids).toEqual([1]); // only the food carrying BOTH peanut AND butter
  });

  it('excludes a food missing any query token', () => {
    // "red lentils" needs both "red" and "lentils"; the only lentil here lacks
    // "red", so it is dropped rather than surfaced as a partial match.
    expect(searchFoods('red lentils', FOODS)).toEqual([]);
  });

  it('gives an exact single-word match high confidence', () => {
    expect(searchFoods('spinach', FOODS)[0].confidence).toBe('high');
  });

  it('returns nothing for an unknown ingredient or empty query', () => {
    expect(searchFoods('xyzzy widgets', FOODS)).toEqual([]);
    expect(searchFoods('to taste', FOODS)).toEqual([]); // all stopwords
  });

  it('respects the result limit', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Beans, black, mature seeds, raw', n: {} },
      { fdcId: 2, description: 'Beans, kidney, mature seeds, raw', n: {} },
      { fdcId: 3, description: 'Beans, pinto, mature seeds, raw', n: {} },
    ];
    expect(searchFoods('beans', foods).length).toBe(3); // all three carry "bean"
    expect(searchFoods('beans', foods, 2).length).toBe(2);
  });

  it('reaches a compound-word food via its suffix, kept low-confidence', () => {
    // "mint" is a substring, not a token, of "Peppermint"/"Spearmint", so an
    // exact-token match misses it; the suffix reach surfaces both as candidates.
    const foods: FoodRecord[] = [
      { fdcId: 10, description: 'Peppermint, fresh', n: {} },
      { fdcId: 11, description: 'Spearmint, fresh', n: {} },
      { fdcId: 12, description: 'Spinach, raw', n: {} },
    ];
    const matches = searchFoods('fresh mint', foods);
    const ids = matches.map((m) => m.food.fdcId);
    expect(ids).toContain(10);
    expect(ids).toContain(11);
    expect(ids).not.toContain(12);
    // A guess never auto-selects: a purely-suffix match stays 'low'.
    expect(matches.every((m) => m.confidence === 'low')).toBe(true);
  });

  it('does not let a short (<4 char) token over-reach', () => {
    // "oil" must not suffix-match "broiled"/"aioli" etc.
    const foods: FoodRecord[] = [{ fdcId: 20, description: 'Beef, tenderloin, broiled', n: {} }];
    expect(searchFoods('oil', foods)).toEqual([]);
  });
});

describe('foodToNutrientVector / portionGrams', () => {
  it('returns the per-100g vector', () => {
    expect(foodToNutrientVector(FOODS[0]).energyKcal).toBe(116);
  });
  it('looks up a named portion weight, case-insensitively', () => {
    expect(portionGrams(FOODS[4], '1 Large')).toBe(50);
    expect(portionGrams(FOODS[4], '1 cup')).toBeNull();
    expect(portionGrams(FOODS[0], '1 large')).toBeNull(); // no portions defined
  });
});
