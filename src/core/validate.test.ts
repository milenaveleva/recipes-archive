import { describe, it, expect } from 'vitest';
import {
  validateRecipe,
  identityTokens,
  sharesIdentity,
  falseFriend,
  isWaterLike,
  unitKind,
  isExpectedCarbBase,
  stem,
  type ValidatableIngredient,
  type ValidatableRecipe,
  type IssueCode,
} from './validate';
import type { FoodRecord } from './match';

const FOODS: FoodRecord[] = [
  { fdcId: 1, description: 'Ice cream cones, cake or wafer-type', n: { energyKcal: 417, carbs_g: 79 } },
  { fdcId: 2, description: 'Water convolvulus,raw', n: { energyKcal: 19, carbs_g: 3 } },
  { fdcId: 3, description: 'Water, bottled, generic', n: { energyKcal: 0 } },
  { fdcId: 4, description: 'Pumpkin leaves, raw', n: { energyKcal: 19, carbs_g: 2 } },
  { fdcId: 5, description: 'Pumpkin, raw', n: { energyKcal: 26, carbs_g: 6.5, fiber_g: 0.5 } },
  { fdcId: 6, description: 'Rice, white, long-grain, regular, raw, unenriched', n: { energyKcal: 365, carbs_g: 80, fiber_g: 1.3 } },
  { fdcId: 7, description: 'Pomegranates, raw', n: { energyKcal: 83, carbs_g: 19 } },
  { fdcId: 8, description: 'Nuts, walnuts, english', n: { energyKcal: 654, fat_g: 65, carbs_g: 14 } },
  { fdcId: 9, description: 'Oil, walnut', n: { energyKcal: 884, fat_g: 100 } },
  { fdcId: 10, description: 'Onions, raw', n: { energyKcal: 40, carbs_g: 9.3, fiber_g: 1.7 } },
  { fdcId: 11, description: 'Spices, curry powder', n: { energyKcal: 325, carbs_g: 56 } },
  { fdcId: 12, description: 'Sugars, granulated', n: { energyKcal: 387, carbs_g: 100 } },
  { fdcId: 13, description: 'Apricots, raw', n: { energyKcal: 48, carbs_g: 11, fiber_g: 2 } },
  { fdcId: 14, description: 'Butter, salted', n: { energyKcal: 717, fat_g: 81, sodium_mg: 643 } },
  { fdcId: 15, description: 'Carrots, raw', n: { energyKcal: 41, carbs_g: 9.6, fiber_g: 2.8 } },
  { fdcId: 16, description: 'Beef, ground, 85% lean meat / 15% fat, raw', n: { energyKcal: 215, fat_g: 15, protein_g: 18.6 } },
  { fdcId: 17, description: 'Salt, table', n: { energyKcal: 0, sodium_mg: 38758 } },
  { fdcId: 18, description: 'Eggplant, raw', n: { energyKcal: 25, carbs_g: 5.9, fiber_g: 3 } },
  { fdcId: 19, description: 'Squash, summer, zucchini, includes skin, raw', n: { energyKcal: 17 } },
  { fdcId: 20, description: 'Arugula, raw', n: { energyKcal: 25 } },
  { fdcId: 21, description: 'Coriander (cilantro) leaves, raw', n: { energyKcal: 23 } },
  { fdcId: 22, description: 'Crustaceans, shrimp, raw', n: { energyKcal: 85 } },
  { fdcId: 23, description: 'Onions, spring or scallions (includes tops and bulb), raw', n: { energyKcal: 32 } },
  { fdcId: 24, description: 'Chickpeas (garbanzo beans, bengal gram), mature seeds, raw', n: { energyKcal: 378 } },
  { fdcId: 25, description: 'Peppers, sweet, red, raw', n: { energyKcal: 31 } },
  { fdcId: 26, description: 'Yogurt, Greek, plain, nonfat', n: { energyKcal: 59 } },
  { fdcId: 27, description: 'Leeks, (bulb and lower leaf-portion), raw', n: { energyKcal: 61 } },
  { fdcId: 28, description: 'Vinegar, red wine', n: { energyKcal: 19 } },
  { fdcId: 29, description: 'Alcoholic beverage, wine, table, red', n: { energyKcal: 85 } },
  { fdcId: 30, description: 'Lemon juice, raw', n: { energyKcal: 22 } },
  { fdcId: 31, description: 'Lemon peel, raw', n: { energyKcal: 47 } },
  { fdcId: 32, description: 'Mustard greens, raw', n: { energyKcal: 27 } },
  { fdcId: 33, description: 'Mustard, prepared, yellow', n: { energyKcal: 60 } },
  { fdcId: 34, description: 'Dill weed, fresh', n: { energyKcal: 43 } },
  { fdcId: 35, description: 'Seeds, flaxseed', n: { energyKcal: 534 } },
  { fdcId: 36, description: 'Bread, irish soda, prepared from recipe', n: { energyKcal: 290 } },
  { fdcId: 37, description: 'Eggs, whole, raw, fresh', n: { energyKcal: 143 } },
  { fdcId: 38, description: 'Honey', category: 'Sweets', n: { energyKcal: 304, carbs_g: 82.4 } },
  { fdcId: 39, description: 'Dates, medjool', category: 'Fruits and Fruit Juices', n: { energyKcal: 277, carbs_g: 75, fiber_g: 6.7 } },
  { fdcId: 40, description: 'Mangos, raw', category: 'Fruits and Fruit Juices', n: { energyKcal: 60, carbs_g: 15, fiber_g: 1.6 } },
  { fdcId: 42, description: 'Oil, olive, salad or cooking', n: { energyKcal: 884, fat_g: 100 } },
  { fdcId: 41, description: 'Potatoes, flesh and skin, raw', category: 'Vegetables and Vegetable Products', n: { energyKcal: 77, carbs_g: 17.5, fiber_g: 2.1 } },
];
const foodById = new Map(FOODS.map((f) => [f.fdcId!, f]));

