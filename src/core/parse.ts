/**
 * Ingredient-line parsing: raw text → structured, metric-aware fields.
 *
 * The genuinely hard part (mixed numbers, vulgar fractions, ranges, group
 * headers, trailing-quantity phrasings) is delegated to `parse-ingredient`;
 * this module adapts its output to our schema shape, splits the food from its
 * prep note, and produces a pre-match metric estimate via `units`.
 */
import { parseIngredient } from 'parse-ingredient';
import type { MetricAmount, ParsedLine } from './types';
import { canonicalUnit, toMetric } from './units';

/** Split a parsed description into the food item and an optional prep note. */
export function splitDescription(description: string): { item: string; note?: string } {
  const text = description.trim();
  // A trailing parenthetical is a note: "tomatoes (peeled)".
  const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(text);
  if (paren && paren[1].trim()) {
    return { item: paren[1].trim(), note: paren[2].trim() || undefined };
  }
  // Otherwise the first comma separates food from prep: "onion, finely chopped".
  const comma = text.indexOf(',');
  if (comma >= 0) {
    const item = text.slice(0, comma).trim();
    const note = text.slice(comma + 1).trim();
    return { item: item || text, note: note || undefined };
  }
  return { item: text };
}

/** Parse a single raw ingredient line into structured fields. */
export function parseIngredientLine(raw: string): ParsedLine {
  // Default (no normalizeUOM): `unitOfMeasure` keeps the as-written token for
  // provenance ("cups"), while `unitOfMeasureID` is still the canonical id
  // used for conversion ("cup").
  const [parsed] = parseIngredient(raw);
  if (!parsed) {
    return {
      raw,
      quantity: null,
      quantity2: null,
      unit: null,
      unitId: null,
      item: raw.trim(),
      isGroupHeader: false,
    };
  }
  if (parsed.isGroupHeader) {
    return {
      raw,
      quantity: null,
      quantity2: null,
      unit: null,
      unitId: null,
      item: parsed.description.trim(),
      isGroupHeader: true,
    };
  }
  const { item, note } = splitDescription(parsed.description);
  const line: ParsedLine = {
    raw,
    quantity: parsed.quantity,
    quantity2: parsed.quantity2,
    unit: parsed.unitOfMeasure ?? null,
    unitId: parsed.unitOfMeasureID ?? canonicalUnit(parsed.unitOfMeasure),
    item,
    isGroupHeader: false,
  };
  // Omit `note` entirely when absent, so it never serialises as an empty/null
  // field (the schema's `note` is optional, expecting absence not null).
  if (note !== undefined) line.note = note;
  return line;
}

/** Parse a block of newline-separated ingredient lines. */
export function parseIngredientLines(lines: string[]): ParsedLine[] {
  return lines.map((line) => parseIngredientLine(line));
}

/**
 * Best-effort metric estimate for a parsed line, before a USDA match.
 * Mass units give grams directly; volume units give millilitres only. Volume
 * weight and count words ("clove", "pinch") are resolved later from the matched
 * food's USDA portion (see addLib's initialGrams), not estimated here.
 */
export function estimateMetric(parsed: ParsedLine): MetricAmount {
  // For a range ("2–3 cups"), estimate from the midpoint of the two bounds.
  const quantity =
    parsed.quantity != null && parsed.quantity2 != null
      ? (parsed.quantity + parsed.quantity2) / 2
      : parsed.quantity;
  return toMetric(quantity, parsed.unitId ?? parsed.unit);
}
