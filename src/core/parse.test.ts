import { describe, it, expect } from 'vitest';
import { parseIngredientLine, splitDescription, estimateMetric } from './parse';

describe('splitDescription', () => {
  it('splits a prep note after the first comma', () => {
    expect(splitDescription('onion, finely chopped')).toEqual({
      item: 'onion',
      note: 'finely chopped',
    });
  });
  it('treats a trailing parenthetical as a note', () => {
    expect(splitDescription('tomatoes (peeled)')).toEqual({ item: 'tomatoes', note: 'peeled' });
  });
  it('returns the whole string as the item when there is no note', () => {
    expect(splitDescription('red lentils')).toEqual({ item: 'red lentils' });
  });
});

describe('parseIngredientLine', () => {
  it('parses quantity, unit and splits item from note', () => {
    const r = parseIngredientLine('1 1/2 cups red lentils, rinsed');
    expect(r.quantity).toBe(1.5);
    expect(r.unitId).toBe('cup');
    expect(r.unit).toBe('cups');
    expect(r.item).toBe('red lentils');
    expect(r.note).toBe('rinsed');
    expect(r.isGroupHeader).toBe(false);
  });
  it('flags group headers', () => {
    const r = parseIngredientLine('For the sauce:');
    expect(r.isGroupHeader).toBe(true);
    expect(r.item).toBe('For the sauce:');
  });
  it('captures quantity ranges', () => {
    const r = parseIngredientLine('2-3 cloves garlic, minced');
    expect(r.quantity).toBe(2);
    expect(r.quantity2).toBe(3);
    expect(r.item).toBe('garlic');
    expect(r.note).toBe('minced');
  });
  it('handles non-numeric amounts', () => {
    const r = parseIngredientLine('Salt to taste');
    expect(r.quantity).toBeNull();
    expect(r.item.toLowerCase()).toContain('salt');
  });
});

describe('estimateMetric', () => {
  it('gives grams directly for mass units', () => {
    const r = estimateMetric(parseIngredientLine('8 ounces chicken breast'));
    expect(r.grams).toBeCloseTo(226.8, 1);
    expect(r.milliliters).toBeNull();
  });
  it('gives millilitres only for volume units (weight comes from the USDA portion)', () => {
    const r = estimateMetric(parseIngredientLine('2 tablespoons olive oil'));
    expect(r.milliliters).toBeCloseTo(29.57, 1);
    expect(r.grams).toBeNull();
  });
  it('leaves count units unresolved', () => {
    const r = estimateMetric(parseIngredientLine('2 cloves garlic'));
    expect(r.grams).toBeNull();
    expect(r.milliliters).toBeNull();
  });
});

