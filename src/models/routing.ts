import type { ProviderId } from './provider.js';

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
}

export interface RoutingDecision {
  taskId: string;
  scores: RoutingScore[];
  selected: ProviderId;
  reasons: string[];
  decidedAt: string;
}
