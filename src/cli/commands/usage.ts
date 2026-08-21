import type { AppContext } from '../bootstrap.js';
import { UsageTracker, type UsageWindowName } from '../../routing/usage-tracker.js';
import type { ProviderId } from '../../models/provider.js';

export async function runUsageCommand(ctx: AppContext, providerFilter: string | undefined, json: boolean): Promise<number> {
  const tracker = new UsageTracker(ctx.history);
  const providers = providerFilter
    ? [ctx.providers.get(providerFilter as ProviderId)]
    : ctx.providers.list();

  const windows: UsageWindowName[] = ['1h', '24h', '7d', 'all'];
  const report = await Promise.all(
    providers.map(async (provider) => ({
      provider: provider.id,
      windows: Object.fromEntries(
        await Promise.all(windows.map(async (w) => [w, await tracker.usageFor(provider.id, w)] as const)),
      ),
    })),
  );

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  for (const entry of report) {
    process.stdout.write(`${entry.provider}:\n`);
    for (const w of windows) {
      const usage = entry.windows[w];
      if (!usage) continue;
      process.stdout.write(
        `  ${w}: requests=${usage.requests} success=${usage.successes} failures=${usage.failures} timeouts=${usage.timeouts}${usage.estimatedCostUsd !== undefined ? ` cost=$${usage.estimatedCostUsd.toFixed(4)}` : ''}\n`,
      );
    }
  }
  return 0;
}

export function runProvidersCommand(ctx: AppContext, json: boolean): number {
  const list = ctx.providers.list().map((p) => ({ id: p.id, capabilities: p.capabilities() }));
  if (json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  } else {
    for (const p of list) process.stdout.write(`${p.id}: ${p.capabilities.join(', ')}\n`);
  }
  return 0;
}
