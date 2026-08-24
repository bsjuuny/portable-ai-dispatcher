import type { AppContext } from '../bootstrap.js';
import type { DispatcherCommand } from '../../models/task.js';
import type { CommonCliOptions } from '../build-task.js';
import { buildTaskFromCli } from '../build-task.js';
import type { ProviderId } from '../../models/provider.js';
import type { TaskOutcome } from '../../core/orchestrator.js';
import { isDispatcherError } from '../../models/error.js';
import {
  buildTaskResultReport,
  formatTaskResultReport,
  type TaskResultReport,
} from '../../reporting/task-result-report.js';

export interface DispatchCommandOptions extends CommonCliOptions {
  json?: boolean;
}

export async function runDispatchCommand(
  ctx: AppContext,
  command: DispatcherCommand,
  descriptionArg: string | undefined,
  options: DispatchCommandOptions,
): Promise<number> {
  const task = await buildTaskFromCli(command, descriptionArg, options, { maxTaskInputBytes: ctx.config.execution.maxTaskInputBytes });
  ctx.logger.debug({ event: 'cli.task.built', taskId: task.id, command }, 'Task built from CLI input');
  ctx.history.recordTaskCreated(task);

  const forcedProvider = options.provider as ProviderId | undefined;
  let outcome: TaskOutcome;
  try {
    outcome = await ctx.orchestrator.runTask(task, { forcedProvider, dryRun: options.dryRun });
  } catch (error) {
    task.status = 'failed';
    ctx.history.updateTaskStatus(task.id, 'failed', {
      endedAt: new Date().toISOString(),
      errorCode: isDispatcherError(error) ? error.code : 'INTERNAL_LOGIC_ERROR',
    });
    throw error;
  } finally {
    // Never leaves a heartbeat timer ticking past this command, including on the
    // thrown-error path (a still-alive timer is otherwise unref()'d and harmless, but
    // stopping it here is cheap and leaves nothing to reason about either way).
    ctx.consoleStatus.stop();
  }
  ctx.logger.debug({ event: 'cli.task.outcome', taskId: task.id, verdict: outcome.verdict }, 'Orchestrator returned');

  const resultReport = buildTaskResultReport(outcome, { dryRun: options.dryRun ?? false });
  await ctx.audit.record(task.id, 'task.report.created', { report: resultReport });

  ctx.history.updateTaskStatus(task.id, task.status, { endedAt: new Date().toISOString() });
  if (outcome.validation) ctx.history.recordValidationOutcome(task.id, outcome.validation.passed);
  if (outcome.review) ctx.history.recordReviewVerdict(task.id, outcome.review.verdict);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          taskId: task.id,
          verdict: outcome.verdict,
          classification: task.classification,
          plan: task.executionPlan,
          routing: outcome.routing,
          attempts: outcome.attempts.map((a) => ({ provider: a.provider, status: a.result.status })),
          validation: outcome.validation
            ? { passed: outcome.validation.passed, failedStage: outcome.validation.failedStage }
            : undefined,
          review: outcome.review ? { verdict: outcome.review.verdict, findings: outcome.review.findings } : undefined,
          resultReport,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printHumanReadable(outcome, options.dryRun ?? false, resultReport);
  }

  return outcome.verdict === 'SUCCESS' || outcome.verdict === 'SUCCESS_WITH_WARNING' ? 0 : 1;
}

function printHumanReadable(outcome: TaskOutcome, dryRun: boolean, resultReport: TaskResultReport): void {
  const lines: string[] = [];
  lines.push(`Task: ${outcome.task.id} (${outcome.task.command})`);
  if (outcome.task.classification) {
    const classification = outcome.task.classification;
    lines.push(
      `Classification: ${classification.type} (${classification.scope ?? 'targeted'}, ${classification.estimatedComplexity})`,
    );
  }
  if (outcome.task.executionPlan) {
    lines.push(`Plan: ${outcome.task.executionPlan.workUnits.length} work unit(s)`);
  }
  lines.push(`Selected provider: ${outcome.routing.selected}`);
  for (const reason of outcome.routing.reasons) lines.push(`  ${reason}`);

  if (dryRun) {
    lines.push('(dry run - no execution performed)');
    lines.push('');
    lines.push(...formatTaskResultReport(resultReport));
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  for (const attempt of outcome.attempts) {
    lines.push(`Execution [${attempt.provider}]: ${attempt.result.status}`);
  }
  if (outcome.validation) {
    lines.push(`Validation: ${outcome.validation.passed ? 'PASSED' : `FAILED at ${outcome.validation.failedStage}`}`);
  }
  if (outcome.review) {
    lines.push(`Review (${outcome.review.reviewer}, independent=${outcome.review.independentReview}): ${outcome.review.verdict}`);
    for (const finding of outcome.review.findings) {
      lines.push(`  [${finding.severity}] ${finding.category}: ${finding.message}`);
    }
  }
  lines.push(`Final verdict: ${outcome.verdict}`);
  const response = outcome.attempts
    .slice()
    .reverse()
    .find((attempt) => (attempt.result.status === 'success' || attempt.result.status === 'success_with_warning') && attempt.result.text?.trim())
    ?.result.text?.trim();
  if (response && (outcome.task.command === 'ask' || outcome.task.command === 'analyze')) {
    lines.push('');
    lines.push('답변:');
    lines.push(response);
  }
  lines.push('');
  lines.push(...formatTaskResultReport(resultReport));
  process.stdout.write(`${lines.join('\n')}\n`);
}