describe('dual-unit imported lines', () => {
  it('strips a leading slash metric/imperial alternate and keeps the trailing note', () => {
    const r = parseIngredientLine(
      '650g/ 1.3lb seafood marinara mix (or mixed fresh seafood - fish, squid, prawns)',
    );
    expect(r.quantity).toBe(650);
    expect(r.unit).toBe('g');
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('seafood marinara mix');
    expect(r.note).toBe('or mixed fresh seafood - fish, squid, prawns');
    expect(estimateMetric(r).grams).toBe(650);
  });

  it('strips a spaced slash alternate', () => {
    const r = parseIngredientLine('650g / 1.3 lb seafood marinara mix');
    expect(r.item).toBe('seafood marinara mix');
    expect(r.note).toBeUndefined();
    expect(r.unitId).toBe('gram');
  });

  it('recovers the leaked primary unit of a glued dual-unit line', () => {
    const r = parseIngredientLine('650g/1.3lb shrimp');
    expect(r.quantity).toBe(650);
    expect(r.unit).toBe('g');
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('shrimp');
    expect(estimateMetric(r).grams).toBe(650);
  });

  it('keeps the imperial side parse-ingredient chose as primary (converts to metric)', () => {
    const r = parseIngredientLine('8 oz / 225 g cream cheese');
    expect(r.quantity).toBe(8);
    expect(r.unitId).toBe('ounce');
    expect(r.item).toBe('cream cheese');
    expect(estimateMetric(r).grams).toBeCloseTo(226.8, 1);
  });

  it('recovers the leaked unit of a glued imperial-first line', () => {
    const r = parseIngredientLine('8oz/225g cheese');
    expect(r.unit).toBe('oz');
    expect(r.unitId).toBe('ounce');
    expect(r.item).toBe('cheese');
  });

  it('strips a volume slash alternate, leaving millilitres only', () => {
    const r = parseIngredientLine('500 ml / 2 cups stock');
    expect(r.item).toBe('stock');
    const m = estimateMetric(r);
    expect(m.milliliters).toBe(500);
    expect(m.grams).toBeNull();
  });

  it('strips a two-word alternate unit ("fl oz") without eating the food', () => {
    const r = parseIngredientLine('200ml / 7 fl oz double cream');
    expect(r.unitId).toBe('milliliter');
    expect(r.item).toBe('double cream');
    expect(estimateMetric(r).milliliters).toBe(200);
  });

  it('keeps a quantity range and strips a ranged alternate', () => {
    const r = parseIngredientLine('2-3 lb / 1-1.4 kg beef');
    expect(r.quantity).toBe(2);
    expect(r.quantity2).toBe(3);
    expect(r.unitId).toBe('pound');
    expect(r.item).toBe('beef');
  });

  it('strips a fraction alternate', () => {
    const r = parseIngredientLine('1 lb / 1/2 kg meat');
    expect(r.unitId).toBe('pound');
    expect(r.item).toBe('meat');
  });

  it('runs the trailing paren-note split on the cleaned description', () => {
    const r = parseIngredientLine('1 kg / 2.2 lbs potatoes (peeled and diced)');
    expect(r.unitId).toBe('kilogram');
    expect(r.item).toBe('potatoes');
    expect(r.note).toBe('peeled and diced');
  });

  it('runs the comma-note split on the cleaned description', () => {
    const r = parseIngredientLine('100g / 3.5oz flour, sifted');
    expect(r.item).toBe('flour');
    expect(r.note).toBe('sifted');
  });

  it('leaves an empty item rather than re-leaking the alternate when no food follows', () => {
    const r = parseIngredientLine('250g / 9oz');
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('');
    expect(estimateMetric(r).grams).toBe(250);
  });

  it('does not strip an alternate whose unit is unrecognised (fail-safe)', () => {
    const r = parseIngredientLine('1 lb / 2 onions');
    expect(r.unitId).toBe('pound');
    expect(r.item).toContain('onions');
  });

  it('does not strip a prose alternate with no number after the slash (fail-safe)', () => {
    const r = parseIngredientLine('1 lb / about 2 cups cooked rice');
    expect(r.unitId).toBe('pound');
    expect(r.item).toContain('cooked rice');
  });

  it('preserves an interior alternate-food slash', () => {
    const r = parseIngredientLine('1 cup chicken/vegetable stock');
    expect(r.unitId).toBe('cup');
    expect(r.item).toBe('chicken/vegetable stock');
  });

  it('preserves a slash inside a trailing note', () => {
    const r = parseIngredientLine('2 tbsp soy sauce (light/dark)');
    expect(r.item).toBe('soy sauce');
    expect(r.note).toBe('light/dark');
  });
});

describe('leaked British units', () => {
  it('lifts "litre" out of the item and converts to millilitres', () => {
    const r = parseIngredientLine('1 litre vegetable broth');
    expect(r.quantity).toBe(1);
    expect(r.unit).toBe('litre');
    expect(r.unitId).toBe('liter');
    expect(r.item).toBe('vegetable broth');
    expect(estimateMetric(r).milliliters).toBe(1000);
  });

  it('defaults the quantity to 1 for an unquantified leaked unit', () => {
    const r = parseIngredientLine('litre vegetable broth');
    expect(r.quantity).toBe(1);
    expect(r.unitId).toBe('liter');
    expect(r.item).toBe('vegetable broth');
  });

  it('lifts a plural "litres" with a decimal quantity', () => {
    const r = parseIngredientLine('1.5 litres water');
    expect(r.quantity).toBe(1.5);
    expect(r.unitId).toBe('liter');
    expect(r.item).toBe('water');
    expect(estimateMetric(r).milliliters).toBe(1500);
  });

  it('drops a connective "of" left after lifting the unit', () => {
    const r = parseIngredientLine('1 litre of water');
    expect(r.unitId).toBe('liter');
    expect(r.item).toBe('water');
    expect(estimateMetric(r).milliliters).toBe(1000);
  });

  it('lifts a leaked unit terminated by a comma (does not drop the weight)', () => {
    const r = parseIngredientLine('500 grammes, diced potatoes');
    expect(r.quantity).toBe(500);
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('diced potatoes');
    expect(estimateMetric(r).grams).toBe(500);
  });

  it('lifts "millilitres"', () => {
    const r = parseIngredientLine('200 millilitres double cream');
    expect(r.unitId).toBe('milliliter');
    expect(r.item).toBe('double cream');
    expect(estimateMetric(r).milliliters).toBe(200);
  });

  it('lifts "grammes" as a mass unit', () => {
    const r = parseIngredientLine('500 grammes beef mince');
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('beef mince');
    expect(estimateMetric(r).grams).toBe(500);
  });
});

