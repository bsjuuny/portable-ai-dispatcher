import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { measureRepository } from '../../src/project/repository-metrics.js';

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('measureRepository', () => {
  it('counts source/test files while excluding generated dependency directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dispatcher-metrics-'));
    cleanup.push(root);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'tests'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'src', 'app.ts'), 'export const x = 1;');
    await writeFile(join(root, 'tests', 'app.test.ts'), 'test("x",()=>{});');
    await writeFile(join(root, 'node_modules', 'ignored.ts'), 'x'.repeat(1000));

    const metrics = await measureRepository(root);
    expect(metrics.totalFiles).toBe(3);
    expect(metrics.sourceFiles).toBe(2);
    expect(metrics.testFiles).toBe(1);
    expect(metrics.packageFiles).toBe(1);
  });
});
