import { describe, it, expect } from 'vitest';
import {
  applyCooking,
  cookingApplies,
  cookingGroupOf,
  isPreparedFood,
  retentionFor,
  suggestCooking,
  yieldFor,
  COOKING_METHODS,
  type CookingGroup,
} from './cooking';
import { scoreRecipe, storedScoringFields, toScored, dataSourcesFor, COOKING_FACTORS_CREDIT, NATIONAL_TABLE_CREDITS, type FoodScoring } from './recipeScore';
import type { FoodRecord } from './match';
import { computeScores } from './score';
import { foodFII } from './fii';
import usdaFoods from '../data/usda-foods.json';
import retentionData from '../data/retention-factors.json';
import yieldData from '../data/cooking-yields.json';

const foods = usdaFoods as FoodRecord[];
const foodById = new Map(foods.map((f) => [f.fdcId as number, f]));
const food = (id: number) => {
  const f = foodById.get(id);
  if (!f) throw new Error(`fixture food ${id} missing from usda-foods.json`);
  return f;
};

const BROCCOLI = 170379; // Broccoli, raw
const PASTA_DRY = 168927; // Pasta, dry, unenriched
const PASTA_COOKED = 168928; // Pasta, cooked, unenriched, without added salt
const LENTILS_RAW = 172420; // Lentils, raw

describe('applyCooking', () => {
  it('is the identity for raw (and for a missing method)', () => {
    const b = food(BROCCOLI);
    for (const m of ['raw', undefined, null] as const) {
      const c = applyCooking(100, b.n, b, m);
      expect(c.cookedGrams).toBe(100);
      expect(c.yieldFactor).toBe(1);
      expect(c.cookedPer100).toEqual(b.n);
      expect(c.nutrientsTotal.vitC_mg).toBeCloseTo(b.n.vitC_mg!, 10);
    }
  });

  it('boiled broccoli keeps less vitamin C and gains mass by the Bognár yield', () => {
    const b = food(BROCCOLI);
    const c = applyCooking(100, b.n, b, 'boiled');
    expect(c.group).toBe('other-veg');
    expect(c.nutrientsTotal.vitC_mg!).toBeLessThan(b.n.vitC_mg!);
    expect(c.nutrientsTotal.vitC_mg! / b.n.vitC_mg!).toBeCloseTo(0.8, 5); // USDA RF6 3774
    expect(c.cookedGrams).toBeCloseTo(111, 5); // Bognár 2002 Table 19 "Broccoli, boiled" 1.11
  });

  it('leaves minerals near-unchanged and macronutrients + energy fully retained', () => {
    const b = food(BROCCOLI);
    const c = applyCooking(100, b.n, b, 'boiled');
    for (const k of ['calcium_mg', 'iron_mg', 'magnesium_mg'] as const) {
      expect(c.nutrientsTotal[k]! / b.n[k]!).toBeGreaterThanOrEqual(0.9);
    }
    for (const k of ['energyKcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g'] as const) {
      if (b.n[k] != null) expect(c.nutrientsTotal[k]).toBeCloseTo(b.n[k]!, 10);
    }
  });

  it('books the mass change as water and dilutes the per-100 g composition', () => {
    const p = food(PASTA_DRY);
    const c = applyCooking(100, p.n, p, 'boiled');
    expect(c.cookedGrams).toBeCloseTo(210, 5); // Bognár 2002 Table 30 egg-free pasta 2.10
    expect(c.cookedPer100.energyKcal!).toBeCloseTo(p.n.energyKcal! / 2.1, 5);
    expect(c.nutrientsTotal.water_g!).toBeCloseTo(p.n.water_g! + 110, 5);
    expect(c.retainedPer100Raw.protein_g).toBeCloseTo(p.n.protein_g!, 10);
  });

  it('is the identity for an already-cooked record, whatever the method', () => {
    const p = food(PASTA_COOKED);
    expect(isPreparedFood(p.description)).toBe(true);
    const c = applyCooking(100, p.n, p, 'boiled');
    expect(c.group).toBe('none');
    expect(c.cookedGrams).toBe(100);
  });

  it('adds no fat uptake to fried foods', () => {
    const b = food(BROCCOLI);
    const c = applyCooking(100, b.n, b, 'fried');
    expect(c.nutrientsTotal.fat_g).toBeCloseTo(b.n.fat_g!, 10);
  });
});

