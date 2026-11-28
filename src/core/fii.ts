/**
 * Inflammatory-potential score of a dish or a single food, computed from its pooled, cooked
 * composition. This is our own composition-derived index: it is not the licensed Dietary
 * Inflammatory Index (never labelled "DII"), and it is distinct from Wang 2025's published
 * Food Inflammation Index (per 100 g, 39 DII-derived components, 1–100 scale). The module
 * name `fii` is internal shorthand. Every figure is an estimate.
 *
 * Method (parameters in src/data/fii-parameters.json, reference in inflammation-reference.json):
 *
 * 1. Each ingredient contributes its cooked per-100 g composition × grams. Three inputs are
 *    derived per ingredient before pooling, because they depend on what the food is, not only
 *    on its columns (src/data/fii-food-classes.json):
 *      - free sugar = total sugar × the food's WHO free-sugar fraction (Louie 2015 /
 *        Wanselius 2019 decision tree: whole, dried and cooked fruit 0, honey/syrups/juice 1),
 *        re-classified by the ingredient's `prep` (blended fruit/veg → the purée fraction,
 *        juiced → the juiced fraction);
 *      - chain-length-weighted saturated fat = long-chain SFA + mediumChainSfaFactor × the
 *        4:0–12:0 fatty acids;
 *      - industrial trans fat = trans fat unless the food's trans is natural (ruminant).
 * 2. The dish is scored as ONE composition: each parameter's density per 100 kcal is the
 *    pooled amount over the pooled energy (the E-DII aggregates a whole diet this way; Food
 *    Compass a mixed food). Pooling lets fibre in one ingredient count against sugar in
 *    another, which averaging per-food scores cannot. A single food is the one-item case, so
 *    food and dish scores share one code path. Missing data: a protective (`corpus`) or limit
 *    parameter is read over the ingredients that report it (their energy as denominator) and
 *    scored only when they supply ≥ `minCoverage` of the dish's energy; a `carrier` signal
 *    (EPA + DHA, carotenoids, polyphenol subclasses) counts only where measured, over the
 *    dish's whole energy, so an unmeasured food never inflates it.
 * 3. Each density is standardised by its parameter type (corpus robust z; carrier median
 *    units; multiples of the WHO limit density), clamped, and combined as a direction-weighted
 *    mean, then restandardised against the USDA per-food corpus onto −2 (most anti) … +2 (most
 *    pro), with the full range available only at a quorum of scored parameters.
 * 4. Composition-blind food-matrix corrections (dairy, soy) are added by energy share.
 *
 * The recipe aggregate (inflammation.ts) adds the capped aromatic term and bands the score.
 */
import type { NutrientVector } from './types';
import { round, clamp } from './num';
import { energyKcalOf } from './nutrition';
import paramsData from '../data/fii-parameters.json';
import referenceData from '../data/inflammation-reference.json';
import classesData from '../data/fii-food-classes.json';

/** How an ingredient's structure is broken down before eating (re-classifies its sugars). */
export type Prep = 'blended' | 'juiced';
export const PREPS: readonly Prep[] = ['blended', 'juiced'];

type Scale = 'corpus' | 'carrier' | { limit: number };
interface FiiParam {
  key: string;
  dir: 1 | -1;
  weight: number;
  scale: Scale;
  /** Source field → weight within the parameter (a carrier's evidence grade per component). */
  fields: Record<string, number>;
  /** Carrier components read in a fixed intake unit instead of the carrier median. */
  units?: Record<string, number>;
  /** DII overall effect score (Shivappa 2014), read only by the sensitivity analysis. */
  dii?: number;
  /** Corpus parameters: global mean daily intake (Shivappa 2014), the protective-nutrient zero point. */
  dietMean?: number;
}
interface MatrixDelta {
  delta: number;
}
export interface FiiParameters {
  version: string;
  minKcalPer100g: number;
  clampZ: number;
  bonusMinZ: number;
  quorum: number;
  minCoverage: number;
  mediumChainSfaFactor: number;
  pureeFreeSugarFraction: number;
  juicedFreeSugarFraction: number;
  matrixDeltas: Record<string, MatrixDelta>;
  ageAdjustment: { max: number; saturation: number; index: Record<string, Record<string, number>> };
  upfAdjustment: { max: number; from: number; to: number };
  bands: { antiMax: number; mildlyAntiMax: number; neutralMax: number; mildlyProMax: number };
  dietEnergyKcal: number;
  parameters: FiiParam[];
}
/** The standardisation referent (inflammation-reference.json; built by build-inflammation-reference.mjs). */
export interface FiiReference {
  /** Corpus parameters: robust centre/scale of the per-100-kcal density. */
  corpus: Record<string, { center: number; scale: number }>;
  /** Carrier components: median per-100-kcal density among the foods that carry them. */
  carrier: Record<string, { median: number }>;
  /** Corpus centre/scale of the raw (pre-standardisation) score. */
  fiiRaw: { center: number; scale: number };
}
interface FoodClass {
  age?: string;
  ageCooked?: string;
  fs?: number;
  trans?: 'industrial' | 'natural';
  fv?: boolean;
  matrix?: string;
}

