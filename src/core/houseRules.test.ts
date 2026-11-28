import { describe, it, expect } from 'vitest';
import {
  checkHouseRules,
  normalizeRecipe,
  normalizeIngredient,
  forbiddenReason,
  meatSuggestions,
  findDuplicateRecipes,
  oliveOilAmount,
  HOUSE_FOODS,
  type NormalizableLine,
  type NormalizableRecipe,
} from './houseRules';
import { validateRecipe, type IssueCode, type ValidatableIngredient, type ValidatableRecipe } from './validate';
import { parseIngredientLine, estimateMetric } from './parse';
import type { FoodRecord } from './match';
import usdaFoods from '../data/usda-foods.json';

const foods = usdaFoods as FoodRecord[];
const foodById = new Map(foods.map((f) => [f.fdcId as number, f]));

/** A stored ingredient for a line, as the importers store it (parsed fields + weight + food). */
function stored(line: NormalizableLine): ValidatableIngredient {
  const p = parseIngredientLine(line.raw);
  return {
    raw: line.raw,
    quantity: p.quantity,
    unit: p.unit,
    item: p.item,
    note: p.note,
    grams: line.grams ?? estimateMetric(p).grams ?? 10,
    fdcId: line.fdcId ?? null,
    excludeFromNutrition: line.exclude,
    proxyOk: line.proxyOk,
  };
}

function recipeOf(r: NormalizableRecipe, body = ''): ValidatableRecipe {
  return { title: r.title, course: r.course, servings: r.servings, ingredients: r.ingredients.map(stored), body };
}

const codes = (r: ValidatableRecipe) => checkHouseRules(r, foodById).map((i) => i.code);
const errorCodes = (r: ValidatableRecipe) =>
  checkHouseRules(r, foodById).filter((i) => i.severity === 'error').map((i) => i.code);

/** The gate flags `code` on the recipe, and after normalizeRecipe the code is gone. */
function flagsAndFixes(r: NormalizableRecipe, code: IssueCode, body = '') {
  expect(codes(recipeOf(r, body))).toContain(code);
  const fixed = normalizeRecipe(r, foodById);
  expect(fixed.changes.length).toBeGreaterThan(0);
  expect(codes(recipeOf(fixed.value, body))).not.toContain(code);
  return fixed;
}

const main = (ingredients: NormalizableLine[], extra: Partial<NormalizableRecipe> = {}): NormalizableRecipe => ({
  title: 'Test dish',
  course: 'Main Course',
  servings: 4,
  ingredients,
  steps: [],
  ...extra,
});

