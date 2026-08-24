import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { RepositoryMetrics } from '../models/classification.js';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.dispatcher',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'vendor',
]);

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js',
  '.jsx', '.kt', '.kts', '.php', '.py', '.rb', '.rs', '.scss', '.sql', '.swift',
  '.ts', '.tsx', '.vue',
]);

const PACKAGE_FILES = new Set([
  'package.json', 'pyproject.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile',
]);

export interface RepositoryMetricOptions {
  maxFiles?: number;
  maxDepth?: number;
}

/**
 * Fast, bounded repository sizing used by the deterministic task classifier. It
 * deliberately ignores generated/dependency directories and never follows symlinks.
 */
export async function measureRepository(
  root: string,
  options: RepositoryMetricOptions = {},
): Promise<RepositoryMetrics> {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxDepth = options.maxDepth ?? 20;
  const metrics: RepositoryMetrics = {
    totalFiles: 0,
    sourceFiles: 0,
    testFiles: 0,
    packageFiles: 0,
    totalSourceBytes: 0,
    scanTruncated: false,
  };

  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (metrics.totalFiles >= maxFiles) {
        metrics.scanTruncated = true;
        return metrics;
      }

      const path = join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push({ directory: path, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;

      metrics.totalFiles += 1;
      if (PACKAGE_FILES.has(entry.name)) metrics.packageFiles += 1;

      const extension = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) continue;
      metrics.sourceFiles += 1;
      if (/(^|[.\-_])(test|spec)s?([.\-_]|$)|(^|[\\/])tests?([\\/]|$)/i.test(path)) {
        metrics.testFiles += 1;
      }
      try {
        metrics.totalSourceBytes += (await stat(path)).size;
      } catch {
        // A concurrently removed file should not make task classification fail.
      }
    }
  }

  return metrics;
}
