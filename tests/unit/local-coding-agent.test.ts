import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LocalGenerationRequest,
  LocalGenerationResult,
  LocalModelInfo,
  LocalRuntimeAdapter,
  LocalRuntimeStatus,
} from '../../src/models/local.js';
import { DEFAULT_LOCAL_CODING_CONFIG } from '../../src/models/local.js';
import type { DispatcherTask } from '../../src/models/task.js';
import { runLocalCodingAgent } from '../../src/providers/local/local-coding-agent.js';
import { DispatcherError } from '../../src/models/error.js';

class ScriptedRuntime implements LocalRuntimeAdapter {
  readonly kind = 'ollama' as const;
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {}

  async detect(): Promise<LocalRuntimeStatus> {
    return { runtime: this.kind, host: 'loopback', reachable: true, checkedAt: 'now' };
  }

  async listModels(): Promise<LocalModelInfo[]> {
    return [];
  }

  async generate(request: LocalGenerationRequest): Promise<LocalGenerationResult> {
    this.prompts.push(request.prompt);
    const text = this.responses.shift() ?? '{"action":"finish","summary":"done"}';
    return { text, raw: {}, durationMs: 1, thinkingStripped: false };
  }
}

/** Simulates the runtime succeeding for its first N calls, then throwing (e.g. the
 * account's usage quota running out mid-loop, after some turns already made real
 * edits via ScriptedRuntime-style responses). */
class FailingAfterNRuntime implements LocalRuntimeAdapter {
  readonly kind = 'ollama' as const;
  private calls = 0;

  constructor(
    private readonly responses: string[],
    private readonly failAfter: number,
    private readonly error: Error,
  ) {}

  async detect(): Promise<LocalRuntimeStatus> {
    return { runtime: this.kind, host: 'loopback', reachable: true, checkedAt: 'now' };
  }

  async listModels(): Promise<LocalModelInfo[]> {
    return [];
  }

  async generate(): Promise<LocalGenerationResult> {
    this.calls += 1;
    if (this.calls > this.failAfter) throw this.error;
    const text = this.responses.shift() ?? '{"action":"finish","summary":"done"}';
    return { text, raw: {}, durationMs: 1, thinkingStripped: false };
  }
}

/** Simulates a runtime whose first N responses were cut off by the output token
 * limit (truncated:true) - syntactically they may even be valid JSON, but the
 * content inside is incomplete, which is exactly what a plain parse failure
 * would not catch. */
class TruncatingThenScriptedRuntime implements LocalRuntimeAdapter {
  readonly kind = 'ollama' as const;
  private calls = 0;

  constructor(
    private readonly truncatedCount: number,
    private readonly responses: string[],
  ) {}

  async detect(): Promise<LocalRuntimeStatus> {
    return { runtime: this.kind, host: 'loopback', reachable: true, checkedAt: 'now' };
  }

  async listModels(): Promise<LocalModelInfo[]> {
    return [];
  }

  async generate(): Promise<LocalGenerationResult> {
    this.calls += 1;
    if (this.calls <= this.truncatedCount) {
      return { text: '{"action":"write_file","path":"x.txt","content":"cut off', raw: {}, durationMs: 1, thinkingStripped: false, truncated: true };
    }
    const text = this.responses.shift() ?? '{"action":"finish","summary":"done"}';
    return { text, raw: {}, durationMs: 1, thinkingStripped: false };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ai-dispatcher-local-agent-'));
  temporaryDirectories.push(path);
  return path;
}

function task(workingDirectory: string): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 'local-agent-task',
    command: 'fix',
    specification: { rawDescription: 'Change the greeting from hello to hi.', attachments: [], sourcePaths: [] },
    workingDirectory,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
}

