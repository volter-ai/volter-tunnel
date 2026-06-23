import { defineConfig } from 'vitest/config';

// The CF E2E suite drives a real `createTunnel` client (Node: net/http/ws)
// against the Worker+DO booted via wrangler's `unstable_dev`. `unstable_dev`
// only resolves under Node, so this suite runs on Node/vitest (the Fly suite
// stays on bun:test). Boot + teardown need generous hook timeouts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 90000,
    pool: 'forks',
    fileParallelism: false,
  },
});