describe('cookingGroupOf', () => {
  const g = (description: string, category: string, fat_g?: number): CookingGroup =>
    cookingGroupOf({ description, category, n: { fat_g } });
  it('maps USDA categories + name rules to factor groups', () => {
    expect(g('Spinach, raw', 'Vegetables and Vegetable Products')).toBe('leafy-veg');
    expect(g('Carrots, raw', 'Vegetables and Vegetable Products')).toBe('root-veg');
    expect(g('Potatoes, flesh and skin, raw', 'Vegetables and Vegetable Products')).toBe('potato');
    expect(g('Sweet potato, raw, unprepared', 'Vegetables and Vegetable Products')).toBe('sweet-potato');
    expect(g('Tomatoes, red, ripe, raw', 'Vegetables and Vegetable Products')).toBe('tomato');
    expect(g('Pasta, dry, unenriched', 'Cereal Grains and Pasta')).toBe('pasta');
    expect(g('Wheat flour, white, all-purpose', 'Cereal Grains and Pasta')).toBe('flour');
    expect(g('Rice, white, long-grain, regular, raw', 'Cereal Grains and Pasta')).toBe('grain');
    expect(g('Lentils, raw', 'Legumes and Legume Products')).toBe('legume-dry');
    expect(g('Tofu, raw, firm', 'Legumes and Legume Products')).toBe('none');
    expect(g('Fish, salmon, Atlantic, farmed, raw', 'Finfish and Shellfish Products', 13)).toBe('fish-fatty');
    expect(g('Fish, cod, Atlantic, raw', 'Finfish and Shellfish Products', 0.7)).toBe('fish-lean');
    expect(g('Crustaceans, shrimp, raw', 'Finfish and Shellfish Products', 1)).toBe('shellfish');
    expect(g('Egg, whole, raw, fresh', 'Dairy and Egg Products')).toBe('egg');
    expect(g('Cheese, parmesan, hard', 'Dairy and Egg Products')).toBe('cheese');
    expect(g('Butter, without salt', 'Dairy and Egg Products')).toBe('none');
    expect(g('Oil, olive, salad or cooking', 'Fats and Oils')).toBe('none');
    expect(g('Lemons, raw, without peel', 'Fruits and Fruit Juices')).toBe('citrus');
    expect(g('Apples, raw, with skin', 'Fruits and Fruit Juices')).toBe('fruit');
  });
});

describe('suggestCooking', () => {
  it('boils dry staples, reads an explicit cooking word, else raw', () => {
    expect(suggestCooking('200 g red lentils', food(LENTILS_RAW))).toBe('boiled');
    expect(suggestCooking('2 carrots, roasted', null)).toBe('baked');
    expect(suggestCooking('1 head broccoli', food(BROCCOLI))).toBe('raw');
  });
});

describe('factor tables', () => {
  it('cover every group × cooked method with provenance', () => {
    const r = retentionData as unknown as { groups: Record<string, { methods: Record<string, { usda: string | null; from: Record<string, string> }> }> };
    const y = yieldData as unknown as { groups: Record<string, { methods: Record<string, { yield: number; basis: string; source: string }> }> };
    const cooked = COOKING_METHODS.filter((m) => m !== 'raw');
    for (const [gid, grp] of Object.entries(r.groups)) {
      for (const m of cooked) {
        expect(grp.methods[m], `${gid}/${m} retention`).toBeTruthy();
        expect(Object.keys(grp.methods[m].from).length).toBeGreaterThan(0);
        const ye = y.groups[gid].methods[m];
        expect(ye.yield, `${gid}/${m} yield`).toBeGreaterThan(0);
        expect(ye.source.length).toBeGreaterThan(0);
        expect(['bognar', 'usda-pair', 'assumed']).toContain(ye.basis);
      }
    }
    expect(retentionFor('none', 'boiled')).toEqual({});
    expect(yieldFor(null, 'none', 'boiled')).toBe(1);
  });
});

