import { describe, it, expect } from 'vitest';
import Fuse from 'fuse.js';
import { facetsOf, matchesFacets, visibleSlugs, glLevelOf, FUSE_OPTIONS, type SearchDoc } from './search';

function doc(slug: string, over: Partial<SearchDoc> = {}): SearchDoc {
  return {
    slug,
    title: slug,
    description: '',
    ingredients: [],
    steps: [],
    lists: [],
    course: null,
    difficulty: null,
    giBand: null,
    glBand: null,
    nutriGrade: null,
    inflammationBand: null,
    balanceBand: null,
    ...over,
  };
}

describe('facetsOf', () => {
  it('only includes groups that at least one recipe carries', () => {
    const groups = facetsOf([doc('a', { course: 'Soup' })]);
    const keys = groups.map((g) => g.key);
    expect(keys).toContain('course');
    expect(keys).not.toContain('gi');
  });

  it('offers no Lists or Cuisine facet', () => {
    const keys = facetsOf([doc('a', { lists: ['Kifli favourites'], course: 'Soup' })]).map((g) => g.key);
    expect(keys).not.toContain('list');
    expect(keys).not.toContain('cuisine');
  });

  it('marks only course collapsible', () => {
    const groups = facetsOf([doc('a', { course: 'Soup', giBand: 'low' })]);
    expect(groups.filter((g) => g.collapsible).map((g) => g.key)).toEqual(['course']);
  });

  it('collapses values by slug and counts each recipe once', () => {
    const groups = facetsOf([doc('a', { course: 'Main Course' }), doc('b', { course: 'main course' }), doc('c', { course: 'Soup' })]);
    const course = groups.find((g) => g.key === 'course')!;
    const main = course.values.find((v) => v.value === 'main-course')!;
    expect(main.count).toBe(2);
    expect(main.label).toBe('Main Course'); // first original term seen for the slug
    expect(course.values.find((v) => v.value === 'soup')!.count).toBe(1);
  });

  it('sorts values by count desc then label', () => {
    const course = facetsOf([
      doc('a', { course: 'Soup' }),
      doc('b', { course: 'Drink' }),
      doc('c', { course: 'Drink' }),
      doc('d', { course: 'Dessert' }),
    ]).find((g) => g.key === 'course')!;
    expect(course.values.map((v) => v.value)).toEqual(['drink', 'dessert', 'soup']);
  });

  it('labels score-band and difficulty values for display', () => {
    const groups = facetsOf([
      doc('a', { giBand: 'low', difficulty: 'easy', inflammationBand: 'anti-inflammatory', nutriGrade: 'A' }),
    ]);
    expect(groups.find((g) => g.key === 'gi')!.values[0].label).toBe('Low');
    expect(groups.find((g) => g.key === 'difficulty')!.values[0].label).toBe('Easy');
    expect(groups.find((g) => g.key === 'inflammation')!.values[0].label).toBe('Anti-Inflam.');
    expect(groups.find((g) => g.key === 'nutri')!.values[0].label).toBe('A'); // grade kept verbatim
  });

  it('orders ordinal groups (bands, difficulty) by intrinsic severity, not count/alphabet', () => {
    // One recipe per band → all counts tie → alphabetical fallback would misorder.
    const groups = facetsOf([
      doc('a', { giBand: 'high', difficulty: 'hard' }),
      doc('b', { giBand: 'low', difficulty: 'easy' }),
      doc('c', { giBand: 'medium', difficulty: 'medium' }),
    ]);
    expect(groups.find((g) => g.key === 'gi')!.values.map((v) => v.label)).toEqual(['Low', 'Medium', 'High']);
    expect(groups.find((g) => g.key === 'difficulty')!.values.map((v) => v.label)).toEqual(['Easy', 'Medium', 'Hard']);
  });

  it('exposes a nutrient-balance facet ordered best → worst', () => {
    const groups = facetsOf([
      doc('a', { balanceBand: 'excellent' }),
      doc('b', { balanceBand: 'low' }),
      doc('c', { balanceBand: 'moderate' }),
    ]);
    const balance = groups.find((g) => g.key === 'balance')!;
    expect(balance.label).toBe('Nutrient balance');
    expect(balance.values.map((v) => v.label)).toEqual(['Excellent', 'Moderate', 'Low']);
  });
});

