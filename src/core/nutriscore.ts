/**
 * Nutri-Score 2023 nutrient-profiling grade for a food, per 100 g (or per 100 mL
 * for beverages). The published 2023 threshold tables are reimplemented here from
 * their numeric values (the score is computed, not the trademarked logo — which
 * is never shipped). Three category sub-algorithms are supported, selected by
 * `category`:
 *
 *  - 'general'          — solid foods (the default; every recipe is a general food).
 *  - 'beverage'         — drinks: stricter energy/sugar scales, a 4-point penalty
 *                         for non-nutritive sweeteners, a beverage-only protein
 *                         scale, and a grade table where plain water is the only A.
 *  - 'fat-oil-nut-seed' — fats, oils, nuts and seeds: energy is scored from
 *                         saturates (saturates × 37 kJ/g) and the saturated-fat
 *                         component is replaced by the saturated-fat-to-total-fat
 *                         ratio.
 *
 * Score = negative points − positive points. Negatives are energy, sugars,
 * saturated fat (or the SFA/lipid ratio for fats) and salt, plus a non-nutritive-
 * sweetener penalty for beverages. Positives are protein, fibre and the
 * %fruit/vegetables/legumes (FVL) share. Protein drops out of the positives once
 * the negative total reaches the category cap (general ≥ 11, except cheese; fats
 * ≥ 7; beverages have no cap). All figures are estimates.
 */
import { round } from './num';

export type NutriCategory = 'general' | 'beverage' | 'fat-oil-nut-seed';

export interface NutriInput {
  /** Energy per 100 g/mL, in kilojoules. Ignored for fats (scored from saturates). */
  energyKj: number;
  /** Sugars, g/100 g/mL. */
  sugars_g: number;
  /** Saturated fat, g/100 g/mL. */
  satFat_g: number;
  /** Salt, g/100 g/mL (= sodium g × 2.5). */
  salt_g: number;
  /** Protein, g/100 g/mL. */
  protein_g: number;
  /** Dietary fibre (AOAC), g/100 g/mL. */
  fiber_g: number;
  /** Fruit/vegetables/legumes as a percentage of mass (0–100). */
  fvlPercent: number;
  /** Total fat, g/100 g — required by the fats category for the SFA/total-fat ratio. */
  totalFat_g?: number;
  /** Beverages: a non-nutritive sweetener is present (adds the NNS penalty). */
  nnsPresent?: boolean;
  /** Beverages: plain water, which is graded A by definition. */
  isWater?: boolean;
  /** General foods: cheese keeps its protein points past the negative cap. */
  isCheese?: boolean;
}

export type NutriGrade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface NutriResult {
  grade: NutriGrade;
  /** Final score (negatives − positives); lower is better. */
  points: number;
  category: NutriCategory;
  version: '2023';
}

/* ---- 2023 threshold tables (each entry is the ">" breakpoint earning that point) ---- */

// General foods.
const ENERGY_KJ = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350]; // 0–10
const SUGARS_G = [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51]; // 0–15
const SATFAT_G = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 0–10 (1 g per point)
const SALT_G = Array.from({ length: 20 }, (_, i) => round((i + 1) * 0.2, 1)); // 0–20 (0.2 g per point)
const PROTEIN_G = [2.4, 4.8, 7.2, 9.6, 12, 14, 17]; // 0–7
const FIBER_G = [3.0, 4.1, 5.2, 6.3, 7.4]; // 0–5 (AOAC)

// Beverages: stricter energy/sugar scales and a beverage-only protein scale.
const ENERGY_KJ_BEVERAGE = [30, 90, 150, 210, 240, 270, 300, 330, 360, 390]; // 0–10
const SUGARS_G_BEVERAGE = [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11]; // 0–10
const PROTEIN_G_BEVERAGE = [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0]; // 0–7
const NNS_PENALTY = 4; // negative points for the presence of a non-nutritive sweetener

// Fats/oils/nuts/seeds: energy from saturates, and the saturated-fat/total-fat ratio.
const ENERGY_FROM_SAT_KJ = [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200]; // 0–10
const KJ_PER_G_SATFAT = 37; // energy from saturates = saturates (g) × 37 kJ/g
// SFA-to-total-fat ratio (%): banded <10→0 … <64→9, ≥64→10, so these are "≥" breakpoints.
const SFA_RATIO_PCT = [10, 16, 22, 28, 34, 40, 46, 52, 58, 64]; // 0–10

/** Points = how many ">" thresholds the value exceeds (already capped by length). */
function pointsFor(value: number, thresholds: number[]): number {
  if (!Number.isFinite(value)) return 0;
  let p = 0;
  for (const t of thresholds) if (value > t) p++;
  return p;
}

/** Points = how many "≥" thresholds the value reaches (the SFA/total-fat ratio band). */
function pointsForAtLeast(value: number, thresholds: number[]): number {
  if (!Number.isFinite(value)) return 0;
  let p = 0;
  for (const t of thresholds) if (value >= t) p++;
  return p;
}

