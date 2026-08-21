import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '../models/provider.js';
import type { ProviderCommandPlan } from '../providers/types.js';
import type { ProcessOutcome } from '../process/process-runner.js';
import { DispatcherError, isDispatcherError } from '../models/error.js';
import { scrubSecrets } from './redaction.js';

// Spec section 74: on a failed execution, persist enough to diagnose it later
// without re-running anything, under .dispatcher/runs/<executionId>/.
export interface FailureArtifactInput {
  taskId: string;
  executionId: string;
  provider: ProviderId;
  command: ProviderCommandPlan;
  outcome: ProcessOutcome;
  error?: DispatcherError | { code?: string; message: string } | undefined;
  startedAt: string;
  finishedAt: string;
}

/**
 * Writes metadata.json, error.json, stdout.log, stderr.log to
 * `<projectRoot>/.dispatcher/runs/<executionId>/`. Returns the directory path so
 * callers can attach it to the TaskResult (result.rawOutputPath) for discoverability.
 *
 * `command.args` is written as-is, not scrubbed: by construction (see
 * providers/claude/command-builder.ts, providers/codex/command-builder.ts), the task
 * description/attachments - the only place a secret could plausibly appear - always
 * travel via stdinContent, never argv, so argv only ever contains flags/paths/model
 * names. stdout/stderr, which genuinely can contain arbitrary provider output, are
 * scrubbed. `stdinContent` itself is deliberately never written here - the same
 * default-no-raw-prompt policy as the audit log (logging/audit.ts) applies.
 */
export async function saveFailureArtifact(projectRoot: string, input: FailureArtifactInput): Promise<string> {
  const dir = join(projectRoot, '.dispatcher', 'runs', input.executionId);
  await mkdir(dir, { recursive: true });

  const metadata = {
    taskId: input.taskId,
    executionId: input.executionId,
    provider: input.provider,
    command: input.command.file,
    args: input.command.args,
    cwd: input.command.cwd,
    exitCode: input.outcome.exitCode,
    timedOut: input.outcome.timedOut,
    durationMs: input.outcome.durationMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };

  const writes: Promise<void>[] = [
    writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8'),
    writeFile(join(dir, 'stdout.log'), scrubSecrets(input.outcome.stdout), 'utf8'),
    writeFile(join(dir, 'stderr.log'), scrubSecrets(input.outcome.stderr), 'utf8'),
  ];

  if (input.error) {
    const errorJson = isDispatcherError(input.error) ? input.error.toJSON() : input.error;
    writes.push(writeFile(join(dir, 'error.json'), JSON.stringify(errorJson, null, 2), 'utf8'));
  }

  await Promise.all(writes);
  return dir;
}