describe('house rules: each mistake the owner caught is flagged and auto-fixed', () => {
  it('butter in a stew → extra virgin olive oil at 75 % of the weight, in spoons', () => {
    const fixed = flagsAndFixes(
      main([{ raw: '40 g butter', fdcId: 173430 }, { raw: '400 g potatoes' }], { steps: ['Melt the butter in a pot.'] }),
      'FORBIDDEN_INGREDIENT',
    );
    const oil = fixed.value.ingredients[0];
    expect(oil.raw).toBe('2 tbsp extra virgin olive oil'); // 30 g oil ≈ 2.2 tbsp → 2 tbsp
    expect(oil.fdcId).toBe(HOUSE_FOODS.oliveOil);
    expect(fixed.value.steps).toEqual(['Heat the olive oil in a pot.']);
    expect(fixed.value.ingredients.some((l) => /butter/i.test(l.raw))).toBe(false);
  });

  it("cow's milk → unsweetened oat milk at the same volume", () => {
    const fixed = flagsAndFixes(main([{ raw: '250 ml whole milk' }]), 'FORBIDDEN_INGREDIENT');
    expect(fixed.value.ingredients[0]).toMatchObject({ raw: '250 ml oat milk, unsweetened', fdcId: HOUSE_FOODS.oatMilk });
  });

  it('wine → vegetable broth plus lemon juice, and the method follows', () => {
    const fixed = flagsAndFixes(
      main([{ raw: '100 ml dry white wine' }], { steps: ['Deglaze with the wine.'] }),
      'FORBIDDEN_INGREDIENT',
    );
    expect(fixed.value.ingredients.map((l) => l.raw)).toEqual(['100 ml vegetable broth', '1 tbsp lemon juice']);
    expect(fixed.value.steps).toEqual(['Deglaze with the broth.']);
  });

  it('white rice → brown rice', () => {
    const fixed = flagsAndFixes(main([{ raw: '320 g white rice', fdcId: 169756 }]), 'FORBIDDEN_INGREDIENT');
    expect(fixed.value.ingredients[0].raw).toBe('320 g brown rice');
  });

  it('sugar → honey, same amount', () => {
    const fixed = flagsAndFixes(main([{ raw: '2 tbsp caster sugar' }]), 'FORBIDDEN_INGREDIENT');
    expect(fixed.value.ingredients[0]).toMatchObject({ raw: '2 tbsp honey', fdcId: HOUSE_FOODS.honey });
  });

  it('"1 handful parsley" → grams', () => {
    const fixed = flagsAndFixes(main([{ raw: '1 handful parsley' }]), 'FORBIDDEN_WORDING');
    expect(fixed.value.ingredients[0].raw).toBe('10 g parsley');
  });

  it('"240 g canned chickpeas (≈ 82 g uncooked)" → the dry record with a soaking step', () => {
    const r = main([{ raw: '240 g canned chickpeas (≈ 82 g uncooked)', fdcId: 173756, grams: 82 }]);
    expect(errorCodes(recipeOf(r))).toEqual(expect.arrayContaining(['FORBIDDEN_WORDING', 'NOT_DRY_STAPLE']));
    const fixed = normalizeRecipe(r, foodById);
    expect(fixed.value.ingredients[0]).toMatchObject({ raw: '82 g chickpeas, dry', fdcId: 173756, grams: 82 });
    expect(fixed.value.steps?.[0]).toMatch(/^Soak the chickpeas/);
    expect(errorCodes(recipeOf(fixed.value))).toEqual([]);
  });

  it('a canned staple without a note converts by dry matter from the two records', () => {
    const { value } = normalizeIngredient({ raw: '400 g canned chickpeas, drained and rinsed' }, { foodById });
    // 400 g × (100 − 66.9) / (100 − 11.5) dry matter of canned-drained vs raw chickpeas
    const dry = Math.round((400 * (100 - foodById.get(173801)!.n.water_g!)) / (100 - foodById.get(173756)!.n.water_g!));
    expect(value.raw).toBe(`${dry} g chickpeas, dry`);
  });

  it('"(in place of butter)" annotation is removed', () => {
    const fixed = flagsAndFixes(main([{ raw: '2 tbsp extra virgin olive oil (in place of butter)' }]), 'FORBIDDEN_WORDING');
    expect(fixed.value.ingredients[0].raw).toBe('2 tbsp extra virgin olive oil');
  });

  it('a "dried chickpeas" line says "dry" in the note', () => {
    const fixed = flagsAndFixes(main([{ raw: '200 g dried chickpeas', fdcId: 173756 }]), 'FORBIDDEN_WORDING');
    expect(fixed.value.ingredients[0].raw).toBe('200 g chickpeas, dry');
  });

  it('keeps "dried" on product names (dried oregano, dried apricots)', () => {
    const r = main([{ raw: '1 tsp dried oregano' }, { raw: '50 g dried apricots' }]);
    expect(codes(recipeOf(r))).not.toContain('FORBIDDEN_WORDING');
    expect(normalizeRecipe(r, foodById).changes).toEqual([]);
  });

  it('a prosciutto tip is a meat suggestion; fish and shellfish are fine', () => {
    expect(errorCodes(recipeOf(main([{ raw: '1 tbsp capers' }]), '## Tips\n\n- Add a few slices of prosciutto.'))).toContain('MEAT_SUGGESTION');
    expect(meatSuggestions('Serve with grilled salmon. Open the mussels and put the meat in a bowl.')).toEqual([]);
    expect(meatSuggestions('Serve as a side with meat or fish.')).toEqual(['meat']);
    expect(meatSuggestions('Use chicken stock or vegetable broth.')).toEqual([]);
  });

  it('a pasta main at 100 g per serving → 80 g dry per serving, servings unchanged', () => {
    const fixed = flagsAndFixes(main([{ raw: '400 g whole-wheat spaghetti, dry', fdcId: 169738 }]), 'PORTION_80');
    expect(fixed.value.servings).toBe(4);
    expect(fixed.value.ingredients[0]).toMatchObject({ raw: '320 g whole-wheat spaghetti, dry', grams: 320 });
  });

  it('a pasta frittata is exempt from the 80 g rule', () => {
    const r = main([{ raw: '110 g whole-wheat spaghetti, dry, cooked', fdcId: 169738 }], { title: 'Frittata di pasta' });
    expect(codes(recipeOf(r))).not.toContain('PORTION_80');
  });

  it('iced tea with excluded ice and tea bags → water counted, tea as the brewed record', () => {
    const tea: NormalizableRecipe = {
      title: 'Iced tea',
      course: 'Drink',
      servings: 2,
      ingredients: [
        { raw: '500 ml water', fdcId: HOUSE_FOODS.water, exclude: true },
        { raw: '4 tea bags', grams: 8 },
        { raw: '200 g ice', fdcId: HOUSE_FOODS.water, exclude: true },
        { raw: '1 cinnamon stick', grams: 3 },
      ],
      steps: ['Steep the tea bags and cinnamon in the hot water for 5 minutes, then strain.'],
    };
    expect(errorCodes(recipeOf(tea)).filter((c) => c === 'DRINK_WATER')).toHaveLength(3);
    const fixed = normalizeRecipe(tea, foodById);
    expect(fixed.value.ingredients).toEqual([
      expect.objectContaining({ raw: '500 ml black tea, brewed from 4 tea bags', fdcId: HOUSE_FOODS.blackTea, grams: 500, exclude: false }),
      expect.objectContaining({ raw: '200 g ice', fdcId: HOUSE_FOODS.water, exclude: false }),
      expect.objectContaining({ raw: '1 cinnamon stick', exclude: true }),
    ]);
    expect(codes(recipeOf(fixed.value))).not.toContain('DRINK_WATER');
  });

  it('alcohol in a drink is dropped', () => {
    const fixed = normalizeRecipe({ title: 'Spritz', course: 'Drink', servings: 1, ingredients: [{ raw: '100 ml prosecco' }, { raw: '200 ml soda water' }] }, foodById);
    expect(fixed.value.ingredients.map((l) => l.raw)).toEqual(['200 ml soda water']);
  });

  it('800 g eggs → a count', () => {
    const fixed = flagsAndFixes(main([{ raw: '800 g eggs', fdcId: 171287 }]), 'EGG_COUNT');
    expect(fixed.value.ingredients[0]).toMatchObject({ raw: '16 eggs', grams: 800 });
    expect(normalizeIngredient({ raw: '2 large eggs' }).value.raw).toBe('2 eggs');
  });

  it('olive oil in grams → tablespoons (13.5 g/tbsp, ½ steps; tsp under ½ tbsp)', () => {
    const fixed = flagsAndFixes(main([{ raw: '30 g extra virgin olive oil', fdcId: 171413 }]), 'OLIVE_OIL_UNIT');
    expect(fixed.value.ingredients[0]).toMatchObject({ raw: '2 tbsp extra virgin olive oil', grams: 27 });
    expect(oliveOilAmount(5).amount).toBe('1 tsp');
    expect(oliveOilAmount(20).amount).toBe('1½ tbsp');
  });

  it('dairy cream, sour cream, crème fraîche and mayonnaise → the plant-based / yogurt records', () => {
    const fixed = normalizeRecipe(
      main([{ raw: '200 ml heavy cream' }, { raw: '150 g sour cream' }, { raw: '100 ml crème fraîche' }, { raw: '3 tbsp mayonnaise' }]),
      foodById,
    );
    expect(fixed.value.ingredients.map((l) => [l.raw, l.fdcId])).toEqual([
      ['200 ml plant-based cooking cream', HOUSE_FOODS.plantCream],
      ['150 g plant-based sour cream', HOUSE_FOODS.plantSourCream],
      ['100 ml plant-based crème fraîche', HOUSE_FOODS.plantCream],
      ['3 tbsp Greek yogurt', HOUSE_FOODS.greekYogurt],
    ]);
  });
});

