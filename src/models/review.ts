import type { ProviderId } from './provider.js';

export type ReviewVerdict = 'approve' | 'approve_with_warning' | 'request_changes' | 'critical';
export type ReviewSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  category: string;
  message: string;
  recommendation?: string;
}

export interface ReviewResult {
  taskId: string;
  reviewer: ProviderId;
  implementer: ProviderId;
  independentReview: boolean;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  cycle: number;
  durationMs: number;
}

export interface ConflictRecord {
  taskId: string;
  description: string;
  evidence: 'test' | 'build' | 'static-analysis' | 'source' | 'runtime' | 'none';
  resolution: 'accepted-as-warning' | 'escalated-to-user' | 'dismissed';
  detail: string;
}
