import { describe, it, expect } from 'vitest';
import foods from '../data/usda-foods.json';
import scoring from '../data/food-scoring.json';
import polyphenols from '../data/polyphenols.json';
import crosswalk from '../data/phenol-crosswalk.json';

type Food = { fdcId?: number; description: string };
type Scoring = { gi?: number; giConfidence?: string; fvl?: boolean };

const FOODS = foods as Food[];
const SCORING = scoring as Record<string, Scoring>;
const POLYPHENOLS = polyphenols as unknown as Record<string, Record<string, number | undefined> & { source?: string }>;

describe('food-scoring.json integrity', () => {
  // Scoring is curated + cited per food, so it covers a subset of the full USDA
  // dataset (foods without an entry still contribute nutrients, and inflammation is
  // computed from composition regardless). Each entry must still point at a
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
  const FIELDS = ['anthocyanidins_mg', 'flavan3ols_mg', 'flavanones_mg', 'flavones_mg', 'flavonols_mg', 'tyrosols_mg'];

  it('keys every value to a real food fdcId with non-negative, sourced subclass contents', () => {
    const ids = new Set(FOODS.map((f) => String(f.fdcId)));
    expect(entries.length).toBeGreaterThan(300);
    for (const [id, p] of entries) {
      expect(ids.has(id), `orphan fdcId ${id}`).toBe(true);
      const vals = FIELDS.map((k) => p[k]).filter((v) => v !== undefined);
      expect(vals.length, `subclass values ${id}`).toBeGreaterThan(0);
      for (const v of vals) expect(v, `${id}`).toBeGreaterThanOrEqual(0);
      expect(p.source, `source ${id}`).toBeTruthy();
    }
  });
});

describe('phenol-crosswalk.json integrity', () => {
  // The crosswalk (Phenol-Explorer name → fdcId) places the tyrosols and the rule-based zeros
  // in polyphenols.json. Guard it so a typo or a USDA re-ingest that drops a food can't
  // silently orphan a mapping.
  // A name maps to one fdcId or a list of them (several USDA records of the same food);
  // the `_absent` rule lists join the same pool, so every placed fdcId is checked once.
  const raw = crosswalk as Record<string, unknown>;
  const absent = (raw._absent ?? {}) as Record<string, unknown>;
  const ids = [
    ...Object.entries(raw).filter(([k]) => !k.startsWith('_')).map(([, v]) => v),
    ...Object.entries(absent).filter(([k]) => !k.startsWith('_')).map(([, v]) => v),
  ].flat() as number[];

  it('maps every entry to a real food fdcId', () => {
    const real = new Set(FOODS.map((f) => String(f.fdcId)));
    expect(ids.filter((id) => !real.has(String(id)))).toEqual([]);
  });

  it('has no duplicate fdcId targets (one food per entry)', () => {
    expect([...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]).toEqual([]);
  });
});
