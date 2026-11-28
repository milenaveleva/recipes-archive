import { describe, it, expect } from 'vitest';
import {
  foodFII,
  scoreComposition,
  freeSugarFraction,
  foodClassOf,
  checkReference,
  bundledReference,
  PARAMS,
  MIN_KCAL_PER_100G,
  type FiiItem,
} from './fii';
import { nutrientsFor, type PolyphenolTable } from './recipeScore';
import type { NutrientVector } from './types';
import type { FoodRecord } from './match';
import usdaFoods from '../data/usda-foods.json';
import polyphenolData from '../data/polyphenols.json';

const FOODS = usdaFoods as unknown as FoodRecord[];
const POLY = polyphenolData as unknown as PolyphenolTable;
const byDesc = (prefix: string): FoodRecord => {
  const f = FOODS.find((x) => x.description.startsWith(prefix));
  if (!f) throw new Error(`no food ${prefix}`);
  return f;
};
/** A real food's score (100 g, raw record, polyphenol subclasses merged). */
const tagOf = (prefix: string): number => {
  const f = byDesc(prefix);
  return foodFII(nutrientsFor(f, POLY), f.fdcId)!.tag;
};
const item = (prefix: string, grams: number, prep?: 'blended' | 'juiced'): FiiItem => {
  const f = byDesc(prefix);
  return { grams, nutrients: nutrientsFor(f, POLY), fdcId: f.fdcId, prep };
};

describe('referent', () => {
  it('covers every parameter and matches the parameter table version', () => {
    expect(checkReference(bundledReference())).toEqual([]);
    expect((bundledReference() as { version?: string }).version).toBe(PARAMS.version);
  });
});

describe('foodFII (one food as a one-item dish)', () => {
  it('returns null without energy or any parameter', () => {
    expect(foodFII(null)).toBeNull();
    expect(foodFII({ fiber_g: 5, sugar_g: 3, sodium_mg: 20 })).toBeNull();
    expect(foodFII({ energyKcal: 80, protein_g: 10, carbs_g: 5 })).toBeNull();
  });

  it('scores per 100 kcal: pure water gain or loss leaves the score unchanged', () => {
    const dry: NutrientVector = { energyKcal: 352, fiber_g: 9.2, magnesium_mg: 143, satFat_g: 0.4, sugar_g: 2.7, sodium_mg: 8, vitE_mg: 0.4, vitC_mg: 0 };
    const cooked = Object.fromEntries(Object.entries(dry).map(([k, v]) => [k, (v as number) / 2.1])) as NutrientVector;
    expect(foodFII(cooked)).toEqual(foodFII(dry));
  });

  it('reads a near-energy-free food against the energy floor, and leaves water out', () => {
    expect(MIN_KCAL_PER_100G).toBe(20);
    const herb = { fiber_g: 1, vitC_mg: 10, magnesium_mg: 10, vitE_mg: 0.1, sodium_mg: 10 };
    expect(foodFII({ ...herb, energyKcal: 6 })).toEqual(foodFII({ ...herb, energyKcal: 10 }));
    expect(foodFII({ energyKcal: 0, magnesium_mg: 2, sodium_mg: 2, sugar_g: 0, vitC_mg: 0 })).toBeNull();
  });

  it('keeps every score within the −2…+2 axis', () => {
    const pro: NutrientVector = { energyKcal: 900, satFat_g: 100, transFat_g: 20, sugar_g: 100, sodium_mg: 40000, fiber_g: 0, vitC_mg: 0, vitE_mg: 0, magnesium_mg: 0 };
    const anti: NutrientVector = { energyKcal: 50, fiber_g: 20, vitC_mg: 300, vitE_mg: 10, magnesium_mg: 300, luteinZeaxanthin_ug: 20000, anthocyanidins_mg: 500 };
    expect(foodFII(pro)!.tag).toBeGreaterThan(0);
    expect(foodFII(pro)!.tag).toBeLessThanOrEqual(2);
    expect(foodFII(anti)!.tag).toBeLessThan(0);
    expect(foodFII(anti)!.tag).toBeGreaterThanOrEqual(-2);
  });

  it('does not let a zero one-sided signal dilute the signals a food carries', () => {
    // Pure sugar: its free-sugar penalty is not averaged down by its absent saturated fat,
    // trans fat and sodium (absence is their baseline, not a credit).
    const sugar: NutrientVector = { energyKcal: 387, sugar_g: 99.8, fiber_g: 0, vitC_mg: 0, vitE_mg: 0, magnesium_mg: 0, satFat_g: 0, transFat_g: 0, sodium_mg: 1 };
    const withZeros = foodFII(sugar, 169655)!.tag; // granulated sugar
    const without = foodFII({ ...sugar, satFat_g: undefined, transFat_g: undefined, sodium_mg: undefined }, 169655)!.tag;
    expect(withZeros).toBe(without);
  });

  it('shrinks a data-poor food toward neutral below the quorum', () => {
    const s = scoreComposition([{ grams: 100, nutrients: { energyKcal: 900, satFat_g: 90 } }])!;
    expect(s.contributions.length).toBeLessThan(PARAMS.quorum);
    expect(Math.abs(s.tag)).toBeLessThanOrEqual(2 * (s.contributions.length / PARAMS.quorum) + 1e-9);
  });
});

