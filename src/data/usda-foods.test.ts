import { describe, expect, it } from 'vitest';
import foods from './usda-foods.json';
import fills from './nutrient-gap-fills.json';

// Data contract for the bundled food table and its gap fills (scripts/fill-nutrient-gaps.mjs):
// every value is a finite non-negative number, every non-original value carries
// provenance from an allowed method, and nothing is imputed from a similar food.

type Food = { fdcId: number; description: string; n: Record<string, number>; gapFill?: Record<string, string> };
const FOODS = foods as Food[];
const FILLS = fills as unknown as Record<string, Record<string, [number, string]>>;

const PANEL = [
  'energyKcal', 'energyKj', 'water_g', 'protein_g', 'fat_g', 'satFat_g', 'monoFat_g', 'polyFat_g',
  'transFat_g', 'cholesterol_mg', 'carbs_g', 'fiber_g', 'sugar_g', 'polyol_g', 'alcohol_g',
  'caffeine_mg', 'sodium_mg', 'potassium_mg', 'calcium_mg', 'iron_mg', 'magnesium_mg',
  'phosphorus_mg', 'zinc_mg', 'copper_mg', 'manganese_mg', 'selenium_ug', 'vitA_ug', 'vitC_mg',
  'vitD_ug', 'vitE_mg', 'vitK_ug', 'thiamin_mg', 'riboflavin_mg', 'niacin_mg', 'vitB6_mg',
  'folate_ug', 'vitB12_ug', 'pantothenicAcid_mg', 'choline_mg',
];
const PROVENANCE = /^(ANALYSED:USDA-FDC:\d+#[\d.+]+|CALCULATED:(kcal×4\.184|kJ÷4\.184)|ZERO:[a-z-]+|BORROWED:(USDA-SR|USDA-FOUNDATION|FR-CIQUAL|JP-MEXT|DK-FRIDA|UK-COFID|AU-AFCD|CH-SWISS):[\w-]+)$/;

describe('usda-foods.json nutrient data', () => {
  it('stores every nutrient as a finite, non-negative number', () => {
    const bad = FOODS.flatMap((f) =>
      Object.entries(f.n).filter(([, v]) => !Number.isFinite(v) || v < 0).map(([k, v]) => `${f.fdcId} ${k}=${v}`));
    expect(bad).toEqual([]);
  });

  it('records allowed provenance for every gap-filled value, and none is imputed', () => {
    const bad: string[] = [];
    for (const f of FOODS) {
      for (const [k, prov] of Object.entries(f.gapFill ?? {})) {
        if (f.n[k] == null) bad.push(`${f.fdcId} ${k}: provenance without a value`);
        if (!PROVENANCE.test(prov) || /IMPUTED/i.test(prov)) bad.push(`${f.fdcId} ${k}: ${prov}`);
        const src = FILLS[f.fdcId]?.[k];
        if (!src || src[0] !== f.n[k] || src[1] !== prov) bad.push(`${f.fdcId} ${k}: not from nutrient-gap-fills.json`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps the fills file free of imputed values', () => {
    const imputed = Object.entries(FILLS).flatMap(([id, byField]) =>
      Object.entries(byField).filter(([, [, prov]]) => !PROVENANCE.test(prov)).map(([k, [, prov]]) => `${id} ${k}: ${prov}`));
    expect(imputed).toEqual([]);
  });

  it('reports the remaining missing values per field (informational)', () => {
    const missing = Object.fromEntries(PANEL.map((k) => [k, FOODS.filter((f) => f.n[k] == null).length]));
    const open = Object.fromEntries(Object.entries(missing).filter(([, c]) => c > 0));
    console.info(`[usda-foods] ${FOODS.length} foods; still missing per field:`, open);
    expect(FOODS.length).toBeGreaterThan(0);
  });
});
