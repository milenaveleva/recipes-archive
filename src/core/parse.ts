/**
 * Ingredient-line parsing: raw text → structured, metric-aware fields.
 *
 * The genuinely hard part (mixed numbers, vulgar fractions, ranges, group
 * headers, trailing-quantity phrasings) is delegated to `parse-ingredient`;
 * this module adapts its output to our schema shape, splits the food from its
 * prep note, and produces a pre-match metric estimate via `units`.
 *
 * Imported lines often carry the same amount twice (a metric/imperial pair
 * "650g / 1.3lb beef", or a parenthetical conversion "1 cup (240ml) milk"), or
 * use a unit `parse-ingredient` doesn't recognise and leaves at the head of the
 * description (British "1 litre vegetable broth"). A small normalisation
 * pipeline runs before the food/note split: it lifts a leaked unit, strips a
 * leading "/ <alternate>", and drops a redundant leading "(<measure>)".
 * `classifyUnit` is the sole "is this a real cooking unit" oracle, so an
 * alternate-food slash ("chicken/vegetable stock") or a genuine note
 * ("(or other dry white wine)") is never mistaken for a measurement.
 */
import { parseIngredient } from 'parse-ingredient';
import type { MetricAmount, ParsedLine } from './types';
import { canonicalUnit, classifyUnit, toMetric } from './units';

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

/** A numeric token (decimal "1.3"/"1,3", fraction "1/2", or mixed "1 1/2") as a
 *  finite number, or null. A decimal comma is read as a decimal point. */
