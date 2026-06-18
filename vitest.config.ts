import { defineConfig } from 'vitest/config';

// Unit tests for the src/core compute engine. The engine is plain TypeScript
// with no Astro/DOM dependencies, so a Node environment is all it needs.
export default defineConfig({
  test: {
    include: ['src/core/**/*.test.ts'],
    environment: 'node',
  },
});
