import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectContext } from '../models/context.js';

/**
 * Detects project shape from files on disk - spec section 48 (Build Tool 자동
 * 감지). Explicit config (validation.commands in .ai-dispatcher.yml) always takes
 * priority over these guesses; this only fills gaps when no explicit config exists.
 */
export async function analyzeProject(root: string): Promise<ProjectContext> {
  const isGitRepo = existsSync(join(root, '.git'));

  if (existsSync(join(root, 'package.json'))) {
    return analyzeNodeProject(root, isGitRepo);
  }
  if (existsSync(join(root, 'pom.xml'))) {
    return {
      root,
      isGitRepo,
      language: 'java',
      buildTool: 'maven',
      commands: { build: ['mvn', 'compile'], test: ['mvn', 'test'] },
    };
  }
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) {
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    return {
      root,
      isGitRepo,
      language: 'java',
      buildTool: 'gradle',
      commands: { build: [gradlew, 'build'], test: [gradlew, 'test'] },
    };
  }
  if (existsSync(join(root, 'pyproject.toml'))) {
    return {
      root,
      isGitRepo,
      language: 'python',
      buildTool: 'python-tooling',
      commands: { test: ['pytest'], lint: ['ruff', 'check', '.'] },
    };
  }

  return { root, isGitRepo, commands: {} };
}

async function analyzeNodeProject(root: string, isGitRepo: boolean): Promise<ProjectContext> {
  const packageManager = detectPackageManager(root);
  const runner = packageManager === 'yarn' ? 'yarn' : packageManager === 'npm' ? 'npm' : packageManager;

  let packageJson: Record<string, unknown> = {};
  try {
    packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    // no readable package.json - fall through with defaults
  }
  const scripts = (packageJson['scripts'] as Record<string, string> | undefined) ?? {};
  const deps = {
    ...(packageJson['dependencies'] as Record<string, string> | undefined),
    ...(packageJson['devDependencies'] as Record<string, string> | undefined),
  };

  const framework = detectFramework(deps);
  const testFramework = detectTestFramework(deps, scripts);

  const runScript = (name: string): string[] | undefined =>
    scripts[name] ? [runner, 'run', name] : undefined;

  return {
    root,
    isGitRepo,
    language: 'typescript-javascript',
    framework,
    buildTool: packageManager,
    packageManager,
    testFramework,
    commands: {
      lint: runScript('lint'),
      typecheck: runScript('typecheck') ?? (scripts['tsc'] ? [runner, 'run', 'tsc'] : undefined),
      build: runScript('build'),
      test: runScript('test'),
    },
  };
}

function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function detectFramework(deps: Record<string, string>): string | undefined {
  if (deps['next']) return 'next';
  if (deps['react']) return 'react';
  if (deps['vue']) return 'vue';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['express']) return 'express';
  return undefined;
}

function detectTestFramework(deps: Record<string, string>, scripts: Record<string, string>): string | undefined {
  if (deps['vitest']) return 'vitest';
  if (deps['jest']) return 'jest';
  if (deps['mocha']) return 'mocha';
  if (scripts['test']?.includes('vitest')) return 'vitest';
  return undefined;
}
