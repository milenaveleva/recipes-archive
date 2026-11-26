# kifli.hu import

Imports the owner's kifli.hu Séf favourites as English recipes in the list `Kifli favourites`, built through the same authoring engine as `/add` (`src/components/add/addLib.ts` + `src/core/markdown.ts`). Intermediate data lives under `scripts/data-raw/kifli/` (git-ignored): `raw/<id>.json` and `img/<id>.jpg` from the fetcher, `en/<id>.json` translations.

## Pipeline

1. **Sweep favourite ids** in a logged-in browser at `https://www.kifli.hu/sef/receptek/favourites`. Its `__NEXT_DATA__` lists only the first 100 `recipesIds`, and path segments AND-combine filters (`/sef/receptek/favourites/<filter>[/<filter>]`), so union the ids across every filter option. Skip ids already imported (a recipe whose `source.url` contains the id) and the near-duplicates listed in `excluded-ids.json` (kifli publishes some dishes twice; the value names the kept copy). `build.mjs --write` skips both automatically.
2. **Fetch**: `node scripts/kifli/fetch.mjs <id,id,...>` or `--ids-file ids.txt` (add `--force` to refetch). The detail page `https://www.kifli.hu/sef/<id>` is public; the script reads its `recipe-detail` and `recipe-nutritions` queries, writes `raw/<id>.json` and a JPEG hero image (`sips`, q70, max 1000 px). Max 3 requests in flight.
3. **Translate** each `raw/<id>.json` to `en/<id>.json` (format below), applying the ingredient rules. Drop meat-main recipes entirely.
4. **Check**: `node scripts/kifli/build.mjs --check [--ids a,b]` prints our kcal/serving against kifli's, each ingredient's status (`ok` / `NOMATCH` / `NOGRAMS` / `EXCL`) with its matched food, grams and cooking method, the house-rule auto-fixes it applied (`fixed …`), and the validation gate's findings. Fix the en JSON (`food`, `fdcId`, `grams`) until every line is `ok` or a deliberate `EXCL`; a recipe that still breaks a house rule after the auto-fixes is marked `WOULD BE REFUSED`.
5. **Write**: `node scripts/kifli/build.mjs --write [--ids a,b]` writes `src/content/recipes/<slug>.md` and `images/<slug>.jpg`. Without `--ids` only ids not yet imported are written. It replaces a file only when that file is the kifli import of the same recipe; a slug taken by any other recipe gets a `-<id>` suffix, and nothing is ever deleted.
6. **Rescore and verify**: `node scripts/rescore-recipes.mjs`, `node scripts/validate-recipes.mjs`, `node scripts/score-diff.mjs`.

## Full catalogue

1. **Enumerate**: `node scripts/kifli/catalog-ids.mjs` walks the public listing `https://www.kifli.hu/sef/receptek` and its AND-combined filter paths, writing `catalog-ids.txt` (and `catalog-ids.failed.txt` for combinations the server rendered without recipe data; `--resume <combos.txt>` retries them). The listing caps every combination at 100 ids, and recipes carrying no tag beyond their author cannot be reached this way, so ids inside the enumerated range that the filters miss are probed directly with the fetcher and the hits recorded in `catalog-ids-probed.txt`.
2. **Fetch without images**: `node scripts/kifli/fetch.mjs --ids-file scripts/data-raw/kifli/catalog-ids.txt --no-images`. A later run without `--no-images` adds just the missing images for ids already cached.
3. **Classify**: `node scripts/kifli/classify.mjs --ids-file <ids>` writes `catalog-classes.json` — per recipe `{id, name, author, authorType, class, meatLines, reason, decidedBy}` with `class` one of `pescatarian`, `optional-meat` (meat only as a swappable stock/fat/gelatin, an optional or garnish line, or a minor removable flavouring) or `meat-main`, and `authorType` `ai` for "Kifli Kukták". A Hungarian meat lexicon decides the clear cases; anything borderline is flagged `needsReview` until a manual decision is added to `catalog-overrides.json` (`{"<id>": {"class", "reason"}}`). An unqualified `alaplé` counts as vegetable stock.

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
- `grams`: used when the engine finds no weight, or when the unit is a count rather than a mass/volume (cloves, pieces).
- `forceGrams`: overrides the weight unconditionally.
- `cooking`: one of `raw`, `boiled`, `steamed`, `baked`, `grilled`, `fried`, `blanched`, `microwaved`.
- `exclude`: excludes the line from nutrition. `proxyOk`: marks the chosen food as a reviewed stand-in. `group`: the ingredient group heading.

`prepTime`/`cookTime`, author, source URL, image and the source's kcal come from `raw/<id>.json`. The source kcal per serving is stored only when kifli's serving label is in portions (`adag`), rescaled to our serving count.

## Ingredient rules

These rules are enforced automatically, in one shared module, `src/core/houseRules.ts`:

