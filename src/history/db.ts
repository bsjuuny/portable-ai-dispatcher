import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * node:sqlite (not better-sqlite3) - verified live to work on the installed Node
 * v24.14.0 build with zero native compilation, which matters because this machine
 * has no MSVC/cl.exe toolchain and no admin rights. It's Node's "Experimental" API
 * tier; every SQLite call is isolated behind this file + repository.ts so a future
 * swap is a two-file change, not a rewrite. See docs/architecture.md.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    task_type TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    fallback_count INTEGER NOT NULL DEFAULT 0,
    validation_passed INTEGER,
    review_verdict TEXT,
    input_size INTEGER,
    output_size INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    FOREIGN KEY (task_id) REFERENCES tasks (task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_executions_task_id ON executions (task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_task_id ON audit_events (task_id)`,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  return db;
}

export function defaultHistoryDbPath(projectRoot: string): string {
  return `${projectRoot}/.dispatcher/history.sqlite`;
}