function parseNum(token: string): number | null {
  const t = token.trim().replace(',', '.');
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) {
    const n = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
    return Number.isFinite(n) ? n : null;
  }
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) {
    const n = Number(frac[1]) / Number(frac[2]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * When `parse-ingredient` doesn't recognise the leading word as a unit it
 * leaves it at the head of the description with no `unitOfMeasure` — a British
 * spelling ("litre"/"litres"/"grammes") or the primary unit of a glued
 * dual-unit line ("650g/1.3lb" → description "g/1.3lb"). Lift it out when it is
 * a real cooking unit; return null otherwise so a food word ("vegetable",
 * "zest") is left untouched.
 */
function liftLeakedUnit(desc: string): { unit: string; unitId: string; rest: string } | null {
  // The lookahead stops at end / space / slash / open-paren / punctuation so the
  // whole word is captured ("litres", not "lit"), the delimiter is not consumed,
  // and a "500 grammes, diced" comma terminator doesn't hide the unit.
  const m = /^\s*([A-Za-z]+)(?=$|[\s/(,.;:])/.exec(desc);
  if (!m) return null;
  const unit = m[1];
  const unitId = canonicalUnit(unit);
  if (!unitId || classifyUnit(unit) == null) return null;
  // Drop the separator punctuation and a connective "of" the unit governed, so
  // "1 litre of water" → "water" and "500 grammes, diced" → "diced".
  const rest = desc.slice(m[0].length).replace(/^[\s,;:.]+/, '').replace(/^of\s+/i, '');
  return { unit, unitId, rest };
}

/**
 * Strip a leading "/ <number> <unit>" dual-unit alternate — after
 * `parse-ingredient` consumes "650g" the description is "/ 1.3lb beef". Only a
 * leading slash counts (an interior alternate-food slash like
 * "chicken/vegetable stock" never starts the description), and the alternate's
 * unit must be a recognised cooking unit, so "/ 2 onions" is left alone. The
 * number and unit are matched in two stages, then only the validated unit's own
 * length is removed, so the following food word is never swallowed.
 */
function stripLeadingSlashAlternate(desc: string): string {
  const num = /^\s*\/\s*(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?\s*/.exec(
    desc,
  );
  if (!num) return desc;
  const after = desc.slice(num[0].length);
  const um = /^([A-Za-z][A-Za-z.]*)(?:\s+([A-Za-z][A-Za-z.]*))?/.exec(after);
  if (!um) return desc;
  // Prefer a two-word unit ("fl oz"); else accept the one-word unit; else the
  // alternate isn't a measurement (e.g. "/ 2 onions") so leave the line intact.
  const two = um[2] ? `${um[1]} ${um[2]}` : null;
  if (two && classifyUnit(two) != null) return after.slice(um[0].length).trim();
  if (classifyUnit(um[1]) != null) return after.slice(um[1].length).trim();
  return desc;
}

/**
 * A leading "(<measure>)" is either a redundant alternate ("1 cup (240ml)
 * milk") or the only stated weight ("1 (400g) can tomatoes"). Recognise it only
 * when the parenthetical is purely a number + recognised unit and food follows;
 * report the measure so the caller can drop the paren from the item and, when
 * the line has no real unit of its own, adopt it. A non-measure leading paren
 * ("(scant)", "(2 sticks)", "(large)") returns null and is left in place.
 */
function stripLeadingParenMeasurement(
  desc: string,
): { rest: string; quantity: number | null; unit: string; unitId: string } | null {
  const m = /^\s*\(([^)]*)\)\s*([\s\S]*)$/.exec(desc);
  if (!m) return null;
  const rest = m[2].trim();
  if (!rest) return null; // no food after the paren → keep it (degenerate input)
  const inner = m[1].trim().replace(/^(?:about|approx\.?|approximately|around|~)\s+/i, '');
  const meas = /^(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)\s*([A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*)*)$/.exec(
    inner,
  );
  if (!meas) return null;
  // The unit phrase must be a recognised unit AS A WHOLE ("ml", "fl oz") — never
  // peel a leading word, or "(2 cups flour)" would read as "2 cups" + lost food.
  const unitId = canonicalUnit(meas[2]);
  if (!unitId || classifyUnit(meas[2]) == null) return null;
  return { rest, quantity: parseNum(meas[1]), unit: meas[2], unitId };
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

  // Normalise the description before splitting food from note. Order matters: a
  // leaked unit is lifted first, so a glued dual-unit line ("g/1.3lb shrimp")
  // exposes its "/" for the slash-strip that follows.
  let desc = parsed.description;
  let recoveredUnit: string | null = null;
  let recoveredUnitId: string | null = null;
  if (!parsed.unitOfMeasure) {
    const lifted = liftLeakedUnit(desc);
    if (lifted) {
      recoveredUnit = lifted.unit;
      recoveredUnitId = lifted.unitId;
      desc = lifted.rest;
    }
  }
  desc = stripLeadingSlashAlternate(desc.trim());
  const measure = stripLeadingParenMeasurement(desc);
  if (measure) desc = measure.rest;

  // Split the cleaned description into food + note. A food-less line ("250g /
  // 9oz") yields an empty item, left for the reviewer rather than re-leaking the
  // stripped alternate.
  const { item, note } = splitDescription(desc);

  let unit = parsed.unitOfMeasure ?? recoveredUnit ?? null;
  let unitId =
    parsed.unitOfMeasureID ?? recoveredUnitId ?? canonicalUnit(parsed.unitOfMeasure ?? recoveredUnit);
  // An unquantified unit means one of it ("Pinch white pepper", "dash salt") —
  // default the null quantity to 1 so it still carries a metric amount.
  let quantity = parsed.quantity ?? (parsed.unitOfMeasure || recoveredUnit ? 1 : null);
  let quantity2 = parsed.quantity2;

  // "1 (400g) can tomatoes" / "2 (400g) cans": a leading count with no real unit
  // ("can" is not a cooking unit) — adopt the parenthetical weight, scaled by the
  // count so the metric reflects every container; the container word stays in the
  // item for the reviewer. Skip when the line already has a real unit
  // ("1 cup (240ml) milk") or the parenthetical weight didn't parse.
  if (measure && measure.quantity != null && classifyUnit(unit) == null) {
    const count = parsed.quantity ?? 1;
    quantity = count * measure.quantity;
    quantity2 = parsed.quantity2 != null ? parsed.quantity2 * measure.quantity : null;
    unit = measure.unit;
    unitId = measure.unitId;
  }

  const line: ParsedLine = {
    raw,
    quantity,
    quantity2,
    unit,
    unitId,
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
