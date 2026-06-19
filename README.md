# mili’s ~~hedonistic~~ cookbook

A personal recipe-management web app — import recipes by link or write them by hand, store each one as a **uniform metric markdown file**, and browse them as a beautiful recipe book. Every recipe shows its **macros, glycemic index (GI), glycemic load (GL), inflammation score, and nutrition score (Nutri-Score 2023)**.

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
- **Phase 1** — in-browser authoring at [`/add`](https://milenaveleva.github.io/recipes-archive/add): sign in with GitHub, paste a URL (fetched via a Cloudflare Worker CORS proxy) or fill a form → review each ingredient's USDA match → auto-convert to metric → compute macros → commit the markdown to the repo. The Worker (see [`worker/`](worker/)) also runs the GitHub sign-in token exchange; set its URL as `PUBLIC_IMPORT_PROXY` at build time. Anyone can sign in, but only repository collaborators can publish; a manual fine-grained-token path is kept as a fallback.
- **Phase 2 (done)** — every recipe is scored in-app: a carb-weighted composite **glycemic index/load** (GI values transcribed from Atkinson 2021), the general-foods **Nutri-Score 2023** grade, and an independent ingredient-tagged **inflammation index**. Scores are precomputed at author time into the markdown and shown as medallions, with estimate disclaimers throughout.
- **Phase 3 (done)** — discovery on the home page: a fuzzy search box (Fuse.js, over titles, descriptions, ingredients and method text) and faceted filter chips (tags, category, course, cuisine, lists, difficulty, and the glycemic-index/load, Nutri-Score and inflammation bands) filter the pre-rendered card grid live. Pure, client-side, no extra build step — only facets the collection actually uses appear.
- **Later** — shopping lists + kifli.hu purchasing.

## Disclaimer

Nutrition, glycemic, and inflammation figures are **estimates for guidance only** — not medical or dietary advice.

## References

- **Wolever, T.M.S., et al.** (2025). *Equivalent Glycemic Load and Insulinemic Responses Elicited by Low-Carbohydrate Foods: A Randomized Trial in Healthy Adults*. Current Developments in Nutrition. https://consensus.app/papers/details/807276853d585f74af8bb955e19c84ff/ — basis for available carbohydrate = total carbohydrate − dietary fibre (− polyols), used in the macro and glycemic engines (`src/core/nutrition.ts`, `src/core/gi.ts`).
- **Kałuża, J., et al.** (2025). *Development of empirical anti-inflammatory diet index: a cross-sectional study*. Nutrition Journal. https://consensus.app/papers/details/ac8d6cbb07de54728fe249f65cedacd6/ — food-group anti-/pro-inflammatory classification informing the ingredient tags in `src/core/inflammation.ts`.
- **Merz, B., et al.** (2024). *Nutri-Score 2023 update*. Nature Food. https://consensus.app/papers/details/8e9e862d0e6851d598e47d2546beec81/ — the updated nutrient-profiling algorithm reimplemented in `src/core/nutriscore.ts`.
- **Atkinson, F.S., et al.** (2021). *International tables of glycemic index and glycemic load values 2021: a systematic review*. The American Journal of Clinical Nutrition. https://consensus.app/papers/details/4273d4f4694d557f9e6a8233441a05c2/ — source of the transcribed GI values in `src/data/food-scoring.json`.
- **Tabung, F.K., et al.** (2016). *Development and Validation of an Empirical Dietary Inflammatory Index*. The Journal of Nutrition. https://consensus.app/papers/details/ea9d4a52e6825cbdb40b08ade34e8095/ — the biomarker-validated food-group inflammatory index that grounds the ingredient-tag method.
- **Dodd, H., et al.** (2011). *Calculating meal glycemic index by using measured and published food values compared with directly measured meal glycemic index*. The American Journal of Clinical Nutrition. https://consensus.app/papers/details/dfd0edd0c22e5e7e8ce4b9ae0e713d2a/ — evidence that the carb-weighted composite GI over-predicts measured mixed-meal GI, surfaced as the estimate disclaimer.
