import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns full defaults when no config file exists', () => {
    const config = loadConfig(dir);
    expect(config.execution.timeoutMs).toBe(300_000);
  });

  it('loads and merges a real .ai-dispatcher.yml file', async () => {
    await writeFile(
      join(dir, '.ai-dispatcher.yml'),
      'execution:\n  timeoutMs: 60000\n  sandbox: read-only\nsafety:\n  protectedPaths:\n    - .env\n    - custom-secret/\n',
      'utf8',
    );
    const config = loadConfig(dir);
    expect(config.execution.timeoutMs).toBe(60_000);
    expect(config.execution.sandbox).toBe('read-only');
    expect(config.safety.protectedPaths).toEqual(['.env', 'custom-secret/']);
    expect(config.retry.maxRetries).toBe(1); // untouched section still defaulted
  });

  it('prefers .yml over .yaml when both exist', async () => {
    await writeFile(join(dir, '.ai-dispatcher.yml'), 'execution:\n  timeoutMs: 111\n', 'utf8');
    await writeFile(join(dir, '.ai-dispatcher.yaml'), 'execution:\n  timeoutMs: 222\n', 'utf8');
    const config = loadConfig(dir);
    expect(config.execution.timeoutMs).toBe(111);
  });

  it('throws CONFIG_INVALID for malformed YAML', async () => {
    await writeFile(join(dir, '.ai-dispatcher.yml'), 'execution:\n  timeoutMs: [unclosed\n', 'utf8');
    try {
      loadConfig(dir);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error) && error.code === 'CONFIG_INVALID').toBe(true);
    }
  });

  it('throws CONFIG_INVALID for YAML that is well-formed but violates the schema', async () => {
    await writeFile(join(dir, '.ai-dispatcher.yml'), 'execution:\n  sandbox: not-a-real-option\n', 'utf8');
    try {
      loadConfig(dir);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error) && error.code === 'CONFIG_INVALID').toBe(true);
    }
  });
});
