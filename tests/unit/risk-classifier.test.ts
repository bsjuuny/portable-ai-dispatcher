import { describe, expect, it } from 'vitest';
import { classifyRisk } from '../../src/safety/risk-classifier.js';
import type { ChangeScope } from '../../src/safety/change-scope.js';
import type { GitDiffSummary } from '../../src/models/validation.js';
import { DispatcherConfigSchema } from '../../src/config/schema.js';

const blastRadius = DispatcherConfigSchema.parse({}).safety.blastRadius;

function scope(overrides: Partial<ChangeScope> = {}): ChangeScope {
  return { filesChanged: 1, linesAdded: 1, linesDeleted: 0, files: ['a.txt'], ...overrides };
}

function emptyDiff(overrides: Partial<GitDiffSummary> = {}): GitDiffSummary {
  return { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [], ...overrides };
}

describe('classifyRisk', () => {
  it('classifies a small bugfix within limits as LOW', () => {
    const result = classifyRisk({
      taskType: 'bugfix',
      changeScope: scope({ filesChanged: 2, linesAdded: 10, linesDeleted: 2 }),
      gitDiff: emptyDiff({ changedFiles: ['a.txt'] }),
      blastRadius,
    });
    expect(result.level).toBe('LOW');
  });

  it('classifies a change up to 2x over the limit as MEDIUM', () => {
    const result = classifyRisk({
      taskType: 'bugfix',
      changeScope: scope({ filesChanged: blastRadius.bugfix.maxFiles * 1.5, linesAdded: 1, linesDeleted: 0, files: [] }),
      gitDiff: emptyDiff(),
      blastRadius,
    });
    expect(result.level).toBe('MEDIUM');
  });

  it('classifies a change more than 2x over the limit as HIGH', () => {
    const result = classifyRisk({
      taskType: 'refactor',
      changeScope: scope({ filesChanged: blastRadius.refactor.maxFiles * 3, linesAdded: 1, linesDeleted: 0, files: [] }),
      gitDiff: emptyDiff(),
      blastRadius,
    });
    expect(result.level).toBe('HIGH');
  });

  it('classifies any protected-path touch as CRITICAL regardless of size', () => {
    const result = classifyRisk({
      taskType: 'bugfix',
      changeScope: scope({ filesChanged: 1, linesAdded: 1, linesDeleted: 0, files: ['.env'] }),
      gitDiff: emptyDiff({ protectedPathsTouched: ['.env'] }),
      blastRadius,
    });
    expect(result.level).toBe('CRITICAL');
    expect(result.reasons[0]).toMatch(/protected path/);
  });

  it('classifies a CI/CD workflow file touch as CRITICAL even with a trivial one-line diff', () => {
    const result = classifyRisk({
      taskType: 'bugfix',
      changeScope: scope({ filesChanged: 1, linesAdded: 1, linesDeleted: 0, files: ['.github/workflows/ci.yml'] }),
      gitDiff: emptyDiff({ changedFiles: ['.github/workflows/ci.yml'] }),
      blastRadius,
    });
    expect(result.level).toBe('CRITICAL');
    expect(result.reasons[0]).toMatch(/CI\/CD/);
  });

  it('uses the implementation bucket for a task type with no dedicated bucket', () => {
    const result = classifyRisk({
      taskType: 'test-generation',
      changeScope: scope({ filesChanged: blastRadius.implementation.maxFiles, linesAdded: 1, linesDeleted: 0, files: [] }),
      gitDiff: emptyDiff(),
      blastRadius,
    });
    expect(result.level).toBe('LOW');
  });
});
