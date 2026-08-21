import { runProcess } from '../process/process-runner.js';
import type { ValidationStageName, ValidationStageResult } from '../models/validation.js';

const MAX_OUTPUT_EXCERPT_CHARS = 4000;

export interface RunStageOptions {
  stage: ValidationStageName;
  command: string[] | undefined;
  cwd: string;
  timeoutMs?: number;
}

/**
 * Runs a single validation command (build/test/lint/typecheck) through the shared
 * ProcessRunner. When no command is configured or auto-detected for this project
 * (see project/analyzer.ts), the stage is treated as passed-by-absence rather than
 * failed - a project with no lint script isn't lint-broken, it just has no lint step.
 */
export async function runValidationStage(options: RunStageOptions): Promise<ValidationStageResult> {
  const startedAt = Date.now();

  if (!options.command || options.command.length === 0) {
    return {
      stage: options.stage,
      passed: true,
      durationMs: Date.now() - startedAt,
      outputExcerpt: `No ${options.stage} command configured/detected - skipped.`,
    };
  }

  const [file, ...args] = options.command;
  if (!file) {
    return {
      stage: options.stage,
      passed: true,
      durationMs: Date.now() - startedAt,
      outputExcerpt: `No ${options.stage} command configured/detected - skipped.`,
    };
  }

  const outcome = await runProcess({
    file,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 300_000,
  });

  const passed = outcome.exitCode === 0 && !outcome.timedOut;
  const combinedOutput = `${outcome.stdout}\n${outcome.stderr}`.trim();

  return {
    stage: options.stage,
    passed,
    command: options.command,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    outputExcerpt: passed ? undefined : excerpt(combinedOutput),
  };
}

function excerpt(text: string): string {
  if (text.length <= MAX_OUTPUT_EXCERPT_CHARS) return text;
  const half = Math.floor(MAX_OUTPUT_EXCERPT_CHARS / 2);
  return `${text.slice(0, half)}\n...[truncated]...\n${text.slice(-half)}`;
}
