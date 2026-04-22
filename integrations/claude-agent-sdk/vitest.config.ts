import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit:integrations/claude-agent-sdk',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
