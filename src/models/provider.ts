export type ProviderId = 'claude' | 'codex';

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
