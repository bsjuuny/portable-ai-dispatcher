import { describe, expect, it } from 'vitest';
import { decideAutoApply, type CompletionEvidence } from '../../src/safety/auto-apply-gate.js';

function evidence(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {
    autoApplyEnabled: true,
    validationPassed: true,
    reviewBlocking: false,
    riskLevel: 'LOW',
    maxRiskLevel: 'MEDIUM',
    repositoryLockHeld: true,
    baseRevisionMatches: true,
    contentHashesMatch: true,
    ...overrides,
  };
}

describe('decideAutoApply', () => {
  it('returns AUTO_APPLY when every safety and policy check passes', () => {
    expect(decideAutoApply(evidence()).decision).toBe('AUTO_APPLY');
  });

  it('returns FAILED when validation did not pass', () => {
    const result = decideAutoApply(evidence({ validationPassed: false }));
    expect(result.decision).toBe('FAILED');
  });

  it('returns FAILED when review has blocking findings', () => {
    const result = decideAutoApply(evidence({ reviewBlocking: true }));
    expect(result.decision).toBe('FAILED');
  });

  it('returns BLOCKED_BY_POLICY when autoApply is disabled, even if everything else passed', () => {
    const result = decideAutoApply(evidence({ autoApplyEnabled: false }));
    expect(result.decision).toBe('BLOCKED_BY_POLICY');
  });

  it('returns BLOCKED_BY_POLICY when risk exceeds the configured maximum', () => {
    const result = decideAutoApply(evidence({ riskLevel: 'HIGH', maxRiskLevel: 'MEDIUM' }));
    expect(result.decision).toBe('BLOCKED_BY_POLICY');
  });

  it('allows a risk level exactly at the configured maximum', () => {
    const result = decideAutoApply(evidence({ riskLevel: 'MEDIUM', maxRiskLevel: 'MEDIUM' }));
    expect(result.decision).toBe('AUTO_APPLY');
  });

  it('never allows AUTO_APPLY for CRITICAL risk, even if maxRiskLevel were somehow HIGH', () => {
    const result = decideAutoApply(evidence({ riskLevel: 'CRITICAL', maxRiskLevel: 'HIGH' }));
    expect(result.decision).toBe('BLOCKED_BY_POLICY');
  });

  it('fails closed (BLOCKED_BY_POLICY) when the repository lock is not held', () => {
    const result = decideAutoApply(evidence({ repositoryLockHeld: false }));
    expect(result.decision).toBe('BLOCKED_BY_POLICY');
  });

  it('fails closed when the base revision changed since the task started', () => {
    const result = decideAutoApply(evidence({ baseRevisionMatches: false }));
    expect(result.decision).toBe('BLOCKED_BY_POLICY');
  });

  it('fails closed when a touched file changed in the real repo since the task started (stale patch)', () => {
    const result = decideAutoApply(evidence({ contentHashesMatch: false }));
    expect(result.decision).toBe('BLOCKED_BY_POLICY');
  });

  it('checks validation/review before any policy/safety field, regardless of which other fields are also false', () => {
    const result = decideAutoApply(evidence({ validationPassed: false, autoApplyEnabled: false, repositoryLockHeld: false }));
    expect(result.decision).toBe('FAILED');
  });
});