- **Gate** — `checkHouseRules` runs inside the validation gate (`src/core/validate.ts`), so a violation fails `node scripts/validate-recipes.mjs`, the all-recipes test and the build, and shows live in /add, where an error blocks the commit. Codes: `FORBIDDEN_INGREDIENT`, `FORBIDDEN_WORDING`, `MEAT_SUGGESTION`, `NOT_DRY_STAPLE`, `PORTION_80`, `DRINK_WATER` (errors), `OLIVE_OIL_UNIT`, `EGG_COUNT`, `DUPLICATE_RECIPE` (warnings); see `src/data/README.md`.
- **Auto-fix** — `normalizeRecipe` rewrites every import before it is compiled: `build.mjs` applies it to each `en/<id>.json` (and prints the list of fixes), and /add applies it to the rows parsed from a URL import, pasted text or typed lines (and lists the fixes under the ingredients). Swaps: butter / ghee → extra virgin olive oil at 75 % of the weight; milk → unsweetened oat milk (`82018905`); cream → plant-based cooking or whipping cream (`82011214`); sour cream → `82019693`; crème fraîche → `82011214`; mayonnaise → Greek yogurt; wine → vegetable broth plus lemon juice (red wine: red wine vinegar), about 1 tbsp per 100 ml; beer and spirits → vegetable broth (in a drink the line is dropped); refined grains → the whole-grain version of the same type; sugar and syrups → honey at the same amount. It also converts canned / cooked / fresh staples to the dry record by dry matter (water content of the two records; a 400 g can drains to 240 g) with the note `dry, soaked and cooked` or `dry, cooked` and the matching method step, writes handfuls in grams, olive oil in spoons, eggs as a count, moves state words to the note (`dry`, `unsweetened`, herb `fresh`), sets a main course's single pasta / grain line to servings × 80 g (servings never change), and in a drink counts the water and ice, brews the tea or coffee into its record and excludes strained infusers. The method follows the swaps (butter → olive oil, wine → broth, sugar → honey); a substitution is never annotated.
- **Refusal** — `build.mjs --write` refuses (never writes) a recipe that still has a house-rule error after the auto-fixes, printing the reasons.

Rules that need a human (a meat-main dish, meat in a line with no automatic swap) are reported, not fixed.

- No meat-main dishes. Incidental meat is swapped (vegetable broth for meat stock, olive oil for animal fat) or removed when optional.
- Milk → unsweetened oat milk.
- Butter and ghee → extra virgin olive oil at 75 % of the butter weight. Olive oil is always written in tablespoons (13.5 g per tbsp; teaspoons under ½ tbsp). No line uses "handful": herbs, leaves, nuts and berries are written in grams. A substitution is never annotated on the line or in the method ("in place of butter", "instead of rice noodles"): the recipe simply uses the new ingredient.
- Cream (cooking, heavy, whipping, double, single or light cream; `tejszín`, `főzőtejszín`, `habtejszín`) → plant-based cooking cream at the same volume, pinned to `82011214` with grams ≈ ml × 1.0; cream whipped for desserts → plant-based whipping cream. Coconut cream, cream cheese, ice cream, "cream of …" soups and cashew cream stay as they are.
- Sour cream (`tejföl`) → plant-based sour cream pinned to `82019693`; crème fraîche → plant-based crème fraîche pinned to `82011214`. Amounts stay the same.
- No wine of any kind, including sherry, port, marsala and vermouth (→ the same volume of vegetable broth plus a squeeze of lemon juice, or a splash of wine vinegar for red-wine dishes, about 1 tbsp per 100 ml; risotto → broth). Dishes named after wine are retitled. Mirin, sake, rice vinegar and wine vinegar stay.
- No mayonnaise (→ Greek yogurt), spirits or beer.
- Refined grains → the whole-grain version of the same type (whole-wheat pasta, flour, bread; brown rice). Couscous stays plain: whole-wheat couscous is rarely sold and no national table measures it.
- Honey is the only sweetener. Yeast and yeast doughs are allowed.
- Cooked or canned staples (pasta, rice, pulses) are listed in their raw/dry form at the raw dry-matter weight, with the preparation as the note and the method cooking them from dry, e.g. `168 g brown rice, dry, cooked` with `forceGrams: 168`. The note says `dry`, never `dried` or `uncooked`.
- A main course's pasta or grain is 80 g dry per serving; a pasta frittata is exempt.
- Spices and salt in tsp/tbsp/pinch, never grams; juices in ml.
- Water and ice are pinned to plain water (`174158`). In a dish they are excluded from nutrition; in a drink every water, soda-water and ice line that ends up in the glass carries grams and counts, because Nutri-Score profiles a beverage as drunk (ice counts as its melted weight).
- Drinks list a steeped solid together with its water as the brewed beverage (`250 ml black tea, brewed from 1 tbsp loose leaves` → `173227`; green tea `171917`; coffee `171890`). Whole spices, ginger slices, herb sprigs and fruit that only infuse and are strained out or left behind are `exclude`d; blended or pressed produce that is drunk stays counted.
- Every ingredient gets an explicit cooking method, read from the method steps.
