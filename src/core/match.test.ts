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

  it('drops a partial match when a full-token match coexists', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Lentils, pink or red, raw', n: {} },
      { fdcId: 2, description: 'Lentils, mature seeds, raw', n: {} },
    ];
    // #1 carries both "red" and "lentil", so the strict pass returns it and the
    // partial #2 (missing "red") is never surfaced — no relaxation happens.
    expect(searchFoods('red lentils', foods).map((m) => m.food.fdcId)).toEqual([1]);
  });

  it('relaxes to a partial match only when no food contains every token', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Bread, white, commercially prepared', n: {} },
      { fdcId: 2, description: 'Bread, whole-wheat, commercially prepared', n: {} },
      { fdcId: 3, description: 'Spinach, raw', n: {} },
    ];
    // No food carries "crusty", so the strict pass is empty and search falls back
    // to the "bread" partial — surfacing the breads, never the unrelated spinach.
    const ids = searchFoods('crusty bread', foods).map((m) => m.food.fdcId);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
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

  it('prefers a domestic record over a national-table one on an exact tie', () => {
    // Identical descriptions ⇒ identical scores; the national food carries the
    // higher fdcId (81M band) but must NOT win on it — domestic wins the tie.
    const foods: FoodRecord[] = [
      { fdcId: 81017016, source: 'JP-MEXT', description: 'Rice vinegar', n: {} },
      { fdcId: 173469, description: 'Rice vinegar', n: {} },
    ];
    expect(searchFoods('rice vinegar', foods)[0].food.fdcId).toBe(173469);
  });

  it('lets a national-table food win a regional term by out-scoring', () => {
    // "mirin" leads the national record (precision 1 + leads bonus); the USDA proxy
    // doesn't carry the token at all, so the regional food wins on score, not id.
    const foods: FoodRecord[] = [
      { fdcId: 81016025, source: 'JP-MEXT', description: 'Mirin, hon-mirin (sweet rice seasoning)', n: {} },
      { fdcId: 167723, description: 'Alcoholic beverage, rice wine, sake', n: {} },
    ];
    expect(searchFoods('mirin', foods)[0].food.fdcId).toBe(81016025);
  });

  it('canonicalises Commonwealth ingredient names to the USDA term (synonyms)', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Beets, cooked, boiled, drained', n: {} },
      { fdcId: 2, description: 'Eggplant, raw', n: {} },
      { fdcId: 3, description: 'Arugula, raw', n: {} },
      { fdcId: 4, description: 'Squash, summer, zucchini, includes skin, raw', n: {} },
      { fdcId: 5, description: 'Spinach, raw', n: {} },
    ];
    expect(searchFoods('beetroot', foods)[0].food.fdcId).toBe(1); // → "beet"
    expect(searchFoods('beetroots', foods)[0].food.fdcId).toBe(1);
    expect(searchFoods('aubergine', foods)[0].food.fdcId).toBe(2); // → "eggplant"
    expect(searchFoods('rocket', foods)[0].food.fdcId).toBe(3); // → "arugula"
    expect(searchFoods('courgette', foods)[0].food.fdcId).toBe(4); // → "zucchini"
    expect(searchFoods('spinach', foods)[0].food.fdcId).toBe(5); // non-synonym unaffected
  });

  it('ranks a focused name above one that merely leads with the same noun', () => {
    // Both saturate the displayed 1.0 score; the uncapped-score tie-break must
    // surface "Beets" over "Beet greens" instead of letting the higher fdcId decide.
    const foods: FoodRecord[] = [
      { fdcId: 170375, description: 'Beet greens, raw', n: {} }, // higher id — would win the id tie-break
      { fdcId: 169146, description: 'Beets, cooked, boiled, drained', n: {} },
    ];
    expect(searchFoods('beets', foods)[0].food.fdcId).toBe(169146);
    expect(searchFoods('beetroot', foods)[0].food.fdcId).toBe(169146); // and via the synonym
  });

  it('matches a singular query against an "-e + s" plural without over-stemming', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Apples, raw, fuji, with skin', n: {} },
      { fdcId: 2, description: 'Apple juice, canned or bottled, unsweetened', n: {} },
      { fdcId: 3, description: 'Oranges, raw, with peel', n: {} },
    ];
    // "apples"→"apple" must equal "apple" (not "appl"), so "fuji apple" reaches the
    // whole fruit and not apple juice (which lacks "fuji", sharing only the noun).
    expect(searchFoods('fuji apple', foods)[0].food.fdcId).toBe(1);
    expect(searchFoods('orange', foods)[0].food.fdcId).toBe(3); // "oranges"→"orange"
  });

  it('ignores a parenthetical provenance aside when matching', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: "Cheese, cheddar (Includes foods for USDA's Food Distribution Program)", n: {} },
      { fdcId: 2, description: 'Cheese, cheddar, sharp, sliced', n: {} },
    ];
    // The aside's ~5 tokens must not sink #1's precision below the sharp/sliced cut.
    expect(searchFoods('cheddar cheese', foods)[0].food.fdcId).toBe(1);
  });

  it('keeps a parenthetical common name (only provenance asides are dropped)', () => {
    const foods: FoodRecord[] = [
      { fdcId: 1, description: 'Alcoholic beverage, rice (sake)', n: {} },
      { fdcId: 2, description: 'Spinach, raw', n: {} },
    ];
    // "(sake)" is the food's common name, not a provenance note, so it stays matchable
    // — unlike "(Includes foods for USDA's Food Distribution Program)".
    expect(searchFoods('sake', foods)[0].food.fdcId).toBe(1);
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
