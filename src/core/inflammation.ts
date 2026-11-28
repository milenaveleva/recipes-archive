/**
 * Recipe inflammatory-potential estimate: the score of the dish's pooled, cooked composition
 * (fii.ts scoreComposition — every ingredient's nutrients summed and read per 100 kcal, the
 * way the energy-adjusted DII scores a whole diet), plus a bounded aromatic adjustment
 * (aromatics.ts) for the spices whose bioactives no composition column carries.
 *
 * The five bands are fixed edges on the score axis (fii-parameters.json `bands`, copied into
 * inflammation-reference.json), symmetric about its zero point — the average diet's
 * protective-nutrient density with no free sugar, saturated or trans fat, or sodium. Labels
 * are relative — "anti-inflammatory" means more anti than the average diet's profile, never
 * a clinical category. Diet-level inflammation
 * scores explain at most ~2 % of biomarker variance (Lécuyer 2023), so this is an estimate
 * for comparing dishes, not a prediction of anyone's CRP.
 */
import { round, clamp } from './num';
import { scoreComposition, type FiiItem, type ParamContribution } from './fii';
import referenceData from '../data/inflammation-reference.json';

/** The five band edges on the score axis, from inflammation-reference.json. */
export interface InflammationBandEdges {
  antiMax: number;
  mildlyAntiMax: number;
  neutralMax: number;
  mildlyProMax: number;
}
const BANDS = (referenceData as unknown as { bands: InflammationBandEdges }).bands;
/** The band edges, shared with the dial presentation so its colour follows the same cut-offs. */
export const INFLAMMATION_BAND_EDGES: Readonly<InflammationBandEdges> = BANDS;
if (!BANDS || typeof BANDS.antiMax !== 'number') {
  // The band edges are generated as a unit with the rest of the reference; a file
  // without them means a stale or partial regen, not a recoverable state.
  throw new Error(
    'inflammation-reference.json is missing band edges — run `node scripts/build-inflammation-reference.mjs`',
  );
}

export type InflammationBand =
  | 'anti-inflammatory'
  | 'mildly-anti-inflammatory'
  | 'neutral'
  | 'mildly-pro-inflammatory'
  | 'pro-inflammatory';

export interface Inflammation {
  /** Pooled-composition score plus matrix and aromatic adjustments, rounded to 0.1, within −2…+2. */
  score: number;
  band: InflammationBand;
  /** The aromatic adjustment already included in `score` (score units, < 0); absent when 0. */
  aromaticAdjustment?: number;
}

/** A dish score with the per-parameter breakdown behind it, for explanation and diagnostics. */
export interface InflammationDetail extends Inflammation {
  contributions: ParamContribution[];
  matrixDelta: number;
  coverage: number;
}

/**
 * Map a −2..+2 score to the five-band scale (inflammation-reference.json `bands`).
 */
export function inflammationBandOf(score: number): InflammationBand {
  if (score <= BANDS.antiMax) return 'anti-inflammatory';
  if (score <= BANDS.mildlyAntiMax) return 'mildly-anti-inflammatory';
  if (score <= BANDS.neutralMax) return 'neutral';
  if (score <= BANDS.mildlyProMax) return 'mildly-pro-inflammatory';
  return 'pro-inflammatory';
}

/**
 * The dish's inflammatory-potential estimate from its cooked ingredients plus the recipe's
 * aromatic adjustment (aromatics.ts, ≤ 0), with the per-parameter breakdown; null when no
 * ingredient can be scored.
 */
export function computeInflammationDetail(items: FiiItem[], aromaticAdjustment = 0): InflammationDetail | null {
  const s = scoreComposition(items);
  if (!s) return null;
  const adj = Number.isFinite(aromaticAdjustment) && aromaticAdjustment < 0 ? aromaticAdjustment : 0;
  const score = clamp(round(s.composition + s.matrixDelta + adj, 1), -2, 2) || 0;
  const result: InflammationDetail = {
    score,
    band: inflammationBandOf(score),
    contributions: s.contributions,
    matrixDelta: s.matrixDelta,
    coverage: s.coverage,
  };
  if (adj < 0) result.aromaticAdjustment = adj;
  return result;
}

/** The stored inflammation block for a dish (score, band, aromatic adjustment), or null. */
export function computeInflammation(items: FiiItem[], aromaticAdjustment = 0): Inflammation | null {
  const d = computeInflammationDetail(items, aromaticAdjustment);
  if (!d) return null;
  const result: Inflammation = { score: d.score, band: d.band };
  if (d.aromaticAdjustment != null) result.aromaticAdjustment = d.aromaticAdjustment;
  return result;
}