export const PARAMS = paramsData as unknown as FiiParameters;
const CLASSES = (classesData as unknown as { foods: Record<string, FoodClass> }).foods;
/** Free-sugar fraction for a sugar-bearing food the classifier has not seen (Louie step 10). */
const UNCLASSIFIED_FREE_SUGAR_FRACTION = 0.5;

/** Energy floor (kcal/100 g) of the per-100-kcal conversion, shared with the recipe weight floor. */
export const MIN_KCAL_PER_100G: number = PARAMS.minKcalPer100g;
/** Below this energy density (kcal/100 g) a food with little sodium and no measured bioactive is neutral. */
export const NEUTRAL_MAX_KCAL_PER_100G = 5;
/** Sodium (mg/100 g) at or above which an energy-free food (salt, brine) is still scored. */
export const NEUTRAL_MAX_SODIUM_MG_PER_100G = 200;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Check a referent covers every parameter the table names. Thrown at load for the bundled
 * referent (a stale regen would standardise against the wrong distribution).
 */
export function checkReference(ref: FiiReference, params: FiiParameters = PARAMS): string[] {
  const missing: string[] = [];
  for (const p of params.parameters) {
    if (p.scale === 'corpus' && !ref.corpus?.[p.key]) missing.push(p.key);
    if (p.scale === 'carrier') for (const f of Object.keys(p.fields)) if (!ref.carrier?.[f]) missing.push(`${p.key}.${f}`);
  }
  if (!ref.fiiRaw || !(ref.fiiRaw.scale > 0)) missing.push('fiiRaw');
  return missing;
}
const BUNDLED = referenceData as unknown as FiiReference & { version?: string };
let checked = false;
/**
 * The bundled referent, validated on first use: a stale regen would standardise against
 * the wrong distribution, so it fails loudly. (Lazy, so the reference builder can import
 * this module before the referent it is about to write exists.)
 */
export function bundledReference(): FiiReference {
  if (!checked) {
    const missing = checkReference(BUNDLED);
    const bandsStale = JSON.stringify((BUNDLED as { bands?: unknown }).bands) !== JSON.stringify(PARAMS.bands);
    if (bandsStale) missing.push('bands (differ from fii-parameters.json)');
    if (missing.length > 0 || BUNDLED.version !== PARAMS.version) {
      throw new Error(
        `inflammation-reference.json is stale (${missing.length ? `missing ${missing.join(', ')}` : `version ${BUNDLED.version} ≠ ${PARAMS.version}`}) — run \`node scripts/build-inflammation-reference.mjs\``,
      );
    }
    checked = true;
  }
  return BUNDLED;
}

/** The food class record (free-sugar fraction, trans origin, fruit/veg flag, matrix) for an fdcId. */
export function foodClassOf(fdcId: number | null | undefined): FoodClass | undefined {
  return fdcId == null ? undefined : CLASSES[String(fdcId)];
}

/** One ingredient (or food) as the score reads it. */
export interface FiiItem {
  /** Cooked, as-eaten mass (g). */
  grams: number;
  /** Cooked composition per 100 g of that mass. */
  nutrients: NutrientVector | null | undefined;
  fdcId?: number | null;
  prep?: Prep | null;
  /** Cooking method (cooking.ts), read by the dietary-AGE adjustment. */
  cooking?: string | null;
  /** NOVA group (raised by the line's processing markers), read by the ultra-processing adjustment. */
  nova?: number | null;
}

