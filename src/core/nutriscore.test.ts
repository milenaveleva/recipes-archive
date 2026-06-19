import { describe, it, expect } from 'vitest';
import { computeNutriScore, nutriGradeOf, fatGradeOf, beverageGradeOf, type NutriInput } from './nutriscore';

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

  it('excludes protein when negatives ≥ 11', () => {
    const r = computeNutriScore(base);
    expect(r.points).toBe(25); // 25 negatives, protein NOT subtracted
    expect(r.grade).toBe('E');
  });

  it('still drops protein at negatives ≥ 11 even when FVL is maxed (2023 has no FVL exception)', () => {
    const r = computeNutriScore({ ...base, energyKj: 3400, sugars_g: 0, salt_g: 0.3, fvlPercent: 85 });
    // negatives = energy 10 + salt 1 = 11; protein excluded; positives = fibre 0 + FVL 5 = 5 → score 6.
    expect(r.points).toBe(6);
    expect(r.grade).toBe('C');
  });

  it('keeps protein past the cap for cheese', () => {
    const r = computeNutriScore({ ...base, energyKj: 3400, sugars_g: 0, salt_g: 0.3, fvlPercent: 85, isCheese: true });
    // negatives 11; cheese keeps protein → positives = fibre 0 + FVL 5 + protein 7 = 12 → score −1.
    expect(r.points).toBe(-1);
    expect(r.grade).toBe('A');
  });
});

describe('beverages 2023 sub-algorithm', () => {
  const drink = (over: Partial<NutriInput>): NutriInput => ({
    energyKj: 0, sugars_g: 0, satFat_g: 0, salt_g: 0, protein_g: 0, fiber_g: 0, fvlPercent: 0, ...over,
  });

  it('grades the boundaries: water=A, ≤2=B, 3–6=C, 7–9=D, ≥10=E', () => {
    expect(beverageGradeOf(8, true)).toBe('A'); // the water flag overrides the score
    expect(beverageGradeOf(0, false)).toBe('B'); // best a non-water beverage can do
    expect(beverageGradeOf(2, false)).toBe('B');
    expect(beverageGradeOf(3, false)).toBe('C');
    expect(beverageGradeOf(6, false)).toBe('C');
    expect(beverageGradeOf(7, false)).toBe('D');
    expect(beverageGradeOf(9, false)).toBe('D');
    expect(beverageGradeOf(10, false)).toBe('E');
  });

  it('grades plain water A only with the water flag, else B', () => {
    expect(computeNutriScore(drink({ isWater: true }), 'beverage').grade).toBe('A');
    expect(computeNutriScore(drink({}), 'beverage').grade).toBe('B'); // same zeros, no flag → B
  });

  it('grades a sugary cola E', () => {
    // 180 kJ → energy 3 (>30,>90,>150); 10.6 g sugar → 9 (>0.5…>10); negatives 12, no positives.
    const r = computeNutriScore(drink({ energyKj: 180, sugars_g: 10.6 }), 'beverage');
    expect(r.points).toBe(12);
    expect(r.grade).toBe('E');
  });

  it('penalises a non-nutritive-sweetened diet drink to C', () => {
    // ~0 energy/sugar but NNS present → +4 negatives, no positives → score 4 → C.
    const r = computeNutriScore(drink({ energyKj: 1, nnsPresent: true }), 'beverage');
    expect(r.points).toBe(4);
    expect(r.grade).toBe('C');
  });

  it('stacks the single NNS penalty on top of sugar/energy points (not double-counted)', () => {
    // 180 kJ → 3, 10.6 g sugar → 9, NNS → +4; negatives = 16 (one penalty, not 8) → E.
    const r = computeNutriScore(drink({ energyKj: 180, sugars_g: 10.6, nnsPresent: true }), 'beverage');
    expect(r.points).toBe(16);
    expect(r.grade).toBe('E');
  });

  it('rewards protein on the beverage scale (plain milk → B)', () => {
    // 192 kJ → energy 3; 4.8 g sugar → 3 (>3.5); satfat 1 → 0; salt 0.1 → 0; negatives 6.
    // protein 3.4 → 7 (beverage scale tops at >3.0); positives 7 → score −1 → B (non-water floor).
    const r = computeNutriScore(drink({ energyKj: 192, sugars_g: 4.8, satFat_g: 1, protein_g: 3.4, salt_g: 0.1 }), 'beverage');
    expect(r.points).toBe(-1);
    expect(r.grade).toBe('B');
  });
});

