import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, runReview, hasBlockingFindings } from '../../src/review/review-coordinator.js';
import { detectPersistingFindings, resolveConflict } from '../../src/review/conflict-resolver.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { ReviewResult, ReviewFinding } from '../../src/models/review.js';
import type { ValidationResult } from '../../src/models/validation.js';

function task(): DispatcherTask {
  const now = new Date().toISOString();
  return { id: 't1', command: 'fix', specification: { rawDescription: '로그인 오류 수정', attachments: [], sourcePaths: [] }, workingDirectory: '.', status: 'created', createdAt: now, updatedAt: now };
}

describe('buildReviewPrompt', () => {
  it('includes the original task description and changed files', () => {
    const prompt = buildReviewPrompt(task(), {
      changedFiles: ['src/a.ts', 'src/b.ts'],
      addedFiles: [],
      deletedFiles: [],
      protectedPathsTouched: [],
      patchText: 'diff --git a/src/a.ts b/src/a.ts\n+const fixed = true;',
    });
    expect(prompt).toContain('로그인 오류 수정');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
    expect(prompt).toContain('+const fixed = true;');
  });

  it('always requests a fenced json block in a fixed shape', () => {
    const prompt = buildReviewPrompt(task(), { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] });
    expect(prompt).toContain('```json');
    expect(prompt).toContain('verdict');
    expect(prompt).toContain('findings');
  });
});

describe('runReview', () => {
  it('returns a ReviewResult built from the dispatched provider response', async () => {
    const result = await runReview({
      task: task(),
      implementer: 'codex',
      reviewer: 'claude',
      independentReview: true,
      diff: { changedFiles: ['a.ts'], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] },
      cycle: 1,
      dispatchReview: async () => ({
        taskId: 't1', executionId: 'e1', provider: 'claude', status: 'success', durationMs: 10,
        text: '```json\n{"verdict":"approve","findings":[]}\n```',
      }),
    });
    expect(result.verdict).toBe('approve');
    expect(result.independentReview).toBe(true);
    expect(result.reviewer).toBe('claude');
  });

  it('treats a reviewer that fails to execute as a blocking "critical" verdict, not approve_with_warning', async () => {
    // Regression test for a real incident (2026-08-22): the installed Codex CLI
    // couldn't run at all (unsupported model), so result.text was empty - before this
    // fix, that fell into parseReviewResponse('')'s "assume it's just unparseable
    // text" fallback and silently reported approve_with_warning, exactly as if the
    // reviewer had actually run and only slipped on formatting.
    const result = await runReview({
      task: task(),
      implementer: 'claude',
      reviewer: 'codex',
      independentReview: true,
      diff: { changedFiles: ['a.ts'], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] },
      cycle: 1,
      dispatchReview: async () => ({
        taskId: 't1',
        executionId: 'e1',
        provider: 'codex',
        status: 'failed',
        durationMs: 10,
        error: { code: 'PROVIDER_TASK_FAILED', message: "The 'gpt-5.6-sol' model requires a newer version of Codex." },
      }),
    });
    expect(result.verdict).toBe('critical');
    expect(hasBlockingFindings(result)).toBe(true);
    expect(result.findings[0]?.category).toBe('review-execution-failed');
    expect(result.findings[0]?.message).toContain('gpt-5.6-sol');
  });

  it('fails closed when a successful reviewer dispatch returns an unparseable body', async () => {
    const result = await runReview({
      task: task(),
      implementer: 'codex',
      reviewer: 'claude',
      independentReview: true,
      diff: { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] },
      cycle: 1,
      dispatchReview: async () => ({
        taskId: 't1', executionId: 'e1', provider: 'claude', status: 'success', durationMs: 10,
        text: 'just some prose, no fenced json block',
      }),
    });
    expect(result.verdict).toBe('request_changes');
    expect(result.findings[0]?.category).toBe('review-format');
  });

  it('treats a timed-out reviewer dispatch the same as any other execution failure', async () => {
    const result = await runReview({
      task: task(),
      implementer: 'claude',
      reviewer: 'codex',
      independentReview: true,
      diff: { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] },
      cycle: 1,
      dispatchReview: async () => ({
        taskId: 't1', executionId: 'e1', provider: 'codex', status: 'timeout', durationMs: 10,
      }),
    });
    expect(result.verdict).toBe('critical');
    expect(hasBlockingFindings(result)).toBe(true);
  });
});

describe('hasBlockingFindings', () => {
  const base = (verdict: ReviewResult['verdict']): ReviewResult => ({ taskId: 't1', reviewer: 'claude', implementer: 'codex', independentReview: true, verdict, findings: [], cycle: 1, durationMs: 0 });

  it('blocks on request_changes and critical', () => {
    expect(hasBlockingFindings(base('request_changes'))).toBe(true);
    expect(hasBlockingFindings(base('critical'))).toBe(true);
  });

  it('does not block on approve or approve_with_warning', () => {
    expect(hasBlockingFindings(base('approve'))).toBe(false);
    expect(hasBlockingFindings(base('approve_with_warning'))).toBe(false);
  });
});

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { severity: 'error', category: 'concurrency', message: 'race condition possible', ...overrides };
}

describe('detectPersistingFindings', () => {
  it('detects a finding present in both the previous and current review by category+message', () => {
    const prev: ReviewResult = { taskId: 't1', reviewer: 'claude', implementer: 'codex', independentReview: true, verdict: 'request_changes', findings: [finding()], cycle: 1, durationMs: 0 };
    const curr: ReviewResult = { ...prev, findings: [finding()], cycle: 2 };
    expect(detectPersistingFindings(prev, curr)).toHaveLength(1);
  });

  it('does not flag a genuinely new, different finding as persisting', () => {
    const prev: ReviewResult = { taskId: 't1', reviewer: 'claude', implementer: 'codex', independentReview: true, verdict: 'request_changes', findings: [finding()], cycle: 1, durationMs: 0 };
    const curr: ReviewResult = { ...prev, findings: [finding({ category: 'security', message: 'different issue' })], cycle: 2 };
    expect(detectPersistingFindings(prev, curr)).toHaveLength(0);
  });
});

describe('resolveConflict', () => {
  const passingValidation: ValidationResult = { taskId: 't1', passed: true, stages: [], fixLoopIterations: 0, fixLoopExhausted: false, durationMs: 0, gitDiff: { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] } };
  const failingValidation: ValidationResult = { ...passingValidation, passed: false, failedStage: 'test' };

  it('accepts-as-warning when validation is currently failing (evidence supports the reviewer)', () => {
    const record = resolveConflict('t1', finding(), failingValidation);
    expect(record.resolution).toBe('accepted-as-warning');
    expect(record.evidence).toBe('test');
  });

  it('escalates to the user when there is no evidence and the finding is critical', () => {
    const record = resolveConflict('t1', finding({ severity: 'critical' }), undefined);
    expect(record.resolution).toBe('escalated-to-user');
  });

  it('keeps a non-critical finding as a warning even when build/test pass, rather than silently dismissing it', () => {
    const record = resolveConflict('t1', finding({ severity: 'warning' }), passingValidation);
    expect(record.resolution).toBe('accepted-as-warning');
  });
});
