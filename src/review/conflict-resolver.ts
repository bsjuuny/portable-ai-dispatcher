import type { ReviewResult, ReviewFinding, ConflictRecord } from '../models/review.js';
import type { ValidationResult } from '../models/validation.js';

/**
 * Detects findings that persist across review cycles despite a fix attempt in
 * between (spec section 63/62) - the implementer's fix apparently didn't resolve
 * what the reviewer flagged, or the two disagree about whether it's really a
 * problem. Never resolved by majority vote (spec explicitly forbids that, since
 * v1.0 only ever has one reviewer active per cycle anyway) - resolution is instead
 * driven by whatever objective evidence (test/build/static-analysis) is available
 * from the most recent ValidationResult.
 */
export function detectPersistingFindings(previous: ReviewResult, current: ReviewResult): ReviewFinding[] {
  return current.findings.filter((finding) =>
    previous.findings.some(
      (prior) => prior.category === finding.category && prior.message === finding.message,
    ),
  );
}

export function resolveConflict(
  taskId: string,
  finding: ReviewFinding,
  latestValidation: ValidationResult | undefined,
): ConflictRecord {
  if (latestValidation && !latestValidation.passed) {
    return {
      taskId,
      description: `${finding.category}: ${finding.message}`,
      evidence: 'test',
      resolution: 'accepted-as-warning',
      detail: `Validation stage "${latestValidation.failedStage}" is currently failing, which is consistent with the reviewer's finding - treated as accepted, not dismissed.`,
    };
  }

  if (latestValidation?.passed && finding.severity !== 'critical') {
    return {
      taskId,
      description: `${finding.category}: ${finding.message}`,
      evidence: latestValidation.gitDiff ? 'build' : 'none',
      resolution: 'accepted-as-warning',
      detail:
        'Build/test/lint pass, but no static-analysis or runtime evidence available to confirm or dismiss the finding - kept as a warning for the user rather than silently dropped or auto-dismissed.',
    };
  }

  return {
    taskId,
    description: `${finding.category}: ${finding.message}`,
    evidence: 'none',
    resolution: 'escalated-to-user',
    detail: 'No objective evidence available and the finding is severity=critical - escalated rather than guessed at.',
  };
}
