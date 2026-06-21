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

Hand-curated, cited scoring metadata for a **subset** of the foods above, keyed by `fdcId` and merged at author time by the scoring engines (`src/core/gi.ts`, `nutriscore.ts`, `inflammation.ts`). It covers the common ingredients we hold cited values for; foods without an entry still contribute nutrients (and macros/Nutri-Score), just no GI or inflammation tag. Kept separate from `usda-foods.json` so regenerating the USDA nutrients never wipes the curated values. Per food, optional:

- `gi` + `giSource` + `giConfidence` — the food's glycemic index, transcribed and cited per value (Atkinson 2021 international GI tables). Only carbohydrate-bearing foods carry a GI.
- `inflammation` — an inflammation tag in −2..+2 (anti- to pro-inflammatory), grounded in biomarker-validated food-group indices (Tabung 2016 EDIP; Kałuża 2025 eADI).
- `fvl` — whether the food counts toward Nutri-Score's fruit/vegetables/legumes share. Curated `fvl` takes precedence; otherwise it is approximated from the USDA category (fruits/vegetables/legumes, excluding starchy tubers, nuts, oils, juices and obviously-processed forms). This category heuristic is coarse — like all scores it is an estimate, confirmed per-ingredient in the review step.

The matcher prefers foods we hold curated data for among equally-good text matches, so a common ingredient lands on its better-documented food. When `food-scoring.json` gains a new carbohydrate-bearing food, add its GI here so the glycemic composite stays complete.

All values are **estimates for guidance only** and are confirmed per-ingredient in the authoring review step.
