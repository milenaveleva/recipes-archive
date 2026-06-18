import { defineConfig } from 'vitest/config';

// Unit tests for the framework-agnostic compute engine (src/core) and the
// Worker's pure request guards (worker/src). Both are plain TypeScript with no
// Astro/DOM dependencies, so a Node environment is all they need.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'worker/src/**/*.test.ts'],
    environment: 'node',
  },
});