describe('scores read the cooked state', () => {
  const noScoring: Record<string, FoodScoring> = {};
  const opts = { servings: 2 };

  it('Nutri-Score per 100 g uses the summed cooked mass; macros keep the retained totals', () => {
    const asRaw = scoreRecipe([{ grams: 200, fdcId: PASTA_DRY }], opts, foodById, noScoring, {});
    const boiled = scoreRecipe([{ grams: 200, fdcId: PASTA_DRY, cooking: 'boiled' }], opts, foodById, noScoring, {});
    expect(boiled.macro.totalGrams).toBeCloseTo(420, 1);
    expect(boiled.macro.perServing.energyKcal).toBe(asRaw.macro.perServing.energyKcal);
    expect(boiled.macro.perServing.protein_g).toBe(asRaw.macro.perServing.protein_g);
    // The grade is that of 420 g of a food with the cooked composition (dry ÷ 2.1).
    const p = food(PASTA_DRY);
    const cookedN = Object.fromEntries(Object.entries(p.n).map(([k, v]) => [k, (v as number) / 2.1]));
    const reference = computeScores([{ grams: 420, nutrients: cookedN }], 2);
    expect(boiled.scores.nutriScore!.points).toBe(reference.nutriScore!.points);
    expect(boiled.scores.nutriScore!.points).not.toBe(asRaw.scores.nutriScore!.points);
  });

  it('the inflammation score reads the cooked composition per kcal: the water change cancels, losses remain', () => {
    const s = toScored({ grams: 100, fdcId: BROCCOLI, cooking: 'boiled' }, foodById, noScoring, {});
    const b = food(BROCCOLI);
    expect(s.grams).toBeCloseTo(111, 5);
    expect(s.rawGrams).toBe(100);
    const perKcal = (n: { energyKcal?: number }, v: number) => v / n.energyKcal!;
    expect(perKcal(s.nutrients!, s.nutrients!.fiber_g!)).toBeCloseTo(perKcal(b.n, b.n.fiber_g!), 10);
    expect(perKcal(s.nutrients!, s.nutrients!.vitC_mg!)).toBeCloseTo(perKcal(b.n, b.n.vitC_mg! * 0.8), 10);
    expect(s.nutrients!.fiber_g).toBeCloseTo(b.n.fiber_g! / 1.11, 10);
  });

  it('boiling dry pasta leaves its inflammation score at the dry record\'s value up to retention losses', () => {
    const dry = toScored({ grams: 100, fdcId: PASTA_DRY }, foodById, noScoring, {});
    const boiled = toScored({ grams: 100, fdcId: PASTA_DRY, cooking: 'boiled' }, foodById, noScoring, {});
    expect(boiled.grams).toBeCloseTo(210, 5);
    expect(Math.abs(foodFII(boiled.nutrients)!.tag - foodFII(dry.nutrients)!.tag)).toBeLessThanOrEqual(0.2);
  });

  it('excluded ingredients are untouched by cooking', () => {
    const s = toScored({ grams: 100, fdcId: PASTA_DRY, cooking: 'boiled', excludeFromNutrition: true }, foodById, noScoring, {});
    expect(s.grams).toBe(100);
  });

  it('storedScoringFields passes a valid method through and drops an unknown one', () => {
    expect(storedScoringFields({ cooking: 'steamed' }).cooking).toBe('steamed');
    expect(storedScoringFields({ cooking: 'sous-vide' }).cooking).toBeUndefined();
  });
});

