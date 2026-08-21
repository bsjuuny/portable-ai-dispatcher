import { createDefaultProviderRegistry, type ProviderRegistry } from '../providers/index.js';
import { openDatabase, defaultHistoryDbPath } from '../history/db.js';
import { HistoryRepository } from '../history/repository.js';
import { AuditLogger } from '../logging/audit.js';
import { loadConfig } from '../config/loader.js';
import type { DispatcherConfig } from '../config/schema.js';
import { Orchestrator } from '../core/orchestrator.js';
import { createLogger } from '../logging/logger.js';
import type pino from 'pino';

export interface AppContext {
  cwd: string;
  config: DispatcherConfig;
  providers: ProviderRegistry;
  history: HistoryRepository;
  audit: AuditLogger;
  orchestrator: Orchestrator;
  logger: pino.Logger;
}

/** Composition root for the CLI - the only other place besides providers/index.ts that wires concrete implementations together. */
export function createAppContext(cwd: string, opts: { debug?: boolean } = {}): AppContext {
  const config = loadConfig(cwd);
  const providers = createDefaultProviderRegistry();
  const db = openDatabase(defaultHistoryDbPath(cwd));
  const history = new HistoryRepository(db);
  const audit = new AuditLogger(history, { storeRawContent: config.diagnostics.logPrompts });
  const orchestrator = new Orchestrator({ providers, usageStore: history, auditLogger: audit, config });
  // --debug overrides AI_DISPATCHER_LOG_LEVEL, which overrides the 'info' default.
  const level = opts.debug ? 'debug' : (process.env['AI_DISPATCHER_LOG_LEVEL'] as pino.LevelWithSilent | undefined);
  const logger = createLogger({ level });

  return { cwd, config, providers, history, audit, orchestrator, logger };
}
