import { describe, it, expect } from 'vitest';
import { giFor, storedScoringFields } from './recipeScore';
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
