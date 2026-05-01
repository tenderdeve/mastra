import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // E2E tests hit real AWS Bedrock and require credentials. They are only
    // run when explicitly enabled via `pnpm test:e2e` (which sets
    // RUN_AWS_NOVA_SONIC_E2E=1) and are excluded from the default suite that
    // runs in CI.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.e2e.test.ts'],
  },
});
