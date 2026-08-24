import type { AppContext } from '../bootstrap.js';
import { resolve } from 'node:path';
import { assemblePortableKit, copyPortableNodeRuntime } from '../../local/portable-kit.js';

export function runPortableAssembleCommand(ctx: AppContext, destination: string, includeAssets: boolean, json: boolean): number {
  try {
    const result = assemblePortableKit(ctx.cwd, resolve(ctx.cwd, destination), includeAssets);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Portable kit created: ${result.destination}\n`);
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

export function runPortableAddNodeCommand(destination: string, json: boolean): number {
  try {
    copyPortableNodeRuntime(resolve(destination));
    const result = { destination: resolve(destination), copiedNodeRuntime: true };
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
