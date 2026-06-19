/**
 * Nutri-Score 2023 nutrient-profiling grade for a recipe, treated as a
 * "general food" per 100 g (Merz 2024; see README ## References). The published
 * 2023 threshold tables are reimplemented here from their numeric values (the
 * score is computed, not the trademarked logo — which is never shipped).
 *
 * Score = negative points − positive points, where negatives are energy,
 * sugars, saturated fat and salt, and positives are protein, fibre and the
 * %fruit/vegetables/legumes (FVL) share. Protein is excluded from the positive
 * total when negatives ≥ 11 unless FVL already earns the maximum 5 points.
 *
 * Scope: only the general-foods sub-algorithm is implemented — every recipe is
 * a general food. The beverage and fats/oils/nuts/seeds sub-algorithms (which
 * use different energy/saturated-fat handling and grade cut-offs) are not yet
 * applied; the red-meat-specific protein cap is likewise not modelled at recipe
 * granularity. All figures are estimates.
 */
import { round } from './num';

/** Only the general-foods sub-algorithm is implemented today. */
export type NutriCategory = 'general';

export interface NutriInput {
  /** Energy per 100 g, in kilojoules. */
  energyKj: number;
  /** Sugars, g/100 g. */
  sugars_g: number;
  /** Saturated fat, g/100 g. */
  satFat_g: number;
  /** Salt, g/100 g (= sodium g × 2.5). */
  salt_g: number;
  /** Protein, g/100 g. */
  protein_g: number;
  /** Dietary fibre (AOAC), g/100 g. */
  fiber_g: number;
  /** Fruit/vegetables/legumes as a percentage of mass (0–100). */
  fvlPercent: number;
}

export type NutriGrade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface NutriResult {
  grade: NutriGrade;
  /** Final score (negatives − positives); lower is better. */
  points: number;
  category: NutriCategory;
  version: '2023';
}

/* ---- 2023 general-foods threshold tables (each is the ">" breakpoint per point) ---- */

const ENERGY_KJ = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350]; // 0–10
const SUGARS_G = [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51]; // 0–15
const SATFAT_G = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 0–10 (1 g per point)
const SALT_G = Array.from({ length: 20 }, (_, i) => round((i + 1) * 0.2, 1)); // 0–20 (0.2 g per point)
const PROTEIN_G = [2.4, 4.8, 7.2, 9.6, 12, 14, 17]; // 0–7
const FIBER_G = [3.0, 4.1, 5.2, 6.3, 7.4]; // 0–5 (AOAC)

/** Points = how many ">" thresholds the value exceeds (already capped by length). */
function pointsFor(value: number, thresholds: number[]): number {
  if (!Number.isFinite(value)) return 0;
  let p = 0;
  for (const t of thresholds) if (value > t) p++;
  return p;
}

/** FVL points: 0 (≤40%), 1 (>40%), 2 (>60%), 5 (>80%). No 3 or 4. */
function fvlPoints(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct > 80) return 5;
  if (pct > 60) return 2;
  if (pct > 40) return 1;
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

export function computeNutriScore(
  input: NutriInput,
  category: NutriCategory = 'general',
): NutriResult {
  const negatives =
    pointsFor(input.energyKj, ENERGY_KJ) +
    pointsFor(input.sugars_g, SUGARS_G) +
    pointsFor(input.satFat_g, SATFAT_G) +
    pointsFor(input.salt_g, SALT_G);

  const proteinPts = pointsFor(input.protein_g, PROTEIN_G);
  const fiberPts = pointsFor(input.fiber_g, FIBER_G);
  const fvlPts = fvlPoints(input.fvlPercent);

  // Protein counts only when negatives < 11, unless FVL already maxes out.
  const proteinCounted = negatives < 11 || fvlPts === 5;
  const positives = fiberPts + fvlPts + (proteinCounted ? proteinPts : 0);

  const points = negatives - positives;
  return { grade: nutriGradeOf(points), points, category, version: '2023' };
}
