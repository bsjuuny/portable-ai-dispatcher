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
