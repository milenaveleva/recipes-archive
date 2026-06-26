# Bundled reference data

## `usda-foods.json`

The USDA [FoodData Central](https://fdc.nal.usda.gov/) generic reference foods (public domain, CC0): the **Foundation Foods + SR Legacy** datasets (~7,100 foods), each pruned to its per-100g nutrient profile (energy, macros, fat breakdown, and the FDA-label vitamins & minerals), its USDA food `category`, and named `portions` (e.g. "1 large" egg → 50 g) for count-unit ingredients. Each record keeps its `fdcId` for provenance. The Branded set (~400k branded products, ~3 GB) is intentionally excluded — it is not useful for ingredient matching — and the commercial branded products that SR Legacy mixes into the generic data (candy bars, named smoothies, restaurant dishes, infant formula) are filtered out by `scripts/usda-brands.mjs`, so an "apple" query never lands on "Candies, NESTLE …". The same filter drops enriched (fortified) grain forms — flour, bread, cornmeal, pasta and rice with iron/folate/niacin/thiamin added back — in favour of the base food, so a grain ingredient resolves to its unenriched form rather than the fortified one ("unenriched" entries are kept).

The file is several MB, so the authoring island fetches it **lazily** via its asset URL (a `?url` import in `addLib.ts`) rather than bundling it; it is never shipped to the public recipe pages.

Regenerate it (needs `curl` and `unzip`; no API key required) with:

```sh
node scripts/build-usda.mjs
```

The script downloads both bulk datasets, prunes them to the fields above, dedupes by `fdcId`, drops branded products and enriched grain forms (`scripts/usda-brands.mjs`), and overwrites this file — so a re-ingest reproduces the cleaned dataset rather than reintroducing them. See the script header for the dataset URLs and the nutrient-number → field mapping.

To re-apply the brand filter to the committed file without re-downloading (e.g. after editing the filter, its denylist `usda-exclude.json`, or its keep-list), run `node scripts/prune-branded.mjs` (`--dry-run` to preview). Both entry points refuse to write if filtering would orphan a `food-scoring.json` entry.

## `food-scoring.json`

Hand-curated, cited scoring metadata for a **subset** of the foods above, keyed by `fdcId` and merged at author time by the glycemic engine (`src/core/gi.ts`) and the matcher. It covers the common ingredients we hold cited values for; foods without an entry still contribute nutrients (and macros/Nutri-Score/inflammation), just no GI. Kept separate from `usda-foods.json` so regenerating the USDA nutrients never wipes the curated values. Per food, optional:

- `gi` + `giSource` + `giConfidence` — the food's glycemic index, transcribed and cited per value (Atkinson 2021 international GI tables). Only carbohydrate-bearing foods carry a GI.
- `fvl` — whether the food counts toward Nutri-Score's fruit/vegetables/legumes share. Curated `fvl` takes precedence; otherwise it is approximated from the USDA category (fruits/vegetables/legumes, excluding starchy tubers, nuts, oils, juices and obviously-processed forms). This category heuristic is coarse — like all scores it is an estimate, confirmed per-ingredient in the review step.

The matcher prefers foods we hold curated data for among equally-good text matches, so a common ingredient lands on its better-documented food. When `food-scoring.json` gains a new carbohydrate-bearing food, add its GI here so the glycemic composite stays complete. (Inflammation is computed from composition by the FII, below, not curated here.)

All values are **estimates for guidance only** and are confirmed per-ingredient in the authoring review step.

## Food Inflammation Index data

The inflammation score is a per-food inflammatory potential computed from composition (`src/core/fii.ts`), corrected by a small composition-blind food-form adjustment, energy-weighted across a recipe and banded by quantile of the food reference distribution (`src/core/inflammation.ts`). Five files back it:

- `fii-parameters.json` — the parameter table: which per-100g signals score, each one's direction (anti/pro) and weight, with a citation. Anti: fat quality (`(MUFA+PUFA) − (SFA+trans)`, one derived term so fat is scored once by quality), fibre, vitamins C and E, magnesium, polyphenols. Pro: free sugar, sodium. Two parameters are derived rather than read off the vector: `fatQuality_g` (above) and `freeSugar_g = max(0, sugar − 2·fibre)`, which estimates the free-sugar fraction from the 1:2 fibre:free-sugar carbohydrate-quality ratio so a whole food's intrinsic, matrix-bound sugar is not penalised like a refined sugar. Directions come from open biomarker literature, never the licensed DII effect-score constants.
- `inflammation-reference.json` — **generated** by `scripts/build-inflammation-reference.mjs`: the open reference distribution (per-nutrient robust centre/scale over the USDA corpus, the corpus centre/scale of the raw FII that each food is standardised against, and the `bands` — the quintile edges of the per-food tag distribution, so a recipe's band reflects where its score sits among single foods). Re-run the script after editing `fii-parameters.json` or `polyphenols.json`.
- `polyphenols.json` — **generated** total polyphenols (mg/100g) per `fdcId`, merged into the nutrient vector as `polyphenol_mg` (USDA carries no polyphenol column). Built by `scripts/build-phenol-explorer.mjs <export.csv> <crosswalk.json>` from the **Phenol-Explorer** "Complete composition data" export: the single Folin-Ciocalteu "Polyphenols, total" value per food (not a sum of the per-compound rows, which would double-count across the export's several analytical methods). The polyphenol referent is one-sided — centred at 0 (no measurable polyphenols = baseline) with the scale set to the median content of the foods that carry a value — so a low-polyphenol food never reads pro-inflammatory. The raw export CSV is a local build input (git-ignored); the derived per-food totals and the crosswalk are committed.
- `phenol-crosswalk.json` — the hand-audited join from Phenol-Explorer food name → USDA `fdcId` that `build-phenol-explorer.mjs` reads. One `fdcId` per entry, verified by eye (form + identity must agree); foods our recipes use map to the recipe's own `fdcId`. Phenol-Explorer foods absent from it are reported as unmatched on a run — extend it as new recipes need them.
- `food-adjustments.json` — composition-blind food-form deltas per `fdcId` (`src/core/foodAdjust.ts`): a small cited additive correction to the per-food tag for inflammatory signals composition cannot carry. Seeded with fermented dairy — yogurt and cheese read falsely pro-inflammatory from their saturated fat and sodium (and, for dairy, intrinsic lactose the free-sugar estimate over-penalises), yet are anti-inflammatory in trials. Each delta's direction is evidence-based; its magnitude is a calibration value, like the energy mass floor.

After changing any of these, regenerate the reference (`node scripts/build-inflammation-reference.mjs`) and rescore the recipes (`node scripts/score-recipes-inflammation.mjs`).

### Calibration and scope

The FII is a reproducible, composition-derived estimate, not a biomarker-validated index: its parameter weights and the mass floor are principled choices, and the bands are quantiles of the food (not recipe-outcome) distribution. It is deliberately *not* calibrated against measured inflammatory biomarkers, for two reasons. First, scope: biomarker calibration regresses a *per-person, whole-diet* intake on that person's blood markers (e.g. NHANES 24-hour recalls against hs-CRP, by reduced-rank / stepwise regression, as the EDIP and Dietary Inflammation Score were built), so it needs an external paired diet-plus-biomarker cohort whose foods are keyed by NHANES's FNDDS food codes with no polyphenol values — a different artifact from this archive's per-food USDA composition vectors (keyed by `fdcId`), not a refit of the index that ships. Second, ceiling: even a fully calibrated whole-diet inflammation index explains under ~2% of the variance in inflammatory biomarkers (EPIC cohort, n ≈ 17,600; Lécuyer 2023) — about the share explained by smoking status, and far below body weight — because circulating CRP is dominated by adiposity, genetics and infection, which a food-composition index cannot see. The achievable gain from calibration is therefore bounded near zero, so the FII stays a coarse *relative* estimate by design. It is worth revisiting only if paired per-person diet-and-biomarker data is acquired for some independent reason.
