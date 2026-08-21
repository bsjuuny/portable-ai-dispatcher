import { runProcess } from '../../process/process-runner.js';
import type { ProviderHealth } from '../../models/provider.js';

/**
 * `codex login status` returns PLAIN TEXT, not JSON (verified live: "Logged in using
 * ChatGPT", exit 0) - --json only affects `codex exec`, confirmed by reading
 * `codex exec --help` vs `codex login --help`. Do not assume JSON here.
 *
 * Also verified live during implementation: this environment's Codex CLI was
 * initially broken entirely (a `service_tier` config value invalid for the installed
 * version made every subcommand fail at startup with a config-parse error) - fixed
 * as a one-time prerequisite outside this repo. checkCodexHealth cannot distinguish
 * "not authenticated" from "CLI config is broken" beyond surfacing the raw stderr
 * message, which is why `message` always carries the raw text rather than being
 * dropped.
 */
export async function checkCodexHealth(opts: { timeoutMs?: number } = {}): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const versionOutcome = await runProcess({
    file: 'codex',
    args: ['--version'],
    cwd: process.cwd(),
    timeoutMs,
  }).catch(() => null);

  const installed = versionOutcome !== null && versionOutcome.exitCode === 0;
  if (!installed) {
    return {
      provider: 'codex',
      checkedAt,
      installed: false,
      authenticated: null,
      reachable: null,
      rateLimited: null,
      ready: false,
      message: 'codex CLI not found on PATH.',
    };
  }

  const version = versionOutcome.stdout.trim();

  const loginOutcome = await runProcess({
    file: 'codex',
    args: ['login', 'status'],
    cwd: process.cwd(),
    timeoutMs,
  }).catch(() => null);

  const stdout = loginOutcome?.stdout.trim() ?? '';
  const stderr = loginOutcome?.stderr.trim() ?? '';
  const authenticated = loginOutcome?.exitCode === 0 && /logged in/i.test(stdout);
  const configBroken = /error loading configuration/i.test(stderr);

  return {
    provider: 'codex',
    checkedAt,
    installed: true,
    authenticated: loginOutcome ? authenticated : null,
    reachable: authenticated ? true : null,
    rateLimited: null,
    ready: authenticated,
    version,
    message: authenticated
      ? undefined
      : configBroken
        ? `codex CLI config error (see ~/.codex/config.toml): ${stderr}`
        : stderr || stdout || 'codex login status did not report as logged in.',
  };
}
