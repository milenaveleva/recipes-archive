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

## GitHub sign-in

The same Worker also backs the authoring sign-in: exchanging a GitHub authorization code for a token needs the App's client secret, which can't live in static-site JS. Routes are `/auth` (redirect to GitHub), `/callback` (code→token exchange, delivered to the opener window by `postMessage`), and `/refresh` (mint a fresh access token from a refresh token). Anyone can sign in, but a user token can only push where the GitHub App is installed and the user has write access — so only repository collaborators can publish. See `src/oauth.ts`.

One-time setup:

1. Register a **GitHub App** (Settings → Developer settings → GitHub Apps → New): set the **Callback URL** to `https://<your-worker>/callback`, grant the **Repository → Contents: Read and write** permission, enable **Expire user authorization tokens**, and limit installation to your account. Generate a **client secret**.
2. **Install** the App on the `recipes-archive` repository.
3. Set the credentials as Worker secrets and redeploy:

```sh
cd worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npm run deploy
```

Without these, the proxy still works; the `/add` page reports sign-in as unconfigured and offers the manual-token fallback.

Origins & token storage: sign-in tokens are only ever delivered to the **https** origins in the allowlist (a token is never sent to `http://localhost`); to test sign-in from a local dev server, run a separate `wrangler dev` worker with `ALLOWED_AUTH_ORIGINS` set to your localhost origin. The issued user token and its refresh token are held in the browser's `sessionStorage`, so a sign-in survives reloads within the tab but is wiped when the tab/browser closes — a leak is bounded by the session rather than persisted to disk. Use the in-app **Sign out** to end a session early.
