import type { DispatcherTask } from '../../models/task.js';
import type { TaskContext } from '../../models/context.js';
import type { ProviderCommandPlan, ProviderRunOptions } from '../types.js';
import { renderTaskPrompt } from '../prompt-renderer.js';

/**
 * Pure function: plain data in, argv array out, no side effects. This is what makes
 * shell-injection tests possible without spawning anything - see
 * tests/security/shell-injection.test.ts.
 *
 * The prompt is ALWAYS sent via stdin (verified live: `claude -p` reads the prompt
 * from stdin when no positional argument is given), never as a positional argv
 * element - this avoids OS argv length limits for large task specs/attachments
 * entirely, rather than needing to size-check them.
 */
export function buildClaudeCommand(
  task: DispatcherTask,
  context: TaskContext,
  opts: ProviderRunOptions,
): ProviderCommandPlan {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));

  args.push('--permission-mode', mapSandboxToPermissionMode(opts.sandbox, opts.approval));
  args.push('--no-session-persistence');

  return {
    file: 'claude',
    args,
    cwd: task.workingDirectory,
    timeoutMs: opts.timeoutMs,
    stdinContent: renderTaskPrompt(task, context),
  };
}

/**
 * Claude has no direct --sandbox/--ask-for-approval flags like Codex; the closest
 * equivalent control is --permission-mode. "never" approval + non-read-only sandbox
 * maps to acceptEdits (apply file edits without per-edit prompts, since nothing is
 * present in non-interactive mode to answer a prompt); read-only sandbox maps to
 * "plan" (analysis only, no edits) regardless of approval policy.
 */
function mapSandboxToPermissionMode(
  sandbox: ProviderRunOptions['sandbox'],
  approval: ProviderRunOptions['approval'],
): string {
  if (sandbox === 'read-only') return 'plan';
  if (approval === 'never') return 'acceptEdits';
  return 'dontAsk';
}
