import type { RiskLevel } from './risk-classifier.js';
import { RISK_ORDER } from './risk-classifier.js';

export type AutoApplyDecision = 'AUTO_APPLY' | 'BLOCKED_BY_POLICY' | 'FAILED';

/**
 * Every field here is a required boolean/enum - deliberately no optional field
 * that a caller could omit and have silently treated as "safe". Fail-closed means
 * every one of these must be explicitly satisfied for AUTO_APPLY; any single one
 * being false routes to FAILED or BLOCKED_BY_POLICY, never through by default.
 */
export interface CompletionEvidence {
  autoApplyEnabled: boolean;
  requireIndependentReview: boolean;
  independentReview: boolean;
  validationPassed: boolean;
  reviewBlocking: boolean;
  riskLevel: RiskLevel;
  maxRiskLevel: RiskLevel;
  repositoryLockHeld: boolean;
  baseRevisionMatches: boolean;
  contentHashesMatch: boolean;
}

export interface AutoApplyResult {
  decision: AutoApplyDecision;
  reasons: string[];
}

/**
 * Replaces the human approval step that a non-autonomous run would otherwise
 * wait on. FAILED means the task itself did not succeed (nothing to apply);
 * BLOCKED_BY_POLICY means the task succeeded but policy/safety state says it is
 * not safe or not permitted to land automatically; AUTO_APPLY is the only
 * decision that leads to patch-apply.ts actually touching the real repository.
 */
export function decideAutoApply(evidence: CompletionEvidence): AutoApplyResult {
  if (!evidence.validationPassed) {
    return { decision: 'FAILED', reasons: ['validation did not pass'] };
  }
  if (evidence.reviewBlocking) {
    return { decision: 'FAILED', reasons: ['review has blocking findings'] };
  }

  if (!evidence.repositoryLockHeld) {
    return { decision: 'BLOCKED_BY_POLICY', reasons: ['repository lock is not held - refusing to apply without exclusive access'] };
  }
  if (!evidence.baseRevisionMatches) {
    return { decision: 'BLOCKED_BY_POLICY', reasons: ['base revision changed since the task started'] };
  }
  if (!evidence.contentHashesMatch) {
    return { decision: 'BLOCKED_BY_POLICY', reasons: ['one or more touched files changed in the real repository since the task started'] };
  }
  if (!evidence.autoApplyEnabled) {
    return { decision: 'BLOCKED_BY_POLICY', reasons: ['safety.autoApply.enabled is false'] };
  }
  if (evidence.requireIndependentReview && !evidence.independentReview) {
    return { decision: 'BLOCKED_BY_POLICY', reasons: ['independent review is required for auto-apply, but only self-review was available'] };
  }
  if (RISK_ORDER[evidence.riskLevel] > RISK_ORDER[evidence.maxRiskLevel]) {
    return {
      decision: 'BLOCKED_BY_POLICY',
      reasons: [`risk level ${evidence.riskLevel} exceeds configured maximum ${evidence.maxRiskLevel}`],
    };
  }

  return { decision: 'AUTO_APPLY', reasons: ['all safety and policy checks passed'] };
}
