import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buildTaskFromCli } from '../../src/cli/build-task.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('buildTaskFromCli', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-buildtask-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a task from a plain positional argument (spec 17A)', async () => {
    const task = await buildTaskFromCli('fix', '로그인 오류를 수정해줘', { cwd: dir, stdin: false });
    expect(task.specification.rawDescription).toBe('로그인 오류를 수정해줘');
    expect(task.command).toBe('fix');
    expect(task.workingDirectory).toBe(dir);
  });

  it('accepts a multi-line description as a single positional argument (spec 17B)', async () => {
    const multiline = '로그인 오류가 발생한다.\n\n오류 코드:\nAUTH-500\n\nRegression Test 작성.';
    const task = await buildTaskFromCli('fix', multiline, { cwd: dir, stdin: false });
    expect(task.specification.rawDescription).toBe(multiline);
    expect(task.specification.structured?.errorCodes).toContain('AUTH-500');
  });

  it('reads the description from --file (spec 17C)', async () => {
    const filePath = join(dir, 'bug-report.md');
    await writeFile(filePath, '# 로그인 장애\n\nERR-USER-1042', 'utf8');
    const task = await buildTaskFromCli('fix', undefined, { cwd: dir, file: filePath, stdin: false });
    expect(task.specification.attachments).toHaveLength(1);
    expect(task.specification.attachments[0]!.content).toContain('ERR-USER-1042');
  });

  it('combines a description with --file and --path (spec 18/19)', async () => {
    const filePath = join(dir, 'error.log');
    await writeFile(filePath, 'stack trace here', 'utf8');
    const task = await buildTaskFromCli('fix', '이 오류의 근본 원인을 분석해줘', {
      cwd: dir,
      file: filePath,
      path: ['src/main.ts'],
      stdin: false,
    });
    expect(task.specification.rawDescription).toBe('이 오류의 근본 원인을 분석해줘');
    expect(task.specification.attachments).toHaveLength(1);
    expect(task.specification.sourcePaths[0]).toContain('src');
    expect(task.specification.sourcePaths[0]).toContain('main.ts');
  });

  it('throws INVALID_TASK when no description, file, or stdin content is provided', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(buildTaskFromCli('fix', undefined, { cwd: dir, stdin: false })).rejects.toSatisfy(
        (error: unknown) => isDispatcherError(error) && error.code === 'INVALID_TASK',
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('reads the description from --stdin (spec 17D)', async () => {
    const fakeStdin = Readable.from(['오류 로그 내용입니다']) as unknown as typeof process.stdin;
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      const task = await buildTaskFromCli('fix', undefined, { cwd: dir, stdin: true });
      expect(task.specification.rawDescription).toBe('오류 로그 내용입니다');
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    }
  });

  it('parses --timeout into a numeric timeoutMs', async () => {
    const task = await buildTaskFromCli('fix', 'hello', { cwd: dir, stdin: false, timeout: '60000' });
    expect(task.timeoutMs).toBe(60000);
  });

  it('records an explicit --provider as metadata for the router to honor', async () => {
    const task = await buildTaskFromCli('fix', 'hello', { cwd: dir, stdin: false, provider: 'codex' });
    expect(task.metadata?.['explicitProvider']).toBe('codex');
  });

  it('rejects a --file path that escapes the working directory (path traversal)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ai-dispatcher-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8');
    try {
      await expect(
        buildTaskFromCli('fix', 'hello', { cwd: dir, file: join(outside, 'secret.txt'), stdin: false }),
      ).rejects.toSatisfy((error: unknown) => isDispatcherError(error) && error.code === 'PATH_TRAVERSAL_REJECTED');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
