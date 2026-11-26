/// <reference types="vite/client" />
/**
 * Golden reference set: hand-checked synthetic recipes built from real bundled foods
 * (src/data/usda-foods.json fdcIds), scored through the full pipeline
 * (recipeScore.scoreRecipe: cooking → macros → GI/GL → Nutri-Score → FII → NRF9.3 → NOVA).
 *
 * Each case asserts RANGES a nutrition-literate reader would sign off on, not the exact
 * engine output, so a deliberate engine or data change that keeps a dish's verdict passes
 * while one that flips a verdict (an olive-oil salad reading pro-inflammatory, a jam
 * reading low-GL) fails. Exact per-recipe values are guarded by recipeScore.repro.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreRecipe,
  type FoodScoring,
  type RecipeScoringOptions,
  type StoredScoringIngredient,
  type RecipeScore,
} from './recipeScore';
import type { FoodRecord } from './match';
import type { CookingMethod } from './cooking';
import type { Band } from './gi';
import type { InflammationBand } from './inflammation';
import type { ProcessingBand } from './processing';
import usdaFoods from '../data/usda-foods.json';
import foodScoringData from '../data/food-scoring.json';
import polyphenolData from '../data/polyphenols.json';

const foodById = new Map((usdaFoods as FoodRecord[]).map((f) => [f.fdcId as number, f]));
const foodScoring = foodScoringData as Record<string, FoodScoring>;
const polyphenols = polyphenolData as Record<string, { polyphenol_mg?: number }>;

/** Bundled foods the set is built from (fdcId → USDA description). */
const F = {
  strawberries: 167762, // Strawberries, raw
  honey: 169640, // Honey
  lemonJuice: 167747, // Lemon juice, raw
  water: 174158, // Water, bottled, generic
  carrots: 170393, // Carrots, raw
  onions: 170000, // Onions, raw
  potatoes: 170028, // Potatoes, white, flesh and skin, raw
  celery: 169988, // Celery, raw
  butter: 173430, // Butter, without salt
  oliveOil: 171413, // Oil, olive, salad or cooking
  salt: 173468, // Salt, table
  wwPasta: 169738, // Pasta, whole-wheat, dry
  tomatoes: 170457, // Tomatoes, red, ripe, raw, year round average
  garlic: 169230, // Garlic, raw
  parmesan: 170848, // Cheese, parmesan, hard
  romaine: 169247, // Lettuce, cos or romaine, raw
  spinach: 168462, // Spinach, raw
  cucumber: 168409, // Cucumber, with peel, raw
  lentils: 172420, // Lentils, raw
  whiteToast: 174925, // Bread, white, commercially prepared, toasted
  cheddar: 173414, // Cheese, cheddar
  bananas: 173944, // Bananas, raw
  yogurt: 171284, // Yogurt, plain, whole milk
  vegBroth: 171583, // Soup, vegetable broth, ready to serve
  chickpeasDry: 173756, // Chickpeas, mature seeds, raw
  chickpeasCanned: 173801, // Chickpeas, mature seeds, canned, drained, rinsed in tap water
  broccoli: 170379, // Broccoli, raw
  ginger: 169231, // Ginger root, raw
  turmeric: 172231, // Spices, turmeric, ground
  cumin: 170923, // Spices, cumin seed
  pepper: 170931, // Spices, pepper, black
  walnuts: 170187, // Nuts, walnuts, english
  brie: 172177, // Cheese, brie
  blueCheese: 172175, // Cheese, blue
  matzo: 172740, // Crackers, matzo, plain
  grapes: 174683, // Grapes, red or green (European type), raw
  oats: 2346396, // Oats, whole grain, rolled, old fashioned
  blueberries: 171711, // Blueberries, raw
  whiteRice: 169756, // Rice, white, long-grain, regular, raw, unenriched
  salmon: 173686, // Fish, salmon, Atlantic, wild, raw
  sugar: 169655, // Sugars, granulated
  eggs: 171287, // Egg, whole, raw, fresh
  almonds: 170567, // Nuts, almonds
} as const;

