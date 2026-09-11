import type { AppContext } from '../bootstrap.js';
import { resolve } from 'node:path';
import { assemblePortableKit, copyPortableNodeRuntime } from '../../local/portable-kit.js';
import { sealPortableKit } from '../../local/kit-integrity.js';

export function runPortableAssembleCommand(ctx: AppContext, destination: string, includeAssets: boolean, json: boolean, target?: string): number {
  try {
    const result = assemblePortableKit(ctx.cwd, resolve(ctx.cwd, destination), includeAssets, process.execPath, target);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Portable kit created: ${result.destination} (${result.target})\n`);
      process.stdout.write(`Assets: dependencies=bundled runtime=${result.copiedAssets.runtime} models=${result.copiedAssets.models}\n`);
      if (result.requiredBeforeUse.length) process.stdout.write(`Still required: ${result.requiredBeforeUse.join('; ')}\n`);
    }
    return 0;
  } catch (cause) {
    const message = (cause as Error).message;
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`Portable assembly failed: ${message}\n`);
    return 1;
  }
}

export function runPortableSealCommand(destination: string, json: boolean): number {
  try {
    const root = resolve(destination);
    const lock = sealPortableKit(root);
    const result = { destination: root, target: lock.target, integrityLocked: true, fileCount: lock.files.length };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Portable kit integrity lock updated: ${root} (${lock.files.length} files).\n`);
    return 0;
  } catch (cause) {
    const message = (cause as Error).message;
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`Portable seal failed: ${message}\n`);
    return 1;
  }
}

export function runPortableAddNodeCommand(destination: string, json: boolean): number {
  try {
    const root = resolve(destination);
    copyPortableNodeRuntime(root);
    const lock = sealPortableKit(root);
    const result = { destination: root, copiedNodeRuntime: true, integrityLocked: true, fileCount: lock.files.length };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Portable Node.js runtime copied to ${result.destination}\\runtime\\node\\node.exe\n`);
    return 0;
  } catch (cause) {
    const message = (cause as Error).message;
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`Portable Node.js copy failed: ${message}\n`);
    return 1;
  }
}
