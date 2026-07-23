import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'infra/test/**/*.test.ts',
    ],
    // CDK assertion tests bundle the Lambda entries with esbuild.
    testTimeout: 120_000,
  },
});