describe('forbiddenReason allowlist (the documented exceptions)', () => {
  const ok = [
    'honey', 'Medjool dates', 'ketchup', 'no-added-sugar chocolate sauce', 'mirin', 'sake', 'red wine vinegar',
    'apple cider or white wine vinegar', 'rice vinegar', 'couscous', 'gnocchi', 'vegetable broth', 'chicken stock',
    'buttermilk', 'feta cheese', 'Greek yogurt', 'kefir', 'unsweetened oat milk', 'coconut milk', 'peanut butter',
    'butter beans', 'plant-based cooking cream', 'cream cheese', 'coconut cream', 'whole-wheat spaghetti', 'brown rice',
    'whole-wheat flour', 'chickpea flour', 'whole-wheat panko breadcrumbs', 'salmon', 'shrimp', 'sugar snap peas',
    'lamb\'s lettuce', 'soba noodles', 'rice paper sheets', 'salt, for the pasta water', 'ginger beer',
  ];
  for (const t of ok) it(`allows ${t}`, () => expect(forbiddenReason(t)).toBeNull());

  const bad = [
    'chicken breast', 'prosciutto', 'whole milk', 'butter', 'ghee', 'double cream', 'sour cream', 'crème fraîche',
    'mayonnaise', 'dry white wine', 'beer', 'rum', 'hard cider', 'white rice', 'arborio rice', 'spaghetti', 'egg noodles',
    'udon', 'plain flour', 'all-purpose flour', 'breadcrumbs', 'white bread', 'sugar', 'maple syrup', 'agave syrup',
    'erythritol', 'stevia', 'molasses', 'condensed milk', 'jaggery',
  ];
  for (const t of bad) it(`forbids ${t}`, () => expect(forbiddenReason(t)).not.toBeNull());

  it('reads the matched food too (a "rice" line matched to white rice)', () => {
    expect(forbiddenReason('long-grain', foodById.get(169756))).toMatch(/white rice/);
  });
});

