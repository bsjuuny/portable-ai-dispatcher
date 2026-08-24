import type { ProviderId, ProviderHealthReasonCode } from './provider.js';

export interface RoutingScoreComponents {
  capability: number;
  availability: number;
  usageCapacity: number;
  successRate: number;
  preference: number;
  currentLoadPenalty: number;
  recentFailurePenalty: number;
  rateLimitPenalty: number;
  latencyPenalty: number;
}

export interface RoutingScore {
  provider: ProviderId;
  total: number;
  components: RoutingScoreComponents;
  eligible: boolean;
  ineligibleReason?: string;
  /** Machine-readable mirror of `ineligibleReason`, when the cause maps to a known
   * category - lets callers (CLI --json, `doctor`) branch on why without parsing
   * the free-text reason. */
  ineligibleCode?: ProviderHealthReasonCode;
}

export interface RoutingDecision {
  taskId: string;
  scores: RoutingScore[];
  selected: ProviderId;
  reasons: string[];
  decidedAt: string;
}