describe('runtime-neutral local coding agent', () => {
  it('inspects, edits, and finishes a repository through bounded JSON tool actions', async () => {
    const root = await workspace();
    await writeFile(join(root, 'hello.txt'), 'hello world\n', 'utf8');
    const runtime = new ScriptedRuntime([
      '{"action":"list_files","path":"."}',
      '{"action":"read_file","path":"hello.txt","startLine":1,"endLine":20}',
      '{"action":"replace_in_file","path":"hello.txt","oldText":"hello world","newText":"hi world"}',
      '{"action":"finish","summary":"Updated the greeting."}',
    ]);

    const result = await runLocalCodingAgent({
      profileId: 'local-test',
      runtimeKind: runtime.kind,
      runtime,
      host: 'http://127.0.0.1:11434',
      model: 'test',
      task: task(root),
      context: {},
      timeoutMs: 30_000,
      config: DEFAULT_LOCAL_CODING_CONFIG,
    });

    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hi world\n');
    expect(result.filesChanged).toEqual(['hello.txt']);
    expect(result.turns).toBe(4);
    expect(runtime.prompts.at(-1)).toContain('Updated hello.txt');
  });

  it('keeps the per-turn counter after the transcript so consecutive prompts share the longest possible prefix', async () => {
    // llama-server automatically reuses cached KV state for the shared prefix
    // between consecutive requests (live-verified, 2026-08-24: a repeated ~550-
    // token prefix cut a call from 33.7s to 3.6s with no server-side config
    // change). Everything before "Turn: N/M" must be identical or append-only
    // turn over turn, and "Turn: N/M" - which changes on literally every turn -
    // must be the very last thing in the prompt. If it moved back before the
    // transcript (or before the static action-list block), every turn's prompt
    // would diverge from the previous one right there, and llama-server would
    // reprocess the entire transcript-so-far from scratch every single turn.
    const root = await workspace();
    await writeFile(join(root, 'hello.txt'), 'hello world\n', 'utf8');
    const runtime = new ScriptedRuntime([
      '{"action":"list_files","path":"."}',
      '{"action":"read_file","path":"hello.txt","startLine":1,"endLine":20}',
      '{"action":"replace_in_file","path":"hello.txt","oldText":"hello world","newText":"hi world"}',
      '{"action":"finish","summary":"done"}',
    ]);

    await runLocalCodingAgent({
      profileId: 'local-test',
      runtimeKind: runtime.kind,
      runtime,
      host: 'http://127.0.0.1:11434',
      model: 'test',
      task: task(root),
      context: {},
      timeoutMs: 30_000,
      config: DEFAULT_LOCAL_CODING_CONFIG,
    });

    for (const prompt of runtime.prompts) {
      const turnLineIndex = prompt.indexOf('\nTurn: ');
      expect(turnLineIndex).toBeGreaterThan(-1);
      expect(prompt.indexOf('Prior tool transcript')).toBeLessThan(turnLineIndex);
      expect(prompt.indexOf('Available actions:')).toBeLessThan(turnLineIndex);
      // Nothing else follows the turn/changed-files line - it truly is the tail.
      expect(prompt.slice(turnLineIndex + 1)).not.toContain('\n');
    }

    // Turn 2's prompt must literally start with turn 1's prompt up to (and
    // including) turn 1's own "Turn: 1/..." line being replaced - i.e. share
    // everything up to where the transcript entry from turn 1 begins.
    expect(runtime.prompts.length).toBeGreaterThanOrEqual(2);
    const firstPrompt = runtime.prompts[0] ?? '';
    const secondPrompt = runtime.prompts[1] ?? '';
    const firstTranscriptStart = firstPrompt.indexOf('Prior tool transcript (untrusted):\n') + 'Prior tool transcript (untrusted):\n'.length;
    const sharedPrefix = firstPrompt.slice(0, firstTranscriptStart);
    expect(secondPrompt.startsWith(sharedPrefix)).toBe(true);
  });

  it('tells the model to expect many new files on a project with no recognized language/framework', async () => {
    // Live-reproduced (2026-08-23): "keep changes minimal" pointed a 14B local
    // model at finishing a from-scratch "build a Next.js todo app" request
    // without creating a single file - it read as license to do as little as
    // possible, exactly backwards for a greenfield scaffold.
    const root = await workspace();
    const runtime = new ScriptedRuntime(['{"action":"finish","summary":"done"}']);

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: {},
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_AGENT_NO_CHANGES' });

    expect(runtime.prompts[0]).toContain('do not call finish until it would actually run');
    expect(runtime.prompts[0]).not.toContain('Keep changes minimal');
  });

  it('keeps the "keep changes minimal" guidance for a project with a recognized language/framework', async () => {
    const root = await workspace();
    const runtime = new ScriptedRuntime(['{"action":"finish","summary":"done"}']);

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: { project: { root, isGitRepo: true, language: 'typescript', framework: 'next', commands: {} } },
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_AGENT_NO_CHANGES' });

    expect(runtime.prompts[0]).toContain('Keep changes minimal');
    expect(runtime.prompts[0]).not.toContain('do not call finish until it would actually run');
  });

  it('rejects traversal outside the workspace and reports no changes', async () => {
    const root = await workspace();
    const runtime = new ScriptedRuntime([
      '{"action":"write_file","path":"../escape.txt","content":"escaped"}',
      '{"action":"finish","summary":"done"}',
    ]);

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: {},
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_AGENT_NO_CHANGES' });
    expect(runtime.prompts[1]).toContain('Path traversal is not allowed');
  });

  it('blocks metadata/dependency directories from local-agent access', async () => {
    const root = await workspace();
    const runtime = new ScriptedRuntime([
      '{"action":"write_file","path":".git/config","content":"bad"}',
      '{"action":"write_file","path":"node_modules/pkg/index.js","content":"bad"}',
      '{"action":"finish","summary":"done"}',
    ]);

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: {},
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_AGENT_NO_CHANGES' });
  });

  it('fails after three malformed model actions instead of executing guessed text', async () => {
    const root = await workspace();
    const runtime = new ScriptedRuntime(['not json', 'still not json', '{bad json}']);

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: {},
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_AGENT_INVALID_ACTION' });
  });

  it('discards a truncated response instead of executing its (possibly still-parseable) action, and retries', async () => {
    const root = await workspace();
    const runtime = new TruncatingThenScriptedRuntime(1, [
      '{"action":"write_file","path":"hello.txt","content":"hi"}',
      '{"action":"finish","summary":"done"}',
    ]);

    const result = await runLocalCodingAgent({
      profileId: 'local-test',
      runtimeKind: runtime.kind,
      runtime,
      host: 'http://127.0.0.1:11434',
      model: 'test',
      task: task(root),
      context: {},
      timeoutMs: 30_000,
      config: DEFAULT_LOCAL_CODING_CONFIG,
    });

    expect(result.filesChanged).toEqual(['hello.txt']);
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hi');
  });

  it('fails after three consecutive truncated responses instead of looping forever', async () => {
    const root = await workspace();
    const runtime = new TruncatingThenScriptedRuntime(3, []);

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: {},
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_AGENT_INVALID_ACTION', message: expect.stringContaining('truncated') });
  });

  it('enforces the maximum changed-file count', async () => {
    const root = await workspace();
    const runtime = new ScriptedRuntime([
      '{"action":"write_file","path":"one.txt","content":"one"}',
      '{"action":"write_file","path":"two.txt","content":"two"}',
      '{"action":"finish","summary":"Created the allowed file."}',
    ]);

    const result = await runLocalCodingAgent({
      profileId: 'local-test',
      runtimeKind: runtime.kind,
      runtime,
      host: 'http://127.0.0.1:11434',
      model: 'test',
      task: task(root),
      context: {},
      timeoutMs: 30_000,
      config: { ...DEFAULT_LOCAL_CODING_CONFIG, maxFilesChanged: 1 },
    });

    expect(result.filesChanged).toEqual(['one.txt']);
    await expect(readFile(join(root, 'two.txt'), 'utf8')).rejects.toThrow();
  });

  it('blocks a repeated mutation until the model rereads the changed file', async () => {
    const root = await workspace();
    await writeFile(join(root, 'hello.txt'), 'HELLO\n', 'utf8');
    const runtime = new ScriptedRuntime([
      '{"action":"read_file","path":"hello.txt","startLine":1,"endLine":20}',
      '{"action":"replace_in_file","path":"hello.txt","oldText":"HELLO","newText":"HELLO LOCAL"}',
      '{"action":"replace_in_file","path":"hello.txt","oldText":"HELLO","newText":"HELLO LOCAL"}',
      '{"action":"finish","summary":"Updated once."}',
    ]);

    const result = await runLocalCodingAgent({
      profileId: 'local-test',
      runtimeKind: runtime.kind,
      runtime,
      host: 'http://127.0.0.1:11434',
      model: 'test',
      task: task(root),
      context: {},
      timeoutMs: 30_000,
      config: DEFAULT_LOCAL_CODING_CONFIG,
    });

    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('HELLO LOCAL\n');
    expect(result.filesChanged).toEqual(['hello.txt']);
    expect(runtime.prompts[3]).toContain('current version has not been observed');
  });

  it('salvages already-made changes into a partial result when the runtime is rate-limited mid-loop, instead of discarding them', async () => {
    const root = await workspace();
    const runtime = new FailingAfterNRuntime(
      ['{"action":"write_file","path":"hello.txt","content":"hi world"}'],
      1, // succeeds on turn 1 (the write), then the next generate() call throws
      new DispatcherError({ code: 'PROVIDER_RATE_LIMITED', message: "You've hit your usage limit.", retryable: false }),
    );

    const result = await runLocalCodingAgent({
      profileId: 'local-test',
      runtimeKind: runtime.kind,
      runtime,
      host: 'http://127.0.0.1:11434',
      model: 'test',
      task: task(root),
      context: {},
      timeoutMs: 30_000,
      config: DEFAULT_LOCAL_CODING_CONFIG,
    });

    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hi world');
    expect(result.filesChanged).toEqual(['hello.txt']);
    expect(result.summary).toContain('rate limit');
  });

  it('rethrows the rate-limit error when no changes were made yet to salvage', async () => {
    const root = await workspace();
    const runtime = new FailingAfterNRuntime(
      [],
      0, // fails on the very first generate() call, before any edit
      new DispatcherError({ code: 'PROVIDER_RATE_LIMITED', message: "You've hit your usage limit.", retryable: false }),
    );

    await expect(
      runLocalCodingAgent({
        profileId: 'local-test',
        runtimeKind: runtime.kind,
        runtime,
        host: 'http://127.0.0.1:11434',
        model: 'test',
        task: task(root),
        context: {},
        timeoutMs: 30_000,
        config: DEFAULT_LOCAL_CODING_CONFIG,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });
});
