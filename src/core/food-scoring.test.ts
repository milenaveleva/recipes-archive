import { describe, it, expect } from 'vitest';
import foods from '../data/usda-foods.json';
import scoring from '../data/food-scoring.json';
import polyphenols from '../data/polyphenols.json';

type Food = { fdcId?: number; description: string };
type Scoring = { gi?: number; giConfidence?: string; fvl?: boolean };

const FOODS = foods as Food[];
const SCORING = scoring as Record<string, Scoring>;
const POLYPHENOLS = polyphenols as Record<string, { polyphenol_mg?: number; source?: string }>;

describe('food-scoring.json integrity', () => {
  // Scoring is curated + cited per food, so it covers a subset of the full USDA
  // dataset (foods without an entry still contribute nutrients, and inflammation is
  // computed from composition by the FII regardless). Each entry must still point at a
  // real food and carry valid, cited values.
  it('has no orphan keys — every key is a real food fdcId', () => {
    const ids = new Set(FOODS.map((f) => String(f.fdcId)));
    const orphans = Object.keys(SCORING).filter((k) => !ids.has(k));
    expect(orphans).toEqual([]);
  });

  it('keeps GI in 0..110', () => {
    for (const [id, s] of Object.entries(SCORING)) {
      if (s.gi != null) {
        expect(s.gi, `gi ${id}`).toBeGreaterThanOrEqual(0);
        expect(s.gi, `gi ${id}`).toBeLessThanOrEqual(110);
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

describe('polyphenols.json integrity', () => {
  const entries = Object.entries(POLYPHENOLS).filter(([k]) => !k.startsWith('_'));

  it('keys every value to a real food fdcId with a positive, cited content', () => {
    const ids = new Set(FOODS.map((f) => String(f.fdcId)));
    for (const [id, p] of entries) {
      expect(ids.has(id), `orphan fdcId ${id}`).toBe(true);
      expect(p.polyphenol_mg, `polyphenol_mg ${id}`).toBeGreaterThan(0);
      expect(p.source, `source ${id}`).toBeTruthy();
    }
  });
});
