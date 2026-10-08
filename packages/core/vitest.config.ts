import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Phase 9 T1: money and token maths must have every branch covered.
      thresholds: { branches: 100, lines: 100, functions: 100, statements: 100 },
    },
  },
});