/** A line with a food match and weight. */
const line = (raw: string, fdcId: number | null, grams: number | null, extra: Partial<ValidatableIngredient> = {}): ValidatableIngredient => ({
  raw,
  item: raw,
  fdcId,
  grams,
  ...extra,
});

const run = (ingredients: ValidatableIngredient[], extra: Partial<ValidatableRecipe> = {}) =>
  validateRecipe({ servings: 4, course: 'Main Course', ingredients, ...extra }, foodById);

const codes = (issues: { code: IssueCode }[]) => issues.map((i) => i.code);

/** Line-level issues only (recipe-level per-serving checks are tested separately). */
function lineIssues(ing: ValidatableIngredient) {
  const { errors, warnings } = validateRecipe({ servings: 1, course: 'Main Course', ingredients: [ing] }, foodById, {
    skip: ['KCAL_PER_SERVING', 'SODIUM_PER_SERVING'],
  });
  return { errors: codes(errors), warnings: codes(warnings) };
}

describe('tokens', () => {
  it('folds plurals', () => {
    expect(stem('tomatoes')).toBe('tomato');
    expect(stem('berries')).toBe('berry');
    expect(stem('onions')).toBe('onion');
    expect(stem('peaches')).toBe('peach');
  });

  it('applies synonyms and drops prep/colour words', () => {
    expect([...identityTokens('2 finely chopped red aubergines')]).toEqual(['eggplant']);
    expect(sharesIdentity(identityTokens('courgette'), identityTokens('Squash, summer, zucchini, raw'))).toBe(true);
    expect(sharesIdentity(identityTokens('rocket'), identityTokens('Arugula, raw'))).toBe(true);
    expect(sharesIdentity(identityTokens('kápia pepper'), identityTokens('Peppers, sweet, red, raw'))).toBe(true);
    expect(sharesIdentity(identityTokens('wild garlic'), identityTokens('Leeks, raw'))).toBe(true);
    expect(sharesIdentity(identityTokens('garam masala'), identityTokens('Spices, curry powder'))).toBe(false);
  });

  it('recognises water / ice / soda-water lines', () => {
    expect(isWaterLike('ice cubes')).toBe(true);
    expect(isWaterLike('soda water')).toBe(true);
    expect(isWaterLike('cold sparkling water (for topping)')).toBe(true);
    expect(isWaterLike('vanilla ice cream')).toBe(false);
    expect(isWaterLike('watermelon')).toBe(false);
  });
});

