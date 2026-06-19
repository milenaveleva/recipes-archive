import { describe, it, expect } from 'vitest';
import foods from '../data/usda-foods.json';
import scoring from '../data/food-scoring.json';

type Food = { fdcId?: number; description: string };
type Scoring = { gi?: number; giConfidence?: string; inflammation?: number; fvl?: boolean };

const FOODS = foods as Food[];
const SCORING = scoring as Record<string, Scoring>;

describe('food-scoring.json integrity', () => {
  it('has a scoring entry for every USDA food (no silent untagged matches)', () => {
    const missing = FOODS.filter((f) => f.fdcId != null && !(String(f.fdcId) in SCORING)).map(
      (f) => `${f.fdcId} ${f.description}`,
    );
    expect(missing).toEqual([]);
  });

  it('has no orphan keys — every key is a real food fdcId', () => {
    const ids = new Set(FOODS.map((f) => String(f.fdcId)));
    const orphans = Object.keys(SCORING).filter((k) => !ids.has(k));
    expect(orphans).toEqual([]);
  });

  it('keeps GI in 0..110 and inflammation tags in −2..+2', () => {
    for (const [id, s] of Object.entries(SCORING)) {
      if (s.gi != null) {
        expect(s.gi, `gi ${id}`).toBeGreaterThanOrEqual(0);
        expect(s.gi, `gi ${id}`).toBeLessThanOrEqual(110);
      }
      if (s.inflammation != null) {
        expect(Number.isInteger(s.inflammation), `tag ${id} integer`).toBe(true);
        expect(s.inflammation, `tag ${id}`).toBeGreaterThanOrEqual(-2);
        expect(s.inflammation, `tag ${id}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('cites a source for every GI value (transcribe-and-cite)', () => {
    const uncited = Object.entries(SCORING)
      .filter(([, s]) => s.gi != null && !(s as { giSource?: string }).giSource)
      .map(([id]) => id);
    expect(uncited).toEqual([]);
  });

  it('never marks potatoes/starchy tubers as FVL', () => {
    // Potatoes (fdcId 170026) are excluded from the Nutri-Score FVL share.
    expect(SCORING['170026']?.fvl ?? false).toBe(false);
  });
});
