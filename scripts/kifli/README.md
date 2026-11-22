# kifli.hu import

Imports the owner's kifli.hu Séf favourites as English recipes in the list `Kifli favourites`, built through the same authoring engine as `/add` (`src/components/add/addLib.ts` + `src/core/markdown.ts`). Intermediate data lives under `scripts/data-raw/kifli/` (git-ignored): `raw/<id>.json` and `img/<id>.jpg` from the fetcher, `en/<id>.json` translations.

## Pipeline

1. **Sweep favourite ids** in a logged-in browser at `https://www.kifli.hu/sef/receptek/favourites`. Its `__NEXT_DATA__` lists only the first 100 `recipesIds`, and path segments AND-combine filters (`/sef/receptek/favourites/<filter>[/<filter>]`), so union the ids across every filter option. Skip ids already imported (a recipe whose `source.url` contains the id).
2. **Fetch**: `node scripts/kifli/fetch.mjs <id,id,...>` or `--ids-file ids.txt` (add `--force` to refetch). The detail page `https://www.kifli.hu/sef/<id>` is public; the script reads its `recipe-detail` and `recipe-nutritions` queries, writes `raw/<id>.json` and a JPEG hero image (`sips`, q70, max 1000 px). Max 3 requests in flight.
3. **Translate** each `raw/<id>.json` to `en/<id>.json` (format below), applying the ingredient rules. Drop meat-main recipes entirely.
4. **Check**: `node scripts/kifli/build.mjs --check [--ids a,b]` prints our kcal/serving against kifli's, each ingredient's status (`ok` / `NOMATCH` / `NOGRAMS` / `EXCL`) with its matched food, grams and cooking method, and the validation gate's findings. Fix the en JSON (`food`, `fdcId`, `grams`) until every line is `ok` or a deliberate `EXCL`.
5. **Write**: `node scripts/kifli/build.mjs --write [--ids a,b]` writes `src/content/recipes/<slug>.md` and `images/<slug>.jpg`. Without `--ids` only ids not yet imported are written. It replaces a file only when that file is the kifli import of the same recipe; a slug taken by any other recipe gets a `-<id>` suffix, and nothing is ever deleted.
6. **Rescore and verify**: `node scripts/rescore-recipes.mjs`, `node scripts/validate-recipes.mjs`, `node scripts/score-diff.mjs`.

## `en/<id>.json`

```json
{
  "id": 12864,
  "title": "Penne with Roasted Pepper and Tomato Sauce",
  "description": "One or two sentences.",
  "cuisine": "Italian",
  "course": "Main Course",
  "servings": 4,
  "nutriCategory": "general",
  "redMeat": false,
  "ingredients": [
    { "hu": "250 g teljes kiőrlésű penne tészta", "en": "250 g dry whole-wheat penne", "group": "Main ingredients", "food": "whole-wheat pasta dry", "cooking": "boiled" },
    { "hu": "2 gerezd fokhagyma", "en": "2 cloves garlic", "grams": 6, "cooking": "fried" },
    { "hu": "200 ml víz", "en": "200 ml water", "fdcId": 174158, "exclude": true, "cooking": "raw" }
  ],
  "steps": ["One method step per entry."],
  "tips": ["Optional; rendered as a ## Tips list."]
}
```

Per ingredient, `en` is the stored `raw` line and is parsed by the engine. Optional overrides, applied in this order:

- `food`: a search phrase; its best non-low-confidence match replaces the line's own match when it scores at least as well.
- `fdcId`: pins the USDA food (always wins over `food`).
- `grams`: used when the engine finds no weight, or when the unit is a count rather than a mass/volume (cloves, handfuls, pieces).
- `forceGrams`: overrides the weight unconditionally.
- `cooking`: one of `raw`, `boiled`, `steamed`, `baked`, `grilled`, `fried`, `blanched`, `microwaved`.
- `exclude`: excludes the line from nutrition. `proxyOk`: marks the chosen food as a reviewed stand-in. `group`: the ingredient group heading.

`prepTime`/`cookTime`, author, source URL, image and the source's kcal come from `raw/<id>.json`. The source kcal per serving is stored only when kifli's serving label is in portions (`adag`), rescaled to our serving count.

## Ingredient rules

- No meat-main dishes. Incidental meat is swapped (vegetable broth for meat stock, olive oil for animal fat) or removed when optional.
- Milk → unsweetened oat milk.
- Butter and ghee → extra virgin olive oil at 75 % of the butter weight.
- Cream (cooking, heavy, whipping, double, single or light cream; `tejszín`, `főzőtejszín`, `habtejszín`) → plant-based cooking cream at the same volume, pinned to `82011214` with grams ≈ ml × 1.0; cream whipped for desserts → plant-based whipping cream. Coconut cream, cream cheese, ice cream, "cream of …" soups and cashew cream stay as they are.
- Sour cream (`tejföl`) → plant-based sour cream pinned to `82019693`; crème fraîche → plant-based crème fraîche pinned to `82011214`. Amounts stay the same.
- No wine of any kind, including sherry, port, marsala and vermouth (→ the same volume of vegetable broth plus a squeeze of lemon juice, or a splash of wine vinegar for red-wine dishes, about 1 tbsp per 100 ml; risotto → broth). Dishes named after wine are retitled. Mirin, sake, rice vinegar and wine vinegar stay.
- No mayonnaise (→ Greek yogurt), spirits or beer.
- Refined grains → the whole-grain version of the same type (whole-wheat pasta, flour, bread, couscous; brown rice).
- Honey is the only sweetener. Yeast and yeast doughs are allowed.
- Cooked or canned staples (pasta, rice, pulses) are stored as the raw dry-matter equivalent with the cooked amount kept in the line, e.g. `500 g cooked brown rice (≈ 168 g uncooked)` with `forceGrams: 168`.
- Spices and salt in tsp/tbsp/pinch, never grams; juices in ml.
- Water and ice are excluded from nutrition and pinned to `174158`.
- Every ingredient gets an explicit cooking method, read from the method steps.
