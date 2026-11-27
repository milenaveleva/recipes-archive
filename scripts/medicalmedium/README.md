# Medical Medium import

Imports recipes from the Medical Medium recipe index (`https://www.medicalmedium.com/medical-medium-categories/all-medical-medium-recipes`) into the list `Medical Medium`, built through the same authoring engine and house rules as the kifli import (`scripts/kifli/README.md`). Intermediate data lives under `scripts/data-raw/medicalmedium/` (git-ignored): `index.json`, `raw/<slug>.json` from the fetcher, `en/<slug>.json` rewrites.

The source pages are "All Rights Reserved", and the archive deploys publicly, so an import keeps only the facts of a recipe (its ingredients, quantities, servings and timings) and writes everything else fresh: the description and every method step are rewritten in our own words, never copied or closely paraphrased, and the source's health or spiritual claims are left out. Photos are not copied: the recipe links the source image through `imageUrl`, and `source.url` always points back to the page.

## Pipeline

1. **Index**: `node scripts/medicalmedium/fetch.mjs --list` walks the paginated index until a page adds no new `/blog/<slug>` link and writes `index.json`.
2. **Fetch**: `node scripts/medicalmedium/fetch.mjs --all` (or `<slug,slug,...>`, `--force` to refetch) parses each page into `raw/<slug>.json`: title, image URL, posted date, intro paragraphs, and `recipes[]` (one per "Ingredients:" block) with ingredient groups, direction paragraphs and the "Serves" text. Max 3 requests in flight.
3. **Rewrite** each recipe page into `en/<slug>.json` (format below), applying the ingredient rules. A page with no recipe block (a roundup such as "10 Snacks For Adrenal Health") is skipped; a page holding several recipes becomes one file per recipe, `en/<slug>--<n>.json` for the second and later ones.
4. **Check / write / rescore**: as for kifli (`build.mjs --check`, `--write`, then `rescore-recipes.mjs`, `validate-recipes.mjs`, `score-diff.mjs`).

## `en/<slug>.json`

Same shape as the kifli `en/<id>.json`, with `id` the file name (a slug) and the original line kept as `orig` instead of `hu`:

```json
{
  "id": "apple-crisp",
  "title": "Apple Crisp",
  "description": "One or two sentences, written fresh.",
  "cuisine": "American",
  "course": "Dessert",
  "servings": 6,
  "prepMin": 15,
  "cookMin": 45,
  "nutriCategory": "general",
  "ingredients": [
    { "orig": "4 red apples, chopped", "en": "4 red apples, chopped", "group": "Filling", "grams": 720, "cooking": "baked" }
  ],
  "steps": ["One method step per entry, in our own words."]
}
```

`servings` is the lower end of a range ("6-8" → 6). `prepMin`/`cookMin` are read from the method when it states times, else omitted. Ingredient override fields (`food`, `fdcId`, `grams`, `forceGrams`, `cooking`, `exclude`, `proxyOk`, `group`) work as in the kifli README.

## Ingredient rules

The kifli ingredient rules apply unchanged (`scripts/kifli/README.md` § Ingredient rules). Points that come up often in these recipes:

- Maple syrup, coconut sugar and other sweeteners → raw honey at the same volume (vegan dishes may use Medjool dates instead).
- "Gluten-free" grains keep their type and use the whole-grain form (gluten-free rolled oats stay rolled oats; rice is brown rice).
- An "optional: sub …" or "… or …" alternative keeps the first-named ingredient only; the alternative may become a tip.
- The "Brain Shot Therapy" juice shots (pages named "… Shifter", "… Stabilizer", "… Exposure", and the cilantro, parsley and turmeric-ginger shots) are imported as drinks titled by their main ingredients, e.g. "Mint, Sage & Mango Juice Shot"; the source's name and its claim of what the shot is for are left out.
- Supplements and powders sold by the source (e.g. "barley grass juice powder", "spirulina") stay when they are a real ingredient of the dish.
