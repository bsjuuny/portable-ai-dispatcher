import type { ChangeDisposition, TaskOutcome } from '../core/orchestrator.js';
import type { ProviderId } from '../models/provider.js';

export interface TaskResultReport {
  who: {
    dispatcher: 'ai-dispatcher';
    implementers: ProviderId[];
    reviewer?: ProviderId;
    independentReview?: boolean;
  };
  when: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
  where: {
    workingDirectory: string;
    changedFiles: string[];
  };
  what: {
    command: TaskOutcome['task']['command'];
    taskType?: string;
    intent?: string;
    scope?: string;
    verdict: TaskOutcome['verdict'];
    changeDisposition: ChangeDisposition;
    changedFileCount: number;
    summary: string;
  };
  why: {
    request: string;
    routingReasons: string[];
  };
  how: {
    dryRun: boolean;
    workUnits: Array<{ id: string; objective: string; owner: string }>;
    attempts: Array<{ provider: ProviderId; status: string; durationMs: number }>;
    validation?: {
      passed: boolean;
      failedStage?: string;
      stages: Array<{ stage: string; passed: boolean; durationMs: number }>;
    };
    review?: {
      reviewer: ProviderId;
      verdict: string;
      independent: boolean;
      findingCount: number;
    };
  };
}

export interface BuildTaskResultReportOptions {
  dryRun?: boolean;
  completedAt?: string;
}

/** Builds one stable, machine-readable 5W1H report from the complete outcome. */
export function buildTaskResultReport(
  outcome: TaskOutcome,
  options: BuildTaskResultReportOptions = {},
): TaskResultReport {
  const completedAt = options.completedAt ?? new Date().toISOString();
  const changedFiles = collectChangedFiles(outcome);
  const implementers = unique(
    outcome.attempts.length > 0 ? outcome.attempts.map((attempt) => attempt.provider) : [outcome.routing.selected],
  );

  return {
    who: {
      dispatcher: 'ai-dispatcher',
      implementers,
      reviewer: outcome.review?.reviewer,
      independentReview: outcome.review?.independentReview,
    },
    when: {
      startedAt: outcome.task.createdAt,
      completedAt,
      durationMs: elapsedMs(outcome.task.createdAt, completedAt),
    },
    where: {
      workingDirectory: outcome.task.workingDirectory,
      changedFiles,
    },
    what: {
      command: outcome.task.command,
      taskType: outcome.task.classification?.type,
      intent: outcome.task.executionPlan?.intent,
      scope: outcome.task.executionPlan?.scope ?? outcome.task.classification?.scope,
      verdict: outcome.verdict,
      changeDisposition:
        outcome.changeDisposition ?? changeDisposition(outcome, options.dryRun ?? false, changedFiles.length),
      changedFileCount: changedFiles.length,
      summary: outcomeSummary(outcome, options.dryRun ?? false, changedFiles.length),
    },
    why: {
      request: oneLine(outcome.task.specification.rawDescription, 500),
      routingReasons: outcome.routing.reasons,
    },
    how: {
      dryRun: options.dryRun ?? false,
      workUnits: (outcome.task.executionPlan?.workUnits ?? []).map((unit) => ({
        id: unit.id,
        objective: unit.objective,
        owner: unit.owner,
      })),
      attempts: outcome.attempts.map((attempt) => ({
        provider: attempt.provider,
        status: attempt.result.status,
        durationMs: attempt.result.durationMs,
      })),
      validation: outcome.validation
        ? {
            passed: outcome.validation.passed,
            failedStage: outcome.validation.failedStage,
            stages: outcome.validation.stages.map((stage) => ({
              stage: stage.stage,
              passed: stage.passed,
              durationMs: stage.durationMs,
            })),
          }
        : undefined,
      review: outcome.review
        ? {
            reviewer: outcome.review.reviewer,
            verdict: outcome.review.verdict,
            independent: outcome.review.independentReview,
            findingCount: outcome.review.findings.length,
          }
        : undefined,
    },
  };
}

