import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveFileAttachment } from '../../src/task/input-resolver.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('path traversal resistance', () => {
  let root: string;
  let outsideDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-dispatcher-workdir-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'ok.txt'), 'inside the working directory', 'utf8');
    await writeFile(join(outsideDir, 'secret.txt'), 'should never be readable', 'utf8');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('allows a file that resolves inside the working directory', async () => {
    const attachment = await resolveFileAttachment('src/ok.txt', { workingDirectory: root });
    expect(attachment.content).toBe('inside the working directory');
  });

  it('rejects a relative ../ escape out of the working directory', async () => {
    const relativeEscape = `..${sep}${outsideDir.split(sep).pop()}${sep}secret.txt`;
    await expect(resolveFileAttachment(relativeEscape, { workingDirectory: root })).rejects.toSatisfy(
      (error: unknown) => isDispatcherError(error) && error.code === 'PATH_TRAVERSAL_REJECTED',
    );
  });

  it('rejects a deep ../../../ escape attempt', async () => {
    await expect(
      resolveFileAttachment('../../../../../../../../etc/passwd', { workingDirectory: root }),
    ).rejects.toSatisfy((error: unknown) => isDispatcherError(error));
  });

  it('rejects an absolute path outside the working directory', async () => {
    await expect(
      resolveFileAttachment(join(outsideDir, 'secret.txt'), { workingDirectory: root }),
    ).rejects.toSatisfy((error: unknown) => isDispatcherError(error) && error.code === 'PATH_TRAVERSAL_REJECTED');
  });

  it('allows an absolute path when it is inside an explicit --add-dir', async () => {
    const attachment = await resolveFileAttachment(join(outsideDir, 'secret.txt'), {
      workingDirectory: root,
      additionalAllowedDirs: [outsideDir],
    });
    expect(attachment.content).toBe('should never be readable');
  });

  it('rejects a symlink that resolves outside the working directory (POSIX only)', async () => {
    if (process.platform === 'win32') return; // symlinks require elevated perms on Windows by default
    const linkPath = join(root, 'escape-link');
    await symlink(join(outsideDir, 'secret.txt'), linkPath);
    await expect(resolveFileAttachment('escape-link', { workingDirectory: root })).rejects.toSatisfy(
      (error: unknown) => isDispatcherError(error) && error.code === 'PATH_TRAVERSAL_REJECTED',
    );
  });

  it('rejects a nonexistent file with ATTACHMENT_READ_FAILED, not a path-traversal false-positive', async () => {
    await expect(resolveFileAttachment('does-not-exist.txt', { workingDirectory: root })).rejects.toSatisfy(
      (error: unknown) => isDispatcherError(error) && error.code === 'ATTACHMENT_READ_FAILED',
    );
  });
});
