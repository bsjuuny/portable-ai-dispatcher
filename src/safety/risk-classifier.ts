import type { TaskType } from '../models/classification.js';
import type { GitDiffSummary } from '../models/validation.js';
import type { DispatcherConfig } from '../config/schema.js';
import type { ChangeScope } from './change-scope.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface RiskClassification {
  level: RiskLevel;
  reasons: string[];
}

export interface RiskClassificationInput {
  taskType: TaskType;
  changeScope: ChangeScope;
  gitDiff: GitDiffSummary;
  blastRadius: DispatcherConfig['safety']['blastRadius'];
}

// Structural CRITICAL triggers independent of config.safety.protectedPaths -
// altering CI/CD pipeline definitions is inherently high blast-radius (can
// disable checks, exfiltrate secrets via a modified workflow) regardless of line
// count, so size-based limits below never apply to these paths.
const CI_PIPELINE_PATTERNS: RegExp[] = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)azure-pipelines\.ya?ml$/,
  /(^|\/)Jenkinsfile$/,
];

/** Pure function: same inputs always produce the same classification, no I/O. */
export function classifyRisk(input: RiskClassificationInput): RiskClassification {
  if (input.gitDiff.protectedPathsTouched.length > 0) {
    return {
      level: 'CRITICAL',
      reasons: [`touches configured protected path(s): ${input.gitDiff.protectedPathsTouched.join(', ')}`],
    };
  }

  const ciFiles = input.changeScope.files.filter((f) => CI_PIPELINE_PATTERNS.some((p) => p.test(f)));
  if (ciFiles.length > 0) {
    return { level: 'CRITICAL', reasons: [`touches CI/CD pipeline file(s): ${ciFiles.join(', ')}`] };
  }

  const limits = input.blastRadius[bucketFor(input.taskType)];
  const totalLines = input.changeScope.linesAdded + input.changeScope.linesDeleted;
  const filesRatio = input.changeScope.filesChanged / limits.maxFiles;
  const linesRatio = totalLines / limits.maxChangedLines;
  const worstRatio = Math.max(filesRatio, linesRatio);

  const summary = `${input.changeScope.filesChanged} files / ${totalLines} lines changed vs limit ${limits.maxFiles} files / ${limits.maxChangedLines} lines`;

  if (worstRatio <= 1) {
    return { level: 'LOW', reasons: [`within blast radius limits (${summary})`] };
  }
  if (worstRatio <= 2) {
    return { level: 'MEDIUM', reasons: [`up to 2x over blast radius limits (${worstRatio.toFixed(2)}x - ${summary})`] };
  }
  return { level: 'HIGH', reasons: [`more than 2x over blast radius limits (${worstRatio.toFixed(2)}x - ${summary})`] };
}

function bucketFor(taskType: TaskType): keyof DispatcherConfig['safety']['blastRadius'] {
  if (taskType === 'bugfix') return 'bugfix';
  if (taskType === 'refactor') return 'refactor';
  // Every other classification that can still reach the safety gate (implementation,
  // plus anything the classifier didn't map to bugfix/refactor) uses the
  // 'implementation' bucket as the reasonable middle default.
  return 'implementation';
}
