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

  it('ranks the carb-bearing food first and assigns medium confidence to a partial match', () => {
    const matches = searchFoods('red lentils', FOODS);
    expect(matches[0].food.fdcId).toBe(1);
    expect(matches[0].confidence).toBe('medium'); // "red" not in the food name
  });

  it('gives an exact single-word match high confidence', () => {
    expect(searchFoods('spinach', FOODS)[0].confidence).toBe('high');
  });

  it('returns nothing for an unknown ingredient or empty query', () => {
    expect(searchFoods('xyzzy widgets', FOODS)).toEqual([]);
    expect(searchFoods('to taste', FOODS)).toEqual([]); // all stopwords
  });

  it('respects the result limit', () => {
    const q = 'spinach onion tomato'; // overlaps three different foods
    expect(searchFoods(q, FOODS).length).toBe(3);
    expect(searchFoods(q, FOODS, 2).length).toBe(2);
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
