import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeProject } from '../../src/project/analyzer.js';

const dirsToClean: string[] = [];
afterEach(async () => {
  await Promise.all(dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-analyzer-'));
  dirsToClean.push(dir);
  return dir;
}

describe('analyzeProject', () => {
  it('detects a pnpm + vitest + Next.js project from package.json and lockfile', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '15.0.0' },
        devDependencies: { vitest: '4.0.0' },
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'next build', test: 'vitest run' },
      }),
      'utf8',
    );

    const context = await analyzeProject(dir);
    expect(context.packageManager).toBe('pnpm');
    expect(context.framework).toBe('next');
    expect(context.testFramework).toBe('vitest');
    expect(context.commands.lint).toEqual(['pnpm', 'run', 'lint']);
    expect(context.commands.test).toEqual(['pnpm', 'run', 'test']);
  });

  it('detects npm when only package-lock.json is present', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package-lock.json'), '{}', 'utf8');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }), 'utf8');
    const context = await analyzeProject(dir);
    expect(context.packageManager).toBe('npm');
    expect(context.commands.test).toEqual(['npm', 'run', 'test']);
  });

  it('does not report a command for a script that does not exist', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
    const context = await analyzeProject(dir);
    expect(context.commands.lint).toBeUndefined();
    expect(context.commands.build).toBeUndefined();
  });

  it('detects Maven from pom.xml', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'pom.xml'), '<project></project>', 'utf8');
    const context = await analyzeProject(dir);
    expect(context.buildTool).toBe('maven');
    expect(context.commands.test).toEqual(['mvn', 'test']);
  });

  it('detects Gradle from build.gradle.kts', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'build.gradle.kts'), '', 'utf8');
    const context = await analyzeProject(dir);
    expect(context.buildTool).toBe('gradle');
  });

  it('detects Python tooling from pyproject.toml', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    const context = await analyzeProject(dir);
    expect(context.language).toBe('python');
    expect(context.commands.test).toEqual(['pytest']);
  });

  it('returns empty commands for a directory with no recognizable project markers, rather than throwing', async () => {
    const dir = await tempDir();
    const context = await analyzeProject(dir);
    expect(context.commands).toEqual({});
    expect(context.language).toBeUndefined();
  });

  it('reports isGitRepo correctly', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.git'));
    const context = await analyzeProject(dir);
    expect(context.isGitRepo).toBe(true);
  });

  it('does not throw when package.json exists but is malformed JSON', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), '{ not valid json', 'utf8');
    const context = await analyzeProject(dir);
    expect(context.language).toBe('typescript-javascript');
    expect(context.commands).toEqual({});
  });
});
