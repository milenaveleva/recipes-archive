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
 * A food's NOVA group comes from the matched generic food, which can be less processed
 * than what the recipe actually calls for ("puff pastry" matched to a flour/fat food,
 * "smoked salmon" to raw salmon). `novaFromText` reads the ingredient's original line
 * for explicit processing markers and `promoteNova` raises the group when the text
 * says more processing than the match — never lowers it.
 *
 * Every figure is an estimate: NOVA group assignment itself has low inter-rater
 * agreement (Fleiss' κ ≈ 0.32, Braesco 2022), so this is a guide, not a measure.
 */

export type NovaGroup = 1 | 2 | 3 | 4;

/**
 * Ingredient-text markers of ultra-processed (NOVA 4) products, following the NOVA
 * definition of industrial formulations (Monteiro 2019): ready-made pastry and
 * biscuits, wrappers, stock cubes/powders, commercial curry pastes, instant
 * products, flavoured products, margarine, and reconstituted meat (sausages, hot dogs).
 */
const NOVA4_MARKERS: RegExp[] = [
  /\blady ?fingers?\b/i,
  /\bsavoiardi\b/i,
  /\bpuff[- ]pastry\b/i,
  /\b(?:wonton|won ton|gyoza|dumpling|spring[- ]roll|egg[- ]roll)\s+(?:wrappers?|skins?|sheets?)\b/i,
  /\b(?:stock|bouillon)\s+(?:cubes?|powder|granules|pots?)\b/i,
  /\bcurry\s+paste\b/i,
  /\binstant\s+(?:noodles?|ramen|soup|mash(?:ed)?|potato(?:es)?|pudding|custard|gravy|dessert|broth|stock)\b/i,
  // A flavoured product, not a quality adjective ("well-flavoured stock", "full-flavoured").
  /(?<!\b(?:well|full|richly|highly|strongly|deeply|nicely|delicately|mildly|lightly|subtly)[- ])\bflavou?red\b/i,
  /\bmargarine\b/i,
  /\b(?:sausages?|hot ?dogs?|frankfurters?|wieners?|bratwurst|chipolatas?)\b/i,
];

/**
 * Ingredient-text markers of processed (NOVA 3) foods (Monteiro 2019): cured meats,
 * canned foods and cheeses; cured / smoked / salted / pickled foods are matched by
 * PRESERVED_MARKERS, which exempt preserved seasonings (smoked paprika, smoked salt) and
 * salted butter (a NOVA 2 culinary fat).
 */
const NOVA3_MARKERS: RegExp[] = [
  /\b(?:ham|bacon|prosciutto|pancetta|speck|salami|pepperoni|chorizo|guanciale|lardons?)\b/i,
  /\b(?:canned|tinned)\b/i,
  /\b\d+(?:[.,]\d+)?\s*(?:x\s*)?(?:cans?|tins?)\b/i,
  /\b(?:cans?|tins?)\s+of\b/i,
  /\bin\s+(?:brine|syrup)\b/i,
  /\bcheese\b/i,
  /\b(?:parmesan|parmigiano|pecorino|grana padano|feta|mozzarella|cheddar|gouda|halloumi|gruy[eè]re|emmental|brie|camembert|mascarpone|ricotta|manchego|roquefort|gorgonzola)\b/i,
];

/** Preservation markers (NOVA 3) — read after the seasoning phrases below are removed. */
const PRESERVED_MARKERS: RegExp[] = [/\b(?:cured|smoked|pickled|brined)\b/i, /\bsalted\b(?!\s+butter)/i];

/**
 * A preserved SEASONING — smoked paprika / pimentón / salt / black pepper / chilli flakes,
 * chipotle — whose smoking or salting is not dish-level processing. Only the preserved
 * phrase itself is exempt: "pickled red peppers" or "pickled jalapeño chillies" are
 * preserved vegetables and still read as processed.
 */
const PRESERVED_SEASONING =
  /\b(?:cured|smoked|pickled|brined|salted)\s+(?:(?:sweet|hot|bittersweet|dulce|picante|sea|flaky|rock|dried|ground|crushed)\s+)*(?:paprika|piment[oó]n|salt|(?:black|white)\s+pepper(?:corns?)?|peppercorns?|chil(?:l)?i\s+(?:flakes|powder)|chipotles?(?:\s+(?:powder|flakes))?)\b/gi;

/**
 * The identity part of an ingredient line that markers are read from: alternatives
 * ("butter or margarine", "butter/margarine", "olive oil (or a flavoured oil)") are
 * dropped so only the first-named ingredient counts, and a trailing seasoning clause
 * (", salt and pepper to taste") is dropped so its words don't describe the ingredient.
 * A fraction's slash ("1/2 cup") is not an alternative.
 */
export function identityText(text: string): string {
  return text
    .replace(/\(\s*or\b[^)]*\)/gi, ' ')
    .split(/\s+or\s+|(?<!\d)\s*\/\s*|\s*\/\s*(?!\d)/i)[0]
    .replace(/,\s*(?:(?:and\s+)?(?:salt|(?:freshly\s+)?(?:ground\s+)?(?:black\s+)?pepper)|to taste|season(?:ed|ing)?)\b.*$/i, '')
    .trim();
}

/**
 * The NOVA group an ingredient's original text explicitly signals (4 for an
 * ultra-processed product, 3 for a cured/canned/cheese-type processed food), or null
 * when the text carries no marker. Markers are read from the line's identity part
 * (`identityText`), not from alternatives or seasoning clauses.
 */
export function novaFromText(text: string | null | undefined): NovaGroup | null {
  if (!text) return null;
  const id = identityText(text);
  if (!id) return null;
  if (NOVA4_MARKERS.some((re) => re.test(id))) return 4;
  if (NOVA3_MARKERS.some((re) => re.test(id))) return 3;
  const unseasoned = id.replace(PRESERVED_SEASONING, ' ');
  if (PRESERVED_MARKERS.some((re) => re.test(unseasoned))) return 3;
  return null;
}

/**
 * The matched food's NOVA group, raised to the group its original text signals when
 * that is higher. An unclassified food (null) stays unclassified — text markers
 * refine a classification, they don't place a food the dataset couldn't.
 */
export function promoteNova(
  foodNova: NovaGroup | null | undefined,
  text: string | null | undefined,
): NovaGroup | null {
  if (foodNova == null) return null;
  const marker = novaFromText(text);
  return marker != null && marker > foodNova ? marker : foodNova;
}

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