/** General/fats FVL points: 0 (≤40%), 1 (>40%), 2 (>60%), 5 (>80%). No 3 or 4. */
function fvlPoints(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct > 80) return 5;
  if (pct > 60) return 2;
  if (pct > 40) return 1;
  return 0;
}

/** Beverage FVL points: 0 (≤40%), 2 (>40%), 4 (>60%), 6 (>80%). */
function fvlPointsBeverage(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct > 80) return 6;
  if (pct > 60) return 4;
  if (pct > 40) return 2;
  return 0;
}

/** Total-score → grade (general foods): A ≤0, B 1–2, C 3–10, D 11–18, E ≥19. */
export function nutriGradeOf(points: number): NutriGrade {
  if (points <= 0) return 'A';
  if (points <= 2) return 'B';
  if (points <= 10) return 'C';
  if (points <= 18) return 'D';
  return 'E';
}

/** Total-score → grade (fats/oils/nuts/seeds): A ≤−6, B −5–2, C 3–10, D 11–18, E ≥19. */
export function fatGradeOf(points: number): NutriGrade {
  if (points <= -6) return 'A';
  if (points <= 2) return 'B';
  if (points <= 10) return 'C';
  if (points <= 18) return 'D';
  return 'E';
}

/** Total-score → grade (beverages): water is A; otherwise B ≤2, C 3–6, D 7–9, E ≥10. */
export function beverageGradeOf(points: number, isWater: boolean): NutriGrade {
  if (isWater) return 'A';
  if (points <= 2) return 'B';
  if (points <= 6) return 'C';
  if (points <= 9) return 'D';
  return 'E';
}

/** Compute the Nutri-Score 2023 grade for the given category (defaults to general foods). */
export function computeNutriScore(input: NutriInput, category: NutriCategory = 'general'): NutriResult {
  switch (category) {
    case 'beverage':
      return beverageScore(input);
    case 'fat-oil-nut-seed':
      return fatScore(input);
    default:
      return generalScore(input);
  }
}

function generalScore(input: NutriInput): NutriResult {
  const negatives =
    pointsFor(input.energyKj, ENERGY_KJ) +
    pointsFor(input.sugars_g, SUGARS_G) +
    pointsFor(input.satFat_g, SATFAT_G) +
    pointsFor(input.salt_g, SALT_G);

  const proteinPts = pointsFor(input.protein_g, PROTEIN_G);
  const fiberPts = pointsFor(input.fiber_g, FIBER_G);
  const fvlPts = fvlPoints(input.fvlPercent);

  // Protein drops out once negatives reach 11 — except for cheese.
  const proteinCounted = negatives < 11 || input.isCheese === true;
  const positives = fiberPts + fvlPts + (proteinCounted ? proteinPts : 0);

  const points = negatives - positives;
  return { grade: nutriGradeOf(points), points, category: 'general', version: '2023' };
}

function beverageScore(input: NutriInput): NutriResult {
  const negatives =
    pointsFor(input.energyKj, ENERGY_KJ_BEVERAGE) +
    pointsFor(input.sugars_g, SUGARS_G_BEVERAGE) +
    pointsFor(input.satFat_g, SATFAT_G) +
    pointsFor(input.salt_g, SALT_G) +
    (input.nnsPresent === true ? NNS_PENALTY : 0);

  // Beverages carry no protein cap.
  const positives =
    pointsFor(input.protein_g, PROTEIN_G_BEVERAGE) +
    pointsFor(input.fiber_g, FIBER_G) +
    fvlPointsBeverage(input.fvlPercent);

  const points = negatives - positives;
  return { grade: beverageGradeOf(points, input.isWater === true), points, category: 'beverage', version: '2023' };
}

function fatScore(input: NutriInput): NutriResult {
  const energyFromSat = input.satFat_g * KJ_PER_G_SATFAT;
  // Ratio needs total fat; without it (or at zero fat) the ratio component scores 0.
  const sfaRatio = input.totalFat_g && input.totalFat_g > 0 ? (input.satFat_g / input.totalFat_g) * 100 : 0;

  const negatives =
    pointsFor(energyFromSat, ENERGY_FROM_SAT_KJ) +
    pointsFor(input.sugars_g, SUGARS_G) +
    pointsForAtLeast(sfaRatio, SFA_RATIO_PCT) +
    pointsFor(input.salt_g, SALT_G);

  const proteinPts = pointsFor(input.protein_g, PROTEIN_G);
  const fiberPts = pointsFor(input.fiber_g, FIBER_G);
  const fvlPts = fvlPoints(input.fvlPercent);

  // Protein drops out once negatives reach 7.
  const proteinCounted = negatives < 7;
  const positives = fiberPts + fvlPts + (proteinCounted ? proteinPts : 0);

  const points = negatives - positives;
  return { grade: fatGradeOf(points), points, category: 'fat-oil-nut-seed', version: '2023' };
}