/** The WHO free-sugar fraction of an ingredient's sugars, after its `prep`. */
export function freeSugarFraction(fdcId: number | null | undefined, prep?: Prep | null, params: FiiParameters = PARAMS): number {
  const c = foodClassOf(fdcId);
  const base = c ? (c.fs ?? 0) : UNCLASSIFIED_FREE_SUGAR_FRACTION;
  if (c?.fv && prep === 'juiced') return Math.max(base, params.juicedFreeSugarFraction);
  if (c?.fv && prep === 'blended') return Math.max(base, params.pureeFreeSugarFraction);
  return base;
}

/**
 * Per-100 g value of a source field for one ingredient, derived where the field is not a
 * column; undefined when the food lacks the datum (unknown, never zero).
 */
function fieldValue(n: NutrientVector, field: string, item: FiiItem, params: FiiParameters): number | undefined {
  const v = n as Record<string, number | undefined>;
  switch (field) {
    case 'freeSugar_g':
      return fin(n.sugar_g) ? n.sugar_g * freeSugarFraction(item.fdcId, item.prep, params) : undefined;
    case 'sfaWeighted_g': {
      if (!fin(n.satFat_g)) return undefined;
      // The medium-chain (4:0–12:0) part, where reported; an unreported chain counts as long.
      const mc = ['fa4_0_g', 'fa6_0_g', 'fa8_0_g', 'fa10_0_g', 'fa12_0_g'].reduce((s, k) => s + (fin(v[k]) ? (v[k] as number) : 0), 0);
      const medium = Math.min(mc, n.satFat_g);
      return n.satFat_g - medium + params.mediumChainSfaFactor * medium;
    }
    case 'transIndustrial_g':
      if (!fin(n.transFat_g)) return undefined;
      return foodClassOf(item.fdcId)?.trans === 'natural' ? 0 : n.transFat_g;
    default:
      return fin(v[field]) ? v[field] : undefined;
  }
}

/** True when an ingredient carries no inflammatory signal and is left out of the pool (water). */
function isNeutral(n: NutrientVector, kcalPer100: number): boolean {
  if (kcalPer100 >= NEUTRAL_MAX_KCAL_PER_100G) return false;
  if ((n.sodium_mg ?? 0) >= NEUTRAL_MAX_SODIUM_MG_PER_100G) return false;
  // Brewed tea or coffee: energy-free but polyphenol-bearing, so it stays in the dish.
  for (const p of PARAMS.parameters) {
    if (p.scale !== 'carrier') continue;
    for (const f of Object.keys(p.fields)) if (((n as Record<string, number | undefined>)[f] ?? 0) > 0) return false;
  }
  return true;
}

/** One parameter's pooled density and standardised value for a dish. */
export interface ParamDensity {
  key: string;
  /** Pooled density per 100 kcal (a carrier: per component, in `components`). */
  density?: number;
  components?: Record<string, number>;
  /** Share of the dish's energy that reported this parameter (carriers: 1 when any did). */
  coverage: number;
  /** Whether any ingredient reported it. */
  present: boolean;
}

/**
 * Pool a set of ingredients into per-parameter densities per 100 kcal, without standardising
 * (the reference builder reads these to build the referent). null when nothing scorable
 * carries energy.
 */
export function pooledDensities(items: FiiItem[], params: FiiParameters = PARAMS): { densities: ParamDensity[]; energyKcal: number } | null {
  let energy = 0;
  let grams = 0;
  const scored: { item: FiiItem; n: NutrientVector; kcal: number }[] = [];
  for (const it of items) {
    if (!it || !(it.grams > 0) || !it.nutrients) continue;
    const k100 = energyKcalOf(it.nutrients);
    if (k100 == null || k100 < 0) continue;
    if (isNeutral(it.nutrients, k100)) continue;
    const kcal = (k100 * it.grams) / 100;
    scored.push({ item: it, n: it.nutrients, kcal });
    energy += kcal;
    grams += it.grams;
  }
  if (scored.length === 0) return null;
  // The dish's effective energy: its own, floored at the per-gram floor over its mass, so a
  // near-energy-free dish (tea, broth, a salt solution) can't divide by ~0.
  const floor = (params.minKcalPer100g / 100);
  const effEnergy = Math.max(energy, floor * grams);
  if (!(effEnergy > 0)) return null;
  const densities: ParamDensity[] = [];
  for (const p of params.parameters) {
    if (p.scale === 'carrier') {
      const components: Record<string, number> = {};
      let present = false;
      for (const f of Object.keys(p.fields)) {
        let sum = 0;
        for (const s of scored) {
          const v = fieldValue(s.n, f, s.item, params);
          if (v === undefined) continue;
          present = true;
          sum += (v * s.item.grams) / 100;
        }
        components[f] = (sum * 100) / effEnergy;
      }
      densities.push({ key: p.key, components, coverage: present ? 1 : 0, present });
      continue;
    }
    // Corpus and limit parameters: one field, read over the ingredients that report it.
    const field = Object.keys(p.fields)[0];
    let sum = 0;
    let repEnergy = 0;
    let repGrams = 0;
    for (const s of scored) {
      const v = fieldValue(s.n, field, s.item, params);
      if (v === undefined) continue;
      sum += (v * s.item.grams) / 100;
      repEnergy += s.kcal;
      repGrams += s.item.grams;
    }
    const coverage = energy > 0 ? repEnergy / energy : repGrams / grams;
    const present = repGrams > 0;
    const denom = Math.max(repEnergy, floor * repGrams);
    densities.push({ key: p.key, density: present && denom > 0 ? (sum * 100) / denom : undefined, coverage, present });
  }
  return { densities, energyKcal: energy };
}

