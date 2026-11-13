/**
 * Shared Food Inflammation Index arithmetic for the build scripts — the reference
 * builder (build-inflammation-reference.mjs) and the recipe rescorer (score-recipes-
 * inflammation.mjs). Operates on USDA `food` records ({ fdcId, n }) plus the polyphenol
 * side table. This MIRRORS the canonical engine src/core/fii.ts (which operates on a
 * merged NutrientVector); src/core/fii.test.ts pins the engine to the committed data so
 * the two cannot silently drift.
 */
import { readFileSync } from 'node:fs';

const PARAMS_FILE = JSON.parse(readFileSync(new URL('../../src/data/fii-parameters.json', import.meta.url), 'utf8'));
/** Energy floor (kcal/100 g) of the per-100-kcal conversion (mirror of src/core/fii.ts MIN_KCAL_PER_100G). */
export const MIN_KCAL_PER_100G = PARAMS_FILE.minKcalPer100g;

/** Per-100g value of one parameter for a food, or undefined when the food lacks it. */
function per100gOf(food, key, polyphenols) {
  if (key === 'polyphenol_mg') {
    const p = polyphenols?.[String(food.fdcId)];
    return p && Number.isFinite(p.polyphenol_mg) ? p.polyphenol_mg : undefined;
  }
  const n = food.n ?? {};
  if (key === 'fatQuality_g') {
    // Require a known unsaturated fraction (mirror of src/core/fii.ts): a food with
    // only a saturated figure is unknown quality, not maximally saturated.
    if (!Number.isFinite(n.monoFat_g) && !Number.isFinite(n.polyFat_g)) return undefined;
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

/**
 * Per-100-kcal value of one parameter (mirror of src/core/fii.ts valueOf): the per-100g
 * value × 100 / max(kcal per 100 g, MIN_KCAL_PER_100G). Undefined when the datum or the
 * food's energy is unknown.
 */
export function valueOf(food, key, polyphenols) {
  const kcal = energyKcalOf(food.n);
  if (kcal == null || kcal < 0) return undefined;
  const v = per100gOf(food, key, polyphenols);
  return v === undefined ? undefined : (v * 100) / Math.max(kcal, MIN_KCAL_PER_100G);
}

export const makeClamp = (clampZ) => (z) => (z < -clampZ ? -clampZ : z > clampZ ? clampZ : z);

/**
 * Raw FII (pre-standardisation): the weighted mean of clamped robust-z parameter
 * values, signed so + = pro-inflammatory. null when no parameter is present.
 * `paramStats` is the per-nutrient { center, scale } map.
 */
// Energy-free, sodium-free foods (water) are neutral — no tag (mirror of src/core/fii.ts).
const NEUTRAL_MAX_KCAL_PER_100G = 5;
const NEUTRAL_MAX_SODIUM_MG_PER_100G = 200;

export function rawFII(food, { parameters, paramStats, polyphenols, clampZ }) {
  const kcal = energyKcalOf(food.n);
  if (kcal != null && kcal < NEUTRAL_MAX_KCAL_PER_100G && !((food.n?.sodium_mg ?? 0) >= NEUTRAL_MAX_SODIUM_MG_PER_100G)) return null;
  let sum = 0;
  let wsum = 0;
  let present = 0;
  for (const p of parameters) {
    const v = valueOf(food, p.nutrient, polyphenols);
    if (v === undefined) continue;
    const r = paramStats[p.nutrient];
    if (!r) continue;
    // A one-sided anti parameter clamps to [0, clampZ] so a below-referent value
    // can't read pro (mirror of src/core/fii.ts).
    const z = (v - r.center) / r.scale;
    const lo = p.oneSided ? 0 : -clampZ;
    const zc = z < lo ? lo : z > clampZ ? clampZ : z;
    sum += p.dir * p.weight * zc;
    wsum += p.weight;
    present += 1;
  }
  return wsum > 0 ? { raw: sum / wsum, present, total: parameters.length } : null;
}

/** Coverage at/above which the full ±2 tag range is available (mirror of src/core/fii.ts). */
export const QUORUM_COVERAGE = 0.5;

/** Standardised per-food tag in −2 (anti) … +2 (pro), with parameter coverage. */
export function foodTag(food, ctx) {
  const r = rawFII(food, ctx);
  if (!r) return null;
  const std = (r.raw - ctx.fiiRaw.center) / ctx.fiiRaw.scale;
  if (!Number.isFinite(std)) return null;
  const coverage = r.present / r.total;
  // Shrink data-poor foods toward neutral: ±2 is reachable only at quorum coverage.
  const bound = 2 * Math.min(1, coverage / QUORUM_COVERAGE);
  const tag = Math.max(-bound, Math.min(bound, Math.round(std * 10) / 10));
  return { tag, coverage };
}

// ---- recipe-level aggregation — mirrors src/core/inflammation.ts + nutrition.ts ----

/** Per-gram weight floor of the recipe aggregate (mirror of src/core/inflammation.ts FLOOR_KCAL_PER_G). */
export const FLOOR_KCAL_PER_G = MIN_KCAL_PER_100G / 100;
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
 * Aromatic adjustment (mirrors src/core/aromatics.ts aromaticAdjustment): `items` are
 * { fdcId, grams } as written, `aromatics` is src/data/fii-aromatics.json. ≤ 0, rounded 0.01.
 */
export function aromaticAdjustment(items, servings, aromatics) {
  if (!(servings > 0)) return 0;
  const byFdc = new Map();
  for (const [key, a] of Object.entries(aromatics.aromatics)) {
    for (const [fdcId, f] of Object.entries(a.foods)) byFdc.set(Number(fdcId), { key, effect: a.effect, doseG: f.doseG });
  }
  const fraction = new Map();
  for (const it of items) {
    const a = it.fdcId != null ? byFdc.get(it.fdcId) : undefined;
    if (!a || !(it.grams > 0)) continue;
    const prev = fraction.get(a.key) ?? { effect: a.effect, f: 0 };
    prev.f += it.grams / servings / a.doseG;
    fraction.set(a.key, prev);
  }
  let delta = 0;
  for (const { effect, f } of fraction.values()) delta += effect * Math.min(1, f);
  const d = Math.max(aromatics.k * delta, -aromatics.maxTotal);
  return Math.round(d * 100) / 100 + 0;
}

/**
 * Energy-weighted mean of per-food tags plus the aromatic adjustment (mirrors
 * computeInflammation): each item { grams, energyKcal, tag } weighted by
 * max(energyKcal, FLOOR·grams). null when nothing weighs. `bands` are the corpus-quantile
 * band edges from inflammation-reference.json.
 */
export function aggregateInflammation(items, bands, aromatic = 0) {
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
  const adj = Number.isFinite(aromatic) && aromatic < 0 ? aromatic : 0;
  const r = Math.round((weighted / total + adj) * 10) / 10 + 0;
  const score = r < -2 ? -2 : r > 2 ? 2 : r;
  return { score, band: bandOf(score, bands), ...(adj < 0 ? { aromaticAdjustment: adj } : {}) };
}
