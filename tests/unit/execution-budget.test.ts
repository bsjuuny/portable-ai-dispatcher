import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/schema.js';
import { resolveExecutionBudget } from '../../src/execution/budget.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { TaskClassification } from '../../src/models/classification.js';

function task(timeoutMs?: number): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 't',
    command: 'fix',
    specification: { rawDescription: 'fix', attachments: [], sourcePaths: [] },
    workingDirectory: '.',
    timeoutMs,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
}

function classification(complexity: TaskClassification['estimatedComplexity']): TaskClassification {
  return {
    type: 'bugfix',
    confidence: 1,
    requiredCapabilities: ['bugfix'],
    riskLevel: 'medium',
    estimatedComplexity: complexity,
    scope: 'targeted',
    signals: [],
  };
}

describe('resolveExecutionBudget', () => {
  it('assigns a larger budget to complex autonomous work', () => {
    const config = parseConfig({});
    const simple = resolveExecutionBudget(task(), classification('simple'), config.execution);
    const complex = resolveExecutionBudget(task(), classification('complex'), config.execution);
    expect(simple.hardTimeoutMs).toBe(300_000);
    expect(complex.hardTimeoutMs).toBe(1_800_000);
    expect(complex.idleTimeoutMs).toBe(300_000);
    expect(complex.source).toBe('adaptive');
  });

  it('honors an explicit timeout while keeping the configured safety ceiling', () => {
    const config = parseConfig({ execution: { adaptiveTimeout: { maximumMs: 600_000 } } });
    const budget = resolveExecutionBudget(task(900_000), classification('complex'), config.execution);
    expect(budget.hardTimeoutMs).toBe(600_000);
    expect(budget.source).toBe('explicit');
  });
});
