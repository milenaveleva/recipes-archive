import { defineConfig } from 'vitest/config';

// Unit tests for the framework-agnostic compute engine (src/core), the Worker's
// pure request guards (worker/src) and the data/report scripts (scripts/). None
// has Astro/DOM dependencies, so a Node environment is all they need.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'worker/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
