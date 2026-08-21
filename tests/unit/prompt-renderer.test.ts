import { describe, expect, it } from 'vitest';
import { renderTaskPrompt } from '../../src/providers/prompt-renderer.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { TaskContext } from '../../src/models/context.js';

function task(overrides: Partial<DispatcherTask['specification']> = {}): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 't1', command: 'fix', workingDirectory: '.', status: 'created', createdAt: now, updatedAt: now,
    specification: { rawDescription: '로그인 오류 수정', attachments: [], sourcePaths: [], ...overrides },
  };
}

describe('renderTaskPrompt', () => {
  it('always includes the raw description verbatim (spec section 21/23)', () => {
    const prompt = renderTaskPrompt(task(), {});
    expect(prompt).toContain('로그인 오류 수정');
  });

  it('includes structured error codes, requirements, and constraints when present', () => {
    const t = task({ structured: { errorCodes: ['ERR-1'], requirements: ['req A'], constraints: ['no API changes'] } });
    const prompt = renderTaskPrompt(t, {});
    expect(prompt).toContain('ERR-1');
    expect(prompt).toContain('req A');
    expect(prompt).toContain('no API changes');
  });

  it('includes project context fields when available', () => {
    const context: TaskContext = { project: { root: '.', isGitRepo: true, language: 'typescript-javascript', framework: 'next', commands: {} } };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).toContain('next');
  });

  it('includes memory snippets', () => {
    const context: TaskContext = { memorySnippets: [{ summary: 'chose node:sqlite', hash: 'abc', recordedAt: '2026-01-01' }] };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).toContain('chose node:sqlite');
  });

  it('renders windowed attachments with their reason/line-range headers instead of raw attachment content when both are present', () => {
    const context: TaskContext = {
      attachments: [{ id: 'a1', type: 'log', sizeBytes: 100, sha256: 'x', truncated: false, content: 'RAW UNWINDOWED CONTENT should not appear' }],
      windowedAttachments: [{ attachmentId: 'a1', windows: [{ reason: 'stack-trace', startLine: 1, endLine: 3, text: 'WINDOWED CONTENT' }], totalLineCount: 100, keptLineCount: 3, dedupedLineCount: 0, truncated: true }],
    };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).toContain('WINDOWED CONTENT');
    expect(prompt).toContain('truncated');
    expect(prompt).not.toContain('RAW UNWINDOWED CONTENT');
  });

  it('falls back to raw attachment content when no windowing was applied', () => {
    const context: TaskContext = {
      attachments: [{ id: 'a1', type: 'log', sizeBytes: 10, sha256: 'x', truncated: false, content: 'short log content' }],
    };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).toContain('short log content');
  });

  it('includes the previous validation failure output when the last validation failed', () => {
    const context: TaskContext = {
      validationResults: [{ taskId: 't1', passed: false, stages: [{ stage: 'test', passed: false, durationMs: 1, outputExcerpt: 'AssertionError: expected 1 to be 2' }], failedStage: 'test', fixLoopIterations: 0, fixLoopExhausted: false, durationMs: 1 }],
    };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).toContain('AssertionError');
    expect(prompt).toContain('test');
  });

  it('does not mention validation at all when the last validation passed', () => {
    const context: TaskContext = {
      validationResults: [{ taskId: 't1', passed: true, stages: [], fixLoopIterations: 0, fixLoopExhausted: false, durationMs: 1 }],
    };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).not.toContain('Previous Validation Failure');
  });

  it('includes previous review findings', () => {
    const context: TaskContext = {
      reviewResults: [{ taskId: 't1', reviewer: 'claude', implementer: 'codex', independentReview: true, verdict: 'request_changes', findings: [{ severity: 'error', category: 'null-safety', message: 'user may be null' }], cycle: 1, durationMs: 1 }],
    };
    const prompt = renderTaskPrompt(task(), context);
    expect(prompt).toContain('null-safety');
    expect(prompt).toContain('user may be null');
    expect(prompt).toContain('claude');
  });
});
