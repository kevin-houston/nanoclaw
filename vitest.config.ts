import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // Some suites do heavy module-graph work in a hook -- notably
    // src/channels/telegram-instances-registration.test.ts, whose beforeAll
    // imports the whole src/channels barrel so every adapter self-registers.
    // Under full-suite parallel load that exceeds the 10s default and flakes,
    // though it runs in ~1.3s alone. Set here rather than in the test file:
    // that file is skill-owned and /update-skills overwrites it.
    hookTimeout: 30_000,
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
  },
});