describe('identity + false friends', () => {
  it('flags ice matched to ice-cream cones', () => {
    const r = lineIssues(line('100 g ice', 1, 100, { item: 'ice' }));
    expect(r.errors).toContain('FALSE_FRIEND');
    expect(r.errors).toContain('WATER_MATCH');
  });

  it('flags soda water matched to water convolvulus', () => {
    expect(lineIssues(line('200 ml soda water', 2, 200, { item: 'soda water' })).errors).toEqual(
      expect.arrayContaining(['FALSE_FRIEND', 'WATER_MATCH']),
    );
    // excluded: the bad match is still surfaced, as a warning
    const ex = lineIssues(line('200 ml soda water', 2, 200, { item: 'soda water', excludeFromNutrition: true }));
    expect(ex.errors).toEqual([]);
    expect(ex.warnings).toContain('FALSE_FRIEND');
  });

  it('accepts water lines matched to plain water or excluded', () => {
    expect(lineIssues(line('soda water', 3, 200))).toEqual({ errors: [], warnings: [] });
    expect(lineIssues(line('ice cubes', null, null, { excludeFromNutrition: true }))).toEqual({ errors: [], warnings: [] });
  });

  it('flags soda matched to soda bread', () => {
    expect(falseFriend('soda', 'Bread, irish soda, prepared from recipe')).toMatch(/soda bread/);
  });

  it('flags pumpkin matched to pumpkin leaves, accepts pumpkin flesh', () => {
    expect(lineIssues(line('500 g pumpkin', 4, 500)).errors).toContain('FALSE_FRIEND');
    expect(lineIssues(line('500 g pumpkin', 5, 500)).errors).toEqual([]);
  });

  it('does not treat qualifiers as plant parts', () => {
    expect(falseFriend('spring onions', 'Onions, spring or scallions (includes tops and bulb), raw')).toBeNull();
    expect(falseFriend('chickpeas', 'Chickpeas (garbanzo beans, bengal gram), mature seeds, raw')).toBeNull();
    expect(falseFriend('leeks', 'Leeks, (bulb and lower leaf-portion), raw')).toBeNull();
    expect(falseFriend('coriander', 'Coriander (cilantro) leaves, raw')).toBeNull();
  });

  it('flags flaxseed matched to pomegranate', () => {
    expect(lineIssues(line('2 tbsp flaxseed', 7, 20)).errors).toContain('FALSE_FRIEND');
    expect(lineIssues(line('2 tbsp flaxseed', 35, 20)).errors).toEqual([]);
  });

  it('flags oil vs nut in both directions', () => {
    expect(lineIssues(line('1 tbsp walnut oil', 8, 14)).errors).toContain('FALSE_FRIEND');
    expect(lineIssues(line('50 g walnuts', 9, 50)).errors).toContain('FALSE_FRIEND');
    expect(lineIssues(line('1 tbsp walnut oil', 9, 14)).errors).toEqual([]);
  });

  it('flags vinegar vs wine, peel vs juice, mustard vs mustard greens', () => {
    expect(falseFriend('red wine vinegar', 'Alcoholic beverage, wine, table, red')).toMatch(/vinegar/);
    expect(falseFriend('red wine', 'Vinegar, red wine')).toMatch(/vinegar/);
    expect(falseFriend('lemon zest', 'Lemon juice, raw')).toMatch(/juice/);
    expect(falseFriend('juice of 1 lemon', 'Lemon peel, raw')).toMatch(/peel/);
    expect(falseFriend('juice and zest of 1 lemon', 'Lemon juice, raw')).toBeNull();
    expect(falseFriend('zest of 1 lemon', 'Lemon peel, raw')).toBeNull();
    expect(falseFriend('Dijon mustard', 'Mustard greens, raw')).toMatch(/greens/);
    expect(falseFriend('Dijon mustard', 'Mustard, prepared, yellow')).toBeNull();
  });

  it('accepts synonym matches', () => {
    for (const [item, id] of [
      ['aubergine', 18], ['courgette', 19], ['rocket', 20], ['coriander', 21], ['prawns', 22],
      ['spring onions', 23], ['chickpeas', 24], ['kápia pepper', 25], ['yoghurt', 26], ['wild garlic', 27],
    ] as const) {
      expect(lineIssues(line(item, id, 100)), item).toEqual({ errors: [], warnings: [] });
    }
  });

  it('warns on an unrelated match, silenced by proxyOk', () => {
    expect(lineIssues(line('1 tsp garam masala', 11, 2)).warnings).toEqual(['IDENTITY_MISMATCH']);
    expect(lineIssues(line('1 tsp garam masala', 11, 2, { proxyOk: true }))).toEqual({ errors: [], warnings: [] });
  });
});

