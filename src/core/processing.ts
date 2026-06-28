/**
 * Recipe food-processing score from the NOVA classification (Monteiro).
 *
 * Each matched food carries a NOVA group (1 minimally processed, 2 culinary
 * ingredient, 3 processed, 4 ultra-processed), stamped at build time from its
 * name/category (scripts/nova.mjs). The recipe figure is the share of dish ENERGY
 * in each group — the standard way NOVA is aggregated for a mixed diet or dish
 * (the "% of total energy from NOVA groups" reference approach, Steele 2022).
 *
 * The headline `minimallyProcessedPct` (groups 1+2 — whole foods plus basic
 * culinary ingredients) reads higher = better; `ultraProcessedPct` (group 4) is
 * the health-relevant risk signal shown alongside. Bands are anchored to typical
 * population intake (US mean NOVA 1+2 ≈ 33% of energy, Steele 2022), so ≥70% is
 * well above average ("minimally processed") and <40% is around/below it.
 *
 * Every figure is an estimate: NOVA group assignment itself has low inter-rater
 * agreement (Fleiss' κ ≈ 0.32, Braesco 2022), so this is a guide, not a measure.
 */

export type NovaGroup = 1 | 2 | 3 | 4;

/** One ingredient's contribution: its absolute dish energy and its NOVA group. */
export interface ProcessingItem {
  /** Absolute energy this ingredient contributes (kcal), or null when unknown. */
  energyKcal: number | null;
  /** Matched food's NOVA group, or null when the food carries no classification. */
  nova: NovaGroup | null;
}

export type ProcessingBand =
  | 'minimally-processed'
  | 'moderately-processed'
  | 'highly-processed';

export interface ProcessingResult {
  /** Energy share (%) of each NOVA group across the classified, energy-bearing mass. */
  pct: { n1: number; n2: number; n3: number; n4: number };
  /** Headline: % of energy from NOVA 1+2 (whole foods + culinary ingredients). */
  minimallyProcessedPct: number;
  /** % of energy from NOVA 4 (ultra-processed) — the risk signal. */
  ultraProcessedPct: number;
  band: ProcessingBand;
}

/** ≥70% minimally processed reads well above the population average; <40% at/below it. */
const MINIMAL_GOOD = 70;
const MINIMAL_MID = 40;

function bandFor(minimallyProcessedPct: number): ProcessingBand {
  if (minimallyProcessedPct >= MINIMAL_GOOD) return 'minimally-processed';
  if (minimallyProcessedPct >= MINIMAL_MID) return 'moderately-processed';
  return 'highly-processed';
}

/**
 * Energy-weighted NOVA distribution for a recipe. Only ingredients that carry both
 * a NOVA group and a positive energy contribution count toward the shares (an
 * unclassified or energy-less food can't be placed and is left out, exactly as a
 * food with no usable energy is left out of the Nutri-Score basis). Returns
 * undefined when nothing is classifiable, so the caller emits no processing block.
 */
export function computeProcessing(items: ProcessingItem[]): ProcessingResult | undefined {
  const energy = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<NovaGroup, number>;
  let total = 0;
  for (const it of items) {
    if (it.nova == null) continue;
    const kcal = it.energyKcal;
    if (kcal == null || !Number.isFinite(kcal) || kcal <= 0) continue;
    energy[it.nova] += kcal;
    total += kcal;
  }
  if (total <= 0) return undefined;

  const share = (g: NovaGroup) => round1((energy[g] / total) * 100);
  const pct = { n1: share(1), n2: share(2), n3: share(3), n4: share(4) };
  const minimallyProcessedPct = round1(((energy[1] + energy[2]) / total) * 100);
  const ultraProcessedPct = pct.n4;
  return {
    pct,
    minimallyProcessedPct,
    ultraProcessedPct,
    band: bandFor(minimallyProcessedPct),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
