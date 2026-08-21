import type { ProjectContext } from '../models/context.js';
import type { ValidationResult, ValidationStageName, ValidationStageResult } from '../models/validation.js';
import { computeGitDiff } from './git-diff.js';
import { runValidationStage } from './stage-runner.js';

export interface ValidationPipelineOptions {
  taskId: string;
  cwd: string;
  project: ProjectContext;
  protectedPaths?: string[];
  /** Explicit config always overrides project-analyzer auto-detected commands (spec section 47/48). */
  commandOverrides?: Partial<Record<ValidationStageName, string[]>>;
  stageTimeoutMs?: number;
}

type CommandStage = Exclude<ValidationStageName, 'git-diff'>;
const STAGE_ORDER: CommandStage[] = ['typecheck', 'lint', 'build', 'test'];

export async function runValidationPipeline(options: ValidationPipelineOptions): Promise<ValidationResult> {
  const startedAt = Date.now();
  const stages: ValidationStageResult[] = [];

  const gitDiff = await computeGitDiff(options.cwd, options.protectedPaths ?? []);
  stages.push({
    stage: 'git-diff',
    passed: gitDiff.protectedPathsTouched.length === 0,
    durationMs: 0,
    outputExcerpt:
      gitDiff.protectedPathsTouched.length > 0
        ? `Protected path(s) modified: ${gitDiff.protectedPathsTouched.join(', ')}`
        : `${gitDiff.changedFiles.length} file(s) changed.`,
  });

  let failedStage: ValidationStageName | undefined = stages[0]?.passed ? undefined : 'git-diff';

  for (const stageName of STAGE_ORDER) {
    if (failedStage) break; // don't run later stages once one has already failed
    const command = options.commandOverrides?.[stageName] ?? options.project.commands[stageName];
    const result = await runValidationStage({
      stage: stageName,
      command,
      cwd: options.cwd,
      timeoutMs: options.stageTimeoutMs,
    });
    stages.push(result);
    if (!result.passed) failedStage = stageName;
  }

  return {
    taskId: options.taskId,
    passed: !failedStage,
    stages,
    failedStage,
    gitDiff,
    fixLoopIterations: 0,
    fixLoopExhausted: false,
    durationMs: Date.now() - startedAt,
  };
}
