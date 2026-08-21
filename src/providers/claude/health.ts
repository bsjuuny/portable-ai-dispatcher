import { z } from 'zod';
import { runProcess } from '../../process/process-runner.js';
import type { ProviderHealth } from '../../models/provider.js';

/**
 * `claude auth status` returns clean JSON already (verified live) - no fragile text
 * parsing needed, unlike Codex's `login status`.
 */
const ClaudeAuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    apiProvider: z.string().optional(),
    email: z.string().optional(),
    subscriptionType: z.string().optional(),
  })
  .passthrough();

export async function checkClaudeHealth(opts: { timeoutMs?: number } = {}): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const versionOutcome = await runProcess({
    file: 'claude',
    args: ['--version'],
    cwd: process.cwd(),
    timeoutMs,
  }).catch(() => null);

  const installed = versionOutcome !== null && versionOutcome.exitCode === 0;
  if (!installed) {
    return {
      provider: 'claude',
      checkedAt,
      installed: false,
      authenticated: null,
      reachable: null,
      rateLimited: null,
      ready: false,
      message: 'claude CLI not found on PATH.',
    };
  }

  const version = versionOutcome.stdout.trim();

  const authOutcome = await runProcess({
    file: 'claude',
    args: ['auth', 'status'],
    cwd: process.cwd(),
    timeoutMs,
  }).catch(() => null);

  if (!authOutcome || authOutcome.exitCode !== 0) {
    return {
      provider: 'claude',
      checkedAt,
      installed: true,
      authenticated: false,
      // We genuinely cannot tell network reachability from an auth-status failure
      // alone - null (not false) is the honest answer per spec section 31.
      reachable: null,
      rateLimited: null,
      ready: false,
      version,
      message: authOutcome?.stderr.trim() || 'claude auth status failed.',
    };
  }

  const parsed = ClaudeAuthStatusSchema.safeParse(safeJsonParse(authOutcome.stdout));
  const authenticated = parsed.success ? parsed.data.loggedIn : false;

  return {
    provider: 'claude',
    checkedAt,
    installed: true,
    authenticated,
    reachable: authenticated ? true : null,
    rateLimited: null,
    ready: authenticated,
    version,
    message: parsed.success ? undefined : 'claude auth status returned unexpected output.',
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