function ing(
  fdcId: number | null,
  grams: number,
  raw: string,
  cooking?: CookingMethod,
  excludeFromNutrition?: boolean,
): StoredScoringIngredient {
  return { fdcId, grams, raw, cooking, excludeFromNutrition };
}
const water = (grams: number) => ing(F.water, grams, `${grams} ml water`, undefined, true);

function score(ingredients: StoredScoringIngredient[], options: RecipeScoringOptions): RecipeScore {
  return scoreRecipe(ingredients, options, foodById, foodScoring, polyphenols);
}

const GRADES = ['A', 'B', 'C', 'D', 'E'] as const;
const INFLAMMATION: readonly InflammationBand[] = [
  'anti-inflammatory',
  'mildly-anti-inflammatory',
  'neutral',
  'mildly-pro-inflammatory',
  'pro-inflammatory',
];

interface Expected {
  /** kcal per serving, inclusive range. */
  kcal: [number, number];
  /** Acceptable GI band(s); null = no glycemic block expected. */
  giBand: Band[] | null;
  /** Meal GI inclusive range, when a case pins the value tighter than its band. */
  gi?: [number, number];
  glBand?: Band[];
  glBasis?: 'meal' | 'portion';
  /** Nutri-Score grade range, best → worst. */
  nutri: [(typeof GRADES)[number], (typeof GRADES)[number]];
  /** Inflammation band range, most anti → most pro; null = no inflammation block expected. */
  inflammation: [InflammationBand, InflammationBand] | null;
  processing?: ProcessingBand[];
  /** Nutrient-balance 1–10 score range. */
  balance?: [number, number];
}

interface GoldenCase {
  name: string;
  ingredients: StoredScoringIngredient[];
  options: RecipeScoringOptions;
  expected: Expected;
}

const STEW_VEG = [
  ing(F.carrots, 300, '300 g carrots', 'boiled'),
  ing(F.onions, 200, '2 onions', 'boiled'),
  ing(F.potatoes, 400, '400 g potatoes', 'boiled'),
  ing(F.celery, 150, '3 sticks celery', 'boiled'),
  ing(F.salt, 6, '1 tsp salt'),
  water(800),
];

const LENTIL_SOUP = [
  ing(F.lentils, 300, '300 g dried brown lentils', 'boiled'),
  ing(F.carrots, 150, '2 carrots', 'boiled'),
  ing(F.onions, 150, '1 onion', 'boiled'),
  ing(F.celery, 100, '2 sticks celery', 'boiled'),
  ing(F.tomatoes, 200, '200 g tomatoes', 'boiled'),
  ing(F.oliveOil, 20, '1½ tbsp olive oil'),
  ing(F.salt, 5, '1 tsp salt'),
  water(1200),
];

