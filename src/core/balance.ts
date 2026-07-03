/**
 * Nutrient-balance score: the Nutrient-Rich Foods Index NRF9.3 (Drewnowski &
 * Fulgoni 2014; Fulgoni et al. 2009) mapped to an integer 1–10 for the score
 * medallion, where higher means more nutrient-dense per calorie.
 *
 * NRF9.3 = Σ %DV of 9 nutrients to encourage (protein, fibre, vitamins A, C, E,
 * calcium, iron, potassium, magnesium), each capped at 100% DV, minus Σ %MRV of
 * 3 nutrients to limit (saturated fat, sugar, sodium), computed PER 100 kcal —
 * the energy basis that best tracks overall diet quality against the Healthy
 * Eating Index (per-100-g performs worse). Reference amounts are the FDA 2016
 * Daily Values (21 CFR 101.9); the USDA data is already in µg RAE / mg, matching
 * those values natively.
 *
 * The published index limits *added* sugar. The bundled USDA generic dataset
 * carries no added-sugar datum, so the limit term uses TOTAL sugar instead — an
 * empirically near-equivalent substitution when added-sugar data is unavailable
 * (Corriveau et al. 2025), disclosed as an estimate and never presented as
 * added-sugar precision.
 *
 * The raw NRF value is kept for provenance; the 1–10 score bins it by
 * breakpoints anchored to the per-100-kcal distribution of the bundled food
 * dataset, so 5 ≈ a median food and 10 ≈ top-tier nutrient density. An estimate
 * for comparison only — never a clinical figure, and not labelled "DII".
 */
import { round } from './num';

export type BalanceBand = 'poor' | 'low' | 'moderate' | 'high' | 'excellent';

/**
 * Per-100g aggregate nutrient concentrations of the finished dish plus its
 * energy density (kcal/100g), the basis the NRF9.3 per-100-kcal figure is
 * derived from. The caller (score.ts) supplies encouraged nutrients over the
 * full dish mass (a nutrient no food carries arrives as 0, biasing the score
 * down, never up) and the nutrients-to-limit over their seen mass (a food that
 * omits one imputes the typical amount, so missing data can't inflate the score).
 */
export interface BalanceInput {
  energyKcalPer100g: number;
  protein_g: number;
  fiber_g: number;
  vitA_ug: number;
  vitC_mg: number;
  vitE_mg: number;
  calcium_mg: number;
  iron_mg: number;
  potassium_mg: number;
  magnesium_mg: number;
  satFat_g: number;
  /** Total sugar (the added-sugar substitute — see module note). */
  sugar_g: number;
  sodium_mg: number;
}

export interface BalanceResult {
  /** Integer 1–10; higher is more nutrient-dense per calorie. */
  score: number;
  band: BalanceBand;
  /** NRF9.3 per 100 kcal (rounded for display), retained for provenance. */
  nrf: number;
  version: 'NRF9.3';
}

/** FDA 2016 Daily Values (21 CFR 101.9) for the 9 nutrients to encourage. */
const DV = {
  protein_g: 50,
  fiber_g: 28,
  vitA_ug: 900,
  vitC_mg: 90,
  vitE_mg: 15,
  calcium_mg: 1300,
  iron_mg: 18,
  potassium_mg: 4700,
  magnesium_mg: 420,
} as const satisfies Partial<Record<keyof BalanceInput, number>>;
const QUALIFYING_KEYS = Object.keys(DV) as (keyof typeof DV)[];

/** Maximum recommended values for the 3 nutrients to limit. */
const MRV = {
  satFat_g: 20,
  sugar_g: 50,
  sodium_mg: 2300,
} as const satisfies Partial<Record<keyof BalanceInput, number>>;
const LIMITING_KEYS = Object.keys(MRV) as (keyof typeof MRV)[];

/**
 * Raw-NRF breakpoints for the integer score, anchored to the shipped food
 * dataset's per-100-kcal percentile distribution (p50 ≈ 46 → 5, p90 ≈ 198 → 8,
 * p95 ≈ 290 → 9; regenerate with scripts/build-nrf-anchors.mjs). A net-negative
 * balance (limits outweigh the encouraged nutrients, ≈ 11% of foods) maps to 1;
 * only the top few % of nutrient density reaches 10.
 */
const SCORE_BREAKPOINTS = [0, 10, 22, 36, 56, 90, 140, 210, 340];

/** Integer 1–10 from a raw NRF value: 1 + how many breakpoints it reaches. */
export function balanceScoreOf(nrf: number): number {
  if (!Number.isFinite(nrf)) return 1;
  let score = 1;
  for (const b of SCORE_BREAKPOINTS) if (nrf >= b) score++;
  return score; // bounded 1..10 by the breakpoint count
}

/** 1–10 score → band word: 1–2 poor, 3–4 low, 5–6 moderate, 7–8 high, 9–10 excellent. */
export function balanceBandOf(score: number): BalanceBand {
  if (score >= 9) return 'excellent';
  if (score >= 7) return 'high';
  if (score >= 5) return 'moderate';
  if (score >= 3) return 'low';
  return 'poor';
}

/**
 * The NRF9.3 nutrient-balance score for a dish, or null when there is no usable
 * energy basis (kcal/100g ≤ 0) — the per-100-kcal normalisation is undefined
 * without energy, so the medallion shows an em-dash rather than a fabricated
 * value. Per-100-kcal is invariant to dilution with water/stock (numerator and
 * denominator scale together), so excluding broth concentrates nothing here.
 */
export function computeBalance(input: BalanceInput): BalanceResult | null {
  const kcalPer100g = input.energyKcalPer100g;
  if (!Number.isFinite(kcalPer100g) || kcalPer100g <= 0) return null;
  const per100kcal = 100 / kcalPer100g; // scale per-100g concentrations → per-100-kcal

  let qualifying = 0;
  for (const key of QUALIFYING_KEYS) {
    const amount = input[key];
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const pctDV = ((amount * per100kcal) / DV[key]) * 100;
    qualifying += Math.min(pctDV, 100); // each encouraged nutrient capped at 100% DV
  }
  let limit = 0;
  for (const key of LIMITING_KEYS) {
    const amount = input[key];
    if (!Number.isFinite(amount) || amount <= 0) continue;
    limit += ((amount * per100kcal) / MRV[key]) * 100;
  }

  // Round the NRF for display, then derive the score from that same value so the
  // stored score and stored NRF always agree for an auditor.
  const nrf = round(qualifying - limit, 1);
  const score = balanceScoreOf(nrf);
  return { score, band: balanceBandOf(score), nrf, version: 'NRF9.3' };
}