describe('free sugar by food class (WHO definition, Louie/Wanselius tree)', () => {
  it('counts no free sugar in whole, frozen or dried fruit, or in plain dairy', () => {
    expect(freeSugarFraction(byDesc('Bananas, raw').fdcId)).toBe(0);
    expect(freeSugarFraction(byDesc('Dates, medjool').fdcId)).toBe(0);
    expect(freeSugarFraction(byDesc('Yogurt, plain, whole milk').fdcId)).toBe(0);
  });

  it('counts honey, syrups and juice as wholly free sugar', () => {
    expect(freeSugarFraction(byDesc('Honey').fdcId)).toBe(1);
    expect(freeSugarFraction(byDesc('Sugars, granulated').fdcId)).toBe(1);
    expect(freeSugarFraction(byDesc('Orange juice, raw').fdcId)).toBe(1);
  });

  it('re-classifies blended and juiced fruit by the ingredient’s prep', () => {
    const banana = byDesc('Bananas, raw').fdcId;
    expect(freeSugarFraction(banana, 'blended')).toBe(PARAMS.pureeFreeSugarFraction);
    expect(freeSugarFraction(banana, 'juiced')).toBe(PARAMS.juicedFreeSugarFraction);
    // A non-produce food is not re-classified by a prep.
    expect(freeSugarFraction(byDesc('Honey').fdcId, 'blended')).toBe(1);
  });

  it('falls back to half for a food the classifier has not seen (Louie step 10)', () => {
    expect(foodClassOf(123)).toBeUndefined();
    expect(freeSugarFraction(123)).toBe(0.5);
  });
});

describe('pooled dish composition', () => {
  it('scores a one-food dish exactly as the food', () => {
    const f = byDesc('Spinach, raw');
    expect(scoreComposition([item('Spinach, raw', 250)])!.tag).toBe(foodFII(nutrientsFor(f, POLY), f.fdcId)!.tag);
  });

  it('lets one ingredient’s protective nutrients offset another’s sugar (pooled, not averaged)', () => {
    const honeyOnly = scoreComposition([item('Honey', 20)])!.tag;
    const withOats = scoreComposition([item('Honey', 20), item('Oats', 80)])!.tag;
    expect(withOats).toBeLessThan(honeyOnly);
  });

  it('grades sugar by dose: a spoon of honey in a fruit bowl moves it less than a cup', () => {
    const spoon = scoreComposition([item('Strawberries, raw', 300), item('Honey', 7)])!.tag;
    const cup = scoreComposition([item('Strawberries, raw', 300), item('Honey', 340)])!.tag;
    expect(spoon).toBeLessThan(cup);
  });

  it('weights saturated fat by chain length: coconut’s lauric fraction penalises less', () => {
    const veg = [item('Spinach, raw', 200), item('Tomatoes, red, ripe, raw', 300), item('Lentils, raw', 100)];
    const coconut = item('Oil, coconut', 25);
    const asLongChain: FiiItem = {
      ...coconut,
      nutrients: { ...coconut.nutrients!, fa4_0_g: 0, fa6_0_g: 0, fa8_0_g: 0, fa10_0_g: 0, fa12_0_g: 0 },
    };
    const push = (items: FiiItem[]) => scoreComposition(items)!.contributions.find((c) => c.key === 'saturatedFat')!.push;
    expect(push([...veg, coconut])).toBeLessThan(push([...veg, asLongChain]));
  });

  it('applies the dairy matrix correction by energy share', () => {
    const s = scoreComposition([item('Cheese, cheddar', 100)])!;
    expect(s.matrixDelta).toBe(PARAMS.matrixDeltas.cheese.delta);
    expect(s.tag).toBeCloseTo(Math.round((s.composition + s.matrixDelta) * 10) / 10, 5);
  });
});