describe('findDuplicateRecipes', () => {
  const ings = (pairs: [number, number][]): ValidatableIngredient[] => pairs.map(([fdcId, grams]) => ({ raw: String(fdcId), fdcId, grams }));
  it('pairs near-identical recipes and flags an excluded kifli id', () => {
    const a = { slug: 'a', ingredients: ings([[1, 100], [2, 50], [3, 20], [4, 10]]) };
    const b = { slug: 'b', ingredients: ings([[1, 110], [2, 50], [3, 20], [4, 12]]) };
    const c = { slug: 'c', kifliId: 99, ingredients: ings([[5, 100], [6, 100]]) };
    const found = findDuplicateRecipes([a, b, c], [a, b, c], { 99: 'kept-copy' });
    expect(found.map((f) => f.slug)).toEqual(['a', 'c']);
    expect(found[1].issue.message).toMatch(/kept-copy/);
  });
});

describe('validateRecipe runs the house rules', () => {
  it('reports a cooked staple once, as NOT_DRY_STAPLE (not also STATE_MISMATCH)', () => {
    const r: ValidatableRecipe = {
      title: 'Chickpea stew',
      course: 'Main Course',
      servings: 4,
      ingredients: [{ raw: '240 g cooked chickpeas', quantity: 240, unit: 'g', item: 'cooked chickpeas', grams: 240, fdcId: 173756 }],
    };
    const { errors } = validateRecipe(r, foodById);
    expect(errors.map((e) => e.code)).toContain('NOT_DRY_STAPLE');
    expect(errors.map((e) => e.code)).not.toContain('STATE_MISMATCH');
  });

  it('a normalized line is stable (normalizing twice changes nothing)', () => {
    const once = normalizeRecipe(main([{ raw: '50 g butter' }, { raw: '1 handful basil' }, { raw: '240 g canned chickpeas' }]), foodById);
    expect(normalizeRecipe(once.value, foodById).changes).toEqual([]);
  });
});

