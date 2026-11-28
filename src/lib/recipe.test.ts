import { describe, it, expect } from 'vitest';
import {
  oliveOilSpoons,
  displayItemNote,
  formatQuantity,
  buildScoreDials,
  hasAnyScore,
  hasDisplayableScore,
  formatIngredientAmount,
  isSeasoning,
  showRawFallback,
  ratingTone,
  giRating,
  glRating,
  nutriRating,
  balanceRating,
  inflammationRating,
  processingRating,
  UPF_ALARM_PCT,
  giEstimateLabel,
  NUTRI_LOW_DATA_COVERAGE,
} from './recipe';
import { INFLAMMATION_BAND_EDGES, inflammationBandOf } from '../core/inflammation';
import { glBandOf, DEFAULT_GL_BASIS } from '../core/gi';

describe('formatIngredientAmount (display unit ≠ calc basis)', () => {
  it('shows tsp/tbsp as written even when grams/ml are stored for the math', () => {
    expect(formatIngredientAmount({ quantity: 1, unit: 'tbsp', grams: 13.6, milliliters: 14.8 })).toBe('1 tbsp');
    expect(formatIngredientAmount({ quantity: 2, unit: 'tsp', grams: 9.2 })).toBe('2 tsp');
    expect(formatIngredientAmount({ quantity: 0.5, unit: 'tbsp' })).toBe('½ tbsp');
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
    expect(formatIngredientAmount({ quantity: 34, unit: 'g', grams: 34 })).toBe('30 g');
    expect(formatIngredientAmount({ quantity: 35, unit: 'g', grams: 35 })).toBe('40 g'); // half rounds up
    expect(formatIngredientAmount({ quantity: 4.5, unit: 'g', grams: 4.5 })).toBe('4.5 g'); // ≤10: exact, never coarsened
    expect(formatIngredientAmount({ quantity: 3, unit: 'g', grams: 3 })).toBe('3 g');
    expect(formatIngredientAmount({ quantity: 1234, unit: 'g', grams: 1234 })).toBe('1.23 kg');
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
    // Oils are liquids too (display ml), not grams — except olive oil, always in spoons.
    expect(
      formatIngredientAmount({ quantity: 0.25, unit: 'cup', item: 'sunflower oil', milliliters: 59, grams: 54 }),
    ).toBe('60 ml');
    expect(
      formatIngredientAmount({ quantity: 0.25, unit: 'cup', item: 'olive oil', milliliters: 59, grams: 54 }),
    ).toBe('4 tbsp');
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
    expect(formatIngredientAmount({ quantity: 1.5, unit: 'cups', item: 'shelled edamame', milliliters: 354.882 })).toBe('1½ cups');
    expect(formatIngredientAmount({ quantity: 0.25, unit: 'cup', item: 'fresh mint', milliliters: 59.147 })).toBe('¼ cup');
  });

  it('shows nothing for a line with no written quantity (its grams are a hidden estimate)', () => {
    expect(formatIngredientAmount({ item: 'salt', note: 'to taste', grams: 3 })).toBeNull();
    expect(formatIngredientAmount({ item: 'fresh parsley', note: 'for garnish', grams: 3 })).toBeNull();
    expect(formatIngredientAmount({ item: 'sunflower oil', note: 'for frying', grams: 60 })).toBeNull();
  });

  it('never shows a seasoning in grams — spoon, pinch or count only, else nothing', () => {
    expect(formatIngredientAmount({ quantity: 5, unit: 'g', item: 'smoked paprika', grams: 5 })).toBeNull();
    expect(formatIngredientAmount({ quantity: 2, unit: 'g', item: 'salt', grams: 2 })).toBeNull();
    expect(formatIngredientAmount({ quantity: 0.5, unit: 'mg', item: 'saffron', grams: 0.0005 })).toBeNull();
    expect(formatIngredientAmount({ quantity: 1, unit: 'tsp', item: 'ground cumin', grams: 2.1 })).toBe('1 tsp');
    expect(formatIngredientAmount({ quantity: 0.5, unit: 'tbsp', item: 'curry powder', grams: 3 })).toBe('½ tbsp');
    expect(formatIngredientAmount({ quantity: 1, unit: 'pinch', item: 'nutmeg', grams: 0.2 })).toBe('1 pinch');
    expect(formatIngredientAmount({ quantity: 2, item: 'bay leaves', grams: 0.4 })).toBe('2');
    expect(formatIngredientAmount({ quantity: 1, unit: 'stick', item: 'cinnamon', grams: 3 })).toBe('1 stick');
    expect(formatIngredientAmount({ quantity: 5, unit: 'ml', item: 'vanilla extract', milliliters: 5, grams: 4 })).toBeNull();
    expect(formatIngredientAmount({ item: 'black pepper', note: 'to taste', grams: 0.5 })).toBeNull();
  });

  it('recognises seasonings without catching produce that shares a word', () => {
    for (const s of ['salt', 'sea salt', 'pepper', 'black pepper', 'freshly ground black pepper', 'red pepper flakes', 'chili flakes', 'chilli powder', 'cumin', 'ground coriander', 'coriander seeds', 'ginger, ground', 'dried thyme', 'rosemary (dried)', 'garam masala', 'garlic powder', 'baking soda', 'baking powder', 'vanilla', 'vanilla extract', 'mixed spice', "za'atar", 'bay leaves']) {
      expect(isSeasoning(s), s).toBe(true);
    }
    for (const s of ['red pepper', 'green pepper', 'bell pepper', 'fresh ginger', 'fresh thyme', 'garlic cloves', 'vanilla yoghurt', 'chicken breast', 'salted peanuts', '']) {
      expect(isSeasoning(s), s).toBe(false);
    }
    expect(formatIngredientAmount({ quantity: 200, unit: 'g', item: 'red pepper', grams: 200 })).toBe('200 g');
  });

  it('shows no amount for a juice with no written quantity', () => {
    expect(formatIngredientAmount({ item: 'lemon juice', note: 'to taste', raw: 'lemon juice, to taste', grams: 15 })).toBeNull();
    expect(formatIngredientAmount({ item: 'lime juice', raw: 'a squeeze of lime juice', milliliters: 5 })).toBeNull();
  });

  it('shows juice in ml — from its volume, or its weight at ≈1 g/ml', () => {
    expect(formatIngredientAmount({ item: 'juice of ¼ lemon', grams: 10 })).toBe('10 ml');
    expect(formatIngredientAmount({ item: 'lemon', note: 'juice of ½', raw: 'juice of ½ lemon', grams: 15 })).toBe('20 ml');
    expect(formatIngredientAmount({ item: 'lime', raw: 'juice of 1 lime', quantity: 1, grams: 30 })).toBe('30 ml');
    expect(formatIngredientAmount({ quantity: 2, unit: 'tbsp', item: 'lemon juice', grams: 30 })).toBe('2 tbsp');
    expect(formatIngredientAmount({ quantity: 0.5, unit: 'cup', item: 'orange juice', milliliters: 118, grams: 124 })).toBe('120 ml');
  });

  it('shows the original line only when there is no amount and the ingredient is not a seasoning', () => {
    expect(showRawFallback({ item: 'lime', raw: 'lime (optional)' }, null)).toBe(true);
    expect(showRawFallback({ item: 'cumin', raw: '5 g cumin' }, null)).toBe(false);
    expect(showRawFallback({ item: 'lime', raw: 'lime' }, '30 g')).toBe(false);
    // A line that only restates its item and note is not printed twice.
    expect(showRawFallback({ item: 'spring onions', note: 'sliced', raw: 'spring onions, sliced' }, null)).toBe(false);
  });

  it('shows the stored weight of a line written without an amount, unless it is to taste or optional', () => {
    expect(formatIngredientAmount({ item: 'red onion', note: 'sliced', raw: 'red onion, sliced', grams: 30 })).toBe('30 g');
    expect(formatIngredientAmount({ item: 'lime', raw: 'lime (optional)', grams: 30 })).toBeNull();
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

  it('maps per-serving GL on portion bands: ≤10 / 11–19 / ≥20 → 1–3 / 4–6 / 7–10', () => {
    expect(glRating(0, 'portion')).toBe(1);
    expect(glRating(5, 'portion')).toBe(2);
    expect(glRating(10, 'portion')).toBe(3); // top of the low band → still good
    expect(glRating(11, 'portion')).toBe(4);
    expect(glRating(15, 'portion')).toBe(5);
    expect(glRating(19, 'portion')).toBe(6);
    expect(glRating(20, 'portion')).toBe(7); // into high → bad
    expect(glRating(30, 'portion')).toBe(10);
    expect(glRating(45, 'portion')).toBe(10); // clamped
    expect(glRating(null, 'portion')).toBeNull();
    for (let g = 0; g <= 40; g++) {
      expect(ratingTone(glRating(g, 'portion')), `GL ${g}`).toBe(
        glBandOf(g, 'portion') === 'low' ? 'good' : glBandOf(g, 'portion') === 'medium' ? 'mid' : 'bad',
      );
    }
  });

  it('maps per-serving GL on meal bands: <20 / 20–39 / ≥40 → 1–3 / 4–6 / 7–10', () => {
    expect(glRating(0, 'meal')).toBe(1);
    expect(glRating(10, 'meal')).toBe(2);
    expect(glRating(19, 'meal')).toBe(3); // top of the low band → still good
    expect(glRating(20, 'meal')).toBe(4);
    expect(glRating(30, 'meal')).toBe(5);
    expect(glRating(39, 'meal')).toBe(6);
    expect(glRating(40, 'meal')).toBe(7); // into high → bad
    expect(glRating(60, 'meal')).toBe(10);
    expect(glRating(90, 'meal')).toBe(10); // clamped
    expect(glRating(null, 'meal')).toBeNull();
    for (let g = 0; g <= 80; g++) {
      const tone = ratingTone(glRating(g, 'meal'));
      expect(tone).toBe(g < 20 ? 'good' : g < 40 ? 'mid' : 'bad');
    }
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

  it('maps inflammation onto 1…10 by the band edges, so colour agrees with the band word', () => {
    const e = INFLAMMATION_BAND_EDGES;
    expect(inflammationRating(-2)).toBe(1);
    expect(inflammationRating(e.antiMax)).toBe(2); // top of "anti" → good
    expect(inflammationRating(e.mildlyAntiMax)).toBe(3); // top of "mildly anti" → still good
    expect(inflammationRating(e.neutralMax)).toBe(6); // top of "neutral" → mid
    expect(inflammationRating(e.mildlyProMax)).toBe(8); // top of "mildly pro" → bad
    expect(inflammationRating(2)).toBe(10);
    expect(inflammationRating(null)).toBeNull();
    const toneOf: Record<string, string> = {
      'anti-inflammatory': 'good',
      'mildly-anti-inflammatory': 'good',
      neutral: 'mid',
      'mildly-pro-inflammatory': 'bad',
      'pro-inflammatory': 'bad',
    };
    for (let x = -2; x <= 2.0001; x += 0.05) {
      const score = Math.round(x * 100) / 100;
      expect(ratingTone(inflammationRating(score)), `score ${score}`).toBe(toneOf[inflammationBandOf(score)]);
    }
  });

  it('positions inflammation by the stored band, clamping a score outside it', () => {
    // The stored band decides the colour segment even if the score sits past its edge.
    expect(ratingTone(inflammationRating(1.2, 'mildly-pro-inflammatory'))).toBe('bad');
    expect(inflammationRating(1.2, 'mildly-pro-inflammatory')).toBe(8);
    expect(ratingTone(inflammationRating(0, 'neutral'))).toBe('mid');
    expect(inflammationRating(0, 'bogus')).toBe(inflammationRating(0)); // invalid band → score's band
  });
});

describe('buildScoreDials', () => {
  const nutrition = {
    glycemic: { gi: 64, gl: 19, giBand: 'medium', glBand: 'low', glBasis: 'meal' },
    nutriScore: { grade: 'C' },
    balance: { score: 8, band: 'high' },
    inflammation: { score: -0.8, band: 'mildly-anti-inflammatory' },
  };

  it('returns each dial as a 1–10 rating with matching tone and fill', () => {
    const [gi, gl, nutri, balance, inflam] = buildScoreDials(nutrition);

    expect(gi.value).toBe('5');
    expect(gi.tone).toBe('mid');
    expect(gi.fill).toBeCloseTo(0.5);

    expect(gl.value).toBe('3'); // GL 19 is a low-GL meal
    expect(gl.tone).toBe('good');

    expect(nutri.value).toBe('6'); // grade C → 6
    expect(nutri.tone).toBe('mid');
    expect(nutri.fill).toBeCloseTo(0.6);

    expect(balance.value).toBe('3'); // NRF 8 inverted → 3 (good)
    expect(balance.tone).toBe('good');
    expect(balance.fill).toBeCloseTo(0.3);

    expect(inflam.value).toBe('2'); // −0.8, low in the mildly-anti band → 2 (good, agreeing with the band)
    expect(inflam.tone).toBe('good');
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
    const [, gl] = buildScoreDials({ glycemic: { gl: 32, glBasis: 'meal' } });
    expect(gl.value).toBe('5'); // GL 32 on meal bands → 5
    expect(gl.present).toBe(true);
    const [giBlank] = buildScoreDials({ glycemic: { gi: 50, giBand: '' } });
    expect(giBlank.value).toBe('3'); // GI 50 → 3
  });

  it('maps a positive (pro-inflammatory) score to a poor rating', () => {
    const [, , , , inflam] = buildScoreDials({ inflammation: { score: 1.2, band: 'mildly-pro-inflammatory' } });
    expect(inflam.value).toBe('8'); // +1.2 → 8 (bad)
    expect(inflam.tone).toBe('bad');
  });

  it('shows a NOVA-3-heavy dish amber, not red', () => {
    const [, , , , , proc] = buildScoreDials({
      processing: { minimallyProcessedPct: 22, ultraProcessedPct: 0, band: 'moderately-processed' },
    });
    expect(proc.key).toBe('processing');
    expect(proc.tone).toBe('mid');
    expect(proc.caption).toBe('Moderately Processed');
  });

  it('captions GI as a rounded estimate and GL with the serving carbs', () => {
    const [gi, gl] = buildScoreDials(
      {
        perServing: { availableCarb_g: 46.4 },
        glycemic: { gi: 57, gl: 26, measuredGiPct: 80 },
      },
      'Main Course',
    );
    expect(gi.caption).toBe('≈ 55, estimated');
    expect(gi.blurb).toContain('80% of the carbohydrate has a measured GI');
    expect(gl.caption).toBe('26 per serving · meal bands'); // no stored basis → the course's (main → meal)
    expect(gl.blurb).toContain('low under 20, medium 20–39, high 40+');
    expect(gl.blurb).toContain('46 g of available carbohydrate');
    expect(giEstimateLabel(58)).toBe('≈ 60, estimated');
    expect(giEstimateLabel(52)).toBe('≈ 50, estimated');
    const [, glNoCarbs] = buildScoreDials({ glycemic: { gl: 26 } });
    expect(glNoCarbs.blurb).not.toContain('available carbohydrate.');
  });

  it('defaults a missing GL basis to the engine default, or infers it from the course', () => {
    expect(glRating(20)).toBe(glRating(20, DEFAULT_GL_BASIS));
    const [, none] = buildScoreDials({ glycemic: { gl: 20 } });
    expect(none.caption).toBe(`20 per serving · ${DEFAULT_GL_BASIS} bands`);
    const [, main] = buildScoreDials({ glycemic: { gl: 20 } }, 'Main Course');
    expect(main.caption).toBe('20 per serving · meal bands');
    const [, snack] = buildScoreDials({ glycemic: { gl: 20 } }, 'Snack');
    expect(snack.caption).toBe('20 per serving · portion bands');
    // A stored basis always wins over the course.
    const [, stored] = buildScoreDials({ glycemic: { gl: 20, glBasis: 'portion' } }, 'Main Course');
    expect(stored.caption).toBe('20 per serving · portion bands');
  });

  it('rates and captions GL on the stored basis', () => {
    const [, portion] = buildScoreDials({ glycemic: { gl: 20, glBasis: 'portion' } });
    expect(portion.value).toBe('7'); // GL 20 is a high-GL portion
    expect(portion.tone).toBe('bad');
    expect(portion.caption).toBe('20 per serving · portion bands');
    expect(portion.blurb).toContain('low 10 or less, medium 11–19, high 20+');
    const [, meal] = buildScoreDials({ glycemic: { gl: 20, glBasis: 'meal' } });
    expect(meal.value).toBe('4'); // GL 20 is a medium-GL meal
    expect(meal.caption).toBe('20 per serving · meal bands');
  });

  it('flags a low-data Nutri-Score (coverage < 0.9) in caption and tooltip', () => {
    const [, , low] = buildScoreDials({ nutriScore: { grade: 'B', coverage: 0.72 } });
    expect(low.caption).toBe('Grade B · low data');
    expect(low.blurb).toContain('Low data: only 72%');
    const [, , ok] = buildScoreDials({ nutriScore: { grade: 'B', coverage: 0.95 } });
    expect(ok.caption).toBe('Grade B');
    expect(ok.blurb).not.toContain('Low data');
    expect(NUTRI_LOW_DATA_COVERAGE).toBe(0.9);
  });

  it('captions inflammation by its band, and omits captions for absent scores', () => {
    const [, , , , inflam] = buildScoreDials({ inflammation: { score: -0.5, band: 'mildly-anti-inflammatory' } });
    expect(inflam.caption).toBe('Mildly anti-inflammatory');
    const [gi] = buildScoreDials(undefined);
    expect(gi.caption).toBeUndefined();
  });

  it('reserves the critical processing rating for genuinely ultra-processed dishes', () => {
    const [, , , , , proc] = buildScoreDials({
      processing: { minimallyProcessedPct: 22, ultraProcessedPct: 55, band: 'highly-processed' },
    });
    expect(proc.tone).toBe('bad');
  });
});

describe('processingRating', () => {
  it('gives each band one tone: minimally good, moderately amber, highly red', () => {
    expect(ratingTone(processingRating(95, 0, 'minimally-processed'))).toBe('good');
    expect(ratingTone(processingRating(70, 10, 'minimally-processed'))).toBe('good');
    // A dish whose energy is mostly NOVA 3 (canned legumes, cheese) is processed, not ultra-processed.
    expect(ratingTone(processingRating(10, 0, 'moderately-processed'))).toBe('mid');
    expect(ratingTone(processingRating(50, UPF_ALARM_PCT - 1, 'moderately-processed'))).toBe('mid');
    expect(ratingTone(processingRating(22, UPF_ALARM_PCT, 'highly-processed'))).toBe('bad');
    expect(processingRating(70, UPF_ALARM_PCT, 'highly-processed')).toBe(7);
    expect(processingRating(0, 100, 'highly-processed')).toBe(10);
  });

  it('is monotone: never falls as the UPF share rises or the whole-food share falls', () => {
    const band = (m: number, u: number) =>
      u >= UPF_ALARM_PCT ? 'highly-processed' : m >= 70 ? 'minimally-processed' : 'moderately-processed';
    const r = (m: number, u: number) => processingRating(m, u, band(m, u))!;
    for (let m = 0; m <= 100; m += 5) {
      for (let u = 0; u + m <= 100; u += 5) {
        if (u + 5 + m <= 100) expect(r(m, u + 5), `m ${m} u ${u}→${u + 5}`).toBeGreaterThanOrEqual(r(m, u));
        if (m + 5 + u <= 100) expect(r(m + 5, u), `u ${u} m ${m}→${m + 5}`).toBeLessThanOrEqual(r(m, u));
      }
    }
  });

  it('reads red for a UPF share at the alarm even on a stale non-highly band, and for a highly band at any share', () => {
    expect(ratingTone(processingRating(80, UPF_ALARM_PCT, 'minimally-processed'))).toBe('bad');
    expect(ratingTone(processingRating(30, UPF_ALARM_PCT + 20, 'moderately-processed'))).toBe('bad');
    for (const pct of [0, 40, 80]) expect(processingRating(pct, null, 'highly-processed')!).toBeGreaterThanOrEqual(7);
  });

  it('is null for a missing band or share, and falls back to the band when the UPF share is unknown', () => {
    expect(processingRating(50, 0, null)).toBeNull();
    expect(processingRating(null, 0, 'minimally-processed')).toBeNull();
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

describe('formatQuantity (cook-readable fractions)', () => {
  it('renders common fractions and mixed numbers, decimals otherwise', () => {
    expect(formatQuantity(0.5)).toBe('½');
    expect(formatQuantity(0.25)).toBe('¼');
    expect(formatQuantity(1.75)).toBe('1¾');
    expect(formatQuantity(1 / 3)).toBe('⅓');
    expect(formatQuantity(2)).toBe('2');
    expect(formatQuantity(1.4)).toBe('1.4');
  });
});

describe('olive oil and state-word display', () => {
  it('shows olive oil in tablespoons from its weight or volume', () => {
    expect(oliveOilSpoons({ item: 'extra virgin olive oil', quantity: 60, unit: 'ml', milliliters: 60 })).toBe('4 tbsp');
    expect(oliveOilSpoons({ item: 'olive oil', quantity: 150, unit: 'g', grams: 150 })).toBe('11 tbsp');
    expect(oliveOilSpoons({ item: 'olive oil', quantity: 1.5, unit: 'tbsp', grams: 20 })).toBe('1½ tbsp');
    expect(oliveOilSpoons({ item: 'olive oil', grams: 4 })).toBe('1 tsp');
    expect(oliveOilSpoons({ item: 'sunflower oil', grams: 30 })).toBeNull();
  });

  it('moves a leading state word of a staple into the note, but not of a product name', () => {
    expect(displayItemNote('dried chickpeas', 'soaked and cooked')).toEqual({ item: 'chickpeas', note: 'dry, soaked and cooked' });
    expect(displayItemNote('dry whole-wheat penne')).toEqual({ item: 'whole-wheat penne', note: 'dry' });
    expect(displayItemNote('dried oregano')).toEqual({ item: 'dried oregano', note: null });
    expect(displayItemNote('raw honey')).toEqual({ item: 'raw honey', note: null });
    expect(displayItemNote('fresh basil leaves', 'for garnish')).toEqual({ item: 'basil leaves', note: 'fresh, for garnish' });
    expect(displayItemNote('fresh garlic')).toEqual({ item: 'fresh garlic', note: null });
    expect(displayItemNote('unsweetened oat milk', 'as needed')).toEqual({ item: 'oat milk', note: 'unsweetened, as needed' });
  });
});

describe('egg display', () => {
  it('shows eggs as a count, never by weight', () => {
    expect(formatIngredientAmount({ quantity: 16, item: 'eggs', grams: 800 })).toBe('16');
    expect(formatIngredientAmount({ quantity: 2, unit: 'medium', item: 'eggs', grams: 100 })).toBe('2');
    expect(formatIngredientAmount({ quantity: 3, item: 'egg yolks', grams: 51 })).toBe('3');
    expect(formatIngredientAmount({ quantity: 200, unit: 'g', item: 'eggplant', grams: 200 })).toBe('200 g');
  });
});
