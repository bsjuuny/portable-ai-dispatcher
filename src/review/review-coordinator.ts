import type { DispatcherTask } from '../models/task.js';
import type { GitDiffSummary } from '../models/validation.js';
import type { ReviewResult } from '../models/review.js';
import type { ProviderId } from '../models/provider.js';
import type { TaskResult } from '../models/result.js';
import { parseReviewResponse } from './review-schema.js';

const REVIEW_DIMENSIONS = [
  'Correctness',
  'Requirement Compliance',
  'Regression',
  'Security',
  'Concurrency',
  'Null Handling',
  'Error Handling',
  'Resource Leak',
  'Performance',
  'Maintainability',
  'Test Coverage',
  'Unrelated Change',
  'Architecture Consistency',
] as const;

export function buildReviewPrompt(task: DispatcherTask, diff: GitDiffSummary): string {
  return [
    `You are an independent code reviewer. Review the following change made in response to this task:`,
    ``,
    `## Original Task`,
    task.specification.rawDescription,
    ``,
    `## Files Changed`,
    diff.changedFiles.map((f) => `- ${f}`).join('\n') || '(none reported)',
    ``,
    `## Patch${diff.patchTruncated ? ' (truncated)' : ''}`,
    diff.patchText || '(no patch content reported)',
    ``,
    `## Review Dimensions`,
    REVIEW_DIMENSIONS.map((d) => `- ${d}`).join('\n'),
    ``,
    `Respond with your reasoning, then end with EXACTLY ONE fenced json block matching this shape:`,
    '```json',
    JSON.stringify(
      {
        verdict: 'approve | approve_with_warning | request_changes | critical',
        findings: [
          {
            severity: 'info | warning | error | critical',
            file: 'optional path',
            line: 'optional number',
            category: 'short category name',
            message: 'what is wrong and why',
            recommendation: 'optional suggested fix',
          },
        ],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}

export interface RunReviewOptions {
  task: DispatcherTask;
  implementer: ProviderId;
  reviewer: ProviderId;
  independentReview: boolean;
  diff: GitDiffSummary;
  cycle: number;
  dispatchReview: (reviewPromptText: string) => Promise<TaskResult>;
}

/**
 * `independentReview` is recorded explicitly (spec section 59) rather than assumed -
 * when only one provider is Ready, the caller passes independentReview: false and
 * uses the same provider as both implementer and reviewer (self-review), which is
 * strictly worse but better than blocking entirely.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewResult> {
  const startedAt = Date.now();
  const prompt = buildReviewPrompt(options.task, options.diff);
  const result = await options.dispatchReview(prompt);

  // The reviewer's dispatch can fail outright (provider error, timeout, ...) rather
  // than merely return a badly-formatted response - found live (2026-08-22) when the
  // configured Codex CLI couldn't run at all (unsupported model), yet the review step
  // silently reported approve_with_warning because result.text was empty, same as a
  // real reviewer's formatting slip. Treated the same, a fully-broken reviewer would
  // let any change through review, defeating the whole point of the safety gate once
  // safety.autoApply.enabled is on. A dispatch failure is fail-closed here (verdict
  // 'critical', which hasBlockingFindings() below already treats as blocking) instead
  // of being routed into parseReviewResponse()'s "assume it's just unparseable text"
  // fallback, which exists for the different case of a reviewer that DID run.
  if (result.status !== 'success' && result.status !== 'success_with_warning') {
    return {
      taskId: options.task.id,
      reviewer: options.reviewer,
      implementer: options.implementer,
      independentReview: options.independentReview,
      verdict: 'critical',
      findings: [
        {
          severity: 'critical',
          category: 'review-execution-failed',
          message: `Reviewer (${options.reviewer}) failed to execute (status=${result.status}): ${result.error?.message ?? 'no error detail'}`,
        },
      ],
      cycle: options.cycle,
      durationMs: Date.now() - startedAt,
    };
  }

  const parsed = parseReviewResponse(result.text ?? result.summary ?? '');

  return {
    taskId: options.task.id,
    reviewer: options.reviewer,
    implementer: options.implementer,
    independentReview: options.independentReview,
    verdict: parsed.verdict,
    findings: parsed.findings,
    cycle: options.cycle,
    durationMs: Date.now() - startedAt,
  };
}

export function hasBlockingFindings(review: ReviewResult): boolean {
  return review.verdict === 'request_changes' || review.verdict === 'critical';
}
