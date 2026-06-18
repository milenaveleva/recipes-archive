/**
 * Approximate ingredient densities (g/ml) for volume→weight conversion.
 *
 * When a recipe measures an ingredient by volume ("1 cup flour") and we have
 * no USDA portion weight yet, we estimate grams from millilitres × density.
 * These are coarse pantry-staple approximations for a pre-match estimate; the
 * authoring flow refines weight from the matched food's USDA `foodPortions`,
 * and the chosen grams are always editable. Values are surfaced as estimates.
 */

/**
 * Densities in grams per millilitre. Single-word keys match the food's head
 * noun (its last word), so "rice vinegar" or "salt-free seasoning" do NOT pick
 * up the "rice"/"salt" density. Multi-word keys match as a whole-word phrase,
 * and the longest matching key wins ("brown sugar" over "sugar").
 */
export const DENSITY_G_PER_ML: Record<string, number> = {
  water: 1.0,
  milk: 1.03,
  buttermilk: 1.03,
  cream: 1.0,
  yogurt: 1.03,
  yoghurt: 1.03,
  'olive oil': 0.91,
  'vegetable oil': 0.92,
  'coconut oil': 0.92,
  oil: 0.92,
  butter: 0.911,
  honey: 1.42,
  'maple syrup': 1.37,
  syrup: 1.37,
  'all-purpose flour': 0.53,
  'almond flour': 0.4,
  'whole wheat flour': 0.51,
  flour: 0.53,
  'brown sugar': 0.93,
  'powdered sugar': 0.56,
  'icing sugar': 0.56,
  'granulated sugar': 0.85,
  sugar: 0.85,
  salt: 1.22,
  rice: 0.85,
  'rolled oats': 0.38,
  oats: 0.38,
  'cocoa powder': 0.51,
  cocoa: 0.51,
  'chia seeds': 0.81,
};

interface DensityEntry {
  key: string;
  density: number;
  /** Precompiled whole-word matcher for multi-word keys. */
  re?: RegExp;
}

// Build the lookup table once: multi-word keys get a precompiled regex; single-
// word keys match the head noun by equality (no regex needed).
const ENTRIES: DensityEntry[] = Object.entries(DENSITY_G_PER_ML).map(
  ([key, density]) => {
    const multiWord = /\s/.test(key);
    return multiWord
      ? { key, density, re: new RegExp(`(^|[^a-z])${escapeRegExp(key)}([^a-z]|$)`) }
      : { key, density };
  },
);

/**
 * Look up a density for a food by name. A single-word key must equal the food's
 * head noun (last alphabetic word); a multi-word key must appear as a whole
 * phrase. The longest matching key wins, so "extra virgin olive oil" resolves
 * to "olive oil" and "packed brown sugar" to "brown sugar". Returns null when
 * nothing matches.
 */
export function densityFor(item: string): number | null {
  const name = item.toLowerCase();
  const words = name.split(/[^a-z]+/).filter(Boolean);
  const head = words[words.length - 1] ?? '';
  let best: DensityEntry | null = null;
  for (const entry of ENTRIES) {
    const match = entry.re ? entry.re.test(name) : head === entry.key;
    if (match && (!best || entry.key.length > best.key.length)) best = entry;
  }
  return best?.density ?? null;
}

/**
 * Convert a volume (in millilitres) of a named ingredient to grams via the
 * density table; null when the ingredient's density is unknown.
 */
export function volumeToGrams(milliliters: number, item: string): number | null {
  if (!Number.isFinite(milliliters)) return null;
  const density = densityFor(item);
  return density == null ? null : milliliters * density;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