/** One parameter's contribution to a score: its standardised value and signed weight. */
export interface ParamContribution {
  key: string;
  z: number;
  /** dir × weight × z — the parameter's push on the raw score (+ = pro). */
  push: number;
  weight: number;
}

export interface CompositionScore {
  /** Score on the −2 (anti) … +2 (pro) axis, before matrix corrections. */
  composition: number;
  /** Energy-weighted matrix correction (score units), added after standardisation. */
  matrixDelta: number;
  /** composition + matrixDelta, rounded to 0.1 and clamped to ±2. */
  tag: number;
  /** Raw weighted mean before restandardisation. */
  raw: number;
  /** Parameters that entered the weighted mean. */
  contributions: ParamContribution[];
  /** Share of the parameter table the dish reported (0..1). */
  coverage: number;
}

/** Standardised value of one pooled parameter, or undefined when it can't be scored. */
function standardise(p: FiiParam, d: ParamDensity, ref: FiiReference, params: FiiParameters): number | undefined {
  const c = params.clampZ;
  if (p.scale === 'carrier') {
    if (!d.present || !d.components) return undefined;
    let z = 0;
    for (const [f, w] of Object.entries(p.fields)) {
      const m = ref.carrier[f]?.median;
      if (m && m > 0) z += (w * (d.components[f] ?? 0)) / m;
    }
    return clamp(z, 0, c);
  }
  if (d.density === undefined || d.coverage < params.minCoverage) return undefined;
  if (p.scale === 'corpus') {
    const r = ref.corpus[p.key];
    return r ? clamp((d.density - r.center) / r.scale, -c, c) : undefined;
  }
  return clamp(d.density / p.scale.limit, 0, c);
}

/**
 * The raw weighted mean of the standardised parameters (+ = pro), with each scored
 * parameter's contribution; null when no parameter can be scored.
 */
export function rawScore(
  pooled: { densities: ParamDensity[] },
  ref: FiiReference,
  params: FiiParameters = PARAMS,
): { raw: number; contributions: ParamContribution[]; present: number } | null {
  let sum = 0;
  let wsum = 0;
  let present = 0;
  const contributions: ParamContribution[] = [];
  for (const p of params.parameters) {
    const d = pooled.densities.find((x) => x.key === p.key);
    if (!d) continue;
    const z = standardise(p, d, ref, params);
    if (z === undefined) continue;
    present += 1;
    // A one-sided signal (a carrier credit or a limit penalty) enters the mean only where the
    // food carries it meaningfully: its absence is the baseline, and counting a zero would
    // dilute every signal the food does carry (pure sugar's free-sugar penalty by its zero
    // saturated fat, a berry's anthocyanins by its zero EPA + DHA).
    if (p.scale !== 'corpus' && z < params.bonusMinZ) continue;
    sum += p.dir * p.weight * z;
    wsum += p.weight;
    contributions.push({ key: p.key, z, push: p.dir * p.weight * z, weight: p.weight });
  }
  return wsum > 0 ? { raw: sum / wsum, contributions, present } : null;
}

