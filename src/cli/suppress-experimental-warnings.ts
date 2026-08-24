/**
 * Side-effect-only module. It must be the FIRST import in cli/index.ts: ES module
 * evaluation runs sibling imports in declaration order before the importing file's
 * own body, so listing this first guarantees the filter is registered before
 * history/db.ts's node:sqlite import (several imports later in the graph) fires its
 * ExperimentalWarning. Node has no per-message warning filter, only the whole-category
 * `--disable-warning` CLI flag (already used by the portable launcher) - this reproduces
 * that filtering for the regular `ai-dispatcher` binary, where callers don't control
 * the node invocation. Only this one, known-benign warning is swallowed; everything
 * else still reaches stderr exactly as Node would print it by default.
 */
const SUPPRESSED = [/SQLite is an experimental feature/];

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && SUPPRESSED.some((pattern) => pattern.test(warning.message))) return;
  console.error(warning.stack ?? `${warning.name}: ${warning.message}`);
});
