# Recipe import CORS proxy

A tiny Cloudflare Worker that fetches a recipe page (or image) server-side and returns it with CORS headers, so the static site's in-browser import can read third-party HTML. It is the only backend in the project.

## What it does

`GET https://<your-worker>.workers.dev/?url=<encoded recipe URL>`

- Only requests from an allowlisted **Origin** are served (`ALLOWED_ORIGINS`).
- Only **http(s)** targets are fetched; localhost and private/link-local/CGNAT hosts are refused (no SSRF relay). See `src/guards.ts`.
- Responses are limited to HTML / plain text / images and capped at 4 MB.

## Deploy

Requires a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```sh
cd worker
npm install
npx wrangler login      # one-time browser auth
npm run deploy          # publishes to https://recipes-archive-proxy.<subdomain>.workers.dev
```

Local development: `npm run dev` serves it at `http://localhost:8787`.

## Configuration

- **Allowed origins** — edit `[vars] ALLOWED_ORIGINS` in `wrangler.toml` (comma-separated). Add a custom domain here if the site moves.
- The deployed Worker URL is what the site's authoring UI calls; set it as `PUBLIC_IMPORT_PROXY` for the build (the `/add` page reads it).
