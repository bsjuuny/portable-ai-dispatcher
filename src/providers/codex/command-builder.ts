import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatcherTask } from '../../models/task.js';
import type { TaskContext } from '../../models/context.js';
import type { ProviderCommandPlan, ProviderRunOptions } from '../types.js';
import { renderTaskPrompt } from '../prompt-renderer.js';

/**
 * Pure function: plain data in, argv array out (see claude/command-builder.ts for
 * why this matters for shell-injection testing).
 *
 * IMPORTANT, verified live against the installed CLI (codex-cli 0.130.0): `-a/--ask-
 * for-approval` and `-s/--sandbox` are GLOBAL flags and do NOT appear under
 * `codex exec --help` at all. They must precede the `exec` subcommand
 * (`codex -a never -s read-only exec --json ...`), not follow it. This was confirmed
 * both by reading real --help output and by a real successful (accepted-syntax) live
 * probe - see docs/fixtures/raw-probes/codex-output-jsonl.jsonl.
 *
 * The prompt is always sent via stdin (codex exec reads stdin when no positional
 * prompt is given, or appends it as a <stdin> block if one is - we never rely on the
 * positional form to avoid OS argv length limits for large task specs).
 *
 * `--output-last-message <file>` is used to reliably capture the final response text
 * without depending on the exact shape of the success-path JSONL events, which could
 * not be verified live at implementation time (the configured account had hit its
 * usage limit - see docs/fixtures/raw-probes/codex-stderr.log). The JSONL stream
 * itself (--json) is still parsed for turn.started/turn.failed/error detection, which
 * WAS verified live.
 */
export function buildCodexCommand(
  task: DispatcherTask,
  context: TaskContext,
  opts: ProviderRunOptions,
): ProviderCommandPlan {
  const outputLastMessagePath = join(tmpdir(), `ai-dispatcher-codex-${task.id}-${randomUUID()}.txt`);

  const args: string[] = ['-a', opts.approval, '-s', opts.sandbox];
  if (opts.model) args.push('-m', opts.model);
  args.push('exec', '--json', '--skip-git-repo-check', '-o', outputLastMessagePath);

  return {
    file: 'codex',
    args,
    cwd: task.workingDirectory,
    timeoutMs: opts.timeoutMs,
    stdinContent: renderTaskPrompt(task, context),
    metadata: { outputLastMessagePath },
  };
}
