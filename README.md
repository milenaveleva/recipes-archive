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
- **Phase 1** — in-browser authoring: paste a URL (fetched via a Cloudflare Worker CORS proxy) or fill a form → review each ingredient's USDA match → auto-convert to metric → compute macros → commit markdown via the GitHub API.
- **Phase 2** — GI/GL + Nutri-Score 2023 + inflammation index, computed in-app.
- **Phase 3** — search (Pagefind) + faceted filtering.
- **Later** — shopping lists + kifli.hu purchasing.

## Disclaimer

Nutrition, glycemic, and inflammation figures are **estimates for guidance only** — not medical or dietary advice.

## References

- **Wolever, T.M.S., et al.** (2025). *Equivalent Glycemic Load and Insulinemic Responses Elicited by Low-Carbohydrate Foods: A Randomized Trial in Healthy Adults*. Current Developments in Nutrition. https://consensus.app/papers/details/807276853d585f74af8bb955e19c84ff/ — basis for available carbohydrate = total carbohydrate − dietary fibre (− polyols), used in the macro engine (`src/core/nutrition.ts`).
