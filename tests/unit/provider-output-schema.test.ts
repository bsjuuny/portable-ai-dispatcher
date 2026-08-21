import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseClaudeJsonOutput, parseClaudeStreamJsonOutput } from '../../src/providers/claude/output-schema.js';
import { parseCodexStream } from '../../src/providers/codex/output-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'docs', 'fixtures', 'raw-probes');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('parseClaudeJsonOutput (real captured --output-format json sample)', () => {
  it('parses the real sample without error', () => {
    const event = parseClaudeJsonOutput(readFixture('claude-output-json.json'));
    expect(event.type).toBe('result');
    expect(event.is_error).toBe(false);
    expect(event.result).toBe('OK');
    expect(typeof event.session_id).toBe('string');
  });

  it('throws on genuinely malformed JSON rather than silently returning something', () => {
    expect(() => parseClaudeJsonOutput('{not valid json')).toThrow();
  });
});

describe('parseClaudeStreamJsonOutput (real captured --output-format stream-json sample)', () => {
  it('finds the final result event among system/rate_limit_event/assistant lines', () => {
    const event = parseClaudeStreamJsonOutput(readFixture('claude-output-stream-json.jsonl'));
    expect(event.type).toBe('result');
    expect(event.result).toBe('OK');
  });

  it('skips lines that are not valid JSON instead of aborting the whole parse', () => {
    const raw = readFixture('claude-output-stream-json.jsonl');
    const withGarbage = `not json at all\n${raw}\nmore garbage {{{`;
    const event = parseClaudeStreamJsonOutput(withGarbage);
    expect(event.type).toBe('result');
  });

  it('throws a clear error when no result event is present at all', () => {
    expect(() => parseClaudeStreamJsonOutput('{"type":"system","subtype":"init"}')).toThrow(/No "result" event/);
  });
});

describe('parseCodexStream (real captured error-path sample)', () => {
  it('parses thread.started, turn.started, error, turn.failed from the real captured sample', () => {
    const raw = readFixture('codex-output-jsonl.jsonl');
    const result = parseCodexStream(raw);
    expect(result.threadId).toBeDefined();
    expect(result.failed).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('is defensive against non-JSON noise lines mixed into stdout (observed live: garbled plugin/notify-hook text)', () => {
    const raw = readFixture('codex-output-jsonl.jsonl');
    const withNoise = `${raw}\n��: PID 12345�� garbled text��`;
    expect(() => parseCodexStream(withNoise)).not.toThrow();
    const result = parseCodexStream(withNoise);
    expect(result.failed).toBe(true); // still finds the real events despite the noise
  });

  it('reports failed:false and no errors for a clean stream with no error/turn.failed events', () => {
    const cleanStream = ['{"type":"thread.started","thread_id":"abc"}', '{"type":"turn.started"}'].join('\n');
    const result = parseCodexStream(cleanStream);
    expect(result.failed).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.threadId).toBe('abc');
  });

  it('skips lines that fail to parse as JSON entirely', () => {
    const result = parseCodexStream('not json\n{"type":"thread.started","thread_id":"x"}\n{{{broken');
    expect(result.threadId).toBe('x');
    expect(result.events).toHaveLength(1);
  });
});
