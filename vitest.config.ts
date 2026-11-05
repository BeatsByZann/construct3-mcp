import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup-env.ts'],
    // Tests that reach the process's catalogue provider read the hand-written
    // fixture folder and never fetch or write into a user's cache.
    env: {
      C3_ACE_SOURCE_DIR: fileURLToPath(new URL('./test/fixtures/ace-source', import.meta.url)),
      C3_ACE_CACHE_DIR: join(tmpdir(), 'c3-ace-test-cache'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