describe('evidence-based orderings (face validity, the report’s golden pairs)', () => {
  // Each pair is ordered by human trial evidence; the score must agree (more anti first).
  const pairs: [string, string, string][] = [
    ['Fish, salmon, Atlantic, farmed, raw', 'Butter, without salt', 'oily fish < butter (EPA + DHA; saturated fat)'],
    ['Oil, olive, salad or cooking', 'Butter, without salt', 'olive oil < butter'],
    ['Blueberries, raw', 'Bananas, raw', 'berries < banana (anthocyanins)'],
    ['Bananas, raw', 'Honey', 'whole fruit < honey (free sugar)'],
    ['Dates, medjool', 'Sugars, granulated', 'dates (intact sugar) < table sugar'],
    ['Orange juice, raw', 'Sugars, granulated', '100 % juice < sugar'],
    ['Yogurt, plain, whole milk', 'Butter, without salt', 'yogurt < butter (fermented-dairy matrix)'],
    ['Spinach, raw', 'Bread, white wheat', 'leafy greens < white bread'],
    ['Nuts, almonds', 'Sugars, granulated', 'almonds < sugar'],
  ];
  for (const [anti, pro, why] of pairs) {
    it(why, () => {
      expect(tagOf(anti)).toBeLessThan(tagOf(pro));
    });
  }

  it('reads honey, maple syrup and table sugar alike', () => {
    const t = [tagOf('Honey'), tagOf('Syrups, maple'), tagOf('Sugars, granulated')];
    expect(Math.max(...t) - Math.min(...t)).toBeLessThanOrEqual(0.2);
  });

  it('keeps coconut oil no more pro than butter', () => {
    expect(tagOf('Oil, coconut')).toBeLessThanOrEqual(tagOf('Butter, without salt') + 0.1);
  });
});

describe('food classes cover the recipes', () => {
  it('classifies every recipe-used food that carries sugar (no silent step-10 fallback)', () => {
    const files = import.meta.glob('../content/recipes/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const byId = new Map(FOODS.map((f) => [f.fdcId, f]));
    const missing = new Set<number>();
    for (const text of Object.values(files)) {
      for (const m of text.matchAll(/fdcId:\s*(\d+)/g)) {
        const id = Number(m[1]);
        const f = byId.get(id);
        if (f && (f.n?.sugar_g ?? 0) > 0 && foodClassOf(id)?.fs === undefined) missing.add(id);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe('zero point', () => {
  it('reads the average diet (Shivappa 2014 Table 2 global means) as neutral to mildly pro', () => {
    // A day's intake as one composition: 2,056 kcal with the table's global mean fibre,
    // vitamins C and E, magnesium, saturated and trans fat and n-3 (as ALA). Free sugar,
    // sodium and carotenoids are not in the table, so they are left unknown.
    const day: NutrientVector = {
      energyKcal: 2056, fiber_g: 18.8, vitC_mg: 118.2, vitE_mg: 8.73, magnesium_mg: 310.1,
      satFat_g: 28.6, transFat_g: 3.15, ala_g: 1.06,
    };
    const s = scoreComposition([{ grams: 100, nutrients: day }])!;
    // The zero point holds protective nutrients at the average diet's density with NO limit
    // nutrients; the average diet exceeds the WHO saturated- and trans-fat limits (12.5 % and
    // 1.4 % of energy), so it lands on the mildly pro side, not at zero.
    expect(s.tag).toBeGreaterThan(PARAMS.bands.mildlyAntiMax);
    expect(s.tag).toBeLessThanOrEqual(PARAMS.bands.mildlyProMax);
  });
});
