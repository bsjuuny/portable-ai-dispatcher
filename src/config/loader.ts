import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { parseConfig, type DispatcherConfig } from './schema.js';
import { DispatcherError } from '../models/error.js';

const CONFIG_FILENAMES = ['.ai-dispatcher.yml', '.ai-dispatcher.yaml'];

export function loadConfig(root: string): DispatcherConfig {
  const path = CONFIG_FILENAMES.map((name) => join(root, name)).find((p) => existsSync(p));
  if (!path) return parseConfig({});

  let raw: unknown;
  try {
    raw = loadYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Failed to parse ${path}: ${(cause as Error).message}`,
      cause,
      retryable: false,
    });
  }

  try {
    return parseConfig(raw);
  } catch (cause) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Invalid configuration in ${path}: ${(cause as Error).message}`,
      cause,
      retryable: false,
    });
  }
}