/** Energy-share-weighted matrix correction of a set of ingredients (score units). */
function matrixDeltaOf(items: FiiItem[], params: FiiParameters): number {
  let weighted = 0;
  let total = 0;
  for (const it of items) {
    if (!it || !(it.grams > 0) || !it.nutrients) continue;
    const k100 = energyKcalOf(it.nutrients);
    if (k100 == null || k100 < 0 || isNeutral(it.nutrients, k100)) continue;
    const kcal = (k100 * it.grams) / 100;
    const cls = foodClassOf(it.fdcId)?.matrix;
    const d = cls ? params.matrixDeltas[cls]?.delta ?? 0 : 0;
    weighted += d * kcal;
    total += kcal;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Score a dish (or one food) from its ingredients' cooked compositions: the pooled
 * per-100-kcal profile, standardised, combined and restandardised onto −2…+2, plus the
 * matrix correction. null when nothing scorable carries energy or no parameter can be scored.
 */
export function scoreComposition(
  items: FiiItem[],
  ref: FiiReference = bundledReference(),
  params: FiiParameters = PARAMS,
): CompositionScore | null {
  const pooled = pooledDensities(items, params);
  if (!pooled) return null;
  const r = rawScore(pooled, ref, params);
  if (!r) return null;
  const std = (r.raw - ref.fiiRaw.center) / ref.fiiRaw.scale;
  if (!Number.isFinite(std)) return null;
  // A data-poor profile can't pin to an extreme it hasn't earned: ±2 only at the quorum.
  const bound = 2 * Math.min(1, r.contributions.length / params.quorum);
  const composition = clamp(std, -bound, bound);
  const matrixDelta = matrixDeltaOf(items, params);
  return {
    composition,
    matrixDelta,
    tag: clamp(round(composition + matrixDelta, 1), -2, 2),
    raw: r.raw,
    contributions: r.contributions,
    coverage: r.present / params.parameters.length,
  };
}

export interface FoodFII {
  /** Per-food inflammatory potential on the −2 (anti) … +2 (pro) axis, matrix-corrected. */
  tag: number;
  /** Share of the parameter table the food reported (0..1). */
  coverage: number;
}

/** A single food's score (100 g of it, as one-item dish), or null when it can't be scored. */
export function foodFII(n: NutrientVector | null | undefined, fdcId?: number | null, prep?: Prep | null): FoodFII | null {
  const s = scoreComposition([{ grams: 100, nutrients: n, fdcId, prep }]);
  return s ? { tag: s.tag, coverage: s.coverage } : null;
}

/** An ingredient's absolute energy (kcal) in the dish, or 0 when unknown. */
function energyOf(it: FiiItem): number {
  if (!it || !(it.grams > 0) || !it.nutrients) return 0;
  const k = energyKcalOf(it.nutrients);
  return k != null && k > 0 ? (k * it.grams) / 100 : 0;
}

const METHOD_ORDER = ['raw', 'blanched', 'boiled', 'steamed', 'microwaved', 'baked', 'grilled', 'fried'];

/**
 * Dietary-AGE adjustment (score units, ≥ 0): the energy-share-weighted AGE index of the
 * ingredients' food class × cooking method (the method floored at the dry heat the food record
 * already carries), saturating at `saturation` and capped at `max` (fii-parameters.json).
 */
export function ageAdjustment(items: FiiItem[], params: FiiParameters = PARAMS): number {
  const a = params.ageAdjustment;
  let total = 0;
  let load = 0;
  for (const it of items) {
    const e = energyOf(it);
    if (e <= 0) continue;
    total += e;
    const c = foodClassOf(it.fdcId);
    if (!c?.age) continue;
    const own = it.cooking ?? 'raw';
    const method = c.ageCooked && METHOD_ORDER.indexOf(c.ageCooked) > METHOD_ORDER.indexOf(own) ? c.ageCooked : own;
    load += e * (a.index[c.age]?.[method] ?? 0);
  }
  if (!(total > 0)) return 0;
  return a.max * Math.min(1, load / total / a.saturation);
}

/**
 * Ultra-processing adjustment (score units, ≥ 0): rises linearly with the dish's NOVA 4 energy
 * share from `from` to `to`, capped at `max` (fii-parameters.json).
 */
export function upfAdjustment(items: FiiItem[], params: FiiParameters = PARAMS): number {
  const u = params.upfAdjustment;
  let total = 0;
  let upf = 0;
  for (const it of items) {
    const e = energyOf(it);
    if (e <= 0) continue;
    total += e;
    if (it.nova === 4) upf += e;
  }
  if (!(total > 0)) return 0;
  return u.max * clamp((upf / total - u.from) / (u.to - u.from), 0, 1);
}
