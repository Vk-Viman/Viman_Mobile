// Test runner settings for the server (Vitest). Run with `npm test` from the project root.
// Every test file lives under src/tests and describes one business area (see the header comment inside each file).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only files named *.test.ts are tests; the helpers folder is shared code, not tests.
    include: ['src/tests/**/*.test.ts'],
    environment: 'node',
    // Each test file runs in its own child process ("forks"): SQLite database files, ports and the process-level
    // start-up tests then cannot interfere with one another.
    pool: 'forks',
    // 20 seconds per test: the long model-check and start-up tests do real database work and spawn real processes
    // (individual tests may set a longer limit themselves).
    testTimeout: 20000,
  },
});
