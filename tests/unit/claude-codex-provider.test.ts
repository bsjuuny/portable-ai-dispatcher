import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClaudeProvider } from '../../src/providers/claude/claude-provider.js';
import { CodexProvider } from '../../src/providers/codex/codex-provider.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { ProcessOutcome } from '../../src/process/process-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'docs', 'fixtures', 'raw-probes');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function task(overrides: Partial<DispatcherTask> = {}): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 't1', command: 'ask',
    specification: { rawDescription: 'hi', attachments: [], sourcePaths: [] },
    workingDirectory: '.', status: 'created', createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function outcome(overrides: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 100, ...overrides };
}

describe('ClaudeProvider.parseOutcome', () => {
  const provider = new ClaudeProvider();

  it('reports capabilities appropriate to its provider role', () => {
    expect(provider.capabilities()).toContain('architecture');
    expect(provider.capabilities()).toContain('review');
  });

  it('parses the real captured stream-json sample into a success TaskResult', () => {
    const result = provider.parseOutcome(outcome({ stdout: readFixture('claude-output-stream-json.jsonl') }), task(), 'e1');
    expect(result.status).toBe('success');
    expect(result.text).toBe('OK');
    expect(typeof result.sessionId).toBe('string');
  });

  it('reports timeout status without attempting to parse output', () => {
    const result = provider.parseOutcome(outcome({ timedOut: true, stdout: '' }), task(), 'e1');
    expect(result.status).toBe('timeout');
    expect(result.error?.code).toBe('PROCESS_TIMEOUT');
  });

  it('throws OUTPUT_PARSE_FAILED for empty stdout (not a silent success)', () => {
    expect(() => provider.parseOutcome(outcome({ stdout: '' }), task(), 'e1')).toThrow();
  });

  it('throws INVALID_PROVIDER_OUTPUT for stdout that is not valid Claude JSONL', () => {
    expect(() => provider.parseOutcome(outcome({ stdout: 'not json at all' }), task(), 'e1')).toThrow();
  });

  it('reports failed status when the parsed result event has is_error:true', () => {
    const errorEvent = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'something broke', session_id: 's1', duration_ms: 10 });
    const result = provider.parseOutcome(outcome({ stdout: errorEvent }), task(), 'e1');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('something broke');
  });
});

describe('CodexProvider.parseOutcome', () => {
  const provider = new CodexProvider();

  it('reports capabilities appropriate to its provider role', () => {
    expect(provider.capabilities()).toContain('implementation');
    expect(provider.capabilities()).toContain('bugfix');
  });

  it('parses the real captured error-path sample into a failed TaskResult', async () => {
    const result = await provider.parseOutcome(
      outcome({ stdout: readFixture('codex-output-jsonl.jsonl'), exitCode: 1 }),
      task(),
      'e1',
      { file: 'codex', args: [], cwd: '.', timeoutMs: 1000 },
    );
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('usage limit');
    expect(result.sessionId).toBeDefined();
  });

  it('reports timeout status without attempting to parse output', async () => {
    const result = await provider.parseOutcome(outcome({ timedOut: true }), task(), 'e1', { file: 'codex', args: [], cwd: '.', timeoutMs: 1000 });
    expect(result.status).toBe('timeout');
  });

  it('reports success when the stream has no error/turn.failed events and exit code is 0', async () => {
    const cleanStream = ['{"type":"thread.started","thread_id":"abc"}', '{"type":"turn.completed"}'].join('\n');
    const result = await provider.parseOutcome(outcome({ stdout: cleanStream, exitCode: 0 }), task(), 'e1', { file: 'codex', args: [], cwd: '.', timeoutMs: 1000 });
    expect(result.status).toBe('success');
    expect(result.sessionId).toBe('abc');
  });

  it('reports failed for a non-zero exit code even with no error events in the stream', async () => {
    const cleanStream = '{"type":"thread.started","thread_id":"abc"}';
    const result = await provider.parseOutcome(
      outcome({ stdout: cleanStream, exitCode: 1, stderr: 'crashed unexpectedly' }),
      task(),
      'e1',
      { file: 'codex', args: [], cwd: '.', timeoutMs: 1000 },
    );
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('crashed unexpectedly');
  });
});
