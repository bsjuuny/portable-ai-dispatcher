import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatcherTask } from '../../src/models/task.js';
import { DEFAULT_LOCAL_CODING_CONFIG } from '../../src/models/local.js';
import { runLocalCodingAgent } from '../../src/providers/local/local-coding-agent.js';
import { LocalProvider } from '../../src/providers/local/local-provider.js';
import { OllamaRuntimeAdapter } from '../../src/providers/local/ollama-runtime.js';
import { buildReviewPrompt } from '../../src/review/review-coordinator.js';
import { parseReviewResponse } from '../../src/review/review-schema.js';

const host = 'http://127.0.0.1:11434';
const runtime = new OllamaRuntimeAdapter();
const liveRequested = process.env['AI_DISPATCHER_LIVE_LOCAL_CODING'] === '1';
const detected = liveRequested ? await runtime.detect(host, { timeoutMs: 5_000 }).catch(() => null) : null;
const models = detected?.reachable ? await runtime.listModels(host, { timeoutMs: 5_000 }).catch(() => []) : [];
const model = models.find((candidate) => candidate.name === 'qwen3:4b')?.name ?? models[0]?.name;
const localReady = liveRequested && detected?.reachable === true && model !== undefined;
let temporaryDirectory: string | undefined;

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('local autonomous coding (live Ollama contract)', () => {
  it.skipIf(!localReady)('uses a real local model to inspect and edit a file autonomously', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-dispatcher-live-coding-'));
    await writeFile(join(temporaryDirectory, 'greeting.txt'), 'HELLO\n', 'utf8');
    const now = new Date().toISOString();
    const task: DispatcherTask = {
      id: 'live-local-coding',
      command: 'fix',
      specification: {
        rawDescription:
          'Edit only greeting.txt. Replace the exact text HELLO with HELLO LOCAL, preserve the final newline, then finish.',
        attachments: [],
        sourcePaths: ['greeting.txt'],
      },
      workingDirectory: temporaryDirectory,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    };

    const result = await runLocalCodingAgent({
      profileId: 'local-live-coder',
      runtimeKind: 'ollama',
      runtime,
      host,
      model: model!,
      task,
      context: {},
      timeoutMs: 180_000,
      config: { ...DEFAULT_LOCAL_CODING_CONFIG, maxTurns: 10, maxFilesChanged: 1, maxOutputTokens: 512 },
    });

    expect(await readFile(join(temporaryDirectory, 'greeting.txt'), 'utf8')).toBe('HELLO LOCAL\n');
    expect(result.filesChanged).toEqual(['greeting.txt']);
    expect(result.summary.length).toBeGreaterThan(0);

    const reviewer = new LocalProvider(
      { name: 'live-reviewer', runtime: 'ollama', model: model! },
      runtime,
      host,
      { ...DEFAULT_LOCAL_CODING_CONFIG, maxOutputTokens: 512 },
    );
    const reviewPrompt = buildReviewPrompt(task, {
      changedFiles: ['greeting.txt'],
      addedFiles: [],
      deletedFiles: [],
      protectedPathsTouched: [],
      patchText: '-HELLO\n+HELLO LOCAL\n',
    });
    const reviewResult = await reviewer.executeDirect(
      { ...task, specification: { ...task.specification, rawDescription: reviewPrompt } },
      {},
      { sandbox: 'read-only', approval: 'never', timeoutMs: 60_000 },
      'live-local-review',
    );
    const parsedReview = parseReviewResponse(reviewResult.text ?? '');
    expect(parsedReview.findings.some((finding) => finding.category === 'review-format')).toBe(false);
  }, 200_000);

  if (!localReady) {
    it('reports that the opt-in live coding contract was skipped', () => {
      expect(localReady).toBe(false);
    });
  }
});