const CASES: GoldenCase[] = [
  {
    // Fruit + honey is mostly free sugar at GI ~58; a generous ~60 g spread is a medium-GL portion.
    name: 'strawberry jam with honey (condiment)',
    ingredients: [
      ing(F.strawberries, 500, '500 g strawberries', 'boiled'),
      ing(F.honey, 250, '250 g honey'),
      ing(F.lemonJuice, 20, 'juice of 1 lemon'),
    ],
    options: { servings: 12, course: 'Condiment' },
    expected: {
      kcal: [65, 90], giBand: ['medium'], glBand: ['medium', 'high'], glBasis: 'portion',
      nutri: ['C', 'E'], inflammation: ['mildly-pro-inflammatory', 'pro-inflammatory'], balance: [1, 2],
    },
  },
  {
    // Honey lemonade: almost all energy is free sugar → pro-inflammatory, poor beverage grade.
    name: 'honey-sweetened lemonade (drink)',
    ingredients: [water(1000), ing(F.lemonJuice, 100, '100 ml lemon juice'), ing(F.honey, 120, '120 g honey')],
    options: { servings: 4, course: 'Drink', nutriCategory: 'beverage' },
    expected: {
      kcal: [80, 115], giBand: ['medium'], glBand: ['medium', 'high'], glBasis: 'portion',
      nutri: ['D', 'E'], inflammation: ['pro-inflammatory', 'pro-inflammatory'], processing: ['minimally-processed'], balance: [1, 2],
    },
  },
  {
    // 30 g butter per serving: saturated fat dominates the energy → pro side.
    name: 'butter-heavy vegetable stew (main)',
    ingredients: [...STEW_VEG, ing(F.butter, 120, '120 g butter')],
    options: { servings: 4, course: 'Main Course' },
    expected: {
      kcal: [300, 380], giBand: ['low', 'medium'], glBand: ['low'], glBasis: 'meal',
      nutri: ['B', 'D'], inflammation: ['mildly-pro-inflammatory', 'pro-inflammatory'], balance: [2, 4],
    },
  },
  {
    // Same stew with olive oil: MUFA fat quality flips it to the anti side and lifts the grade.
    name: 'olive-oil vegetable stew (main)',
    ingredients: [...STEW_VEG, ing(F.oliveOil, 120, '120 g extra virgin olive oil')],
    options: { servings: 4, course: 'Main Course' },
    expected: {
      kcal: [350, 430], giBand: ['low', 'medium'], glBand: ['low'], glBasis: 'meal',
      nutri: ['A', 'C'], inflammation: ['anti-inflammatory', 'mildly-anti-inflammatory'], balance: [4, 6],
    },
  },
  {
    // 100 g dry whole-wheat pasta per plate: ~65 g carb at GI ~50 → medium meal GL; fibre and
    // olive oil offset refined-starch energy → inflammation near neutral.
    name: 'whole-wheat pasta with tomato and parmesan (main)',
    ingredients: [
      ing(F.wwPasta, 400, '400 g whole-wheat pasta', 'boiled'),
      ing(F.tomatoes, 400, '400 g tomatoes', 'boiled'),
      ing(F.oliveOil, 30, '2 tbsp olive oil'),
      ing(F.garlic, 10, '3 cloves garlic'),
      ing(F.parmesan, 40, '40 g parmesan'),
      ing(F.salt, 4, 'salt'),
    ],
    options: { servings: 4, course: 'Main Course' },
    expected: {
      kcal: [430, 530], giBand: ['low'], glBand: ['medium'], glBasis: 'meal',
      nutri: ['A', 'B'], inflammation: ['mildly-anti-inflammatory', 'mildly-pro-inflammatory'], processing: ['minimally-processed'], balance: [4, 6],
    },
  },
  {
    // Leafy greens + olive oil: vitamin C/E, magnesium, polyphenols and MUFA → anti side, dense.
    name: 'green salad with olive oil (salad)',
    ingredients: [
      ing(F.romaine, 200, '1 head romaine'),
      ing(F.spinach, 100, '100 g baby spinach'),
      ing(F.cucumber, 150, '1 cucumber'),
      ing(F.oliveOil, 30, '2 tbsp extra virgin olive oil'),
      ing(F.lemonJuice, 15, '1 tbsp lemon juice'),
      ing(F.salt, 2, 'pinch of salt'),
    ],
    options: { servings: 2, course: 'Salad' },
    expected: {
      kcal: [150, 200], giBand: ['low'], glBand: ['low'], glBasis: 'meal',
      nutri: ['A', 'A'], inflammation: ['anti-inflammatory', 'mildly-anti-inflammatory'], processing: ['minimally-processed'], balance: [8, 10],
    },
  },
  {
    // Lentils (GI ~32) carry the carbohydrate → low GI; legume fibre → anti side, grade A.
    name: 'lentil soup (soup)',
    ingredients: LENTIL_SOUP,
    options: { servings: 4, course: 'Soup' },
    expected: {
      kcal: [310, 390], giBand: ['low'], glBand: ['low'], glBasis: 'meal',
      nutri: ['A', 'A'], inflammation: ['anti-inflammatory', 'neutral'], processing: ['minimally-processed'], balance: [6, 8],
    },
  },
  {
    // White toast + cheddar: refined starch, sat fat and salt → poor grade, pro side, ultra-processed
    // bread. White wheat bread carries its measured GI (mean ≈ 74, Atkinson 2021); the cheese's fat
    // and protein pull the meal GI only slightly below that, so it stays high.
    name: 'white-bread toast with cheddar (snack)',
    ingredients: [ing(F.whiteToast, 60, '2 slices white bread, toasted'), ing(F.cheddar, 30, '30 g cheddar')],
    options: { servings: 1, course: 'Snack' },
    expected: {
      kcal: [260, 330], giBand: ['high'], gi: [70, 76], glBand: ['medium', 'high'], glBasis: 'portion',
      nutri: ['C', 'E'], inflammation: ['neutral', 'pro-inflammatory'], processing: ['highly-processed'], balance: [1, 3],
    },
  },
  {
    // Whole-fruit sugar is fibre-bound (free sugar = max(0, sugar − 2·fibre)) and yogurt is
    // fermented dairy; whole-milk yogurt's saturated fat and banana's free-sugar excess put it
    // on the neutral / mildly-pro edge, well short of the honey lemonade.
    name: 'banana-strawberry yogurt smoothie (drink)',
    ingredients: [
      ing(F.bananas, 240, '2 bananas'),
      ing(F.strawberries, 200, '200 g strawberries'),
      ing(F.yogurt, 250, '250 g plain yogurt'),
    ],
    options: { servings: 2, course: 'Drink', nutriCategory: 'beverage' },
    expected: {
      kcal: [190, 240], giBand: ['low'], glBand: ['medium'], glBasis: 'portion',
      nutri: ['B', 'D'], inflammation: ['mildly-anti-inflammatory', 'mildly-pro-inflammatory'], processing: ['minimally-processed'], balance: [5, 8],
    },
  },
  {
    // 15 g added salt on top of a salted broth: salt dominates → pro-inflammatory, poor balance.
    name: 'salt-heavy vegetable broth (soup)',
    ingredients: [
      ing(F.carrots, 200, '2 carrots', 'boiled'),
      ing(F.onions, 150, '1 onion', 'boiled'),
      ing(F.celery, 100, '2 sticks celery', 'boiled'),
      ing(F.vegBroth, 1000, '1 l vegetable broth'),
      ing(F.salt, 15, '1 tbsp salt'),
    ],
    options: { servings: 4, course: 'Soup' },
    expected: {
      kcal: [35, 70], giBand: ['low'], glBand: ['low'], glBasis: 'meal',
      nutri: ['C', 'E'], inflammation: ['mildly-pro-inflammatory', 'pro-inflammatory'], balance: [1, 2],
    },
  },
  {
    // Turmeric, ginger, garlic, onion, pepper at full doses: the aromatic credit saturates at its cap.
    name: 'spice-heavy chickpea curry (main)',
    ingredients: [
      ing(F.chickpeasDry, 300, '300 g dried chickpeas', 'boiled'),
      ing(F.tomatoes, 400, '400 g tomatoes', 'boiled'),
      ing(F.onions, 200, '2 onions', 'fried'),
      ing(F.oliveOil, 30, '2 tbsp oil'),
      ing(F.garlic, 20, '6 cloves garlic'),
      ing(F.ginger, 30, '30 g fresh ginger'),
      ing(F.turmeric, 10, '1 tbsp ground turmeric'),
      ing(F.cumin, 6, '2 tsp cumin seeds'),
      ing(F.pepper, 3, '1 tsp black pepper'),
      ing(F.salt, 5, '1 tsp salt'),
    ],
    options: { servings: 4, course: 'Main Course' },
    expected: {
      kcal: [370, 460], giBand: ['low'], glBand: ['low', 'medium'], glBasis: 'meal',
      nutri: ['A', 'A'], inflammation: ['anti-inflammatory', 'mildly-anti-inflammatory'], processing: ['minimally-processed'], balance: [5, 7],
    },
  },
  {
    // Honey over yogurt and walnuts: walnut PUFA and fermented dairy offset the honey's free
    // sugar only partly; a dessert is one portion, so ~23 g carb reads medium GL.
    name: 'yogurt with honey and walnuts (dessert)',
    ingredients: [ing(F.yogurt, 500, '500 g plain yogurt'), ing(F.honey, 80, '4 tbsp honey'), ing(F.walnuts, 60, '60 g walnuts')],
    options: { servings: 4, course: 'Dessert' },
    expected: {
      kcal: [200, 270], giBand: ['low', 'medium'], glBand: ['medium'], glBasis: 'portion',
      nutri: ['B', 'D'], inflammation: ['neutral', 'mildly-pro-inflammatory'], processing: ['minimally-processed'], balance: [1, 3],
    },
  },
  {
    // Three cheeses + crackers + grapes, scored as cheese (protein kept) and not red meat:
    // sat fat and salt dominate → poor grade, pro side; cheese is NOVA 3 (processed, not
    // ultra-processed), so the board reads moderately processed.
    name: 'cheese board (appetizer)',
    ingredients: [
      ing(F.cheddar, 100, '100 g cheddar'),
      ing(F.brie, 100, '100 g brie'),
      ing(F.blueCheese, 60, '60 g blue cheese'),
      ing(F.matzo, 80, '80 g crackers'),
      ing(F.grapes, 200, '200 g grapes'),
    ],
    options: { servings: 6, course: 'Appetizer', isCheese: true, redMeat: false },
    expected: {
      kcal: [200, 270], giBand: ['low', 'medium'], glBand: ['low'], glBasis: 'portion',
      nutri: ['D', 'E'], inflammation: ['mildly-pro-inflammatory', 'pro-inflammatory'], processing: ['moderately-processed'], balance: [1, 3],
    },
  },
  {
    // Rolled oats + fruit, ~40 g carb at GI ~55: a breakfast is a meal → medium meal GL.
    name: 'oat porridge with banana and blueberries (breakfast)',
    ingredients: [
      ing(F.oats, 80, '80 g rolled oats', 'boiled'),
      water(300),
      ing(F.bananas, 120, '1 banana'),
      ing(F.blueberries, 80, '80 g blueberries'),
    ],
    options: { servings: 2, course: 'Breakfast' },
    expected: {
      kcal: [200, 260], giBand: ['low', 'medium'], glBand: ['low', 'medium'], glBasis: 'meal',
      nutri: ['A', 'B'], inflammation: ['mildly-anti-inflammatory', 'neutral'], processing: ['minimally-processed'], balance: [4, 6],
    },
  },
  {
    // 50 g dry white rice per serving at GI ~73 → GL ~29: a high-GL portion as a side dish.
    name: 'plain white rice (side dish)',
    ingredients: [ing(F.whiteRice, 200, '200 g long-grain white rice', 'boiled'), ing(F.salt, 2, 'salt'), water(400)],
    options: { servings: 4, course: 'Side Dish' },
    expected: {
      kcal: [160, 200], giBand: ['high'], glBand: ['high'], glBasis: 'portion',
      nutri: ['A', 'C'], inflammation: ['neutral', 'mildly-pro-inflammatory'], processing: ['minimally-processed'], balance: [1, 3],
    },
  },
  {
    // The identical rice labelled a main course is banded as a meal → medium, not high.
    name: 'plain white rice (main course)',
    ingredients: [ing(F.whiteRice, 200, '200 g long-grain white rice', 'boiled'), ing(F.salt, 2, 'salt'), water(400)],
    options: { servings: 4, course: 'Mains' },
    expected: {
      kcal: [160, 200], giBand: ['high'], glBand: ['medium'], glBasis: 'meal',
      nutri: ['A', 'C'], inflammation: ['neutral', 'mildly-pro-inflammatory'], processing: ['minimally-processed'], balance: [1, 3],
    },
  },
  {
    // No course at all falls back to portion bands.
    name: 'plain white rice (no course)',
    ingredients: [ing(F.whiteRice, 200, '200 g long-grain white rice', 'boiled')],
    options: { servings: 4 },
    expected: {
      kcal: [160, 200], giBand: ['high'], glBand: ['high'], glBasis: 'portion',
      nutri: ['A', 'C'], inflammation: ['neutral', 'mildly-pro-inflammatory'], processing: ['minimally-processed'], balance: [1, 4],
    },
  },
  {
    // Wild salmon's omega-3 fat + olive oil → anti side; fish protein lowers the potato GI.
    name: 'baked salmon with boiled potatoes (main)',
    ingredients: [
      ing(F.salmon, 600, '600 g salmon fillet', 'baked'),
      ing(F.potatoes, 800, '800 g potatoes', 'boiled'),
      ing(F.oliveOil, 30, '2 tbsp olive oil'),
      ing(F.lemonJuice, 20, 'juice of ½ lemon'),
      ing(F.salt, 4, 'salt'),
    ],
    options: { servings: 4, course: 'Main Course' },
    expected: {
      kcal: [370, 470], giBand: ['low', 'medium'], glBand: ['low'], glBasis: 'meal',
      nutri: ['A', 'B'], inflammation: ['anti-inflammatory', 'mildly-anti-inflammatory'], processing: ['minimally-processed'], balance: [5, 7],
    },
  },
  {
    // Sugar syrup: pure sucrose (GI 65), 10 g per serving → low GL portion, but grade E and pro.
    name: 'simple sugar syrup (sauce)',
    ingredients: [ing(F.sugar, 200, '200 g sugar'), water(200)],
    options: { servings: 20, course: 'Sauce' },
    expected: {
      kcal: [35, 45], giBand: ['medium'], glBand: ['low'], glBasis: 'portion',
      nutri: ['E', 'E'], inflammation: ['pro-inflammatory', 'pro-inflammatory'], balance: [1, 1],
    },
  },
  {
    // Plain water declared as water: Nutri-Score A by rule; no energy → no GI, FII or balance.
    name: 'plain water (drink)',
    ingredients: [ing(F.water, 500, '500 ml water')],
    options: { servings: 2, course: 'Drink', nutriCategory: 'beverage', isWater: true },
    expected: { kcal: [0, 0], giBand: null, nutri: ['A', 'A'], inflammation: null },
  },
  {
    // Eggs + spinach: ~2 g carb per serving → GL 0; egg protein and spinach micronutrients → dense.
    name: 'spinach omelette (breakfast)',
    ingredients: [
      ing(F.eggs, 300, '6 eggs', 'fried'),
      ing(F.spinach, 150, '150 g spinach', 'fried'),
      ing(F.oliveOil, 15, '1 tbsp olive oil'),
      ing(F.salt, 2, 'salt'),
    ],
    options: { servings: 2, course: 'Breakfast' },
    expected: {
      kcal: [260, 340], giBand: ['low'], glBand: ['low'], glBasis: 'meal',
      nutri: ['A', 'C'], inflammation: ['anti-inflammatory', 'neutral'], processing: ['minimally-processed'], balance: [6, 8],
    },
  },
  {
    // A handful of almonds on the fats/oils/nuts/seeds sub-algorithm: MUFA-rich → grade A, anti side.
    name: 'almonds (snack, nuts category)',
    ingredients: [ing(F.almonds, 30, '30 g almonds')],
    options: { servings: 1, course: 'Snack', nutriCategory: 'fat-oil-nut-seed' },
    expected: {
      kcal: [160, 190], giBand: ['low'], glBand: ['low'], glBasis: 'portion',
      nutri: ['A', 'B'], inflammation: ['anti-inflammatory', 'mildly-anti-inflammatory'], processing: ['minimally-processed'], balance: [6, 8],
    },
  },
];