describe('meat and poultry pass through unchanged', () => {
  it('has no meat group: land-meat categories map to none and cook as the identity', () => {
    for (const category of ['Beef Products', 'Pork Products', 'Poultry Products', 'Lamb, Veal, and Game Products', 'Sausages and Luncheon Meats']) {
      const meat = { description: 'Some meat, raw', category, n: { energyKcal: 200, protein_g: 20, fat_g: 12, water_g: 65 } };
      expect(cookingGroupOf(meat), category).toBe('none');
      expect(cookingApplies(meat, 'fried')).toBe(false);
      const c = applyCooking(150, meat.n, meat, 'fried');
      expect(c.yieldFactor).toBe(1);
      expect(c.cookedPer100).toEqual(meat.n);
    }
  });

  it('the bundled dataset carries no land meat (so the missing group loses nothing)', () => {
    const meat = foods.filter((f) => /Beef|Pork|Poultry|Lamb|Veal|Game|Sausage|Luncheon/.test(f.category ?? ''));
    expect(meat.map((f) => f.description)).toEqual([]);
  });
});

describe('suggestCooking for already-cooked lines', () => {
  it('starts raw (no yield on an as-eaten weight) when the line says cooked/leftover/canned/drained', () => {
    const rice = foods.find((f) => /^Rice, white, long-grain, regular, raw/.test(f.description));
    expect(rice).toBeTruthy();
    expect(suggestCooking('300 g basmati rice', rice)).toBe('boiled');
    expect(suggestCooking('300 g cooked basmati rice', rice)).toBe('raw');
    expect(suggestCooking('200 g leftover cooked pasta', food(PASTA_DRY))).toBe('raw');
    expect(suggestCooking('250 g pre-cooked lentils', food(LENTILS_RAW))).toBe('raw');
    expect(suggestCooking('1 can lentils', food(LENTILS_RAW))).toBe('raw');
    expect(suggestCooking('400 g lentils, drained', food(LENTILS_RAW))).toBe('raw');
    expect(suggestCooking('200 g uncooked lentils', food(LENTILS_RAW))).toBe('boiled');
  });
});

describe('dataSourcesFor', () => {
  const TOFU = 172475; // Tofu, raw, firm — no cooking group
  const credit = (ings: Parameters<typeof dataSourcesFor>[1]) => dataSourcesFor({}, ings, foodById);

  it('credits the cooking factor tables only when a factor was actually applied', () => {
    expect(credit([{ fdcId: LENTILS_RAW, grams: 200, cooking: 'boiled' }])).toContain(COOKING_FACTORS_CREDIT);
    expect(credit([{ fdcId: TOFU, grams: 200, cooking: 'fried' }])).not.toContain(COOKING_FACTORS_CREDIT);
    expect(credit([{ fdcId: PASTA_COOKED, grams: 200, cooking: 'boiled' }])).not.toContain(COOKING_FACTORS_CREDIT);
    expect(credit([{ fdcId: LENTILS_RAW, grams: 200, cooking: 'boiled', excludeFromNutrition: true }])).not.toContain(COOKING_FACTORS_CREDIT);
    expect(credit([{ fdcId: LENTILS_RAW, grams: null, cooking: 'boiled' }])).not.toContain(COOKING_FACTORS_CREDIT);
    expect(credit([{ fdcId: LENTILS_RAW, grams: 200, cooking: 'raw' }])).not.toContain(COOKING_FACTORS_CREDIT);
  });

  it('credits a national table from the matched food source, in a stable order', () => {
    const bySource = (tag: string) => foods.find((f) => f.source === tag)!;
    const jp = bySource('JP-MEXT');
    const fr = bySource('FR-CIQUAL');
    const out = credit([{ fdcId: fr.fdcId, grams: 50 }, { fdcId: jp.fdcId, grams: 50 }]);
    expect(out.slice(0, 3)).toEqual(['USDA FoodData Central', NATIONAL_TABLE_CREDITS['JP-MEXT'], NATIONAL_TABLE_CREDITS['FR-CIQUAL']]);
  });
});
