/**
 * Shared Food Inflammation Index arithmetic for the build scripts — the reference
 * builder (build-inflammation-reference.mjs) and the recipe rescorer (score-recipes-
 * inflammation.mjs). Operates on USDA `food` records ({ fdcId, n }) plus the polyphenol
 * side table. This MIRRORS the canonical engine src/core/fii.ts (which operates on a
 * merged NutrientVector); src/core/fii.test.ts pins the engine to the committed data so
 * the two cannot silently drift.
 */

/** Per-100g value of one parameter for a food, or undefined when the food lacks it. */
export function valueOf(food, key, polyphenols) {
  if (key === 'polyphenol_mg') {
    const p = polyphenols?.[String(food.fdcId)];
    return p && Number.isFinite(p.polyphenol_mg) ? p.polyphenol_mg : undefined;
  }
  const n = food.n ?? {};
  if (key === 'fatQuality_g') {
    const parts = ['monoFat_g', 'polyFat_g', 'satFat_g', 'transFat_g'];
    if (!parts.some((k) => Number.isFinite(n[k]))) return undefined;
    return (n.monoFat_g || 0) + (n.polyFat_g || 0) - (n.satFat_g || 0) - (n.transFat_g || 0);
  }
  if (key === 'freeSugar_g') {
    // Free-sugar estimate from the 1:2 fibre:free-sugar dual ratio (mirror of src/core/fii.ts).
    if (!Number.isFinite(n.sugar_g)) return undefined;
    const fibre = Number.isFinite(n.fiber_g) ? n.fiber_g : 0;
    return Math.max(0, n.sugar_g - 2 * fibre);
  }
  const v = n[key];
  return Number.isFinite(v) ? v : undefined;
}

export const makeClamp = (clampZ) => (z) => (z < -clampZ ? -clampZ : z > clampZ ? clampZ : z);

/**
 * Raw FII (pre-standardisation): the weighted mean of clamped robust-z parameter
 * values, signed so + = pro-inflammatory. null when no parameter is present.
 * `paramStats` is the per-nutrient { center, scale } map.
 */
export function rawFII(food, { parameters, paramStats, polyphenols, clampZ }) {
  const clamp = makeClamp(clampZ);
  let sum = 0;
  let wsum = 0;
  let present = 0;
  for (const p of parameters) {
    const v = valueOf(food, p.nutrient, polyphenols);
    if (v === undefined) continue;
    const r = paramStats[p.nutrient];
    if (!r) continue;
    sum += p.dir * p.weight * clamp((v - r.center) / r.scale);
    wsum += p.weight;
    present += 1;
  }
  return wsum > 0 ? { raw: sum / wsum, present, total: parameters.length } : null;
}

/** Standardised per-food tag in −2 (anti) … +2 (pro), with parameter coverage. */
export function foodTag(food, ctx) {
  const r = rawFII(food, ctx);
  if (!r) return null;
  const std = (r.raw - ctx.fiiRaw.center) / ctx.fiiRaw.scale;
  if (!Number.isFinite(std)) return null;
  return { tag: Math.max(-2, Math.min(2, Math.round(std * 10) / 10)), coverage: r.present / r.total };
}

// ---- recipe-level aggregation — mirrors src/core/inflammation.ts + nutrition.ts ----

export const FLOOR_KCAL_PER_G = 1; // mirror src/core/inflammation.ts FLOOR_KCAL_PER_G
const KJ_PER_KCAL = 4.184; // mirror src/core/nutrition.ts

/** Per-100g kcal for a food, deriving from energyKj when energyKcal is absent (mirrors energyKcalOf). */
export function energyKcalOf(n) {
  if (Number.isFinite(n?.energyKcal)) return n.energyKcal;
  if (Number.isFinite(n?.energyKj)) return n.energyKj / KJ_PER_KCAL;
  return null;
}

/** Additive food-form delta for a food (mirrors src/core/foodAdjust.ts foodFormAdjustment).
 *  `adjustments` is the src/data/food-adjustments.json map (fdcId → { delta }). */
export function foodFormDelta(fdcId, adjustments) {
  if (fdcId == null || !adjustments) return 0;
  const a = adjustments[String(fdcId)];
  return a && typeof a === 'object' && Number.isFinite(a.delta) ? a.delta : 0;
}

/** Apply the food-form delta to a per-food tag, re-clamped to ±2 (mirrors applyFoodForm). */
export function applyFoodForm(tag, fdcId, adjustments) {
  const d = foodFormDelta(fdcId, adjustments);
  if (!d) return tag;
  const t = Math.round((tag + d) * 10) / 10;
  return t < -2 ? -2 : t > 2 ? 2 : t;
}

/** Map a −2..+2 score to the five-band scale via corpus-quantile edges (mirrors
 *  inflammationBandOf). `bands` = { antiMax, mildlyAntiMax, neutralMax, mildlyProMax }. */
export function bandOf(score, bands) {
  return score <= bands.antiMax ? 'anti-inflammatory'
    : score <= bands.mildlyAntiMax ? 'mildly-anti-inflammatory'
    : score <= bands.neutralMax ? 'neutral'
    : score <= bands.mildlyProMax ? 'mildly-pro-inflammatory'
    : 'pro-inflammatory';
}

/**
 * Energy-weighted mean of per-food tags (mirrors computeInflammation): each item
 * { grams, energyKcal, tag } weighted by max(energyKcal, FLOOR·grams). null when nothing
 * weighs. `bands` are the corpus-quantile band edges from inflammation-reference.json.
 */
export function aggregateInflammation(items, bands) {
  let weighted = 0;
  let total = 0;
  for (const it of items) {
    if (!(it.grams > 0) || !Number.isFinite(it.tag)) continue;
    const kcal = Number.isFinite(it.energyKcal) ? it.energyKcal : 0;
    const weight = Math.max(kcal, FLOOR_KCAL_PER_G * it.grams);
    if (weight <= 0) continue;
    weighted += it.tag * weight;
    total += weight;
  }
  if (total <= 0) return null;
  const score = Math.round((weighted / total) * 10) / 10;
  return { score, band: bandOf(score, bands) };
}
