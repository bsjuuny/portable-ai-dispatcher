import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/types.js';
import type { AIProvider, ProviderCommandPlan } from '../../src/providers/types.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { ProviderId } from '../../src/models/provider.js';
import type { TaskResult } from '../../src/models/result.js';
import { InMemoryUsageStore } from '../../src/routing/usage-store.js';
import { AuditLogger, InMemoryAuditSink } from '../../src/logging/audit.js';
import { parseConfig } from '../../src/config/schema.js';
import { runProcess } from '../../src/process/process-runner.js';

/**
 * A fake AIProvider that never spawns a real process - it directly returns
 * pre-scripted outcomes, so orchestrator tests are fast, deterministic, and don't
 * depend on any external CLI being installed. Records every call for assertions.
 */
class FakeProvider implements AIProvider {
  callCount = 0;
  calls: DispatcherTask['command'][] = [];

  constructor(
    readonly id: ProviderId,
    private readonly caps: string[],
    private readonly script: TaskResult[] | (() => TaskResult),
  ) {}

  capabilities() {
    return this.caps as never;
  }

  async checkHealth() {
    return {
      provider: this.id,
      checkedAt: new Date().toISOString(),
      installed: true,
      authenticated: true,
      reachable: true,
      rateLimited: false,
      ready: true,
    };
  }

  buildCommand(task: DispatcherTask): ProviderCommandPlan {
    this.calls.push(task.command);
    // Deliberately NOT `file: this.id` - that would literally spawn the real
    // `claude`/`codex` binary on PATH (found while adding failure-artifact tests:
    // parseOutcome() below is fully scripted and ignores the real ProcessOutcome, but
    // executeOnce() still always calls the real runProcess() in between, so a fake
    // provider whose buildCommand names a real CLI binary genuinely launches it).
    // A trivial real Node subprocess keeps executeOnce's actual process-spawn path
    // exercised without any risk of touching a real provider CLI.
    return { file: process.execPath, args: ['-e', 'process.exit(0)'], cwd: task.workingDirectory, timeoutMs: 1000 };
  }

  parseOutcome(): TaskResult {
    const index = this.callCount;
    this.callCount += 1;
    if (typeof this.script === 'function') return this.script();
    return this.script[Math.min(index, this.script.length - 1)]!;
  }
}

function successResult(provider: ProviderId): TaskResult {
  return { taskId: 't', executionId: `e${Math.random()}`, provider, status: 'success', durationMs: 10, text: 'done' };
}
function failedResult(provider: ProviderId): TaskResult {
  return { taskId: 't', executionId: `e${Math.random()}`, provider, status: 'failed', durationMs: 10, error: { message: 'boom' } };
}

function buildTask(overrides: Partial<DispatcherTask> = {}): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: `task_${Math.random().toString(36).slice(2)}`,
    command: 'ask',
    specification: { rawDescription: 'do a thing', attachments: [], sourcePaths: [] },
    workingDirectory: process.cwd(),
    status: 'created',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Orchestrator - non-code-changing commands (ask/analyze/review)', () => {
  it('completes successfully without touching validation/review at all', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [successResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({}),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(outcome.task.status).toBe('completed');
    expect(outcome.validation).toBeUndefined();
    expect(outcome.review).toBeUndefined();
  });

  it('reports FAILED_PROVIDER when the only provider fails and fallback is disabled', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [failedResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: false } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(outcome.verdict).toBe('FAILED_PROVIDER');
    expect(outcome.task.status).toBe('failed');
  });
});

describe('Orchestrator - the core never branches on provider name (proven with a third, fake provider id)', () => {
  it('routes to and successfully executes against a provider id the orchestrator has never heard of', async () => {
    // "fake" is not "claude" | "codex" at the type level in this codebase, but at
    // runtime nothing in orchestrator.ts/router.ts/scorer.ts/fallback.ts special-
    // cases either literal string - they only ever read provider.id and
    // provider.capabilities() through the AIProvider interface.
    const fake = new FakeProvider('claude' as ProviderId, ['analysis'], [successResult('claude')]);
    Object.defineProperty(fake, 'id', { value: 'totally-unknown-provider', writable: false });

    const registry = new ProviderRegistry();
    registry.register(fake);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({}),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'analyze' }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(outcome.routing.selected).toBe('totally-unknown-provider');
  });
});

describe('Orchestrator - retry and fallback', () => {
  it('retries the same provider once on a retryable failure, then succeeds', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [failedResult('claude'), successResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 1 } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(claude.callCount).toBe(2);
  });

  it('falls back to a second provider after the first is exhausted', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [failedResult('claude')]);
    const codex = new FakeProvider('codex', ['analysis'], [successResult('codex')]);
    const registry = new ProviderRegistry();
    registry.register(claude);
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: true } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(outcome.attempts.map((a) => a.provider)).toEqual(['claude', 'codex']);
  });

  it('reports FAILED_PROVIDER once every provider (including fallback) has failed', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [failedResult('claude')]);
    const codex = new FakeProvider('codex', ['analysis'], [failedResult('codex')]);
    const registry = new ProviderRegistry();
    registry.register(claude);
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: true } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(outcome.verdict).toBe('FAILED_PROVIDER');
    expect(outcome.attempts).toHaveLength(2);
  });
});

