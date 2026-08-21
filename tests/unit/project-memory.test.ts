import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectMemory } from '../../src/project/memory.js';

describe('ProjectMemory', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-memory-'));
    filePath = join(dir, 'memory.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns no snippets before anything has been remembered', async () => {
    const memory = new ProjectMemory(filePath);
    const snippets = await memory.relevantTo('anything');
    expect(snippets).toEqual([]);
  });

  it('persists a remembered decision to disk and reloads it in a new instance', async () => {
    const memory = new ProjectMemory(filePath);
    await memory.remember({ summary: 'Chose node:sqlite over better-sqlite3', path: 'src/history/db.ts', decision: 'no native compile toolchain available' });

    const reloaded = new ProjectMemory(filePath);
    const snippets = await reloaded.relevantTo('sqlite database choice');
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.summary).toContain('node:sqlite');
  });

  it('never stores full source text, only summary/path/decision/hash fields', async () => {
    const memory = new ProjectMemory(filePath);
    await memory.remember({ summary: 'short summary', sourceText: 'x'.repeat(5000) });
    const snippets = await memory.relevantTo('short summary');
    expect(snippets[0]!.hash).toHaveLength(16);
    expect(JSON.stringify(snippets[0])).not.toContain('x'.repeat(100));
  });

  it('ranks a keyword-overlapping record above an unrelated one', async () => {
    const memory = new ProjectMemory(filePath);
    await memory.remember({ summary: 'Authentication uses JWT tokens with refresh rotation' });
    await memory.remember({ summary: 'Payment processing uses Stripe webhooks' });

    const results = await memory.relevantTo('how does authentication token refresh work');
    expect(results[0]!.summary).toContain('Authentication');
  });

  it('respects the limit parameter', async () => {
    const memory = new ProjectMemory(filePath);
    for (let i = 0; i < 10; i += 1) {
      await memory.remember({ summary: `decision number ${i} about testing` });
    }
    const results = await memory.relevantTo('testing decisions', 3);
    expect(results).toHaveLength(3);
  });
});
