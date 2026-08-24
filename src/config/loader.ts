import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { parseConfig, type DispatcherConfig } from './schema.js';
import { DispatcherError } from '../models/error.js';

const CONFIG_FILENAMES = ['.ai-dispatcher.yml', '.ai-dispatcher.yaml'];

export function loadConfig(root: string): DispatcherConfig {
  const portableConfigPath = process.env['AI_DISPATCHER_CONFIG_PATH'];
  const projectConfigPath = CONFIG_FILENAMES.map((name) => join(root, name)).find((p) => existsSync(p));
  if (portableConfigPath && !existsSync(portableConfigPath)) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Portable configuration does not exist: ${portableConfigPath}`,
      retryable: false,
    });
  }
  if (!portableConfigPath && !projectConfigPath) return parseConfig({});

  // A portable kit supplies conservative local-only defaults. A project's
  // configuration remains authoritative for its own settings, while arrays are
  // replaced rather than concatenated to avoid accidentally enabling profiles.
  const portableRaw = portableConfigPath ? readConfigFile(portableConfigPath) : {};
  const projectRaw = projectConfigPath ? readConfigFile(projectConfigPath) : {};

  try {
    return parseConfig(deepMerge(portableRaw, projectRaw));
  } catch (cause) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Invalid configuration: ${(cause as Error).message}`,
      cause,
      retryable: false,
    });
  }
}

function readConfigFile(path: string): unknown {
  try {
    return loadYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Failed to parse ${path}: ${(cause as Error).message}`,
      cause,
      retryable: false,
    });
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
