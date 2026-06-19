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
  formFromRecipe,
  rowsFromIngredients,
  splitMethodBody,
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

describe('buildDraft dates (edit)', () => {
  it('keeps the original createdAt while stamping updatedAt and computedAt on an edit', () => {
    const rows = [buildRow('200 g red lentils')];
    const macro = computeNutrition(rows, 2);
    const draft = buildDraft({ ...EMPTY_FORM, title: 'X', servings: 2 }, rows, macro, '2026-01-01', {
      computedAt: '2026-06-20',
      updatedAt: '2026-06-20',
    });
    expect(draft.createdAt).toBe('2026-01-01');
    expect(draft.updatedAt).toBe('2026-06-20');
    expect(draft.nutrition?.computedAt).toBe('2026-06-20');
    // updatedAt round-trips quoted (z.coerce.date would otherwise see a bare scalar).
    expect(toRecipeMarkdown(draft)).toContain('updatedAt: "2026-06-20"');
  });

  it('leaves updatedAt unset for a fresh recipe', () => {
    const rows = [buildRow('200 g red lentils')];
    const draft = buildDraft({ ...EMPTY_FORM, title: 'X' }, rows, computeNutrition(rows, 4), '2026-06-20');
    expect(draft.updatedAt).toBeUndefined();
    expect(toRecipeMarkdown(draft)).not.toContain('updatedAt:');
  });
});

describe('editing round-trip (formFromRecipe / rowsFromIngredients)', () => {
  it('re-seeds the form fields from stored frontmatter', () => {
    const form = formFromRecipe(
      {
        title: 'Lentil Dahl',
        description: 'cosy',
        servings: 3,
        prepTime: 'PT15M',
        cookTime: 'PT30M',
        cuisine: 'Indian',
        course: 'Main',
        category: 'Mains',
        tags: ['vegan', 'one-pot'],
        lists: ['weeknight'],
        imageUrl: 'https://ex.com/x.jpg',
        source: { name: 'Blog', url: 'https://ex.com/r' },
        nutrition: { nutriScore: { category: 'beverage' } },
      },
      ['Rinse the lentils.', 'Simmer until soft.'],
    );
    expect(form.title).toBe('Lentil Dahl');
    expect(form.prepMin).toBe(15);
    expect(form.cookMin).toBe(30);
    expect(form.tags).toBe('vegan, one-pot');
    expect(form.lists).toBe('weeknight');
    expect(form.nutriCategory).toBe('beverage');
    expect(form.sourceName).toBe('Blog');
    expect(form.instructions).toBe('Rinse the lentils.\nSimmer until soft.');
  });

  it('restores each ingredient row’s confirmed match, weight and exclusion', () => {
    const rows = rowsFromIngredients([
      { raw: '200 g red lentils', fdcId: 172420, grams: 200, matchConfidence: 'high', excludeFromNutrition: false },
      { raw: '1 cup water', fdcId: null, grams: 240, excludeFromNutrition: true },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].selectedFdcId).toBe(172420);
    expect(rows[0].grams).toBe(200);
    expect(rows[1].selectedFdcId).toBeNull();
    expect(rows[1].excludeFromNutrition).toBe(true);
  });

  it('keeps a stored match selectable even when search would not surface it', () => {
    // chicken breast 171534 is not a plausible search hit for "mystery powder".
    const [row] = rowsFromIngredients([
      { raw: '10 g mystery powder', fdcId: 171534, grams: 10, matchConfidence: 'low' },
    ]);
    expect(row.selectedFdcId).toBe(171534);
    expect(row.candidates.some((c) => c.food.fdcId === 171534)).toBe(true);
    expect(selectedConfidence(row)).toBe('low');
  });

  it('a draft → stored → draft round-trip preserves the match and metric weight', () => {
    const original = [buildRow('2 cloves garlic, minced')];
    const draft = buildDraft({ ...EMPTY_FORM, title: 'G', servings: 2 }, original, computeNutrition(original, 2), '2026-06-20');
    const restored = rowsFromIngredients(draft.ingredients);
    expect(restored[0].selectedFdcId).toBe(169230);
    expect(restored[0].grams).toBe(6);
  });

  it('restores stored structured fields instead of re-parsing the raw line', () => {
    // Author hand-converted "1 tbsp" → 14 g; a fresh parse would revert it.
    const [row] = rowsFromIngredients([
      { raw: '1 tbsp coconut oil', quantity: 14, unit: 'g', item: 'coconut oil', grams: 14, fdcId: null },
    ]);
    expect(row.parsed.quantity).toBe(14);
    expect(row.parsed.unit).toBe('g');
    expect(row.grams).toBe(14);
  });

  it('restores the beverage NNS flag from the stored nutriScore', () => {
    const form = formFromRecipe(
      { title: 'Diet Cola', nutrition: { nutriScore: { category: 'beverage', nnsPresent: true } } },
      [],
    );
    expect(form.nutriCategory).toBe('beverage');
    expect(form.nnsPresent).toBe(true);
  });
});

