import { describe, it, expect } from 'vitest';
import {
  buildRow,
  buildDraft,
  computeNutrition,
  splitCsv,
  minutesToIso,
  isoToMinutes,
  clampServings,
  safeUrl,
  linesToRows,
  reparseRows,
  selectedConfidence,
  EMPTY_FORM,
} from './addLib';
import { toRecipeMarkdown } from '../../core/markdown';

describe('buildRow', () => {
  it('parses, matches, and weighs a mass-measured ingredient', () => {
    const row = buildRow('200 g red lentils');
    expect(row.parsed.item).toBe('red lentils');
    expect(row.grams).toBe(200);
    expect(row.selectedFdcId).toBe(172420); // pre-selected USDA lentils
  });

  it('weighs a count-unit ingredient from the matched food portion', () => {
    const row = buildRow('2 cloves garlic, minced');
    expect(row.selectedFdcId).toBe(169230);
    expect(row.grams).toBe(6); // 3 g per clove × 2
  });

  it('matches a mass ingredient with a multi-word name', () => {
    const row = buildRow('8 ounces chicken breast');
    expect(row.selectedFdcId).toBe(171534);
    expect(row.grams).toBeCloseTo(226.8, 1);
  });
});

describe('buildDraft → markdown', () => {
  it('assembles a draft with computed macros and serialises it', () => {
    const form = { ...EMPTY_FORM, title: 'Test Dahl', servings: 2, prepMin: 10, tags: 'vegan, one-pot' };
    const rows = [buildRow('200 g red lentils'), buildRow('100 g spinach')];
    const macro = computeNutrition(rows, form.servings);
    const draft = buildDraft(form, rows, macro, '2026-06-19');

    expect(draft.title).toBe('Test Dahl');
    expect(draft.tags).toEqual(['vegan', 'one-pot']);
    expect(draft.prepTime).toBe('PT10M');
    expect(draft.ingredients).toHaveLength(2);
    expect(draft.nutrition?.perServing?.energyKcal).toBeGreaterThan(0);

    expect(toRecipeMarkdown(draft)).toContain('title: Test Dahl');
  });

  it('computes the glycemic, Nutri-Score and inflammation block from the matches', () => {
    const form = { ...EMPTY_FORM, title: 'Scored Dahl', servings: 2 };
    const rows = [buildRow('200 g red lentils'), buildRow('100 g spinach')];
    const macro = computeNutrition(rows, form.servings);
    const draft = buildDraft(form, rows, macro, '2026-06-19');

    expect(draft.nutrition?.glycemic?.gi).toBe(32); // only lentils carry a GI
    expect(draft.nutrition?.glycemic?.giBand).toBe('low');
    expect(draft.nutrition?.nutriScore?.grade).toBe('A');
    expect(draft.nutrition?.nutriScore?.points).toBe(-9); // pin the score, not just the band
    expect(draft.nutrition?.inflammation?.band).toBe('anti-inflammatory');
    expect(draft.nutrition?.inflammation?.method).toBe('ingredient-tag v1');
    expect(draft.nutrition?.dataSources).toContain('Nutri-Score 2023');

    // The score block round-trips into the serialized markdown.
    expect(toRecipeMarkdown(draft)).toContain('nutriScore:');
  });

  it('omits the nutrition block when nothing is matched', () => {
    const rows = [buildRow('1 pinch of magic')];
    const macro = computeNutrition(rows, 4);
    const draft = buildDraft({ ...EMPTY_FORM, title: 'X' }, rows, macro, '2026-06-19');
    expect(draft.nutrition).toBeUndefined();
  });
});

describe('value sanitizers', () => {
  it('clampServings yields a positive integer', () => {
    expect(clampServings(4)).toBe(4);
    expect(clampServings(0)).toBe(1);
    expect(clampServings(-3)).toBe(1);
    expect(clampServings(2.5)).toBe(3); // rounded, never a float in frontmatter
    expect(clampServings(Number.NaN)).toBe(1);
  });

  it('safeUrl accepts only absolute http(s), resolving relatives against a base', () => {
    expect(safeUrl('https://ex.com/a')).toBe('https://ex.com/a');
    expect(safeUrl('/img.jpg', 'https://ex.com/r')).toBe('https://ex.com/img.jpg');
    expect(safeUrl('relative.jpg')).toBeUndefined();
    expect(safeUrl('ftp://ex.com')).toBeUndefined();
    expect(safeUrl('')).toBeUndefined();
  });

  it('buildDraft sanitises servings, urls and negative grams to schema-valid values', () => {
    const rows = linesToRows('100 g spinach');
    rows[0].grams = -5; // user typo
    const draft = buildDraft(
      { ...EMPTY_FORM, title: 'X', servings: 2.5, imageUrl: '/x.jpg', sourceUrl: 'https://ex.com/r' },
      rows,
      computeNutrition(rows, 2.5),
      '2026-06-19',
    );
    expect(Number.isInteger(draft.servings) && draft.servings >= 1).toBe(true);
    expect(draft.imageUrl).toBe('https://ex.com/x.jpg'); // resolved against source
    expect(draft.source?.url).toBe('https://ex.com/r');
    expect(draft.ingredients[0].grams).toBeNull(); // negative dropped
  });
});

describe('reparseRows', () => {
  it('preserves per-row edits for unchanged lines', () => {
    const text = '8 ounces chicken breast\n100 g spinach';
    let rows = linesToRows(text);
    rows = rows.map((r) => (r.raw.startsWith('8') ? { ...r, grams: 999, selectedFdcId: null } : r));
    const reparsed = reparseRows(text, rows);
    const chicken = reparsed.find((r) => r.raw.startsWith('8'))!;
    expect(chicken.grams).toBe(999);
    expect(chicken.selectedFdcId).toBeNull();
  });
  it('builds fresh rows for newly added lines', () => {
    const reparsed = reparseRows('100 g spinach\n200 g red lentils', linesToRows('100 g spinach'));
    expect(reparsed).toHaveLength(2);
  });
});

describe('selectedConfidence', () => {
  it('is none when unmatched', () => {
    const row = buildRow('1 pinch of magic');
    expect(selectedConfidence({ ...row, selectedFdcId: null })).toBe('none');
  });
});

describe('helpers', () => {
  it('splitCsv trims and drops empties', () => {
    expect(splitCsv('a, b ,,c')).toEqual(['a', 'b', 'c']);
  });
  it('converts minutes ⇄ ISO duration, rolling minutes into hours', () => {
    expect(minutesToIso(90)).toBe('PT1H30M');
    expect(minutesToIso(30)).toBe('PT30M');
    expect(minutesToIso(60)).toBe('PT1H');
    expect(minutesToIso(119.7)).toBe('PT2H'); // rounds, no 'PT1H60M'
    expect(minutesToIso(0.3)).toBeUndefined(); // never the empty 'PT'
    expect(minutesToIso(0)).toBeUndefined();
    expect(minutesToIso(null)).toBeUndefined();
    expect(isoToMinutes('PT1H30M')).toBe(90);
    expect(isoToMinutes('P1DT30M')).toBe(1470); // days included
    expect(isoToMinutes(undefined)).toBeNull();
  });
});