describe('fats/oils/nuts/seeds 2023 sub-algorithm', () => {
  const fat = (over: Partial<NutriInput>): NutriInput => ({
    energyKj: 0, sugars_g: 0, satFat_g: 0, salt_g: 0, protein_g: 0, fiber_g: 0, fvlPercent: 0, ...over,
  });

  it('grades the boundaries: A ≤−6, B −5–2, C 3–10, D 11–18, E ≥19', () => {
    expect(fatGradeOf(-6)).toBe('A');
    expect(fatGradeOf(-5)).toBe('B');
    expect(fatGradeOf(2)).toBe('B');
    expect(fatGradeOf(3)).toBe('C');
    expect(fatGradeOf(10)).toBe('C');
    expect(fatGradeOf(11)).toBe('D');
    expect(fatGradeOf(18)).toBe('D');
    expect(fatGradeOf(19)).toBe('E');
  });

  it('grades olive oil B when its oil counts toward FVL', () => {
    // satfat 14 g → energy-from-sat 518 kJ → 4 (>120,>240,>360,>480); ratio 14% → 1 (≥10); negatives 5.
    // FVL 100% → 5 positive points; score 5 − 5 = 0 → B.
    const r = computeNutriScore(fat({ satFat_g: 14, totalFat_g: 100, fvlPercent: 100 }), 'fat-oil-nut-seed');
    expect(r.points).toBe(0);
    expect(r.grade).toBe('B');
  });

  it('grades butter E', () => {
    // satfat 51 g → energy-from-sat 1887 kJ → 10; ratio 51/81≈63% → 9 (≥58, <64); negatives 19; no positives.
    const r = computeNutriScore(fat({ satFat_g: 51, totalFat_g: 81 }), 'fat-oil-nut-seed');
    expect(r.points).toBe(19);
    expect(r.grade).toBe('E');
  });

  it('grades plain walnuts A on protein + fibre with a low SFA ratio', () => {
    // satfat 6 g → energy-from-sat 222 kJ → 1; ratio 6/65≈9.2% → 0 (<10); sugar 2.6 → 0; negatives 1 (<7).
    // protein 15 → 6, fibre 6.7 → 4; positives 10; score 1 − 10 = −9 → A.
    const r = computeNutriScore(fat({ satFat_g: 6, totalFat_g: 65, sugars_g: 2.6, protein_g: 15, fiber_g: 6.7 }), 'fat-oil-nut-seed');
    expect(r.points).toBe(-9);
    expect(r.grade).toBe('A');
  });

  it('scores the SFA-ratio component as 0 when total fat is missing or zero', () => {
    // No totalFat_g → ratio component contributes 0 (only energy-from-sat 518 → 4 negatives here).
    expect(computeNutriScore(fat({ satFat_g: 14 }), 'fat-oil-nut-seed').points).toBe(4);
    // totalFat_g === 0 takes the same guard (no divide-by-zero); satfat 5 → energy 1, ratio 0 → score 1.
    const zeroFat = computeNutriScore(fat({ satFat_g: 5, totalFat_g: 0 }), 'fat-oil-nut-seed');
    expect(zeroFat.points).toBe(1);
    expect(zeroFat.grade).toBe('B');
  });

  it('scores the SFA ratio inclusively at the band edges (≥, not >)', () => {
    // ratio exactly 10% → 1 ratio point (10 ≥ 10); energy-from-sat 10×37=370 → 3; score 4 → C.
    expect(computeNutriScore(fat({ satFat_g: 10, totalFat_g: 100 }), 'fat-oil-nut-seed').points).toBe(4);
    // ratio just under 10% → 0 ratio points; satfat 9.99 → energy 369.6 → 3; score 3 → C.
    expect(computeNutriScore(fat({ satFat_g: 9.99, totalFat_g: 100 }), 'fat-oil-nut-seed').points).toBe(3);
    // ratio exactly 64% → the top 10 ratio points (≥64); energy 64×37=2368 → 10; score 20 → E.
    const maxRatio = computeNutriScore(fat({ satFat_g: 64, totalFat_g: 100 }), 'fat-oil-nut-seed');
    expect(maxRatio.points).toBe(20);
    expect(maxRatio.grade).toBe('E');
  });

  it('drops protein once fat negatives reach 7 (cap is 7, not the general 11)', () => {
    // satfat 14 → energy 4, ratio 1; salt 0.5 → 2; negatives = 7; protein 18 → 7 pts but dropped → score 7 → C.
    const r = computeNutriScore(fat({ satFat_g: 14, totalFat_g: 100, salt_g: 0.5, protein_g: 18 }), 'fat-oil-nut-seed');
    expect(r.points).toBe(7);
    expect(r.grade).toBe('C'); // a 11-threshold (general) cap would keep protein → score 0 → B
  });
});
