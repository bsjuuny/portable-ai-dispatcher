import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PortableKitLock {
  schemaVersion: '1';
  algorithm: 'sha256';
  target: string;
  files: Array<{ path: string; type: 'file' | 'symlink'; size: number; sha256: string }>;
}

const LOCK_FILE = 'kit-lock.json';

/** Creates a deterministic integrity inventory. Large GGUF payloads remain
 * covered by their model-pack SHA-256 declarations, avoiding hashing them twice. */
export function sealPortableKit(rootDirectory: string): PortableKitLock {
  const root = resolve(rootDirectory);
  const metadataPath = join(root, 'portable-kit.json');
  if (!existsSync(metadataPath)) throw new Error(`Not a portable kit (portable-kit.json is missing): ${root}`);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { target?: unknown };
  if (typeof metadata.target !== 'string' || !metadata.target) throw new Error('portable-kit.json has no valid target.');

  const files = inventory(root);
  const lock: PortableKitLock = { schemaVersion: '1', algorithm: 'sha256', target: metadata.target, files };
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

export function verifyPortableKit(rootDirectory: string): { verified: boolean; reason?: string; fileCount?: number } {
  const root = resolve(rootDirectory);
  const lockPath = join(root, LOCK_FILE);
  if (!existsSync(lockPath)) return { verified: false, reason: 'kit-lock.json is missing; run portable seal after adding all assets.' };
  try {
    const lock = parseLock(JSON.parse(readFileSync(lockPath, 'utf8')));
    const actual = inventory(root);
    if (actual.length !== lock.files.length) {
      return { verified: false, reason: `Integrity inventory changed (expected ${lock.files.length} files, found ${actual.length}); reseal only after reviewing the changes.` };
    }
    for (let index = 0; index < lock.files.length; index += 1) {
      const expected = lock.files[index]!;
      const found = actual[index]!;
      if (expected.path !== found.path || expected.type !== found.type || expected.size !== found.size || expected.sha256 !== found.sha256) {
        return { verified: false, reason: `Integrity mismatch: ${expected.path}.` };
      }
    }
    return { verified: true, fileCount: actual.length };
  } catch (cause) {
    return { verified: false, reason: `Invalid kit-lock.json: ${(cause as Error).message}` };
  }
}

function inventory(root: string): PortableKitLock['files'] {
  const paths: string[] = [];
  // Inventory the whole kit, not only known folders. Otherwise a misleading
  // top-level "start here" file or an unexpected executable could be added
  // without invalidating the lock. The lock itself is the sole exception.
  for (const name of readdirSync(root).sort((a, b) => a.localeCompare(b, 'en'))) {
    if (name === LOCK_FILE) continue;
    collect(join(root, name), paths);
  }
  return paths
    // Regular GGUF payloads are already covered by model-pack hashes and can be
    // many gigabytes. Still inventory GGUF symlinks so escape checks cannot be
    // bypassed merely by giving a malicious link a .gguf suffix.
    .filter((path) => !path.toLowerCase().endsWith('.gguf') || !lstatSync(path).isFile())
    .map((path) => describeEntry(root, path))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function collect(path: string, result: string[]): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || entry.isFile()) {
    result.push(path);
    return;
  }
  if (!entry.isDirectory()) return;
  for (const child of readdirSync(path).sort((a, b) => a.localeCompare(b, 'en'))) collect(join(path, child), result);
}

function describeEntry(root: string, path: string): PortableKitLock['files'][number] {
  const entry = lstatSync(path);
  const portablePath = relative(root, path).split(sep).join('/');
  if (entry.isSymbolicLink()) {
    const target = readlinkSync(path);
    const resolvedTarget = resolve(dirname(path), target);
    const targetRelative = relative(root, resolvedTarget);
    if (isAbsolute(target) || targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
      throw new Error(`Portable kit symlink escapes the kit root: ${portablePath} -> ${target}`);
    }
    return { path: portablePath, type: 'symlink', size: Buffer.byteLength(target), sha256: digest(Buffer.from(target)) };
  }
  return { path: portablePath, type: 'file', size: statSync(path).size, sha256: digestFile(path) };
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestFile(path: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function parseLock(raw: unknown): PortableKitLock {
  if (!raw || typeof raw !== 'object') throw new Error('lock must be an object');
  const candidate = raw as Partial<PortableKitLock>;
  if (candidate.schemaVersion !== '1' || candidate.algorithm !== 'sha256' || typeof candidate.target !== 'string' || !Array.isArray(candidate.files)) {
    throw new Error('unsupported lock schema');
  }
  for (const entry of candidate.files) {
    if (!entry || typeof entry.path !== 'string' || !['file', 'symlink'].includes(entry.type)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('invalid file entry');
    }
  }
  return candidate as PortableKitLock;
}
