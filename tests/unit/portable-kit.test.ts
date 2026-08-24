import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblePortableKit } from '../../src/local/portable-kit.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-portable-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portable USB kit assembly', () => {
  it('copies the built app and supplied offline assets without downloading anything', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    mkdirSync(join(source, 'runtime', 'cpu'), { recursive: true });
    mkdirSync(join(source, 'models', 'cpu-lite'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');
    writeFileSync(join(source, 'runtime', 'cpu', 'runtime-manifest.json'), '{}');
    writeFileSync(join(source, 'models', 'cpu-lite', 'model-pack.json'), '{}');

    const result = assemblePortableKit(source, destination, true, join(source, 'fake-node.exe'));

    expect(result.copiedAssets).toEqual({ runtime: true, models: true });
    expect(result.bundledDependencies).toBe(true);
    expect(result.copiedNodeRuntime).toBe(true);
    expect(existsSync(join(destination, 'app', 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(join(destination, 'runtime', 'node', 'node.exe'))).toBe(true);
    expect(existsSync(join(destination, 'runtime', 'cpu', 'runtime-manifest.json'))).toBe(true);
    expect(existsSync(join(destination, 'models', 'cpu-lite', 'model-pack.json'))).toBe(true);
    expect(readFileSync(join(destination, 'bin', 'ai-dispatcher.cmd'), 'utf8')).toContain('AI_DISPATCHER_PORTABLE_ROOT');
    expect(readFileSync(join(destination, 'config', '.ai-dispatcher.yml'), 'utf8')).toContain('offlineKitRequired: true');
  });

  it('bundles the prep guide as plain .txt, not markdown, for offline air-gapped reading', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    assemblePortableKit(source, destination, false, join(source, 'fake-node.exe'));

    expect(existsSync(join(destination, 'kit-준비-가이드.txt'))).toBe(true);
    expect(existsSync(join(destination, 'kit-준비-가이드.md'))).toBe(false);
    const guide = readFileSync(join(destination, 'kit-준비-가이드.txt'), 'utf8');
    // No markdown syntax: a plain-text reader on an air-gapped machine would show
    // literal #/**/[]()/| characters instead of rendering them.
    expect(guide).not.toMatch(/^#{1,6} /m);
    expect(guide).not.toContain('**');
    expect(guide).not.toMatch(/\[.+\]\(https?:\/\//);
    expect(readFileSync(join(destination, '사용방법.txt'), 'utf8')).toContain('kit-준비-가이드.txt');
  });

  it('flags a missing bundled git and wires the launcher to prefer it when present', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    const withoutGit = assemblePortableKit(source, destination, false, join(source, 'fake-node.exe'));
    expect(withoutGit.requiredBeforeUse).toContain('a portable git (MinGit, "cmd" flavor) under runtime/git - every dispatch needs it, even air-gapped');
    expect(existsSync(join(destination, 'runtime', 'git', 'PUT_GIT_HERE.txt'))).toBe(true);
    const launcher = readFileSync(join(destination, 'bin', 'ai-dispatcher.cmd'), 'utf8');
    expect(launcher).toContain('runtime\\git\\cmd\\git.exe');
    expect(launcher).toContain('runtime\\git\\cmd;%PATH%');

    const destinationWithGit = join(source, 'portable-kit-with-git');
    mkdirSync(join(source, 'runtime', 'git', 'cmd'), { recursive: true });
    writeFileSync(join(source, 'runtime', 'git', 'cmd', 'git.exe'), 'fake-git');
    const withGit = assemblePortableKit(source, destinationWithGit, true, join(source, 'fake-node.exe'));
    expect(withGit.requiredBeforeUse).not.toContain('a portable git (MinGit, "cmd" flavor) under runtime/git - every dispatch needs it, even air-gapped');
    expect(existsSync(join(destinationWithGit, 'runtime', 'git', 'cmd', 'git.exe'))).toBe(true);
  });

  it('installs a global git shim backed by the bundled git, alongside the ai-dispatcher shim', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    assemblePortableKit(source, destination, false, join(source, 'fake-node.exe'));

    const gitGlobal = readFileSync(join(destination, 'bin', 'git-global.cmd'), 'utf8');
    expect(gitGlobal).toContain('portable-ai-dispatcher\\portable-kit.json');
    expect(gitGlobal).toContain('runtime\\git\\cmd\\git.exe');

    const installer = readFileSync(join(destination, 'bin', 'install-command.cmd'), 'utf8');
    expect(installer).toContain('git-global.cmd');
    expect(installer).toContain('TARGET_BIN%\\git.cmd');

    const uninstaller = readFileSync(join(destination, 'bin', 'uninstall-command.cmd'), 'utf8');
    expect(uninstaller).toContain('git.cmd');
  });

  it('flags a missing Next.js template as optional and copies one when present', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    const withoutTemplate = assemblePortableKit(source, destination, false, join(source, 'fake-node.exe'));
    expect(withoutTemplate.requiredBeforeUse).toContain('(optional) a pre-built templates/nextjs-starter/ with node_modules installed, for bin\\new-nextjs-project.cmd');
    expect(existsSync(join(destination, 'templates', 'PUT_PROJECT_TEMPLATES_HERE.txt'))).toBe(true);
    const script = readFileSync(join(destination, 'bin', 'new-nextjs-project.cmd'), 'utf8');
    expect(script).toContain('templates\\nextjs-starter');
    expect(script).toContain('robocopy');

    const destinationWithTemplate = join(source, 'portable-kit-with-template');
    mkdirSync(join(source, 'templates', 'nextjs-starter', 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'templates', 'nextjs-starter', 'package.json'), '{}');
    const withTemplate = assemblePortableKit(source, destinationWithTemplate, true, join(source, 'fake-node.exe'));
    expect(withTemplate.requiredBeforeUse).not.toContain('(optional) a pre-built templates/nextjs-starter/ with node_modules installed, for bin\\new-nextjs-project.cmd');
    expect(existsSync(join(destinationWithTemplate, 'templates', 'nextjs-starter', 'package.json'))).toBe(true);
  });

  it('refuses to overwrite an existing destination', () => {
    const source = tempRoot();
    const destination = join(source, 'already-there');
    mkdirSync(join(source, 'dist'), { recursive: true });
    mkdirSync(destination);
    writeFileSync(join(source, 'dist', 'cli.js'), 'x');
    expect(() => assemblePortableKit(source, destination)).toThrow(/already exists/i);
  });
});
