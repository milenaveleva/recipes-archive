# Bundled reference data

## `usda-foods.json`

The USDA [FoodData Central](https://fdc.nal.usda.gov/) generic reference foods (public domain, CC0): the **Foundation Foods + SR Legacy** datasets (~7,100 foods), each pruned to its per-100g nutrient profile (energy, macros, fat breakdown, and the FDA-label vitamins & minerals), its USDA food `category`, and named `portions` (e.g. "1 large" egg → 50 g) for count-unit ingredients. Each record keeps its `fdcId` for provenance. The Branded set (~400k branded products, ~3 GB) is intentionally excluded — it is not useful for ingredient matching — and the commercial branded products that SR Legacy mixes into the generic data (candy bars, named smoothies, restaurant dishes, infant formula) are filtered out by `scripts/usda-brands.mjs`, so an "apple" query never lands on "Candies, NESTLE …".

The file is several MB, so the authoring island fetches it **lazily** via its asset URL (a `?url` import in `addLib.ts`) rather than bundling it; it is never shipped to the public recipe pages.

Regenerate it (needs `curl` and `unzip`; no API key required) with:

```sh
node scripts/build-usda.mjs
```

The script downloads both bulk datasets, prunes them to the fields above, dedupes by `fdcId`, drops branded products (`scripts/usda-brands.mjs`), and overwrites this file — so a re-ingest reproduces the cleaned dataset rather than reintroducing brands. See the script header for the dataset URLs and the nutrient-number → field mapping.

To re-apply the brand filter to the committed file without re-downloading (e.g. after editing the filter, its denylist `usda-exclude.json`, or its keep-list), run `node scripts/prune-branded.mjs` (`--dry-run` to preview). Both entry points refuse to write if filtering would orphan a `food-scoring.json` entry.

## `food-scoring.json`

Hand-curated, cited scoring metadata for a **subset** of the foods above, keyed by `fdcId` and merged at author time by the glycemic engine (`src/core/gi.ts`) and the matcher. It covers the common ingredients we hold cited values for; foods without an entry still contribute nutrients (and macros/Nutri-Score/inflammation), just no GI. Kept separate from `usda-foods.json` so regenerating the USDA nutrients never wipes the curated values. Per food, optional:

- `gi` + `giSource` + `giConfidence` — the food's glycemic index, transcribed and cited per value (Atkinson 2021 international GI tables). Only carbohydrate-bearing foods carry a GI.
- `fvl` — whether the food counts toward Nutri-Score's fruit/vegetables/legumes share. Curated `fvl` takes precedence; otherwise it is approximated from the USDA category (fruits/vegetables/legumes, excluding starchy tubers, nuts, oils, juices and obviously-processed forms). This category heuristic is coarse — like all scores it is an estimate, confirmed per-ingredient in the review step.

The matcher prefers foods we hold curated data for among equally-good text matches, so a common ingredient lands on its better-documented food. When `food-scoring.json` gains a new carbohydrate-bearing food, add its GI here so the glycemic composite stays complete. (Inflammation is no longer curated here — it is computed from composition by the FII, below.)

All values are **estimates for guidance only** and are confirmed per-ingredient in the authoring review step.

## Food Inflammation Index data

The inflammation score is a per-food inflammatory potential computed from composition (`src/core/fii.ts`), corrected by a small composition-blind food-form adjustment, energy-weighted across a recipe and banded by quantile of the food reference distribution (`src/core/inflammation.ts`). Four files back it:

- `fii-parameters.json` — the parameter table: which per-100g signals score, each one's direction (anti/pro) and weight, with a citation. Anti: fat quality (`(MUFA+PUFA) − (SFA+trans)`, one derived term so fat is scored once by quality), fibre, vitamins C and E, magnesium, polyphenols. Pro: free sugar, sodium. Two parameters are derived rather than read off the vector: `fatQuality_g` (above) and `freeSugar_g = max(0, sugar − 2·fibre)`, which estimates the free-sugar fraction from the 1:2 fibre:free-sugar carbohydrate-quality ratio so a whole food's intrinsic, matrix-bound sugar is not penalised like a refined sugar. Directions come from open biomarker literature, never the licensed DII effect-score constants.
- `inflammation-reference.json` — **generated** by `scripts/build-inflammation-reference.mjs`: the open reference distribution (per-nutrient robust centre/scale over the USDA corpus, the corpus centre/scale of the raw FII that each food is standardised against, and the `bands` — the quintile edges of the per-food tag distribution, so a recipe's band reflects where its score sits among single foods). Re-run the script after editing `fii-parameters.json` or `polyphenols.json`.
- `polyphenols.json` — total polyphenols (mg/100g) per `fdcId`, merged into the nutrient vector as `polyphenol_mg` (USDA carries no polyphenol column). Sourced from **Phenol-Explorer**: the committed file is a small cited seed (Pérez-Jiménez 2010) for the foods our recipes use, replaced wholesale by `scripts/build-phenol-explorer.mjs <export.csv> <crosswalk.json>` once the registration-gated export is downloaded.
- `food-adjustments.json` — composition-blind food-form deltas per `fdcId` (`src/core/foodAdjust.ts`): a small cited additive correction to the per-food tag for inflammatory signals composition cannot carry. Seeded with fermented dairy — yogurt and cheese read falsely pro-inflammatory from their saturated fat and sodium (and, for dairy, intrinsic lactose the free-sugar estimate over-penalises), yet are anti-inflammatory in trials. Each delta's direction is evidence-based; its magnitude is a calibration value, like the energy mass floor.

After changing any of these, regenerate the reference (`node scripts/build-inflammation-reference.mjs`) and rescore the recipes (`node scripts/score-recipes-inflammation.mjs`).

### FII calibration roadmap

The FII is a reproducible, composition-derived estimate, not a biomarker-validated index. Its parameter weights and the mass floor are principled calibration choices, and the bands are quantiles of the food (not recipe-outcome) distribution. The path to an empirically-grounded version is to validate and recalibrate against measured biomarkers: compute the FII for each NHANES participant's 24-hour recalls, regress it on their hs-CRP, re-fit the parameter weights (reduced-rank / stepwise regression, as the EDIP and Dietary Inflammation Score were built), and anchor the bands to CRP tertiles. That study needs the public NHANES dietary + biomarker download and is scoped as its own phase; even fully calibrated, whole-diet inflammation indices explain under ~2% of biomarker variance (diet is a small part of what drives CRP), so the score stays a coarse relative estimate by design.
