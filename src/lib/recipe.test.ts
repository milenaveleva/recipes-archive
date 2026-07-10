import { describe, it, expect } from 'vitest';
import {
  buildScoreDials,
  hasAnyScore,
  hasDisplayableScore,
  formatIngredientAmount,
  ratingTone,
  giRating,
  glRating,
  nutriRating,
  balanceRating,
  inflammationRating,
  processingRating,
  UPF_ALARM_PCT,
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

describe('score rating normalization (1–10, 1 = healthiest)', () => {
  it('bands every rating the same way: 1–3 good, 4–6 mid, 7–10 bad', () => {
    expect(ratingTone(1)).toBe('good');
    expect(ratingTone(3)).toBe('good');
    expect(ratingTone(4)).toBe('mid');
    expect(ratingTone(6)).toBe('mid');
    expect(ratingTone(7)).toBe('bad');
    expect(ratingTone(10)).toBe('bad');
    expect(ratingTone(null)).toBe('unknown');
    expect(ratingTone(undefined)).toBe('unknown');
  });

  it('maps GI so its low/medium/high bands land on 1–3 / 4–6 / 7–10', () => {
    expect(giRating(0)).toBe(1);
    expect(giRating(55)).toBe(3); // top of the low band → still good
    expect(giRating(64)).toBe(5); // medium
    expect(giRating(70)).toBe(7); // just into high → bad
    expect(giRating(100)).toBe(10);
    expect(giRating(140)).toBe(10); // clamped
    expect(giRating(null)).toBeNull();
  });

  it('maps GL so ≤10 / 11–19 / ≥20 land on 1–3 / 4–6 / 7–10', () => {
    expect(glRating(0)).toBe(1);
    expect(glRating(10)).toBe(3);
    expect(glRating(19)).toBe(6);
    expect(glRating(20)).toBe(7);
    expect(glRating(40)).toBe(10); // clamped
    expect(glRating(null)).toBeNull();
  });

  it('maps Nutri-Score A…E onto 1…10 (A best, E worst)', () => {
    expect(nutriRating('A')).toBe(1);
    expect(nutriRating('B')).toBe(3);
    expect(nutriRating('C')).toBe(6);
    expect(nutriRating('D')).toBe(8);
    expect(nutriRating('E')).toBe(10);
    expect(nutriRating(null)).toBeNull();
    expect(nutriRating('Z')).toBeNull(); // unknown grade
  });

  it('inverts nutrient balance so a denser dish rates lower (better)', () => {
    expect(balanceRating(10)).toBe(1); // densest → best
    expect(balanceRating(8)).toBe(3);
    expect(balanceRating(5)).toBe(6);
    expect(balanceRating(1)).toBe(10); // poorest → worst
    expect(balanceRating(null)).toBeNull();
  });

  it('maps inflammation from −2…+2 onto 1…10 (most anti = best)', () => {
    expect(inflammationRating(-2)).toBe(1);
    expect(inflammationRating(-1)).toBe(3); // anti-inflammatory band edge → still good
    expect(inflammationRating(0)).toBe(6); // neutral → mid
    expect(inflammationRating(2)).toBe(10);
    expect(inflammationRating(null)).toBeNull();
  });
});

describe('buildScoreDials', () => {
  const nutrition = {
    glycemic: { gi: 64, gl: 19, giBand: 'medium', glBand: 'medium' },
    nutriScore: { grade: 'C' },
    balance: { score: 8, band: 'high' },
    inflammation: { score: -0.8, band: 'mildly-anti-inflammatory' },
  };

  it('returns each dial as a 1–10 rating with matching tone and fill', () => {
    const [gi, gl, nutri, balance, inflam] = buildScoreDials(nutrition);

    expect(gi.value).toBe('5');
    expect(gi.tone).toBe('mid');
    expect(gi.fill).toBeCloseTo(0.5);

    expect(gl.value).toBe('6');
    expect(gl.tone).toBe('mid');

    expect(nutri.value).toBe('6'); // grade C → 6
    expect(nutri.tone).toBe('mid');
    expect(nutri.fill).toBeCloseTo(0.6);

    expect(balance.value).toBe('3'); // NRF 8 inverted → 3 (good)
    expect(balance.tone).toBe('good');
    expect(balance.fill).toBeCloseTo(0.3);

    expect(inflam.value).toBe('4'); // −0.8 → 4 (mid)
    expect(inflam.tone).toBe('mid');
  });

  it('shows an em-dash balance dial with empty fill when absent', () => {
    const [, , , balance] = buildScoreDials({ nutriScore: { grade: 'A' } });
    expect(balance.key).toBe('balance');
    expect(balance.value).toBe('—');
    expect(balance.present).toBe(false);
    expect(balance.fill).toBe(0);
    expect(balance.tone).toBe('unknown');
  });

  it('shows em-dash placeholders for every dial when nutrition is empty', () => {
    const [gi, , nutri] = buildScoreDials(undefined);
    expect(gi.value).toBe('—');
    expect(gi.present).toBe(false);
    expect(gi.fill).toBe(0);
    expect(nutri.value).toBe('—');
    expect(nutri.present).toBe(false);
  });

  it('rates a partial nutrition block (only glycemic load present)', () => {
    const [, gl] = buildScoreDials({ glycemic: { gl: 12 } });
    expect(gl.value).toBe('4'); // GL 12 → 4
    expect(gl.present).toBe(true);
    const [giBlank] = buildScoreDials({ glycemic: { gi: 50, giBand: '' } });
    expect(giBlank.value).toBe('3'); // GI 50 → 3
  });

  it('maps a positive (pro-inflammatory) score to a poor rating', () => {
    const [, , , , inflam] = buildScoreDials({ inflammation: { score: 1.2, band: 'mildly-pro-inflammatory' } });
    expect(inflam.value).toBe('8'); // +1.2 → 8 (bad)
    expect(inflam.tone).toBe('bad');
  });

  it('does not flash a low-UPF fermented dish alarming red (miso soup case)', () => {
    // Mostly NOVA-3 fermented foods → low NOVA 1+2 share, ~0% ultra-processed.
    const [, , , , , proc] = buildScoreDials({
      processing: { minimallyProcessedPct: 22, ultraProcessedPct: 0, band: 'highly-processed' },
    });
    expect(proc.key).toBe('processing');
    expect(proc.tone).toBe('mid'); // caution (4–6), not the critical red
  });

  it('reserves the critical processing rating for genuinely ultra-processed dishes', () => {
    const [, , , , , proc] = buildScoreDials({
      processing: { minimallyProcessedPct: 22, ultraProcessedPct: 55, band: 'highly-processed' },
    });
    expect(proc.tone).toBe('bad');
  });
});

describe('processingRating', () => {
  it('keys the poor band on the ultra-processed share, not merely a low whole-food share', () => {
    expect(ratingTone(processingRating(95, 0, 'minimally-processed'))).toBe('good');
    // Highly-processed by NOVA 1+2 share, but ultra-processed content decides the alarm.
    expect(ratingTone(processingRating(22, 0, 'highly-processed'))).toBe('mid');
    expect(ratingTone(processingRating(22, UPF_ALARM_PCT - 1, 'highly-processed'))).toBe('mid');
    expect(ratingTone(processingRating(22, UPF_ALARM_PCT, 'highly-processed'))).toBe('bad');
    expect(ratingTone(processingRating(30, UPF_ALARM_PCT + 20, 'moderately-processed'))).toBe('bad');
  });

  it('alarms a high ultra-processed share regardless of the whole-food band', () => {
    // Reaching the minimally-processed band on NOVA 1+2 share does not excuse a real UPF share.
    expect(ratingTone(processingRating(80, UPF_ALARM_PCT, 'minimally-processed'))).toBe('bad');
  });

  it('is null for a missing band or share, and falls back to the band when the UPF share is unknown', () => {
    expect(processingRating(50, 0, null)).toBeNull();
    expect(processingRating(null, 0, 'minimally-processed')).toBeNull();
    expect(ratingTone(processingRating(10, null, 'highly-processed'))).toBe('bad');
    expect(ratingTone(processingRating(40, null, 'moderately-processed'))).toBe('mid');
    expect(ratingTone(processingRating(90, null, 'minimally-processed'))).toBe('good');
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

describe('hasDisplayableScore', () => {
  it('is true only when at least one score has a real value, not merely a present block', () => {
    expect(hasDisplayableScore({ nutriScore: { grade: 'B' } })).toBe(true);
    // A present-but-empty block leaves hasAnyScore true yet has nothing to show.
    expect(hasAnyScore({ glycemic: { gi: null, gl: null } })).toBe(true);
    expect(hasDisplayableScore({ glycemic: { gi: null, gl: null } })).toBe(false);
    expect(hasDisplayableScore(undefined)).toBe(false);
  });

  it('mirrors the dial present flags that the compact strip filters on', () => {
    const dials = buildScoreDials({ nutriScore: { grade: 'B' }, glycemic: { gi: null } });
    expect(dials.find((d) => d.key === 'nutri')?.present).toBe(true);
    expect(dials.find((d) => d.key === 'gi')?.present).toBe(false);
  });
});
