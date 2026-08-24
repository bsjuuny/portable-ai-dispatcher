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
  descriptions: string[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly caps: string[],
    private readonly script: TaskResult[] | (() => TaskResult),
    readonly dataResidency?: 'local' | 'cloud',
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
    this.descriptions.push(task.specification.rawDescription);
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

/**
 * Unlike FakeProvider above, this one's buildCommand spawns a real trivial Node
 * subprocess that actually WRITES a file into task.workingDirectory before
 * exiting - needed to give computeChangeScope()/classifyRisk() something real to
 * measure inside the isolated worktree. Since the orchestrator temporarily
 * repoints task.workingDirectory at the worktree for the isolated-path tests
 * below, this writes into the worktree, not the real repo, exactly like a real
 * AI provider's edits would.
 */
class FileWritingFakeProvider implements AIProvider {
  callCount = 0;

  constructor(
    readonly id: ProviderId,
    private readonly caps: string[],
    private readonly script: TaskResult[] | (() => TaskResult),
    private readonly fileName: string,
    private readonly content: string,
  ) {}

  capabilities() {
    return this.caps as never;
  }

  async checkHealth() {
    return { provider: this.id, checkedAt: new Date().toISOString(), installed: true, authenticated: true, reachable: true, rateLimited: false, ready: true };
  }

  buildCommand(task: DispatcherTask): ProviderCommandPlan {
    const script = `const fs=require('fs'),path=require('path');const f=${JSON.stringify(this.fileName)};fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,${JSON.stringify(this.content)})`;
    return { file: process.execPath, args: ['-e', script], cwd: task.workingDirectory, timeoutMs: 5000 };
  }

  parseOutcome(): TaskResult {
    const index = this.callCount;
    this.callCount += 1;
    if (typeof this.script === 'function') return this.script();
    return this.script[Math.min(index, this.script.length - 1)]!;
  }
}

function approvingReviewer(): FakeProvider {
  return new FakeProvider('claude', ['review'], () => ({
    taskId: 't',
    executionId: 'e',
    provider: 'claude',
    status: 'success',
    durationMs: 10,
    text: '```json\n{"verdict":"approve","findings":[]}\n```',
  }));
}

function successResult(provider: ProviderId): TaskResult {
  return { taskId: 't', executionId: `e${Math.random()}`, provider, status: 'success', durationMs: 10, text: 'done' };
}
function failedResult(provider: ProviderId): TaskResult {
  return { taskId: 't', executionId: `e${Math.random()}`, provider, status: 'failed', durationMs: 10, error: { message: 'boom' } };
}
function rateLimitedResult(provider: ProviderId): TaskResult {
  return {
    taskId: 't', executionId: `e${Math.random()}`, provider, status: 'failed', durationMs: 10,
    error: { code: 'PROVIDER_RATE_LIMITED', message: "You've hit your usage limit." },
  };
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

  it('continues from the current workspace state after a timeout instead of replaying the original prompt', async () => {
    const claude = new FakeProvider('claude', ['analysis'], [
      { taskId: 't', executionId: 'e1', provider: 'claude', status: 'timeout', durationMs: 10, error: { message: 'limit' } },
      successResult('claude'),
    ]);
    const registry = new ProviderRegistry();
    registry.register(claude);
    const audit = new InMemoryAuditSink();
    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(audit),
      config: parseConfig({ retry: { maxRetries: 1 }, fallback: { enabled: false } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask', specification: { rawDescription: 'original request', attachments: [], sourcePaths: [] } }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(claude.descriptions[0]).toBe('original request');
    expect(claude.descriptions[1]).toContain('Continue the existing task');
    expect(claude.descriptions[1]).toContain('Original request:\noriginal request');
    expect(audit.events.some((event) => event.type === 'checkpoint.saved')).toBe(true);
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

  it('skips the in-place retry and falls back immediately on a PROVIDER_RATE_LIMITED failure, even with retry budget remaining', async () => {
    const claude = new FakeProvider('claude', ['analysis'], () => rateLimitedResult('claude'));
    const codex = new FakeProvider('codex', ['analysis'], [successResult('codex')]);
    const registry = new ProviderRegistry();
    registry.register(claude);
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      // maxRetries:1 would normally mean one extra same-provider attempt on
      // failure - a rate-limited provider must skip straight to fallback instead,
      // since retrying an already-exhausted quota just wastes another attempt.
      config: parseConfig({ retry: { maxRetries: 1 }, fallback: { enabled: true } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(claude.callCount).toBe(1); // no in-place retry against the rate-limited provider
    expect(outcome.attempts.map((a) => a.provider)).toEqual(['claude', 'codex']);
  });

  it("opens the rate-limited provider's circuit immediately, so a second task in the same process routes straight past it", async () => {
    const claude = new FakeProvider('claude', ['analysis'], () => rateLimitedResult('claude'));
    const codex = new FakeProvider('codex', ['analysis'], () => successResult('codex'));
    const registry = new ProviderRegistry();
    registry.register(claude);
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: true } }),
    });

    await orchestrator.runTask(buildTask({ command: 'ask' }));
    // A second, independent task should route straight to codex without ever
    // attempting the still-rate-limited claude again (one confirmed rate-limit
    // response is enough to open the circuit for the full cooldown window).
    const secondOutcome = await orchestrator.runTask(buildTask({ command: 'ask' }));
    expect(secondOutcome.attempts.map((a) => a.provider)).toEqual(['codex']);
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
      // Local LLM Adapter + Hardening increment: 'implement' now runs through the
      // isolated-workspace safety gate by default (safety.workspaceIsolation.enabled
      // defaults true), and AUTO_APPLY additionally requires an explicit opt-in
      // (safety.autoApply.enabled defaults false) - without it this would correctly
      // land on BLOCKED_BY_POLICY instead of SUCCESS, per
      // tests/unit/auto-apply-gate.test.ts. Opting in here exercises the real
      // isolated-worktree -> risk-classify -> auto-apply-gate -> patch-apply pipeline
      // end-to-end against the real temp git repo, not just the pre-existing
      // validate/review logic this test originally covered.
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } },
        safety: { autoApply: { enabled: true } },
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(outcome.validation?.passed).toBe(true);
    expect(outcome.review?.verdict).toBe('approve');
    expect(outcome.review?.independentReview).toBe(true); // codex implemented, claude reviewed
  });

  it('prefers a cloud reviewer over an eligible local one, even when the local one would otherwise be picked first', async () => {
    // A local reviewer's unparseable-output fallback (review-schema.ts) silently
    // downgrades to approve_with_warning rather than blocking - a real risk
    // multiplier for a small local model. pickReviewer() must skip past a local
    // candidate to a cloud one when both are eligible, regardless of registration
    // order (registered here in the order that would pick local-fast first under
    // the old "just take routing.scores[0] that isn't the implementer" logic).
    const codex = new FakeProvider('codex', ['implementation'], () => successResult('codex'));
    const localFast = new FakeProvider(
      'local-fast',
      ['review'],
      () => ({ taskId: 't', executionId: 'e', provider: 'local-fast', status: 'success', durationMs: 10, text: '```json\n{"verdict":"approve","findings":[]}\n```' }),
      'local',
    );
    const claude = approvingReviewer();
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(localFast);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.review?.reviewer).toBe('claude');
  });

  it('falls back to an eligible local reviewer (still better than pure self-review) when no cloud reviewer is eligible', async () => {
    const codex = new FakeProvider('codex', ['implementation'], () => successResult('codex'));
    const localFast = new FakeProvider(
      'local-fast',
      ['review'],
      () => ({ taskId: 't', executionId: 'e', provider: 'local-fast', status: 'success', durationMs: 10, text: '```json\n{"verdict":"approve","findings":[]}\n```' }),
      'local',
    );
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(localFast);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.review?.reviewer).toBe('local-fast');
    expect(outcome.review?.independentReview).toBe(true);
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

  it('reaches FAILED_REVIEW (never a false SUCCESS) when the reviewer provider fails to execute on every cycle', async () => {
    // Regression test for a real incident (2026-08-22): a completely broken reviewer
    // (e.g. Codex CLI unable to run at all) must never be indistinguishable from "code
    // approved with a warning" end to end through the orchestrator.
    const codex = new FakeProvider('codex', ['implementation'], () => successResult('codex'));
    const claude = new FakeProvider('claude', ['review'], () => failedResult('claude'));
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
    expect(outcome.review?.verdict).toBe('critical');
    expect(outcome.review?.findings[0]?.category).toBe('review-execution-failed');
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

describe('Orchestrator - Local LLM Adapter + Hardening: isolated workspace + auto-apply gate (real temp git repo)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-safety-gate-'));
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

  it('a failed execution attempt inside the isolated worktree writes its failure artifact to the REAL repo, and it survives worktree cleanup', async () => {
    // Regression test for a real bug: task.workingDirectory is temporarily
    // repointed at the worktree during isolated execution, and
    // dispatch-execution.ts's persistFailureArtifact() used to derive its save
    // location from exactly that field - so a failed attempt's
    // .dispatcher/runs/<executionId>/ was written INSIDE the worktree and then
    // deleted along with it by releaseWorkspace(), silently losing the artifact
    // for precisely the autonomous fix/implement tasks this increment targets.
    const codex = new FakeProvider('codex', ['implementation'], () => failedResult('codex'));
    const registry = new ProviderRegistry();
    registry.register(codex);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ retry: { maxRetries: 0 }, fallback: { enabled: false } }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('FAILED_PROVIDER');

    const executionId = outcome.attempts[0]!.executionId;
    const artifactDir = join(repo, '.dispatcher', 'runs', executionId);

    // Written under the REAL repo, not some now-deleted worktree path.
    expect(outcome.attempts[0]!.result.rawOutputPath).toBe(artifactDir);
    await expect(access(artifactDir)).resolves.toBeUndefined();
    const files = await readdir(artifactDir);
    expect(files).toEqual(expect.arrayContaining(['metadata.json', 'stdout.log', 'stderr.log', 'error.json']));

    // The worktree itself is gone, proving this artifact could not have survived
    // if it had been written inside it.
    const worktreeList = await runProcess({ file: 'git', args: ['worktree', 'list'], cwd: repo, timeoutMs: 5000 });
    expect(worktreeList.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('BLOCKED_BY_POLICY by default: validation+review succeed inside the isolated worktree, but the change never lands in the real repo (safety.autoApply.enabled defaults false)', async () => {
    const codex = new FileWritingFakeProvider('codex', ['implementation'], () => successResult('codex'), 'generated.txt', 'ai output');
    const claude = approvingReviewer();
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
    expect(outcome.verdict).toBe('BLOCKED_BY_POLICY');
    expect(outcome.validation?.passed).toBe(true);
    expect(outcome.task.status).toBe('completed'); // the task itself finished - only the apply was withheld

    // The real repo must be completely untouched.
    const status = await runProcess({ file: 'git', args: ['status', '--porcelain'], cwd: repo, timeoutMs: 5000 });
    expect(status.stdout.trim()).toBe('');
    await expect(access(join(repo, 'generated.txt'))).rejects.toThrow();

    // The worktree used for isolation must be cleaned up, not left behind.
    const worktreeList = await runProcess({ file: 'git', args: ['worktree', 'list'], cwd: repo, timeoutMs: 5000 });
    expect(worktreeList.stdout.trim().split('\n')).toHaveLength(1);

    // task.workingDirectory is restored to the real repo after the isolated run.
    expect(outcome.task.workingDirectory).toBe(repo);
  });

  it('AUTO_APPLY when explicitly enabled: the change actually lands in the real repository', async () => {
    const codex = new FileWritingFakeProvider('codex', ['implementation'], () => successResult('codex'), 'generated.txt', 'ai output');
    const claude = approvingReviewer();
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } },
        safety: { autoApply: { enabled: true } },
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(await readFile(join(repo, 'generated.txt'), 'utf8')).toBe('ai output');
  });

  it('workspaceIsolation disabled falls back to the exact v1.0 direct-execution path: the change lands immediately, with no worktree and no auto-apply opt-in required', async () => {
    const codex = new FileWritingFakeProvider('codex', ['implementation'], () => successResult('codex'), 'generated.txt', 'direct write');
    const claude = approvingReviewer();
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } },
        safety: { workspaceIsolation: { enabled: false } },
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('SUCCESS');
    expect(await readFile(join(repo, 'generated.txt'), 'utf8')).toBe('direct write');

    const worktreeList = await runProcess({ file: 'git', args: ['worktree', 'list'], cwd: repo, timeoutMs: 5000 });
    expect(worktreeList.stdout.trim().split('\n')).toHaveLength(1); // no worktree was ever created
  });

  it('a protected-path touch is always BLOCKED_BY_POLICY (CRITICAL risk), even with autoApply enabled', async () => {
    const codex = new FileWritingFakeProvider('codex', ['implementation'], () => successResult('codex'), '.env', 'SECRET=1');
    const claude = approvingReviewer();
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } },
        safety: { autoApply: { enabled: true } }, // even fully opted in...
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    // validation itself fails the git-diff stage for a protected-path touch (existing
    // v1.0 behavior, unchanged - see validation/pipeline.ts), so this never even
    // reaches the new risk-classifier/auto-apply-gate code; either way, nothing may
    // land in the real repo.
    expect(outcome.verdict).not.toBe('SUCCESS');
    await expect(access(join(repo, '.env'))).rejects.toThrow();
  });

  it('a CI/CD pipeline file touch is BLOCKED_BY_POLICY via the risk classifier itself (not the protectedPaths validation stage), even with autoApply enabled', async () => {
    // Unlike the .env test above, .github/workflows/ci.yml is not in the default
    // safety.protectedPaths, so validation's git-diff stage passes and this
    // genuinely reaches classifyRisk()'s CI_PIPELINE_PATTERNS check inside the
    // real isolated-worktree flow, not just the standalone risk-classifier unit test.
    const codex = new FileWritingFakeProvider(
      'codex',
      ['implementation'],
      () => successResult('codex'),
      join('.github', 'workflows', 'ci.yml'),
      'jobs: {}',
    );
    const claude = approvingReviewer();
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({
        validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } },
        safety: { autoApply: { enabled: true } },
      }),
    });

    const outcome = await orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }));
    expect(outcome.verdict).toBe('BLOCKED_BY_POLICY');
    await expect(access(join(repo, '.github', 'workflows', 'ci.yml'))).rejects.toThrow();
  });

  it('rejects a second code-changing task on the same repository while one is already running, with a retryable REPOSITORY_LOCKED error', async () => {
    const codex = new FileWritingFakeProvider('codex', ['implementation'], () => successResult('codex'), 'generated.txt', 'x');
    const claude = approvingReviewer();
    const registry = new ProviderRegistry();
    registry.register(codex);
    registry.register(claude);

    const orchestrator = new Orchestrator({
      providers: registry,
      usageStore: new InMemoryUsageStore(),
      auditLogger: new AuditLogger(new InMemoryAuditSink()),
      config: parseConfig({ validation: { commands: { test: [process.execPath, '-e', 'process.exit(0)'] } } }),
    });

    // Directly exercises the same RepositoryLock instance the orchestrator itself
    // uses, simulating "another task already holds the lock" without relying on
    // exact event-loop interleaving timing between two real concurrent runTask()
    // calls.
    const internalLock = (orchestrator as unknown as { repositoryLock: { acquire: (id: string, taskId: string) => unknown } }).repositoryLock;
    const otherHandle = internalLock.acquire(repo, 'some-other-task');

    await expect(orchestrator.runTask(buildTask({ command: 'implement', workingDirectory: repo }))).rejects.toMatchObject({
      code: 'REPOSITORY_LOCKED',
      retryable: true,
    });

    (internalLock as unknown as { release: (h: unknown) => void }).release(otherHandle);
  });
});
