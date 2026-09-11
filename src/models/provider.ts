export type CloudProviderId = 'claude' | 'codex';

/** Routable name for a configured `local.profiles[]` entry, e.g. `local-fast`. */
export type LocalProviderId = `local-${string}`;

export type ProviderId = CloudProviderId | LocalProviderId;

/** Where a provider actually executes - drives safety decisions (e.g. data egress
 * is a non-issue for 'local'). Optional on ProviderHealth/AIProvider so cloud
 * providers need no changes; a missing value is treated as 'cloud' by callers. */
export type ProviderDataResidency = 'local' | 'cloud';

export type ProviderCapability =
  | 'repository-analysis'
  | 'architecture'
  | 'analysis'
  | 'review'
  | 'implementation'
  | 'bugfix'
  | 'test-generation'
  | 'terminal'
  | 'refactor'
  | 'large-context'
  | 'documentation';

/** Runtime-checkable mirror of the ProviderCapability union, for validating
 * operator-supplied config (config/schema.ts's local.profiles[].capabilities) at
 * a real trust boundary instead of accepting arbitrary strings. Kept next to the
 * type it mirrors so the two can't silently drift apart. */
export const PROVIDER_CAPABILITIES = [
  'repository-analysis',
  'architecture',
  'analysis',
  'review',
  'implementation',
  'bugfix',
  'test-generation',
  'terminal',
  'refactor',
  'large-context',
  'documentation',
] as const satisfies readonly ProviderCapability[];

/** Machine-readable category for why `ready` is false, mirroring a subset of
 * `DispatcherErrorCode` - lets callers (routing, `doctor`, CLI --json output)
 * branch on *why* a provider is ineligible instead of only having a free-text
 * `message` to show a human. Absent when `ready` is true, or when the check
 * itself could not determine a specific reason. */
export type ProviderHealthReasonCode =
  | 'PROVIDER_NOT_INSTALLED'
  | 'PROVIDER_NOT_AUTHENTICATED'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'LOCAL_MODEL_NOT_FOUND';

export interface ProviderHealth {
  provider: ProviderId;
  checkedAt: string;
  installed: boolean;
  authenticated: boolean | null;
  reachable: boolean | null;
  rateLimited: boolean | null;
  ready: boolean;
  version?: string;
  message?: string;
  reasonCode?: ProviderHealthReasonCode;
}

export interface ProviderUsage {
  provider: ProviderId;
  windowStart: string;
  windowEnd: string;
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd?: number;
  averageDurationMs?: number;
  lastUsedAt?: string;
  cooldownUntil?: string;
}
