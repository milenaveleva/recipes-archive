import { describe, it, expect } from 'vitest';
import { computeProcessing, identityText, novaFromText, promoteNova, type ProcessingItem } from './processing';

describe('computeProcessing', () => {
  it('returns undefined when nothing is classifiable', () => {
    expect(computeProcessing([])).toBeUndefined();
    // A food with energy but no NOVA group can't be placed.
    expect(computeProcessing([{ energyKcal: 200, nova: null }])).toBeUndefined();
    // A classified food with no usable energy contributes no weight.
    expect(computeProcessing([{ energyKcal: null, nova: 1 }])).toBeUndefined();
    expect(computeProcessing([{ energyKcal: 0, nova: 1 }])).toBeUndefined();
  });

  it('weights NOVA shares by energy, not by ingredient count', () => {
    // One energy-dense NOVA-1 food vs. three trivial NOVA-4 foods: energy wins.
    const items: ProcessingItem[] = [
      { energyKcal: 900, nova: 1 },
      { energyKcal: 10, nova: 4 },
      { energyKcal: 10, nova: 4 },
      { energyKcal: 10, nova: 4 },
    ];
    const r = computeProcessing(items)!;
    expect(r.minimallyProcessedPct).toBeCloseTo(96.8, 1);
    expect(r.ultraProcessedPct).toBeCloseTo(3.2, 1);
    expect(r.band).toBe('minimally-processed');
  });

  it('bundles groups 1+2 into the minimally-processed headline; pct sums to ~100', () => {
    const r = computeProcessing([
      { energyKcal: 50, nova: 1 },
      { energyKcal: 30, nova: 2 },
      { energyKcal: 15, nova: 3 },
      { energyKcal: 5, nova: 4 },
    ])!;
    expect(r.minimallyProcessedPct).toBeCloseTo(80, 1); // 50+30 of 100
    expect(r.ultraProcessedPct).toBeCloseTo(5, 1);
    expect(r.pct).toEqual({ n1: 50, n2: 30, n3: 15, n4: 5 });
    const sum = r.pct.n1 + r.pct.n2 + r.pct.n3 + r.pct.n4;
    expect(sum).toBeCloseTo(100, 1);
  });

  it('bands by the minimally-processed share (≥70 minimally, ≥40 moderately, else highly)', () => {
    const band = (n1: number, n3: number) =>
      computeProcessing([
        { energyKcal: n1, nova: 1 },
        { energyKcal: n3, nova: 3 },
      ])!.band;
    expect(band(70, 30)).toBe('minimally-processed'); // exactly 70%
    expect(band(69, 31)).toBe('moderately-processed');
    expect(band(40, 60)).toBe('moderately-processed'); // exactly 40%
    expect(band(39, 61)).toBe('highly-processed');
  });

  it('excludes unclassified and energy-less items from the denominator', () => {
    // The null-nova 1000 kcal must not dilute the shares of the classified foods.
    const r = computeProcessing([
      { energyKcal: 80, nova: 1 },
      { energyKcal: 20, nova: 4 },
      { energyKcal: 1000, nova: null },
      { energyKcal: null, nova: 3 },
    ])!;
    expect(r.minimallyProcessedPct).toBeCloseTo(80, 1);
    expect(r.ultraProcessedPct).toBeCloseTo(20, 1);
  });
});

describe('NOVA text markers', () => {
  it('flags ultra-processed products (NOVA 4) from the original line', () => {
    for (const line of [
      '200 g ladyfingers',
      '24 savoiardi biscuits',
      '300 g puff pastry',
      '200 g wonton wrappers',
      '1 vegetable stock cube',
      '2 tsp bouillon powder',
      '2 tbsp Thai red curry paste',
      '1 pack instant noodles',
      '150 g strawberry-flavoured yoghurt',
      '50 g margarine',
      '4 pork sausages',
    ]) {
      expect(novaFromText(line), line).toBe(4);
    }
  });

  it('flags cured, smoked, canned and cheese-type foods as processed (NOVA 3)', () => {
    for (const line of [
      '4 slices smoked salmon',
      '100 g prosciutto',
      '150 g bacon lardons',
      '1 can (400 g) chickpeas, drained',
      '2 tins chopped tomatoes',
      'canned tuna',
      '50 g parmesan, grated',
      '200 g feta cheese',
      '3 cloves pickled garlic',
      '1 handful roasted salted pistachios',
    ]) {
      expect(novaFromText(line), line).toBe(3);
    }
  });

  it('leaves whole foods, seasonings and look-alike words unmarked', () => {
    for (const line of [
      '1 tsp smoked paprika',
      'paprika, to taste (can be smoked)',
      '20 g salted butter',
      '1 tsp instant yeast',
      '1500 ml fish stock',
      '200 g cheesecake base', // "cheese" only as part of another word
      '2 graham crackers',
      '400 g chicken breast',
      '',
    ]) {
      expect(novaFromText(line), line).toBeNull();
    }
    expect(novaFromText(null)).toBeNull();
  });

  it('promotes a lower generic match, never demotes, and leaves unclassified foods alone', () => {
    expect(promoteNova(1, '300 g puff pastry')).toBe(4); // flour/fat generic → ready-made pastry
    expect(promoteNova(1, '4 slices smoked salmon')).toBe(3); // raw salmon → smoked
    expect(promoteNova(4, '1 can chickpeas')).toBe(4); // never lowered by a weaker marker
    expect(promoteNova(3, '200 g feta cheese')).toBe(3);
    expect(promoteNova(1, '400 g chicken breast')).toBe(1);
    expect(promoteNova(null, '300 g puff pastry')).toBeNull();
    expect(promoteNova(2, undefined)).toBe(2);
  });
});

describe('NOVA markers read the identity part of the line', () => {
  it('drops alternatives and seasoning clauses before matching', () => {
    expect(identityText('50 g butter or margarine')).toBe('50 g butter');
    expect(identityText('butter/margarine')).toBe('butter');
    expect(identityText('1/2 cup olive oil (or a flavoured oil)')).toBe('1/2 cup olive oil');
    expect(identityText('150 g smoked mackerel, salt and pepper to taste')).toBe('150 g smoked mackerel');
  });

  it('ignores markers in alternatives and quality adjectives', () => {
    for (const line of [
      '50 g butter or margarine',
      '50 g butter/margarine',
      '2 tbsp olive oil (or a flavoured oil)',
      '1 l well-flavoured chicken stock',
      '500 ml full-flavoured vegetable stock',
    ]) {
      expect(novaFromText(line), line).toBeNull();
    }
  });

  it('keeps genuine flavoured-product and margarine hits', () => {
    expect(novaFromText('150 g flavoured yogurt')).toBe(4);
    expect(novaFromText('150 g strawberry-flavoured yoghurt')).toBe(4);
    expect(novaFromText('50 g margarine or butter')).toBe(4);
  });

  it('exempts only a preserved seasoning, not a preserved food named with a seasoning word', () => {
    for (const line of [
      '200 g pickled red peppers',
      '2 pickled jalapeño chillies',
      '150 g smoked mackerel, salt and pepper to taste',
      '100 g smoked salmon, black pepper to serve',
    ]) {
      expect(novaFromText(line), line).toBe(3);
    }
    for (const line of [
      '1 tsp smoked paprika',
      '1 tsp smoked sweet paprika',
      'a pinch of smoked sea salt',
      '1/2 tsp smoked black pepper',
      '1 tsp smoked chilli flakes',
      '2 tsp smoked pimentón',
    ]) {
      expect(novaFromText(line), line).toBeNull();
    }
  });
});
