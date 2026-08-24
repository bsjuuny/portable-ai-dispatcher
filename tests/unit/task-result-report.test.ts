import { describe, expect, it } from 'vitest';
import type { TaskOutcome } from '../../src/core/orchestrator.js';
import { buildTaskResultReport, formatTaskResultReport } from '../../src/reporting/task-result-report.js';

describe('task result report', () => {
  it('captures the complete 5W1H execution result', () => {
    const outcome: TaskOutcome = {
      task: {
        id: 'task-1',
        command: 'fix',
        specification: {
          rawDescription: 'Fix the timeout and verify the project.',
          attachments: [],
          sourcePaths: [],
        },
        workingDirectory: 'C:\\github\\ai-dispatcher',
        status: 'completed',
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
        classification: {
          type: 'repository-remediation',
          confidence: 0.98,
          requiredCapabilities: ['implementation', 'terminal'],
          riskLevel: 'medium',
          estimatedComplexity: 'complex',
          scope: 'repository',
          signals: [],
        },
        executionPlan: {
          intent: 'Inspect, repair, and verify the repository',
          scope: 'repository',
          complexity: 'complex',
          createdAt: '2026-08-22T00:00:01.000Z',
          workUnits: [
            { id: 'inspect', objective: 'Inspect failures', owner: 'provider', dependsOn: [] },
            { id: 'verify', objective: 'Run validation', owner: 'dispatcher', dependsOn: ['inspect'] },
          ],
        },
      },
      routing: {
        taskId: 'task-1',
        selected: 'codex',
        reasons: ['Best fit for repository remediation'],
        scores: [],
        decidedAt: '2026-08-22T00:00:02.000Z',
      },
      attempts: [
        {
          executionId: 'exec-1',
          provider: 'codex',
          result: {
            taskId: 'task-1',
            executionId: 'exec-1',
            provider: 'codex',
            status: 'success',
            summary: 'Fixed timeout handling and added regression coverage.',
            filesChanged: ['src/process/process-runner.ts'],
            durationMs: 60_000,
          },
        },
      ],
      validation: {
        taskId: 'task-1',
        passed: true,
        stages: [{ stage: 'test', passed: true, durationMs: 2_000 }],
        gitDiff: {
          changedFiles: ['tests/unit/process-runner.test.ts', 'src/process/process-runner.ts'],
          addedFiles: [],
          deletedFiles: [],
          protectedPathsTouched: [],
        },
        fixLoopIterations: 0,
        fixLoopExhausted: false,
        durationMs: 2_000,
      },
      review: {
        taskId: 'task-1',
        reviewer: 'claude',
        implementer: 'codex',
        independentReview: true,
        verdict: 'approve',
        findings: [],
        cycle: 1,
        durationMs: 1_000,
      },
      verdict: 'SUCCESS',
    };

    const report = buildTaskResultReport(outcome, { completedAt: '2026-08-22T00:02:00.000Z' });

    expect(report).toMatchObject({
      who: { dispatcher: 'ai-dispatcher', implementers: ['codex'], reviewer: 'claude', independentReview: true },
      when: { durationMs: 120_000 },
      where: {
        workingDirectory: 'C:\\github\\ai-dispatcher',
        changedFiles: ['src/process/process-runner.ts', 'tests/unit/process-runner.test.ts'],
      },
      what: {
        verdict: 'SUCCESS',
        changeDisposition: 'applied',
        changedFileCount: 2,
        summary: 'Fixed timeout handling and added regression coverage.',
      },
      why: {
        request: 'Fix the timeout and verify the project.',
        routingReasons: ['Best fit for repository remediation'],
      },
      how: {
        dryRun: false,
        attempts: [{ provider: 'codex', status: 'success', durationMs: 60_000 }],
        validation: { passed: true },
        review: { reviewer: 'claude', verdict: 'approve', independent: true, findingCount: 0 },
      },
    });

    expect(formatTaskResultReport(report)).toEqual(
      expect.arrayContaining([
        '결과 보고서 (6하 원칙)',
        expect.stringContaining('변경 파일(2)'),
        expect.stringContaining('검증 통과'),
      ]),
    );
  });

  it('marks dry runs as planned instead of applied', () => {
    const outcome: TaskOutcome = {
      task: {
        id: 'task-2',
        command: 'implement',
        specification: { rawDescription: 'Add a report.', attachments: [], sourcePaths: [] },
        workingDirectory: 'C:\\repo',
        status: 'completed',
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      },
      routing: {
        taskId: 'task-2',
        selected: 'codex',
        reasons: [],
        scores: [],
        decidedAt: '2026-08-22T00:00:00.500Z',
      },
      attempts: [],
      verdict: 'SUCCESS',
    };

    const report = buildTaskResultReport(outcome, {
      dryRun: true,
      completedAt: '2026-08-22T00:00:01.000Z',
    });

    expect(report.what.changeDisposition).toBe('planned');
    expect(report.how.dryRun).toBe(true);
    expect(report.who.implementers).toEqual(['codex']);
  });
});
