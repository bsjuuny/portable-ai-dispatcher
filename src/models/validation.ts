export type ValidationStageName = 'git-diff' | 'typecheck' | 'lint' | 'build' | 'test';

export interface ValidationStageResult {
  stage: ValidationStageName;
  passed: boolean;
  command?: string[];
  exitCode?: number | null;
  durationMs: number;
  outputExcerpt?: string;
}

export interface GitDiffSummary {
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  protectedPathsTouched: string[];
}

export interface ValidationResult {
  taskId: string;
  passed: boolean;
  stages: ValidationStageResult[];
  failedStage?: ValidationStageName;
  gitDiff?: GitDiffSummary;
  fixLoopIterations: number;
  fixLoopExhausted: boolean;
  durationMs: number;
}
