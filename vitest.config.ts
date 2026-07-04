import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'lib/**/*.test.ts'],
    environment: 'node',
  },
});
