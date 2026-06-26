# mili’s ~~hedonistic~~ cookbook

A personal recipe-management web app — import recipes by link or write them by hand, store each one as a **uniform metric markdown file**, and browse them as a beautiful recipe book. Every recipe shows its **macros, glycemic index (GI), glycemic load (GL), inflammation score, nutrition score (Nutri-Score 2023), and a 1–10 nutrient-balance score (NRF9.3 nutrient density)**.

Built as a fully static [Astro](https://astro.build) site, deployed to GitHub Pages. Recipes are the source of truth — versioned markdown in `src/content/recipes/`.

> **Live site:** https://milenaveleva.github.io/recipes-archive/

## Tech stack

- **Astro 6** — content collections with Zod-typed frontmatter; near-zero JS, interactive islands only where needed.
- **Tailwind CSS v4** (`@tailwindcss/vite`) — "modern heirloom cookbook" design system (Fraunces / Newsreader / Hanken Grotesk, paper + terracotta palette).
- **GitHub Pages** via `withastro/action` — static hosting, no backend.
- _Planned (Phase 1):_ React islands (`@astrojs/react`) for the in-app authoring UI.

## Develop

```sh
npm install        # install dependencies
npm run dev        # local dev server (http://localhost:4321/recipes-archive)
npm run build      # production build to dist/
npm run preview    # preview the production build
```

> This repo pins `vite` to a single version via `overrides` so Astro and the Tailwind/React plugins share one Vite instance — do not remove it without re-checking the build.

## How recipes are stored

Each recipe is one markdown file: rich YAML frontmatter (structured, metric ingredients + a precomputed nutrition/score block) plus prose method steps in the body. See [`src/content.config.ts`](src/content.config.ts) for the full schema and any file in `src/content/recipes/` for an example.

## Roadmap

- **Phase 0 (done)** — static recipe book: schema, index/detail/taxonomy pages, score medallions, GitHub Pages deploy.
- **Phase 1** — in-browser authoring at [`/add`](https://milenaveleva.github.io/recipes-archive/add): sign in with GitHub, paste a URL (fetched via a Cloudflare Worker CORS proxy) or fill a form → review each ingredient's USDA match → auto-convert to metric → compute macros → commit the markdown to the repo. The Worker (see [`worker/`](worker/)) also runs the GitHub sign-in token exchange; set its URL as `PUBLIC_IMPORT_PROXY` at build time. Anyone can sign in, but only repository collaborators can publish.
- **Phase 2 (done)** — every recipe is scored in-app: a carb-weighted composite **glycemic index/load** (GI values transcribed from Atkinson 2021), the general-foods **Nutri-Score 2023** grade, a composition-derived **Food Inflammation Index** (per-food inflammatory potential from fat quality, fibre, antioxidant micronutrients, polyphenols and an estimated free-sugar penalty, plus a small composition-blind food-form adjustment for signals composition can't see such as fermentation, energy-weighted across the recipe and banded by quantile of the food reference distribution), and a 1–10 **nutrient-balance score** (the NRF9.3 nutrient-density index per 100 kcal). Scores are precomputed at author time into the markdown and shown as medallions.
- **Phase 3 (done)** — discovery on the home page: a fuzzy search box (Fuse.js, over titles, descriptions, ingredients and method text) and faceted filter chips (tags, category, course, cuisine, lists, difficulty, and the glycemic-index/load, Nutri-Score, inflammation and nutrient-balance bands) filter the pre-rendered card grid live. Pure, client-side, no extra build step — only facets the collection actually uses appear.
- **Later** — shopping lists + kifli.hu purchasing.

## Disclaimer

Nutrition, glycemic, and inflammation figures are **estimates for guidance only** — not medical or dietary advice.

## References

- **Wolever, T.M.S., et al.** (2025). *Equivalent Glycemic Load and Insulinemic Responses Elicited by Low-Carbohydrate Foods: A Randomized Trial in Healthy Adults*. Current Developments in Nutrition. https://consensus.app/papers/details/807276853d585f74af8bb955e19c84ff/ — basis for available carbohydrate = total carbohydrate − dietary fibre (− polyols), used in the macro and glycemic engines (`src/core/nutrition.ts`, `src/core/gi.ts`).
- **Corriveau, A., et al.** (2025). *Does the Inclusion of Free Sugars as Opposed to Total Sugars in Nutrient Profiling Models Improve Their Performance? A Cross-sectional Analysis From the PREDISE Study*. The Journal of Nutrition. https://consensus.app/papers/details/1cc8b317caac5d8993fc1f4f0f9972d9/ — evidence that substituting total sugars for free/added sugars has little to no effect on nutrient-profiling performance, supporting the total-sugar limit term in the NRF9.3 nutrient-balance score (`src/core/balance.ts`) where added-sugar data is unavailable.
- **Della Corte, K.D., et al.** (2025). *Association and substitution analyses of dietary sugars, starch and fiber for indices of body fat and cardiometabolic risk — a NoHoW sub-study*. European Journal of Nutrition. https://consensus.app/papers/details/40c2434c9866575282834d7d08679461/ — intrinsic (non-free) sugars track with lower body-fat/cardiometabolic risk while free sugars do not, the basis for the FII penalising only the estimated free-sugar fraction (`freeSugar_g`), not a whole food's intrinsic, matrix-bound sugar (`src/core/fii.ts`, `src/data/fii-parameters.json`).
- **Reyneke, G.L., et al.** (2025). *Food-based indexes and their association with dietary inflammation*. Advances in Nutrition. https://consensus.app/papers/details/59c7ab5558d750f7bd6b0d9886f53108/ — the cross-index consensus (fruit/vegetables/whole grains/legumes favourable; red/processed meat and added sugar unfavourable) behind the fibre and free-sugar direction of the FII (`src/core/fii.ts`, `src/data/fii-parameters.json`).
- **Wang, Z., et al.** (2024). *Food inflammation index reveals the key inflammatory components in foods and heterogeneity within food groups: How do we choose food?*. Journal of Advanced Research. https://consensus.app/papers/details/ed340eb851ed531fa98759ee8a3373d5/ — the per-food, composition-derived inflammatory-potential method (fat quality the key within-group discriminator) adapted in `src/core/fii.ts`.
- **Dryer-Beers, E.R., et al.** (2024). *Higher dietary polyphenol intake is associated with lower blood inflammatory markers*. The Journal of Nutrition. https://consensus.app/papers/details/3bc11a117f2f53b9b8c8b5d8a60e8d51/ — evidence (polyphenol intake estimated from Phenol-Explorer) for the anti-inflammatory polyphenol term in `src/core/fii.ts`.
- **Merz, B., et al.** (2024). *Nutri-Score 2023 update*. Nature Food. https://consensus.app/papers/details/8e9e862d0e6851d598e47d2546beec81/ — the updated nutrient-profiling algorithm reimplemented in `src/core/nutriscore.ts`.
- **Scientific Committee of the Nutri-Score** (2023). *Update of the Nutri-Score algorithm for beverages — second update report (V2)*. https://www.rijksoverheid.nl/binaries/rijksoverheid/documenten/rapporten/2023/03/30/second-update-report-from-the-scientific-committee-of-the-nutri-score-2023/Update+of+the+Nutri-Score+algorithm+for+beverages.pdf — source of the beverage sub-algorithm threshold tables and water-only-A grade table in `src/core/nutriscore.ts`.
- **Scientific Committee of the Nutri-Score** (2022). *Update of the Nutri-Score algorithm — main report (general foods; fats, oils, nuts and seeds)*. https://mpc.gouvernement.lu/dam-assets/le-minist%C3%A8re/consodur/2022-main-algorithm-report-update-final.pdf — source of the general-foods and fats/oils/nuts/seeds threshold tables, protein caps and grade boundaries in `src/core/nutriscore.ts`.
- **Drewnowski, A., et al.** (2022). *A New Carbohydrate Food Quality Scoring System to Reflect Dietary Guidelines: An Expert Panel Report*. Nutrients. https://consensus.app/papers/details/9fc0efd4fc435cbe9c7826af43137b5c/ — the fibre-to-free-sugar carbohydrate-quality ratio behind the FII free-sugar estimate `max(0, sugar − 2·fibre)` (`src/data/fii-parameters.json`).
- **Zhang, K., et al.** (2022). *Effects of fermented dairy products on inflammatory biomarkers: A meta-analysis*. Nutrition, Metabolism and Cardiovascular Diseases. https://consensus.app/papers/details/fc18b45538965840ba1416936a13cd01/ — evidence that fermented dairy lowers inflammatory markers, the direction behind the composition-blind food-form adjustment for yogurt and cheese (`src/core/foodAdjust.ts`, `src/data/food-adjustments.json`).
- **Atkinson, F.S., et al.** (2021). *International tables of glycemic index and glycemic load values 2021: a systematic review*. The American Journal of Clinical Nutrition. https://consensus.app/papers/details/4273d4f4694d557f9e6a8233441a05c2/ — source of the transcribed GI values in `src/data/food-scoring.json`.
- **Yuan, M., et al.** (2021). *Yogurt Consumption Is Associated with Lower Levels of Chronic Inflammation in the Framingham Offspring Study*. Nutrients. https://consensus.app/papers/details/89c9eee889505f75b4a4f0bb946afab9/ — yogurt-specific anti-inflammatory association behind the fermented-dairy food-form adjustment (`src/data/food-adjustments.json`).
- **Liu, J., et al.** (2020). *A comparison of different practical indices for assessing carbohydrate quality among carbohydrate-rich processed products in the US*. PLoS ONE. https://consensus.app/papers/details/22ef4c3418d056fb9f0f82537dccb32b/ — validates the 1:2 fibre:free-sugar dual ratio used to estimate free (penalisable) sugar from composition in the FII (`src/core/fii.ts`).
- **Saeidifard, F., et al.** (2020). *Fermented foods and inflammation: A systematic review and meta-analysis of randomized controlled trials*. Clinical Nutrition ESPEN. https://consensus.app/papers/details/904b58740f4d5418a67549397d7b96f0/ — RCT-level evidence that fermented foods reduce inflammatory markers, supporting the fermented-dairy food-form adjustment (`src/core/foodAdjust.ts`).
- **U.S. Food and Drug Administration** (2016). *Food Labeling: Revision of the Nutrition and Supplement Facts Labels (21 CFR 101.9; Daily Values)*. Federal Register. https://www.federalregister.gov/documents/2016/05/27/2016-11867/food-labeling-revision-of-the-nutrition-and-supplement-facts-labels — source of the Daily Values and maximum recommended values used as the NRF9.3 reference amounts in `src/core/balance.ts`.
- **Cassidy, A., et al.** (2015). *Higher dietary anthocyanin and flavonol intakes are associated with anti-inflammatory effects in a population of US adults*. The American Journal of Clinical Nutrition. https://consensus.app/papers/details/62f7d60bfae55746b4eb7f0062879834/ — supports weighting polyphenols as a key anti-inflammatory signal in `src/core/fii.ts`.
- **Drewnowski, A. & Fulgoni, V.L.** (2014). *Nutrient density: principles and evaluation tools*. The American Journal of Clinical Nutrition. https://consensus.app/papers/details/7e24b2182bc1531eaa03b87398a299e2/ — establishes the NRF9.3 algorithm (9 nutrients to encourage, 3 to limit) and the per-100-kcal basis, reimplemented in `src/core/balance.ts`.
- **Dodd, H., et al.** (2011). *Calculating meal glycemic index by using measured and published food values compared with directly measured meal glycemic index*. The American Journal of Clinical Nutrition. https://consensus.app/papers/details/dfd0edd0c22e5e7e8ce4b9ae0e713d2a/ — evidence that the carb-weighted composite GI over-predicts measured mixed-meal GI, the basis for presenting the glycemic figures as estimates.
- **Pérez-Jiménez, J., et al.** (2010). *Identification of the 100 richest dietary sources of polyphenols: an application of the Phenol-Explorer database*. European Journal of Clinical Nutrition. https://doi.org/10.1038/ejcn.2010.221 — the Phenol-Explorer total-polyphenol values seeded into `src/data/polyphenols.json` and ingested by `scripts/build-phenol-explorer.mjs`.
- **Fulgoni, V.L., et al.** (2009). *Development and validation of the nutrient-rich foods index: a tool to measure nutritional quality of foods*. The Journal of Nutrition. https://consensus.app/papers/details/0067b7a0782f5b09b7d8d6bd5691c039/ — validation of the NRF family against the Healthy Eating Index, identifying NRF9.3 (per 100 kcal) as the best-performing nutrient-density model behind `src/core/balance.ts`.
