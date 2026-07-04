import { describe, it, expect } from 'vitest';
import {
  giFill,
  glFill,
  inflammationFill,
  buildScoreDials,
  hasAnyScore,
  nutriGrades,
  GL_DIAL_MAX,
  formatIngredientAmount,
} from './recipe';

describe('formatIngredientAmount (display unit ≠ calc basis)', () => {
  it('shows tsp/tbsp as written even when grams/ml are stored for the math', () => {
    expect(formatIngredientAmount({ quantity: 1, unit: 'tbsp', grams: 13.6, milliliters: 14.8 })).toBe('1 tbsp');
    expect(formatIngredientAmount({ quantity: 2, unit: 'tsp', grams: 9.2 })).toBe('2 tsp');
    expect(formatIngredientAmount({ quantity: 0.5, unit: 'tbsp' })).toBe('0.5 tbsp');
  });

  it('normalises spoon aliases and casing/trailing dots', () => {
    expect(formatIngredientAmount({ quantity: 1, unit: 'Tablespoon' })).toBe('1 tbsp');
    expect(formatIngredientAmount({ quantity: 1, unit: 'tbsp.' })).toBe('1 tbsp');
    expect(formatIngredientAmount({ quantity: 3, unit: 'teaspoons' })).toBe('3 tsp');
  });

  it('renders spoon ranges with both bounds', () => {
    expect(formatIngredientAmount({ quantity: 1, quantity2: 2, unit: 'tbsp' })).toBe('1–2 tbsp');
  });

  it('shows metric weight for mass units and for weighed volumes (cups → grams)', () => {
    expect(formatIngredientAmount({ quantity: 9, unit: 'oz', grams: 250 })).toBe('250 g');
    // A cup that got matched + weighed shows the weight, not the derived ml.
    expect(formatIngredientAmount({ quantity: 1, unit: 'cup', milliliters: 237, grams: 250 })).toBe('250 g');
  });

  it('snaps metric amounts over 10 g/ml to the nearest 10, keeps ≤10 exact', () => {
    expect(formatIngredientAmount({ quantity: 9, unit: 'oz', grams: 196 })).toBe('200 g');
    expect(formatIngredientAmount({ grams: 34 })).toBe('30 g');
    expect(formatIngredientAmount({ grams: 35 })).toBe('40 g'); // half rounds up
    expect(formatIngredientAmount({ grams: 4.5 })).toBe('4.5 g'); // ≤10: exact, never coarsened
    expect(formatIngredientAmount({ grams: 3 })).toBe('3 g');
    expect(formatIngredientAmount({ grams: 1234 })).toBe('1.23 kg');
    expect(formatIngredientAmount({ quantity: 1, unit: 'ml', milliliters: 196 })).toBe('200 ml');
    expect(formatIngredientAmount({ quantity: 1, unit: 'ml', milliliters: 5 })).toBe('5 ml'); // ≤10: exact
  });

  it('keeps a liquid metered in a metric volume in ml/L', () => {
    expect(formatIngredientAmount({ quantity: 500, unit: 'ml', milliliters: 500 })).toBe('500 ml');
    expect(formatIngredientAmount({ quantity: 2, unit: 'dl', milliliters: 200 })).toBe('200 ml');
    expect(formatIngredientAmount({ quantity: 1.5, unit: 'litre', milliliters: 1500 })).toBe('1.5 L');
  });

  it('shows a liquid (recognised by name, incl. oils) in ml even when written in cups', () => {
    // Milk in cups reads ml, not grams — the head noun marks it a liquid.
    expect(
      formatIngredientAmount({ quantity: 0.25, unit: 'cup', item: 'dairy-free milk', milliliters: 59.147, grams: 34.3 }),
    ).toBe('60 ml');
    // Oils are liquids too (display ml), not grams.
    expect(
      formatIngredientAmount({ quantity: 0.25, unit: 'cup', item: 'olive oil', milliliters: 59, grams: 54 }),
    ).toBe('60 ml');
    // Head-noun match: a modifier like "water"/"cream" doesn't make a solid a liquid.
    expect(formatIngredientAmount({ quantity: 1, unit: 'cup', item: 'water chestnuts', milliliters: 237, grams: 250 })).toBe('250 g');
    expect(formatIngredientAmount({ quantity: 1, unit: 'cup', item: 'cream cheese', milliliters: 237, grams: 250 })).toBe('250 g');
    // A trailing parenthetical / alternative is stripped before reading the head.
    expect(formatIngredientAmount({ quantity: 1, unit: 'cup', item: 'heavy cream ((sub milk for lighter option))', milliliters: 236.588 })).toBe('240 ml');
    expect(formatIngredientAmount({ quantity: 1, unit: 'cup', item: 'oat milk (unsweetened)', milliliters: 237 })).toBe('240 ml');
  });

  it('shows an unweighed dry good measured in cups as cups, never ml', () => {
    // A dry good (not a liquid name) with no USDA match carries only `milliliters`;
    // it must read in cups (its written measure), not a meaningless conversion.
    expect(formatIngredientAmount({ quantity: 1.5, unit: 'cups', item: 'shelled edamame', milliliters: 354.882 })).toBe('1.5 cups');
    expect(formatIngredientAmount({ quantity: 0.25, unit: 'cup', item: 'fresh mint', milliliters: 59.147 })).toBe('0.25 cup');
  });

  it('falls back to quantity+unit, then null', () => {
    expect(formatIngredientAmount({ quantity: 2, unit: 'clove' })).toBe('2 clove');
    expect(formatIngredientAmount({})).toBeNull();
  });
});