const within = (v: number | undefined, [lo, hi]: [number, number]) => v != null && v >= lo && v <= hi;
const indexIn = <T>(list: readonly T[], v: T | undefined) => (v == null ? -1 : list.indexOf(v));

describe('golden reference recipes score within their hand-checked ranges', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const { macro, scores } = score(c.ingredients, c.options);
      const e = c.expected;
      const kcal = macro.perServing.energyKcal;
      expect(within(kcal, e.kcal), `kcal/serving ${kcal} ∉ [${e.kcal}]`).toBe(true);

      if (e.giBand === null) {
        expect(scores.glycemic, 'no glycemic block').toBeUndefined();
      } else {
        expect(e.giBand, `GI ${scores.glycemic?.gi}`).toContain(scores.glycemic?.giBand);
        if (e.gi) expect(within(scores.glycemic?.gi, e.gi), `GI ${scores.glycemic?.gi} ∉ [${e.gi}]`).toBe(true);
        if (e.glBand) expect(e.glBand, `GL ${scores.glycemic?.gl}`).toContain(scores.glycemic?.glBand);
        if (e.glBasis) expect(scores.glycemic?.glBasis).toBe(e.glBasis);
      }

      const g = indexIn(GRADES, scores.nutriScore?.grade as (typeof GRADES)[number]);
      expect(g >= GRADES.indexOf(e.nutri[0]) && g <= GRADES.indexOf(e.nutri[1]), `Nutri ${scores.nutriScore?.grade} ∉ ${e.nutri.join('–')}`).toBe(true);

      if (e.inflammation === null) {
        expect(scores.inflammation, 'no inflammation block').toBeUndefined();
      } else {
        const b = indexIn(INFLAMMATION, scores.inflammation?.band);
        expect(
          b >= INFLAMMATION.indexOf(e.inflammation[0]) && b <= INFLAMMATION.indexOf(e.inflammation[1]),
          `inflammation ${scores.inflammation?.score} (${scores.inflammation?.band}) ∉ ${e.inflammation.join(' … ')}`,
        ).toBe(true);
      }
      if (e.processing) expect(e.processing).toContain(scores.processing?.band);
      if (e.balance) expect(within(scores.balance?.score, e.balance), `balance ${scores.balance?.score} ∉ [${e.balance}]`).toBe(true);
    });
  }
});

