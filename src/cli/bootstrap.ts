import { createDefaultProviderRegistry, type ProviderRegistry } from '../providers/index.js';
import { openDatabase, defaultHistoryDbPath } from '../history/db.js';
import { HistoryRepository } from '../history/repository.js';
import { AuditLogger, FanOutAuditSink } from '../logging/audit.js';
import { loadConfig } from '../config/loader.js';
import type { DispatcherConfig } from '../config/schema.js';
import { Orchestrator } from '../core/orchestrator.js';
import { createLogger, type DispatcherLogger, type LogLevel } from '../logging/logger.js';
import { ConsoleAuditSink } from './console-audit-sink.js';
import { resolve } from 'node:path';

export interface AppContext {
  cwd: string;
  config: DispatcherConfig;
  providers: ProviderRegistry;
  history: HistoryRepository;
  audit: AuditLogger;
  /** Prints live status to stderr as the orchestrator's audit events happen - the
   * same events `audit` persists to history, fanned out (see FanOutAuditSink) rather
   * than replacing that persistence. Call `.stop()` once a dispatch command's task
   * has finished, so a still-ticking heartbeat timer never outlives it. */
  consoleStatus: ConsoleAuditSink;
  orchestrator: Orchestrator;
  logger: DispatcherLogger;
}

/** Composition root for the CLI - the only other place besides providers/index.ts that wires concrete implementations together. */
export function createAppContext(cwd: string, opts: { debug?: boolean } = {}): AppContext {
  const root = resolve(cwd);
  const config = loadConfig(root);
  const providers = createDefaultProviderRegistry(config);
  const db = openDatabase(defaultHistoryDbPath(root));
  const history = new HistoryRepository(db);
  const consoleStatus = new ConsoleAuditSink();
  const audit = new AuditLogger(new FanOutAuditSink([history, consoleStatus]), { storeRawContent: config.diagnostics.logPrompts });
  const orchestrator = new Orchestrator({ providers, usageStore: history, auditLogger: audit, config });
  // --debug overrides AI_DISPATCHER_LOG_LEVEL, which overrides the 'info' default.
  const level = opts.debug ? 'debug' : (process.env['AI_DISPATCHER_LOG_LEVEL'] as LogLevel | undefined);
  const logger = createLogger({ level });

  return { cwd: root, config, providers, history, audit, consoleStatus, orchestrator, logger };
}