describe('state', () => {
  it('flags cooked rice stored against raw rice by cooked weight', () => {
    expect(lineIssues(line('500 g cooked rice', 6, 500, { unit: 'g', quantity: 500 })).errors).toEqual(['STATE_MISMATCH']);
  });

  it('accepts the "(≈ N g uncooked)" raw-equivalent note', () => {
    const ing = line('500 g cooked rice (≈ 168 g uncooked)', 6, 168, { item: 'cooked rice', note: '≈ 168 g uncooked', unit: 'g', quantity: 500 });
    expect(lineIssues(ing)).toEqual({ errors: [], warnings: [] });
  });

  it('accepts a line listed in its dry form with the preparation as the note', () => {
    const ing = line('168 g dried brown rice, cooked', 6, 168, { item: 'dried brown rice', note: 'cooked', unit: 'g', quantity: 168 });
    expect(lineIssues(ing)).toEqual({ errors: [], warnings: [] });
  });

  it('ignores a cooking note on a counted line ("8 eggs, boiled")', () => {
    const ing = line('8 eggs, boiled', 37, 400, { item: 'eggs', note: 'boiled for 6 minutes', quantity: 8, unit: null });
    expect(lineIssues(ing).errors).toEqual([]);
  });

  it('proxyOk silences the state check', () => {
    expect(lineIssues(line('500 g cooked rice', 6, 500, { proxyOk: true })).errors).toEqual([]);
  });
});

describe('grams per unit', () => {
  it('warns on a 14 g small onion and errors beyond 3×', () => {
    expect(lineIssues(line('1 small onion', 10, 14, { item: 'onion', quantity: 1, unit: 'small' })).warnings).toEqual(['GRAMS_PER_UNIT']);
    expect(lineIssues(line('1 onion', 10, 5, { item: 'onion', quantity: 1 })).errors).toEqual(['GRAMS_PER_UNIT']);
    expect(lineIssues(line('1 onion', 10, 150, { item: 'onion', quantity: 1 }))).toEqual({ errors: [], warnings: [] });
  });

  it('checks spoons, with lighter ranges for leafy herbs', () => {
    expect(lineIssues(line('1 tsp sugar', 12, 30, { item: 'sugar', quantity: 1, unit: 'tsp' })).errors).toEqual(['GRAMS_PER_UNIT']);
    expect(lineIssues(line('1 tbsp fresh dill', 34, 0.6, { item: 'fresh dill', quantity: 1, unit: 'tbsp' }))).toEqual({ errors: [], warnings: [] });
  });

  it('reads "T" as a tablespoon and "t" as a teaspoon', () => {
    expect(unitKind('T')).toBe('tbsp');
    expect(unitKind('Tbsp')).toBe('tbsp');
    expect(unitKind('tbl.')).toBe('tbsp');
    expect(unitKind('t')).toBe('tsp');
    expect(unitKind('teaspoons')).toBe('tsp');
    expect(unitKind('cloves')).toBe('clove');
    expect(unitKind('bunches')).toBe('bunch');
    expect(unitKind('tins')).toBe('can');
    expect(unitKind('g')).toBeNull();
    // 1 T olive oil at 13.5 g is a plausible tablespoon, not an implausible teaspoon.
    expect(lineIssues(line('1 T olive oil', 42, 13.5, { item: 'olive oil', quantity: 1, unit: 'T' }))).toEqual({ errors: [], warnings: [] });
    expect(lineIssues(line('1 t olive oil', 42, 13.5, { item: 'olive oil', quantity: 1, unit: 't' })).warnings).toEqual(['GRAMS_PER_UNIT']);
  });

  it('uses the midpoint of a range and skips mass units', () => {
    expect(lineIssues(line('2–3 carrots', 15, 250, { item: 'carrots', quantity: 2, quantity2: 3 }))).toEqual({ errors: [], warnings: [] });
    expect(lineIssues(line('5 g onion', 10, 5, { item: 'onion', quantity: 5, unit: 'g' }))).toEqual({ errors: [], warnings: [] });
  });
});

