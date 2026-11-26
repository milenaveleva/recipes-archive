import { describe, it, expect } from 'vitest';
import { giFor, storedScoringFields, fvlFromCategory } from './recipeScore';
import foodScoring from '../data/food-scoring.json';

const scoring = foodScoring as Record<string, { gi?: number; giConfidence?: string; giDough?: { gi: number; giConfidence?: string } }>;

describe('giFor (GI by what the starch becomes)', () => {
  it('gives flour its bread GI by default and its boiled-pasta GI as pasta dough', () => {
    const flour = scoring['790085']; // Flour, whole wheat, unenriched
    expect(flour.giDough).toBeDefined();
    expect(giFor(flour)).toEqual({ gi: flour.gi, measured: true });
    expect(giFor(flour, 'dough')).toEqual({ gi: flour.giDough!.gi, measured: true });
    expect(flour.giDough!.gi).toBeLessThan(flour.gi!);
  });

  it('ignores the dough marker on a food without a dough GI', () => {
    const rice = { gi: 68, giConfidence: 'high' };
    expect(giFor(rice, 'dough')).toEqual({ gi: 68, measured: true });
  });

  it('reads only a valid starchForm from stored frontmatter', () => {
    expect(storedScoringFields({ starchForm: 'dough' }).starchForm).toBe('dough');
    expect(storedScoringFields({ starchForm: 'batter' }).starchForm).toBeUndefined();
  });
});

describe('fvlFromCategory (Nutri-Score fruit/vegetable/legume share)', () => {
  const fruit = (description: string) => ({ fdcId: 1, description, category: 'Fruits and Fruit Juices', n: {} }) as never;
  it('counts a 100 % fruit or vegetable juice, fortified or not', () => {
    expect(fvlFromCategory(fruit('Orange juice, raw'))).toBe(true);
    expect(fvlFromCategory(fruit('Apple juice, canned or bottled, unsweetened, with added ascorbic acid'))).toBe(true);
  });
  it('leaves out nectars, juice drinks and sweetened juices', () => {
    expect(fvlFromCategory(fruit('Apricot nectar, canned'))).toBe(false);
    expect(fvlFromCategory(fruit('Cranberry juice cocktail, bottled'))).toBe(false);
    expect(fvlFromCategory(fruit('Pineapple juice, canned, sweetened'))).toBe(false);
  });
});
