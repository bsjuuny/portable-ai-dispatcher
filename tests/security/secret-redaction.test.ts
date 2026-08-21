import { describe, expect, it } from 'vitest';
import { scrubSecrets, hashContent, shortHash } from '../../src/logging/redaction.js';
import { AuditLogger, InMemoryAuditSink } from '../../src/logging/audit.js';

const SECRET_SAMPLES: Array<{ label: string; text: string }> = [
  { label: 'AWS access key', text: 'aws_key=AKIAABCDEFGHIJKLMNOP end' },
  { label: 'OpenAI/Anthropic-style key', text: 'export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456' },
  { label: 'GitHub PAT', text: 'token: ghp_1234567890abcdefghijklmnopqrstuvwxyz' },
  { label: 'GitHub fine-grained PAT', text: 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890' },
  {
    label: 'JWT',
    text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc19pc19hX3NpZ25hdHVyZQ',
  },
  {
    label: 'PEM private key',
    text: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...redacted...\n-----END RSA PRIVATE KEY-----',
  },
  { label: '.env-style secret line', text: 'DB_PASSWORD=hunter2\nDB_HOST=localhost' },
];

describe('scrubSecrets', () => {
  it.each(SECRET_SAMPLES)('removes $label from text', ({ text }) => {
    const scrubbed = scrubSecrets(text);
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('does not remove ordinary code that merely mentions "password" as an identifier without a value', () => {
    const code = 'function validatePassword(password: string): boolean { return password.length > 8; }';
    expect(scrubSecrets(code)).toBe(code);
  });

  it('preserves surrounding non-secret text', () => {
    const text = 'Before AKIAABCDEFGHIJKLMNOP After';
    expect(scrubSecrets(text)).toBe('Before [REDACTED] After');
  });
});

describe('hashContent / shortHash', () => {
  it('is deterministic', () => {
    expect(hashContent('same input')).toBe(hashContent('same input'));
  });

  it('shortHash is a prefix of the full hash, never the full 64-char value', () => {
    const full = hashContent('some content');
    const short = shortHash('some content');
    expect(full).toHaveLength(64);
    expect(short).toHaveLength(12);
    expect(full.startsWith(short)).toBe(true);
  });
});

describe('AuditLogger default policy (spec section 71/72)', () => {
  it('never stores raw prompt text by default', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink, { storeRawContent: false });
    const secretPrompt = 'Fix the bug. My AWS key is AKIAABCDEFGHIJKLMNOP.';

    await logger.recordPromptMetadata('task1', 'task.created', secretPrompt);

    const event = sink.events[0]!;
    expect(JSON.stringify(event.data)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(JSON.stringify(event.data)).not.toContain(secretPrompt);
    expect(event.data['promptLength']).toBe(secretPrompt.length);
    expect(typeof event.data['promptSha256']).toBe('string');
  });

  it('scrubs secrets even when storeRawContent is explicitly opted in', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink, { storeRawContent: true });
    const secretPrompt = 'token=ghp_1234567890abcdefghijklmnopqrstuvwxyz please use this';

    await logger.recordPromptMetadata('task1', 'task.created', secretPrompt);

    const event = sink.events[0]!;
    expect(JSON.stringify(event.data)).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(event.data['promptText']).toContain('[REDACTED]');
  });

  it('omits large free-text string fields from generic record() calls by default, not just the dedicated prompt/response helpers', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink, { storeRawContent: false });
    const longText = 'x'.repeat(500);

    await logger.record('task1', 'task.created', { someField: longText, shortField: 'ok' });

    const event = sink.events[0]!;
    expect(event.data['someField']).toBe('[large text omitted]');
    expect(event.data['shortField']).toBe('ok');
  });
});
