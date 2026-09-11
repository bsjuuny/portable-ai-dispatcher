import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sealPortableKit, verifyPortableKit } from '../../src/local/kit-integrity.js';

const roots: string[] = [];

function kitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-integrity-'));
  roots.push(root);
  mkdirSync(join(root, 'app'), { recursive: true });
  mkdirSync(join(root, 'models'), { recursive: true });
  writeFileSync(join(root, 'portable-kit.json'), JSON.stringify({ target: 'macos-arm64' }));
  writeFileSync(join(root, 'README.txt'), 'trusted instructions');
  writeFileSync(join(root, 'app', 'cli.js'), 'console.log("safe")');
  writeFileSync(join(root, 'models', 'large.gguf'), 'fixture');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portable kit integrity lock', () => {
  it('verifies sealed executable assets while leaving GGUF verification to model manifests', () => {
    const root = kitRoot();
    const lock = sealPortableKit(root);

    expect(lock.files.some((entry) => entry.path === 'app/cli.js')).toBe(true);
    expect(lock.files.some((entry) => entry.path === 'README.txt')).toBe(true);
    expect(lock.files.some((entry) => entry.path.endsWith('.gguf'))).toBe(false);
    expect(verifyPortableKit(root)).toMatchObject({ verified: true, fileCount: lock.files.length });
  });

  it('fails closed when a locked file changes or an unreviewed file is added', () => {
    const root = kitRoot();
    sealPortableKit(root);
    writeFileSync(join(root, 'app', 'cli.js'), 'console.log("tampered")');
    expect(verifyPortableKit(root)).toMatchObject({ verified: false });

    sealPortableKit(root);
    writeFileSync(join(root, 'app', 'extra.js'), 'unreviewed');
    expect(verifyPortableKit(root)).toMatchObject({ verified: false });
  });

  it('detects changes to top-level operator instructions', () => {
    const root = kitRoot();
    sealPortableKit(root);
    writeFileSync(join(root, 'README.txt'), 'run this unreviewed command instead');

    expect(verifyPortableKit(root)).toMatchObject({ verified: false });
  });

  it('detects unexpected top-level files', () => {
    const root = kitRoot();
    sealPortableKit(root);
    writeFileSync(join(root, 'START-HERE.txt'), 'unreviewed instructions');

    expect(verifyPortableKit(root)).toMatchObject({ verified: false });
  });
});
