// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages project site: served at https://milenaveleva.github.io/recipes-archive/
// `base` must be set and every internal link/asset prefixed with it (use src/lib/url.ts:withBase).
const SITE = 'https://milenaveleva.github.io';
const BASE = '/recipes-archive';

// https://astro.build/config
export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