describe('per serving', () => {
  it('errors on a jam at 2,900 kcal per serving', () => {
    const r = run([line('750 g sugar', 12, 750)], { servings: 1, course: 'Condiment' });
    expect(codes(r.errors)).toContain('KCAL_PER_SERVING');
  });

  it('warns on a single ingredient dominating energy', () => {
    const r = run([line('200 g butter', 14, 200), line('300 g carrots', 15, 300), line('100 g onion', 10, 100)]);
    const dom = r.warnings.find((w) => w.code === 'DOMINANT_ENERGY');
    expect(dom?.ingredientIndex).toBe(0);
    expect(dom?.message).toMatch(/butter/);
  });

  it('warns on an unexpected ingredient dominating available carbs', () => {
    const r = run([line('200 g honey', 38, 200), line('100 g carrots', 15, 100), line('200 g beef', 16, 200)]);
    expect(codes(r.warnings)).toContain('DOMINANT_CARB');
  });

  it('stays silent when a starchy staple carries the carbohydrate', () => {
    const rice = run([line('200 g rice', 6, 200), line('100 g carrots', 15, 100), line('200 g beef', 16, 200)]);
    expect(codes(rice.warnings)).not.toContain('DOMINANT_CARB');
    const potato = run([line('800 g sweet potatoes', 41, 800), line('100 g carrots', 15, 100), line('200 g beef', 16, 200)]);
    expect(codes(potato.warnings)).not.toContain('DOMINANT_CARB');
  });

  it('accepts fruit in a fruit dish but not dried fruit in a savoury one', () => {
    const mango = foodById.get(40);
    const dates = foodById.get(39);
    expect(isExpectedCarbBase('mango', mango, 'dessert')).toBe(true);
    expect(isExpectedCarbBase('mango', mango, 'drink')).toBe(true);
    expect(isExpectedCarbBase('mango', mango, 'main')).toBe(false);
    expect(isExpectedCarbBase('Medjool dates', dates, 'snack')).toBe(true);
    expect(isExpectedCarbBase('Medjool dates', dates, 'main')).toBe(false);
    expect(isExpectedCarbBase('honey', foodById.get(38), 'dessert')).toBe(false);
    expect(isExpectedCarbBase('orange juice', undefined, 'drink')).toBe(false);
    expect(isExpectedCarbBase('sugar snap peas', undefined, 'side')).toBe(true);
  });

  it('reuses precomputed macros instead of recomputing them', () => {
    const ings = [line('800 g beef', 16, 800), line('400 g carrots', 15, 400), line('200 g onion', 10, 200)];
    const plain = run(ings);
    const fake = { resolved: [], macro: { perServing: { energyKcal: 5000 }, contributingCount: 1 } } as never;
    const pre = validateRecipe({ servings: 4, course: 'Main Course', ingredients: ings }, foodById, { precomputed: fake });
    expect(codes(plain.errors)).not.toContain('KCAL_PER_SERVING');
    expect(codes(pre.errors)).toContain('KCAL_PER_SERVING');
  });

  it('warns on sodium above 2,300 mg per serving', () => {
    const r = run([line('30 g salt', 17, 30), line('500 g beef', 16, 500), line('500 g carrots', 15, 500)]);
    expect(codes(r.warnings)).toContain('SODIUM_PER_SERVING');
  });

  it('cross-checks the source kcal per serving', () => {
    const ings = [line('800 g beef', 16, 800), line('400 g carrots', 15, 400), line('200 g onion', 10, 200)];
    // ours ≈ (1720 + 164 + 80) / 4 ≈ 491 kcal
    expect(codes(run(ings, { source: { kcalPerServing: 480 } }).warnings)).not.toContain('SOURCE_KCAL');
    expect(codes(run(ings, { source: { kcalPerServing: 330 } }).warnings)).toContain('SOURCE_KCAL');
    expect(codes(run(ings, { source: { kcalPerServing: 200 } }).warnings)).toContain('SOURCE_KCAL'); // never an error on its own
    expect(codes(run(ings, { source: { kcalPerServing: 200 } }).errors)).not.toContain('SOURCE_KCAL');
  });

  it('ranges kcal by the shared course key (course.ts), synonyms included', () => {
    const ings = [line('40 g sugar', 12, 40), line('100 g apricots', 13, 100), line('20 g carrots', 15, 20)];
    // ≈ 60 kcal per serving: low for a main course, fine for a drink / mocktail / condiment.
    expect(codes(run(ings, { course: 'Main Course' }).warnings)).toContain('KCAL_PER_SERVING');
    for (const course of ['Mocktail', 'Drink', 'Jam', 'Condiment']) {
      expect(codes(run(ings, { course }).warnings), course).not.toContain('KCAL_PER_SERVING');
    }
    expect(codes(run(ings, { course: 'Entrée' }).warnings)).toContain('KCAL_PER_SERVING');
  });
});

describe('exclusions + completeness + duplicates', () => {
  it('errors on a counted line with no food or no weight', () => {
    expect(lineIssues(line('1 pinch saffron', null, null)).errors).toEqual(['MISSING_MATCH', 'MISSING_GRAMS']);
    expect(lineIssues(line('salt, to taste', 17, null, { excludeFromNutrition: true })).errors).toEqual([]);
  });

  it('errors on an fdcId missing from the food database', () => {
    expect(lineIssues(line('1 carrot', 999, 80)).errors).toContain('UNKNOWN_FOOD');
  });

  it('warns on duplicate identical lines', () => {
    const r = run([line('1 carrot', 15, 80), line('1 Carrot', 15, 80), line('1 carrot', 15, 80, { group: 'For the sauce' })]);
    expect(r.warnings.filter((w) => w.code === 'DUPLICATE_LINE').map((w) => w.ingredientIndex)).toEqual([1]);
  });
});