describe('golden reference pairs', () => {
  it('water and ice lines change nothing (excluded water, unmatched ice)', () => {
    // Excluded cooking water and an unmatched "ice" line carry no nutrients into any score.
    const base = score(LENTIL_SOUP, { servings: 4, course: 'Soup' });
    const extra = score([...LENTIL_SOUP, water(500), ing(null, 200, '200 g ice cubes')], { servings: 4, course: 'Soup' });
    expect(extra.scores).toEqual(base.scores);
    expect(extra.macro.perServing).toEqual(base.macro.perServing);
  });

  it('extra salt worsens the Nutri-Score of an otherwise identical soup', () => {
    // Same vegetables in plain water vs salted broth + a tablespoon of salt.
    const veg = [
      ing(F.carrots, 200, '2 carrots', 'boiled'),
      ing(F.onions, 150, '1 onion', 'boiled'),
      ing(F.celery, 100, '2 sticks celery', 'boiled'),
    ];
    const plain = score([...veg, water(1000)], { servings: 4, course: 'Soup' }).scores;
    const salty = score([...veg, ing(F.vegBroth, 1000, '1 l vegetable broth'), ing(F.salt, 15, '1 tbsp salt')], { servings: 4, course: 'Soup' }).scores;
    expect(salty.nutriScore!.points).toBeGreaterThan(plain.nutriScore!.points);
    expect(GRADES.indexOf(salty.nutriScore!.grade)).toBeGreaterThan(GRADES.indexOf(plain.nutriScore!.grade));
    expect(salty.balance!.score).toBeLessThan(plain.balance!.score);
  });

  it('canned chickpeas score like the dry-equivalent boiled chickpeas', () => {
    // 200 g dry chickpeas boiled ≈ 480 g drained canned; the dish verdicts match. Canned chickpeas
    // are NOVA 3 (processed, not ultra-processed), so the canned dish reads moderately processed —
    // one step from the dry dish, never highly processed.
    const extras = [ing(F.oliveOil, 20, '1½ tbsp olive oil'), ing(F.lemonJuice, 20, 'juice of ½ lemon')];
    const opts = { servings: 4, course: 'Side Dish' };
    const dry = score([ing(F.chickpeasDry, 200, '200 g dried chickpeas', 'boiled'), ...extras], opts);
    const canned = score([ing(F.chickpeasCanned, 480, '2 cans chickpeas, drained and rinsed'), ...extras], opts);
    const kDry = dry.macro.perServing.energyKcal!;
    const kCan = canned.macro.perServing.energyKcal!;
    expect(Math.abs(kDry - kCan) / kDry).toBeLessThan(0.15);
    expect(canned.scores.glycemic!.giBand).toBe(dry.scores.glycemic!.giBand);
    expect(Math.abs(canned.scores.glycemic!.gl - dry.scores.glycemic!.gl)).toBeLessThanOrEqual(3);
    expect(canned.scores.nutriScore!.grade).toBe(dry.scores.nutriScore!.grade);
    expect(canned.scores.inflammation!.band).toBe(dry.scores.inflammation!.band);
    expect(Math.abs(canned.scores.balance!.score - dry.scores.balance!.score)).toBeLessThanOrEqual(1);
    expect(dry.scores.processing!.band).toBe('minimally-processed');
    expect(canned.scores.processing!.band).toBe('moderately-processed');
  });

  it('boiling broccoli gains water mass and loses a little vitamin C (slightly lower NRF)', () => {
    // Boiled: yield > 1 (mass up, energy unchanged); vitamin C retention < 1 trims NRF a little.
    const raw = score([ing(F.broccoli, 400, '400 g broccoli')], { servings: 4, course: 'Side Dish' });
    const boiled = score([ing(F.broccoli, 400, '400 g broccoli', 'boiled')], { servings: 4, course: 'Side Dish' });
    expect(boiled.macro.totalGrams).toBeGreaterThan(raw.macro.totalGrams);
    expect(boiled.macro.totalGrams).toBeLessThan(raw.macro.totalGrams * 1.3);
    expect(boiled.macro.perServing.energyKcal).toBe(raw.macro.perServing.energyKcal);
    expect(boiled.scores.balance!.nrf).toBeLessThan(raw.scores.balance!.nrf);
    expect(boiled.scores.balance!.nrf).toBeGreaterThan(raw.scores.balance!.nrf * 0.9);
    expect(boiled.scores.inflammation!.band).toBe(raw.scores.inflammation!.band);
  });

  it('the aromatic adjustment of a spice-heavy curry is bounded at −0.5', () => {
    // Every aromatic at or above its typical dose: the credit saturates at the cap, never beyond.
    const curry = CASES.find((c) => c.name.startsWith('spice-heavy'))!;
    const adj = score(curry.ingredients, curry.options).scores.inflammation!.aromaticAdjustment!;
    expect(adj).toBeLessThan(0);
    expect(adj).toBeGreaterThanOrEqual(-0.5);
  });

  it('the cheese flag keeps protein in a cheese board’s Nutri-Score; red-meat flag stays off', () => {
    // isCheese counts protein past the negative-points cap, so it can only help the grade.
    const board = CASES.find((c) => c.name.startsWith('cheese board'))!;
    const asCheese = score(board.ingredients, board.options).scores.nutriScore!;
    const plain = score(board.ingredients, { ...board.options, isCheese: false }).scores.nutriScore!;
    const asRedMeat = score(board.ingredients, { ...board.options, isCheese: false, redMeat: true }).scores.nutriScore!;
    expect(asCheese.points).toBeLessThanOrEqual(plain.points);
    expect(asRedMeat.points).toBeGreaterThanOrEqual(plain.points);
  });

  it('butter vs olive oil flips the same stew from the pro to the anti side', () => {
    const butter = CASES.find((c) => c.name.startsWith('butter-heavy'))!;
    const olive = CASES.find((c) => c.name.startsWith('olive-oil'))!;
    const b = score(butter.ingredients, butter.options).scores;
    const o = score(olive.ingredients, olive.options).scores;
    expect(b.inflammation!.score).toBeGreaterThan(0);
    expect(o.inflammation!.score).toBeLessThan(0);
    expect(o.nutriScore!.points).toBeLessThan(b.nutriScore!.points);
  });

  it('fruit sugar in a smoothie reads far less inflammatory than honey in a lemonade', () => {
    const smoothie = CASES.find((c) => c.name.startsWith('banana-strawberry'))!;
    const lemonade = CASES.find((c) => c.name.startsWith('honey-sweetened'))!;
    const s = score(smoothie.ingredients, smoothie.options).scores.inflammation!.score;
    const l = score(lemonade.ingredients, lemonade.options).scores.inflammation!.score;
    expect(l - s).toBeGreaterThanOrEqual(0.8);
  });
});