describe('score dial fills (emptier ring = healthier)', () => {
  it('maps GI onto its 0–100 scale and clamps', () => {
    expect(giFill(0)).toBe(0);
    expect(giFill(64)).toBeCloseTo(0.64);
    expect(giFill(100)).toBe(1);
    expect(giFill(140)).toBe(1); // clamp above
    expect(giFill(null)).toBe(0);
    expect(giFill(undefined)).toBe(0);
  });

  it('saturates GL at GL_DIAL_MAX', () => {
    expect(glFill(0)).toBe(0);
    expect(glFill(10)).toBeCloseTo(0.5);
    expect(glFill(GL_DIAL_MAX)).toBe(1);
    expect(glFill(40)).toBe(1); // clamp above the cap
    expect(glFill(null)).toBe(0);
  });

  it('centres inflammation on its −2 … +2 range', () => {
    expect(inflammationFill(-2)).toBe(0); // most anti → empty (best)
    expect(inflammationFill(0)).toBeCloseTo(0.5);
    expect(inflammationFill(2)).toBe(1); // most pro → full (worst)
    expect(inflammationFill(-0.8)).toBeCloseTo(0.3);
    expect(inflammationFill(-5)).toBe(0); // clamp below
    expect(inflammationFill(null)).toBe(0);
  });
});

describe('buildScoreDials', () => {
  const nutrition = {
    glycemic: { gi: 64, gl: 19, giBand: 'medium', glBand: 'medium' },
    nutriScore: { grade: 'C' },
    balance: { score: 8, band: 'high' },
    inflammation: { score: -0.8, band: 'mildly-anti-inflammatory' },
  };

  it('returns the five dials with value, tone, fill and scale', () => {
    const [gi, gl, nutri, balance, inflam] = buildScoreDials(nutrition);

    expect(gi.value).toBe('64');
    expect(gi.tone).toBe('mid');
    expect(gi.fill).toBeCloseTo(0.64);
    expect(gi.scaleRef).toBe('0–100');

    expect(gl.value).toBe('19');
    expect(gl.sub).toBe('medium');

    expect(nutri.value).toBe('C');
    expect(nutri.fill).toBe(1); // categorical → full ring
    expect(nutri.grades).toEqual(nutriGrades);
    expect(nutri.activeGrade).toBe(2); // A,B,C → index 2

    expect(balance.value).toBe('8');
    expect(balance.sub).toBe('high');
    expect(balance.tone).toBe('good'); // 7–10 → good
    expect(balance.fill).toBeCloseTo(0.8);
    expect(balance.scaleRef).toBe('1–10');

    expect(inflam.value).toBe('−0.8'); // typographic minus (U+2212), matching the −2…+2 scaleRef
    expect(inflam.tone).toBe('good');
  });

  it('shows an em-dash balance dial with empty fill when absent', () => {
    const [, , , balance] = buildScoreDials({ nutriScore: { grade: 'A' } });
    expect(balance.key).toBe('balance');
    expect(balance.value).toBe('—');
    expect(balance.fill).toBe(0);
    expect(balance.tone).toBe('unknown');
  });

  it('shows em-dash placeholders and an inactive grade when nutrition is empty', () => {
    const [gi, , nutri] = buildScoreDials(undefined);
    expect(gi.value).toBe('—');
    expect(gi.fill).toBe(0);
    expect(nutri.value).toBe('—');
    expect(nutri.activeGrade).toBe(-1);
  });

  it('leaves the GL sub empty (no duplicate "per serving") when glBand is absent or blank', () => {
    const [, gl] = buildScoreDials({ glycemic: { gl: 12 } });
    expect(gl.sub).toBeUndefined();
    expect(gl.scaleRef).toBe('per serving'); // shown once, via scaleRef only
    const [giBlank] = buildScoreDials({ glycemic: { gi: 50, giBand: '' } });
    expect(giBlank.sub).toBeUndefined();
  });

  it('prefixes positive inflammation scores with +', () => {
    const [, , , , inflam] = buildScoreDials({ inflammation: { score: 1.2, band: 'mildly-pro-inflammatory' } });
    expect(inflam.value).toBe('+1.2');
    expect(inflam.tone).toBe('bad');
  });
});

describe('hasAnyScore', () => {
  it('is true when any scored block is present', () => {
    expect(hasAnyScore({ nutriScore: { grade: 'A' } })).toBe(true);
    expect(hasAnyScore({ glycemic: { gi: 50 } })).toBe(true);
    expect(hasAnyScore({ inflammation: { score: 0, band: 'neutral' } })).toBe(true);
    expect(hasAnyScore({ balance: { score: 5, band: 'moderate' } })).toBe(true);
  });
  it('is false for an empty or macros-only block', () => {
    expect(hasAnyScore(undefined)).toBe(false);
    expect(hasAnyScore({})).toBe(false);
  });
});