describe('splitMethodBody', () => {
  it('keeps numbered steps verbatim and preserves trailing notes', () => {
    const body = '## Method\n\n1. **Sear** the chicken.\n2. Rest 5 min.\n\n## Notes\n\n- Use thighs.\n- Serve hot.';
    const { steps, before, after } = splitMethodBody(body);
    expect(steps).toEqual(['**Sear** the chicken.', 'Rest 5 min.']);
    expect(before).toBe('');
    expect(after).toBe('## Notes\n\n- Use thighs.\n- Serve hot.');
  });

  it('returns empty before/after for a pure numbered method', () => {
    const { steps, before, after } = splitMethodBody('## Method\n\n1. Mix.\n2. Bake.');
    expect(steps).toEqual(['Mix.', 'Bake.']);
    expect(before).toBe('');
    expect(after).toBe('');
  });

  it('keeps intro prose before the method (no reordering)', () => {
    const { steps, before, after } = splitMethodBody('A family favourite.\n\n1. Step one.\n2. Step two.');
    expect(before).toBe('A family favourite.');
    expect(steps).toEqual(['Step one.', 'Step two.']);
    expect(after).toBe('');
  });

  it('does not promote a numbered line inside a later section to a step', () => {
    const body = '## Method\n\n1. Cook.\n\n## Notes\n\n1. This numbered note is NOT a step.';
    const { steps, after } = splitMethodBody(body);
    expect(steps).toEqual(['Cook.']);
    expect(after).toBe('## Notes\n\n1. This numbered note is NOT a step.');
  });

  it('keeps a prose-only body intact when there is no numbered method', () => {
    const { steps, before, after } = splitMethodBody('Just simmer everything until done.');
    expect(steps).toEqual([]);
    expect(before).toBe('Just simmer everything until done.');
    expect(after).toBe('');
  });
});

describe('edit preserves nnsPresent + surrounding body through serialization', () => {
  it('persists the NNS flag and keeps intro + notes in order', () => {
    const rows = [buildRow('200 g red lentils')];
    const draft = buildDraft(
      {
        ...EMPTY_FORM,
        title: 'Diet Drink',
        servings: 1,
        nutriCategory: 'beverage',
        nnsPresent: true,
        instructions: 'Stir and chill.',
      },
      rows,
      computeNutrition(rows, 1),
      '2026-06-20',
    );
    draft.bodyBefore = 'An intro line.';
    draft.bodyAfter = '## Notes\n\n- Shake well.';
    const md = toRecipeMarkdown(draft);
    expect(md).toContain('nnsPresent: true');
    // Order preserved: intro → method → notes.
    const body = md.split('---').slice(2).join('---');
    expect(body.indexOf('An intro line.')).toBeLessThan(body.indexOf('## Method'));
    expect(body.indexOf('## Method')).toBeLessThan(body.indexOf('## Notes'));
    expect(md.trimEnd().endsWith('- Shake well.')).toBe(true);
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
