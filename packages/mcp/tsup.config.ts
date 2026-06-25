import { defineConfig } from 'tsup';

// The MCP package imports the client SDK by relative source path; bundle that
// (and @volter/tunnel-core) IN so the published package is self-contained. Only
// the real runtime deps stay external. The `bun` condition makes esbuild resolve
// @volter/tunnel-core to its source, so the build doesn't depend on build order.
export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: 'esm',
  clean: true,
  outDir: 'dist',
  external: ['@modelcontextprotocol/sdk', 'zod'],
  esbuildOptions(options) {
    options.conditions = ['bun', 'import'];
  },
});
