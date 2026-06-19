# Bundled reference data

## `usda-foods.json`

A subset of [USDA FoodData Central](https://fdc.nal.usda.gov/) (public domain, CC0): per-100g nutrients for common ingredients, used by the in-app ingredient→food matcher (`src/core/match.ts`). Each record carries its `fdcId` for provenance, the food `description`, a `category`, the `n` nutrient block (the fields the macro engine reads), and optional named `portions` (e.g. "1 large" egg → 50 g) for count-unit ingredients.

This file is a curated starter set covering everyday recipe ingredients. Regenerate or expand it from the full FoodData Central download with:

```sh
node scripts/build-usda.mjs
```

The script streams progress, prunes the bulk dataset to the nutrient fields above, and overwrites this file. See the script header for the data sources and field mapping.

## `food-scoring.json`

Hand-curated scoring metadata for the foods above, keyed by `fdcId` and merged at author time by the scoring engines (`src/core/gi.ts`, `nutriscore.ts`, `inflammation.ts`). It is kept separate from `usda-foods.json` so regenerating the USDA nutrients never wipes the curated values. Per food, optional:

- `gi` + `giSource` + `giConfidence` — the food's glycemic index, transcribed and cited per value (Atkinson 2021 international GI tables). Only carbohydrate-bearing foods carry a GI.
- `inflammation` — an inflammation tag in −2..+2 (anti- to pro-inflammatory), grounded in biomarker-validated food-group indices (Tabung 2016 EDIP; Kałuża 2025 eADI).
- `fvl` — whether the food counts toward Nutri-Score's fruit/vegetables/legumes share (starchy tubers, nuts and oils excluded per the 2023 algorithm).

When `usda-foods.json` gains a new carbohydrate-bearing food, add its GI here so the glycemic composite stays complete.

All values are **estimates for guidance only** and are confirmed per-ingredient in the authoring review step.
