# Bundled reference data

## `usda-foods.json`

A subset of [USDA FoodData Central](https://fdc.nal.usda.gov/) (public domain, CC0): per-100g nutrients for common ingredients, used by the in-app ingredient→food matcher (`src/core/match.ts`). Each record carries its `fdcId` for provenance, the food `description`, a `category`, the `n` nutrient block (the fields the macro engine reads), and optional named `portions` (e.g. "1 large" egg → 50 g) for count-unit ingredients.

This file is a curated starter set covering everyday recipe ingredients. Regenerate or expand it from the full FoodData Central download with:

```sh
node scripts/build-usda.mjs
```

The script streams progress, prunes the bulk dataset to the nutrient fields above, and overwrites this file. See the script header for the data sources and field mapping.

All values are **estimates for guidance only** and are confirmed per-ingredient in the authoring review step.