describe('matchesFacets', () => {
  const d = doc('a', { course: 'Main Course', giBand: 'low' });

  it('matches everything when nothing is selected', () => {
    expect(matchesFacets(d, {})).toBe(true);
    expect(matchesFacets(d, { course: [] })).toBe(true);
  });

  it('ORs within a group', () => {
    expect(matchesFacets(d, { course: ['soup', 'main-course'] })).toBe(true); // has one of the two
    expect(matchesFacets(d, { course: ['soup', 'dessert'] })).toBe(false);
  });

  it('ANDs across groups', () => {
    expect(matchesFacets(d, { gi: ['low'], course: ['main-course'] })).toBe(true);
    expect(matchesFacets(d, { gi: ['low'], course: ['dessert'] })).toBe(false);
  });

  it('normalizes the doc side to slugs before comparing', () => {
    expect(matchesFacets(d, { course: ['main-course'] })).toBe(true); // "Main Course" → "main-course"
  });
});

describe('visibleSlugs', () => {
  const docs = [
    doc('a', { course: 'Soup', giBand: 'low' }),
    doc('b', { course: 'Soup', giBand: 'high' }),
    doc('c', { course: 'Salad', giBand: 'low' }),
  ];

  it('applies no text constraint when textSlugs is null', () => {
    expect(visibleSlugs(docs, null, {})).toEqual(['a', 'b', 'c']);
  });

  it('intersects the text-match set with the facets', () => {
    const textSlugs = new Set(['a', 'b']); // Fuse matched a and b
    expect(visibleSlugs(docs, textSlugs, { gi: ['low'] })).toEqual(['a']);
  });

  it('returns nothing when the text set is empty', () => {
    expect(visibleSlugs(docs, new Set(), {})).toEqual([]);
  });

  it('filters by facet alone', () => {
    expect(visibleSlugs(docs, null, { course: ['soup'] })).toEqual(['a', 'b']);
  });
});

describe('Fuse integration (the client search seam)', () => {
  const docs = [
    doc('lentil-dahl', { title: 'Red Lentil & Spinach Dahl', ingredients: ['red lentils', 'spinach'] }),
    doc('oats', { title: 'Berry Chia Overnight Oats', ingredients: ['rolled oats', 'chia seeds', 'blueberries'] }),
    doc('chicken', { title: 'Sheet-Pan Lemon Chicken', steps: ['Roast the chicken thighs until golden.'] }),
  ];
  const fuse = new Fuse(docs, FUSE_OPTIONS); // exact config the island ships
  const textSlugs = (q: string) => new Set(fuse.search(q).map((r) => r.item.slug));

  it('matches on title and exposes item.slug (the field the island reads)', () => {
    const hits = fuse.search('lentil');
    expect(hits[0].item.slug).toBe('lentil-dahl');
  });

  it('matches on ingredient text', () => {
    expect([...textSlugs('chia')]).toContain('oats');
  });

  it('matches on method/step text', () => {
    expect([...textSlugs('roast')]).toContain('chicken');
  });

  it('feeds visibleSlugs so search ∩ facets works end to end', () => {
    expect(visibleSlugs(docs, textSlugs('overnight'), {})).toEqual(['oats']);
  });
});

describe('GL facet (basis-aware)', () => {
  it('levels GL against the recipe\'s own basis, matching the dial tone', () => {
    // GL 25: medium for a main course (meal cut-offs), high for a snack (portion cut-offs).
    expect(glLevelOf(25, 'meal')).toBe('medium');
    expect(glLevelOf(25, 'portion')).toBe('high');
    expect(glLevelOf(15, 'meal')).toBe('low');
    expect(glLevelOf(15, 'portion')).toBe('medium');
    expect(glLevelOf(null, 'meal')).toBeNull();
  });

  it('labels the group as relative to the course', () => {
    const [gl] = facetsOf([doc('a', { glBand: glLevelOf(25, 'meal') }), doc('b', { glBand: glLevelOf(25, 'portion') })]).filter(
      (g) => g.key === 'gl',
    );
    expect(gl.label).toBe('Glycemic load (for its course)');
    expect(gl.values.map((v) => [v.value, v.count])).toEqual([
      ['medium', 1],
      ['high', 1],
    ]);
  });
});
