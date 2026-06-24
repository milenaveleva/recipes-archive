import { describe, it, expect } from 'vitest';
import Fuse from 'fuse.js';
import { facetsOf, matchesFacets, visibleSlugs, FUSE_OPTIONS, type SearchDoc } from './search';

function doc(slug: string, over: Partial<SearchDoc> = {}): SearchDoc {
  return {
    slug,
    title: slug,
    description: '',
    ingredients: [],
    steps: [],
    tags: [],
    category: null,
    lists: [],
    cuisine: null,
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
    const groups = facetsOf([doc('a', { tags: ['vegan'] })]);
    const keys = groups.map((g) => g.key);
    expect(keys).toContain('tag');
    expect(keys).not.toContain('category'); // no recipe has a category
    expect(keys).not.toContain('cuisine');
  });

  it('collapses values by slug and counts each recipe once', () => {
    const groups = facetsOf([
      doc('a', { tags: ['Vegan', 'vegan', 'High-Fiber'] }), // dup collapses, counted once
      doc('b', { tags: ['vegan'] }),
    ]);
    const tag = groups.find((g) => g.key === 'tag')!;
    const vegan = tag.values.find((v) => v.value === 'vegan')!;
    expect(vegan.count).toBe(2);
    expect(vegan.label).toBe('Vegan'); // first original term seen for the slug
    expect(tag.values.find((v) => v.value === 'high-fiber')!.count).toBe(1);
  });

  it('sorts values by count desc then label', () => {
    const tag = facetsOf([
      doc('a', { tags: ['rare', 'common'] }),
      doc('b', { tags: ['common'] }),
      doc('c', { tags: ['common', 'also'] }),
    ]).find((g) => g.key === 'tag')!;
    expect(tag.values.map((v) => v.value)).toEqual(['common', 'also', 'rare']);
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
  const d = doc('a', { tags: ['vegan', 'one-pot'], category: 'Mains', course: 'main', giBand: 'low' });

  it('matches everything when nothing is selected', () => {
    expect(matchesFacets(d, {})).toBe(true);
    expect(matchesFacets(d, { tag: [] })).toBe(true);
  });

  it('ORs within a group', () => {
    expect(matchesFacets(d, { tag: ['dairy', 'vegan'] })).toBe(true); // has one of the two
    expect(matchesFacets(d, { tag: ['dairy', 'gluten'] })).toBe(false);
  });

  it('ANDs across groups', () => {
    expect(matchesFacets(d, { tag: ['vegan'], course: ['main'] })).toBe(true);
    expect(matchesFacets(d, { tag: ['vegan'], course: ['dessert'] })).toBe(false);
  });

  it('normalizes the doc side to slugs before comparing', () => {
    expect(matchesFacets(d, { category: ['mains'] })).toBe(true); // "Mains" → "mains"
  });
});

describe('visibleSlugs', () => {
  const docs = [
    doc('a', { tags: ['vegan'], giBand: 'low' }),
    doc('b', { tags: ['vegan'], giBand: 'high' }),
    doc('c', { tags: ['meat'], giBand: 'low' }),
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
    expect(visibleSlugs(docs, null, { tag: ['vegan'] })).toEqual(['a', 'b']);
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
