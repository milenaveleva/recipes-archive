import { describe, it, expect } from 'vitest';
import { foodFormAdjustment, applyFoodForm } from './foodAdjust';
import adjustments from '../data/food-adjustments.json';
import foods from '../data/usda-foods.json';

describe('foodFormAdjustment (composition-blind FII correction)', () => {
  it('returns 0 for a food with no adjustment, and for a missing fdcId', () => {
    expect(foodFormAdjustment(169655)).toBe(0); // granulated sugar — not adjusted
    expect(foodFormAdjustment(null)).toBe(0);
    expect(foodFormAdjustment(undefined)).toBe(0);
    expect(foodFormAdjustment(999999999)).toBe(0); // not in the table
  });

  it('returns the cited delta for a fermented-dairy food', () => {
    expect(foodFormAdjustment(171284)).toBe(-1.3); // plain whole-milk yogurt
    expect(foodFormAdjustment(173414)).toBe(-0.4); // cheddar
  });
});

describe('applyFoodForm', () => {
  it('leaves an unadjusted food’s tag unchanged', () => {
    expect(applyFoodForm(0.5, 169655)).toBe(0.5);
    expect(applyFoodForm(-1.2, null)).toBe(-1.2);
  });

  it('shifts an adjusted food’s tag by its delta (rounded to 0.1)', () => {
    expect(applyFoodForm(1.3, 171284)).toBe(0); // 1.3 + (−1.3) → neutral
    expect(applyFoodForm(2, 173414)).toBe(1.6); // 2 + (−0.4)
  });

  it('re-clamps to the −2…+2 axis after adjusting', () => {
    expect(applyFoodForm(-1, 171284)).toBe(-2); // −1 + (−1.3) = −2.3 → clamp −2
  });
});

describe('food-adjustments.json integrity', () => {
  const entries = Object.entries(adjustments as Record<string, unknown>).filter(([k]) => !k.startsWith('_'));

  it('keys every entry to an integer fdcId with a finite, in-range delta and a citation', () => {
    for (const [id, raw] of entries) {
      expect(Number.isInteger(Number(id)), `fdcId ${id}`).toBe(true);
      const a = raw as { delta?: unknown; reason?: unknown; cite?: unknown };
      expect(Number.isFinite(a.delta), `delta ${id}`).toBe(true);
      expect(a.delta as number, `delta in range ${id}`).toBeGreaterThanOrEqual(-2);
      expect(a.delta as number, `delta in range ${id}`).toBeLessThanOrEqual(2);
      expect(a.reason, `reason ${id}`).toBeTruthy();
      expect(a.cite, `cite ${id}`).toBeTruthy();
    }
  });

  it('has no orphan keys — every adjusted fdcId is a real food', () => {
    const ids = new Set((foods as { fdcId?: number }[]).map((f) => String(f.fdcId)));
    const orphans = entries.map(([id]) => id).filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });
});
