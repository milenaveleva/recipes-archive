import { describe, it, expect } from 'vitest';
import { computeNutriScore, nutriGradeOf, type NutriInput } from './nutriscore';

const KJ = 4.184;
const salt = (sodium_mg: number) => (sodium_mg / 1000) * 2.5;

describe('nutriGradeOf (general foods 2023 boundaries)', () => {
  it('maps total score to A ≤0, B 1–2, C 3–10, D 11–18, E ≥19', () => {
    expect(nutriGradeOf(-6)).toBe('A');
    expect(nutriGradeOf(0)).toBe('A');
    expect(nutriGradeOf(1)).toBe('B');
    expect(nutriGradeOf(2)).toBe('B');
    expect(nutriGradeOf(3)).toBe('C');
    expect(nutriGradeOf(10)).toBe('C');
    expect(nutriGradeOf(11)).toBe('D');
    expect(nutriGradeOf(18)).toBe('D');
    expect(nutriGradeOf(19)).toBe('E');
  });
});

describe('computeNutriScore — worked examples from the food data', () => {
  it('grades raw spinach as A', () => {
    const r = computeNutriScore({
      energyKj: 23 * KJ,
      sugars_g: 0.42,
      satFat_g: 0.06,
      salt_g: salt(79),
      protein_g: 2.86,
      fiber_g: 2.2,
      fvlPercent: 100,
    });
    // negatives 0; positives = fibre 0 + FVL 5 + protein 1 = 6 → score −6.
    expect(r.points).toBe(-6);
    expect(r.grade).toBe('A');
    expect(r.version).toBe('2023');
  });

  it('grades granulated sugar as E', () => {
    const r = computeNutriScore({
      energyKj: 387 * KJ,
      sugars_g: 99.8,
      satFat_g: 0,
      salt_g: salt(1),
      protein_g: 0,
      fiber_g: 0,
      fvlPercent: 0,
    });
    // energy 4 + sugars 15 = 19 negatives, no positives.
    expect(r.points).toBe(19);
    expect(r.grade).toBe('E');
  });

  it('grades lean chicken breast as A', () => {
    const r = computeNutriScore({
      energyKj: 165 * KJ,
      sugars_g: 0,
      satFat_g: 1.01,
      salt_g: salt(74),
      protein_g: 31.02,
      fiber_g: 0,
      fvlPercent: 0,
    });
    // energy 2 + satfat 1 = 3 negatives; protein 7 counted → score −4.
    expect(r.points).toBe(-4);
    expect(r.grade).toBe('A');
  });
});

describe('computeNutriScore — FVL point tiers', () => {
  const zero: NutriInput = {
    energyKj: 0, sugars_g: 0, satFat_g: 0, salt_g: 0, protein_g: 0, fiber_g: 0, fvlPercent: 0,
  };
  it('awards 0/1/2/5 FVL points at the ≤40/>40/>60/>80 breakpoints', () => {
    // With all else zero, score = −(FVL points).
    expect(computeNutriScore({ ...zero, fvlPercent: 40 }).points).toBe(0);
    expect(computeNutriScore({ ...zero, fvlPercent: 50 }).points).toBe(-1);
    expect(computeNutriScore({ ...zero, fvlPercent: 60 }).points).toBe(-1);
    expect(computeNutriScore({ ...zero, fvlPercent: 70 }).points).toBe(-2);
    expect(computeNutriScore({ ...zero, fvlPercent: 80 }).points).toBe(-2);
    expect(computeNutriScore({ ...zero, fvlPercent: 90 }).points).toBe(-5);
  });
});

describe('computeNutriScore — protein-exclusion rule', () => {
  const base: NutriInput = {
    energyKj: 3400, // 10 energy points
    sugars_g: 60, // 15 sugar points → negatives ≥ 11
    satFat_g: 0,
    salt_g: 0,
    protein_g: 20, // would earn 7 protein points
    fiber_g: 0,
    fvlPercent: 0,
  };

  it('excludes protein when negatives ≥ 11 and FVL < 5 points', () => {
    const r = computeNutriScore(base);
    expect(r.points).toBe(25); // 25 negatives, protein NOT subtracted
    expect(r.grade).toBe('E');
  });

  it('still counts protein when FVL earns the maximum 5 points', () => {
    const r = computeNutriScore({ ...base, energyKj: 3400, sugars_g: 0, salt_g: 0.3, fvlPercent: 85 });
    // negatives = energy 10 + salt 1 = 11; FVL 5 → protein counted.
    // positives = fibre 0 + FVL 5 + protein 7 = 12 → score −1.
    expect(r.points).toBe(-1);
    expect(r.grade).toBe('A');
  });
});
