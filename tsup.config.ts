import { defineConfig } from 'tsup';

// skipNodeModulesBundle avoids two real bundling pitfalls, not a hypothetical one:
// pino's pretty-print path dynamically resolves `pino-pretty` as a file on disk via
// worker_threads.transport(), which breaks under esbuild inlining; execa is ESM-only
// with its own dynamic internals. Neither is worth fighting, so dependencies stay
// external and get installed normally alongside the built output.
export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: true,
  // esbuild has been observed to rewrite `node:sqlite` to the bare specifier
  // `sqlite` (which does not exist as an npm package) despite `platform: 'node'` -
  // explicitly listing it external, with the exact prefixed spelling, works around
  // that rewrite. Verified by inspecting dist/cli.js after build - see
  // docs/architecture.md.
  external: ['node:sqlite'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