describe('review regressions', () => {
  it('converts every legume alternative without throwing', () => {
    for (const raw of [
      '400 g canned black-eyed peas', '300 g cooked mung beans', '250 g cooked split peas', '300 g cooked dal',
      '400 g canned adzuki beans', '400 g canned flageolet beans', '400 g canned great northern beans', '400 g canned navy beans',
    ]) {
      const { value } = normalizeIngredient({ raw }, { foodById });
      expect(value.raw, raw).toMatch(/, dry$/);
    }
    expect(normalizeIngredient({ raw: '250 g cooked split peas' }, { foodById }).value.raw).toMatch(/dry$/);
  });

  it('treats a can or tin unit as canned (flagged and converted)', () => {
    for (const raw of ['1 can chickpeas', '2 tins cannellini beans, rinsed']) {
      const r = main([{ raw }]);
      expect(errorCodes(recipeOf(r)), raw).toContain('NOT_DRY_STAPLE');
      const fixed = normalizeRecipe(r, foodById);
      expect(fixed.value.ingredients[0].raw, raw).toMatch(/^\d+ g (chickpeas|cannellini beans), dry$/);
    }
    // 1 can drains to 240 g of chickpeas
    const dry = Math.round((240 * (100 - foodById.get(173801)!.n.water_g!)) / (100 - foodById.get(173756)!.n.water_g!));
    expect(normalizeIngredient({ raw: '1 can chickpeas' }, { foodById }).value.raw).toBe(`${dry} g chickpeas, dry`);
  });

  it('does not read steaks or cutlets as meat on their own', () => {
    expect(meatSuggestions('Pat the tuna dry. Sear the steaks for 2 minutes a side.')).toEqual([]);
    expect(meatSuggestions('Cut the cauliflower into thick steaks.')).toEqual([]);
    expect(meatSuggestions('Serve with a beef steak.')).toEqual(['beef']);
  });

  it('allows pomegranate / date molasses and (non-alcoholic) apple cider; hard cider is alcohol', () => {
    expect(forbiddenReason('2 tbsp pomegranate molasses')).toBeNull();
    expect(forbiddenReason('1 tbsp date molasses')).toBeNull();
    expect(forbiddenReason('250 ml apple cider')).toBeNull();
    expect(forbiddenReason('250 ml hard cider')).toMatch(/alcohol/);
    expect(normalizeIngredient({ raw: '2 tbsp pomegranate molasses' }).changes).toEqual([]);
  });

  it('leaves another variety unpinned after the dry conversion', () => {
    const conv = (raw: string) => normalizeIngredient({ raw }, { foodById }).value;
    expect(conv('300 g cooked brown rice').fdcId).toBe(169703);
    expect(conv('300 g cooked brown basmati rice')).toMatchObject({ raw: expect.stringMatching(/^\d+ g brown basmati rice, dry$/), fdcId: null });
    expect(conv('300 g cooked wild rice').fdcId).toBe(169726);
    expect(conv('300 g cooked soba noodles').fdcId).toBe(168906);
    expect(conv('300 g cooked whole-wheat udon').fdcId).toBeNull();
    expect(conv('300 g cooked whole-wheat penne').fdcId).toBe(169738);
  });

  it('drops a drink\'s alcohol from the method too', () => {
    const fixed = normalizeRecipe(
      { title: 'Mojito', course: 'Drink', servings: 1, ingredients: [{ raw: '50 ml white rum' }, { raw: '200 ml soda water' }], steps: ['Muddle the mint. Stir in the rum.', 'Top with soda water.'] },
      foodById,
    );
    expect(fixed.value.ingredients.map((l) => l.raw)).toEqual(['200 ml soda water']);
    expect(fixed.value.steps).toEqual(['Muddle the mint.', 'Top with soda water.']);
  });

  it('swaps spirits and beer in the method of a dish, and butter matched by its food', () => {
    const fixed = normalizeRecipe(
      main([{ raw: '50 ml brandy' }, { raw: '30 g fat', fdcId: 173430 }], { steps: ['Flambé with the brandy.', 'Melt the butter.'] }),
      foodById,
    );
    expect(fixed.value.steps).toEqual(['Flambé with the broth.', 'Heat the olive oil.']);
  });
});

describe('findDuplicateRecipes: removed ids', () => {
  it('says the owner removed the recipe', () => {
    const found = findDuplicateRecipes([{ slug: 'x', kifliId: 7, ingredients: [] }], [], { 7: 'removed: Nutri-Score E (fig-jam)' });
    expect(found[0].issue.message).toBe('kifli id 7 was removed by the owner (Nutri-Score E (fig-jam)) — listed in excluded-ids.json');
  });
});

describe('fresh ginger is stored in grams', () => {
  it('converts a spoon or length of fresh ginger to its grams, and leaves ground ginger in spoons', async () => {
    const { normalizeIngredient, isFreshGinger } = await import('./houseRules');
    expect(normalizeIngredient({ raw: '½ tbsp freshly grated ginger', grams: 3 }).value.raw).toBe('3 g freshly grated ginger');
    expect(normalizeIngredient({ raw: '5 cm fresh ginger', grams: 15 }).value.raw).toBe('15 g fresh ginger');
    expect(isFreshGinger('ground ginger')).toBe(false);
    expect(normalizeIngredient({ raw: '1 tsp ground ginger', grams: 1.7 }).value.raw).toBe('1 tsp ground ginger');
    // A bare "ginger" in spoons is the ground spice; to-taste lines and ginger tea are left alone.
    expect(normalizeIngredient({ raw: '1 tsp ginger', grams: 2 }).value.raw).toBe('1 tsp ginger');
    expect(normalizeIngredient({ raw: 'fresh ginger, to taste', grams: 5 }).value.raw).toBe('fresh ginger, to taste');
    expect(normalizeIngredient({ raw: '1 tbsp ginger tea', grams: 2 }).value.raw).toBe('1 tbsp ginger tea');
  });
});