describe('Orchestrator - dry-run', () => {
  it('computes routing but executes nothing', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [successResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({}),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement' }), { dryRun: true });
    expect(outcome.attempts).toEqual([]);
    expect(claude.callCount).toBe(0);
    expect(outcome.routing.selected).toBe('claude');
  });
});

describe('Orchestrator - code-changing commands: validation + review (real temp git repo, fake providers)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-orch-'));
    await runProcess({ file: 'git', args: ['init', '-q'], cwd: repo, timeoutMs: 10_000 });
    await runProcess({ file: 'git', args: ['config', 'user.email', 't@example.com'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['config', 'user.name', 'T'], cwd: repo, timeoutMs: 5000 });
    await writeFile(join(repo, 'file.txt'), 'v1', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'init'], cwd: repo, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reaches SUCCESS when validation passes and the reviewer approves', async () => {
    const codex = new FakeProvider('codex', ['implementation'], () => successResult('codex'));
    const claude = new FakeProvider('claude', ['review'], () => ({
      taskId: 't', executionId: 'e', provider: 'claude', status: 'success', durationMs: 10,
      text: '```json\n{"verdict":"approve","findings":[]}\n```',
    }));
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(outcome.validation?.passed).toBe(true);
    expect(outcome.review?.verdict).toBe('approve');
    expect(outcome.review?.independentReview).toBe(true); // codex implemented, claude reviewed
  });

  it('reaches FAILED_VALIDATION and exhausts the fix loop when validation keeps failing', async () => {
    const codex = new FakeProvider('codex', ['implementation'], () => successResult('codex'));
    const registry = new ProviderRegistry();
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(1)'] }, maxFixAttempts: 1 },
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'fix', workingDirectory: repo }));
    expect(outcome.verdict).toBe('FAILED_VALIDATION');
    expect(outcome.validation?.fixLoopExhausted).toBe(true);
    expect(outcome.validation?.fixLoopIterations).toBe(1);
  });

  it('self-reviews (independentReview: false) when only one provider is registered', async () => {
    const codex = new FakeProvider('codex', ['implementation', 'review'], () => ({
      taskId: 't', executionId: 'e', provider: 'codex', status: 'success', durationMs: 10,
      text: '```json\n{"verdict":"approve","findings":[]}\n```',
    }));
    const registry = new ProviderRegistry();
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.review?.independentReview).toBe(false);
    expect(outcome.review?.reviewer).toBe('codex');
  });

  it('reaches FAILED_REVIEW when the reviewer keeps requesting changes past maxReviewCycles', async () => {
    const codex = new FakeProvider('codex', ['implementation'], () => successResult('codex'));
    const claude = new FakeProvider('claude', ['review'], () => ({
      taskId: 't', executionId: 'e', provider: 'claude', status: 'success', durationMs: 10,
      text: '```json\n{"verdict":"request_changes","findings":[{"severity":"error","category":"x","message":"still broken"}]}\n```',
    }));
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } },
        review: { maxReviewCycles: 1 },
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('FAILED_REVIEW');
    expect(outcome.review?.verdict).toBe('request_changes');
  });
});

describe('Orchestrator - Failure Artifacts (spec section 74)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-artifacts-orch-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes a failure artifact under .dispatcher/runs/<executionId>/ when saveFailureArtifacts is enabled (default)', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [failedResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: false } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask', workingDirectory: workDir }));
    expect(outcome.verdict).toBe('FAILED_PROVIDER');

    const executionId = outcome.attempts[0]!.executionId;
    const artifactDir = join(workDir, '.dispatcher', 'runs', executionId);
    await expect(access(artifactDir)).resolves.toBeUndefined();

    const files = await readdir(artifactDir);
    expect(files).toEqual(expect.arrayContaining(['metadata.json', 'stdout.log', 'stderr.log', 'error.json']));

    const metadata = JSON.parse(await readFile(join(artifactDir, 'metadata.json'), 'utf8'));
    expect(metadata.taskId).toBe(outcome.task.id);
    expect(metadata.provider).toBe('claude');

    // The returned TaskResult links to the artifact for discoverability.
    expect(outcome.attempts[0]!.result.rawOutputPath).toBe(artifactDir);
  });

  it('writes nothing when saveFailureArtifacts is disabled', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [failedResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: false }, diagnostics: { saveFailureArtifacts: false } }),
    });

    await orchestrator.runTask(buildTask({ command: 'ask', workingDirectory: workDir }));
    await expect(access(join(workDir, '.dispatcher', 'runs'))).rejects.toThrow();
  });

  it('does not write an artifact for a successful execution', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [successResult('claude')]);
    const registry = new ProviderRegistry();
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({}),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask', workingDirectory: workDir }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(outcome.attempts[0]!.result.rawOutputPath).toBeUndefined();
    await expect(access(join(workDir, '.dispatcher', 'runs'))).rejects.toThrow();
  });
});