describe('leading parenthetical measurements', () => {
  it('drops a redundant "(4 cups)" alternate after a lifted litre', () => {
    const r = parseIngredientLine('1 litre (4 cups) chicken stock');
    expect(r.unitId).toBe('liter');
    expect(r.item).toBe('chicken stock');
    expect(estimateMetric(r).milliliters).toBe(1000);
  });

  it('drops a redundant "(240ml)" and keeps the author\'s primary unit', () => {
    const r = parseIngredientLine('1 cup (240ml) milk');
    expect(r.quantity).toBe(1);
    expect(r.unitId).toBe('cup');
    expect(r.item).toBe('milk');
    expect(estimateMetric(r).milliliters).toBeCloseTo(236.6, 1);
  });

  it('drops a redundant "(900g)" and keeps the primary unit', () => {
    const r = parseIngredientLine('2 lb (900g) potatoes');
    expect(r.quantity).toBe(2);
    expect(r.unitId).toBe('pound');
    expect(r.item).toBe('potatoes');
  });

  it('drops an "(about 250g)" qualifier measurement', () => {
    const r = parseIngredientLine('2 cups (about 250g) flour');
    expect(r.unitId).toBe('cup');
    expect(r.item).toBe('flour');
  });

  it('promotes the paren weight when the line has no real unit ("1 (400g) can")', () => {
    const r = parseIngredientLine('1 (400g) can tomatoes');
    expect(r.quantity).toBe(400);
    expect(r.unit).toBe('g');
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('can tomatoes');
    expect(estimateMetric(r).grams).toBe(400);
  });

  it('promotes a spaced paren weight', () => {
    const r = parseIngredientLine('1 (400 g) can chopped tomatoes');
    expect(r.quantity).toBe(400);
    expect(r.unitId).toBe('gram');
    expect(r.item).toBe('can chopped tomatoes');
  });

  it('scales the promoted paren weight by a multi-can count', () => {
    const r = parseIngredientLine('2 (14.5 oz) cans diced tomatoes');
    expect(r.quantity).toBe(29); // 2 × 14.5 oz, not a single can
    expect(r.unitId).toBe('ounce');
    expect(r.item).toBe('cans diced tomatoes');
    expect(estimateMetric(r).grams).toBeCloseTo(822.1, 1);
  });

  it('scales both range bounds when a counted-can line has a range', () => {
    const r = parseIngredientLine('2-3 (400g) cans beans');
    expect(r.quantity).toBe(800); // 2 × 400 g
    expect(r.quantity2).toBe(1200); // 3 × 400 g, not the stale count "3"
    expect(r.item).toBe('cans beans');
    expect(estimateMetric(r).grams).toBe(1000); // midpoint
  });

  it('drops a redundant two-word "(8 fl oz)" paren without losing the food', () => {
    const r = parseIngredientLine('1 cup (8 fl oz) milk');
    expect(r.quantity).toBe(1);
    expect(r.unitId).toBe('cup');
    expect(r.item).toBe('milk');
  });

  it('does not promote when the paren weight fails to parse (fail-safe)', () => {
    const r = parseIngredientLine('1 (1 / 2 cup) milk');
    expect(r.quantity).toBe(1); // original count kept, not overwritten with null
    expect(r.unit).toBeNull();
    expect(r.item).toBe('milk');
  });

  it('leaves a non-measurement leading paren in place (no over-strip)', () => {
    const onion = parseIngredientLine('1 (large) onion');
    expect(onion.quantity).toBe(1);
    expect(onion.unit).toBeNull();
    expect(onion.item).toBe('(large) onion');

    const sticks = parseIngredientLine('1 cup (2 sticks) butter');
    expect(sticks.unitId).toBe('cup');
    expect(sticks.item).toBe('(2 sticks) butter');

    const scant = parseIngredientLine('100 ml (scant) cream');
    expect(scant.unit).toBe('ml');
    expect(scant.item).toBe('(scant) cream');
  });

  it('does not crash or empty the item when a paren measurement has no food', () => {
    const r = parseIngredientLine('1 cup (240 ml)');
    expect(r.unitId).toBe('cup');
    expect(r.item).toBe('(240 ml)');
  });
});
