/**
 * Metric conversion for cooking units.
 *
 * Recipes are stored in metric (grams precomputed); this module converts the
 * handful of mass/volume/temperature units that appear in recipes to grams or
 * millilitres. Volume→weight needs an ingredient density and lives in
 * `density.ts`; here volume resolves to millilitres only.
 *
 * The conversion factors are exact (US customary) constants — a self-contained
 * table is the right size for ~15 units and avoids a general-purpose
 * conversion dependency plus the id-aliasing shim its abbreviations would
 * still require. Keys are the canonical unit ids emitted by `parse-ingredient`
 * (e.g. "cup", "fluid ounce", "tablespoon", "gram").
 */
import type { Dimension, MetricAmount } from './types';

/** Volume unit → millilitres (US customary, plus metric volumes). */
const ML_PER: Record<string, number> = {
  milliliter: 1,
  centiliter: 10,
  deciliter: 100,
  liter: 1000,
  teaspoon: 4.92892,
  tablespoon: 14.7868,
  'fluid ounce': 29.5735,
  cup: 236.588,
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41,
};

/** Mass unit → grams. */
const G_PER: Record<string, number> = {
  microgram: 0.000001,
  milligram: 0.001,
  gram: 1,
  kilogram: 1000,
  ounce: 28.3495,
  pound: 453.592,
};

/**
 * Aliases → canonical unit id. A safety net: `parse-ingredient` with
 * `normalizeUOM` already yields canonical ids, but raw/imported tokens may not.
 */
const UNIT_ALIASES: Record<string, string> = {
  ml: 'milliliter',
  millilitre: 'milliliter',
  milliliters: 'milliliter',
  millilitres: 'milliliter',
  cl: 'centiliter',
  dl: 'deciliter',
  l: 'liter',
  litre: 'liter',
  liters: 'liter',
  litres: 'liter',
  tsp: 'teaspoon',
  teaspoons: 'teaspoon',
  tbsp: 'tablespoon',
  tbs: 'tablespoon',
  tablespoons: 'tablespoon',
  c: 'cup',
  cups: 'cup',
  'fl oz': 'fluid ounce',
  'fl-oz': 'fluid ounce',
  'fluid ounces': 'fluid ounce',
  pt: 'pint',
  pints: 'pint',
  qt: 'quart',
  quarts: 'quart',
  gal: 'gallon',
  gallons: 'gallon',
  mcg: 'microgram',
  micrograms: 'microgram',
  mg: 'milligram',
  milligrams: 'milligram',
  g: 'gram',
  gr: 'gram',
  grams: 'gram',
  gramme: 'gram',
  grammes: 'gram',
  kg: 'kilogram',
  kilograms: 'kilogram',
  kilo: 'kilogram',
  kilos: 'kilogram',
  oz: 'ounce',
  ounces: 'ounce',
  lb: 'pound',
  lbs: 'pound',
  pounds: 'pound',
};

/** Normalise a unit token to its canonical id, or null when absent. */
export function canonicalUnit(unit?: string | null): string | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase().replace(/\.+$/, '');
  if (!u) return null;
  return UNIT_ALIASES[u] ?? u;
}

/** The physical dimension of a unit, or null when unrecognised. */
export function classifyUnit(unit?: string | null): Dimension | null {
  const u = canonicalUnit(unit);
  if (!u) return null;
  if (u in G_PER) return 'mass';
  if (u in ML_PER) return 'volume';
  return null;
}

/** Convert a mass quantity to grams; null when the unit is not a mass. */
export function massToGrams(
  quantity: number | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (quantity == null || !Number.isFinite(quantity)) return null;
  const factor = G_PER[canonicalUnit(unit) ?? ''];
  return factor == null ? null : quantity * factor;
}

/** Convert a volume quantity to millilitres; null when the unit is not a volume. */
export function volumeToMilliliters(
  quantity: number | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (quantity == null || !Number.isFinite(quantity)) return null;
  const factor = ML_PER[canonicalUnit(unit) ?? ''];
  return factor == null ? null : quantity * factor;
}

/**
 * Resolve a quantity + unit to a metric amount. Mass units yield grams; volume
 * units yield millilitres (weight needs an ingredient density, see
 * `density.ts`); anything else (count words like "clove", "pinch") yields a
 * null amount with a null dimension.
 */
export function toMetric(
  quantity: number | null | undefined,
  unit: string | null | undefined,
): MetricAmount {
  const dimension = classifyUnit(unit);
  if (dimension === 'mass') {
    return { grams: massToGrams(quantity, unit), milliliters: null, dimension };
  }
  if (dimension === 'volume') {
    return { grams: null, milliliters: volumeToMilliliters(quantity, unit), dimension };
  }
  return { grams: null, milliliters: null, dimension: null };
}

/** Fahrenheit → Celsius, for converting imported imperial oven temperatures. */
export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}