/** Renders the same JSON report as a concise Korean terminal summary. */
export function formatTaskResultReport(report: TaskResultReport): string[] {
  const implementers = report.who.implementers.join(', ') || '없음';
  const executionLabel = report.how.dryRun ? '예정 실행' : '실행';
  const reviewer = report.who.reviewer
    ? `, 검토=${report.who.reviewer} (독립=${report.who.independentReview ? '예' : '아니요'})`
    : '';
  const files = report.where.changedFiles.length > 0 ? report.where.changedFiles.join(', ') : '없음';
  const validation = report.how.validation
    ? report.how.validation.passed
      ? '검증 통과'
      : `검증 실패(${report.how.validation.failedStage ?? '단계 미상'})`
    : '검증 없음';
  const review = report.how.review ? `검토 ${report.how.review.verdict}` : '검토 없음';
  const attempts = report.how.attempts.length > 0
    ? report.how.attempts.map((attempt) => `${attempt.provider}:${attempt.status}`).join(' -> ')
    : report.how.dryRun
      ? '실행 생략(dry-run)'
      : '실행 기록 없음';

  return [
    '결과 보고서 (6하 원칙)',
    `  누가: 조정=ai-dispatcher, ${executionLabel}=${implementers}${reviewer}`,
    `  언제: ${report.when.startedAt} ~ ${report.when.completedAt} (${formatDuration(report.when.durationMs)})`,
    `  어디서: ${report.where.workingDirectory}`,
    `  무엇을: ${report.what.summary} [${report.what.verdict}, ${describeDisposition(report.what.changeDisposition)}]`,
    `    변경 파일(${report.what.changedFileCount}): ${files}`,
    `  왜: ${report.why.request}`,
    `  어떻게: 작업 ${report.how.workUnits.length}개, ${attempts}, ${validation}, ${review}`,
  ];
}

function collectChangedFiles(outcome: TaskOutcome): string[] {
  const validationFiles = outcome.validation?.gitDiff?.changedFiles ?? [];
  const attemptFiles = outcome.attempts.flatMap((attempt) => attempt.result.filesChanged ?? []);
  return unique([...validationFiles, ...attemptFiles]).sort();
}

function changeDisposition(
  outcome: TaskOutcome,
  dryRun: boolean,
  changedFileCount: number,
): TaskResultReport['what']['changeDisposition'] {
  if (dryRun) return 'planned';
  if (outcome.verdict === 'BLOCKED_BY_POLICY') return 'withheld';
  if (outcome.verdict.startsWith('FAILED') || outcome.verdict === 'CANCELLED') return 'unknown';
  if (changedFileCount === 0) return 'no-code-change';
  return 'applied';
}

function outcomeSummary(outcome: TaskOutcome, dryRun: boolean, changedFileCount: number): string {
  if (dryRun) return `실행 계획 수립: ${outcome.task.executionPlan?.intent ?? outcome.task.command}`;

  const providerSummary = [...outcome.attempts]
    .reverse()
    .map((attempt) => attempt.result.summary ?? attempt.result.text)
    .find((summary): summary is string => typeof summary === 'string' && summary.trim().length > 0);
  if (providerSummary) return oneLine(providerSummary, 300);
  if (changedFileCount > 0) return `${changedFileCount}개 파일 변경`;
  return outcome.verdict === 'SUCCESS' ? '요청 처리 완료(파일 변경 없음)' : `요청 처리 결과: ${outcome.verdict}`;
}

function elapsedMs(startedAt: string, completedAt: string): number {
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

function describeDisposition(disposition: ChangeDisposition): string {
  const descriptions: Record<ChangeDisposition, string> = {
    planned: '계획만 수립',
    applied: '반영 완료',
    withheld: '정책상 미반영',
    discarded: '격리 작업 폐기',
    'left-in-place': '작업 디렉터리에 변경 남음',
    'no-code-change': '코드 변경 없음',
    unknown: '변경 상태 확인 필요',
  };
  return descriptions[disposition];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
