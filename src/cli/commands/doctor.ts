import type { AppContext } from '../bootstrap.js';

export async function runDoctorCommand(ctx: AppContext, json: boolean): Promise<number> {
  const results = await Promise.all(
    ctx.providers.list().map(async (provider) => ({ provider: provider.id, health: await provider.checkHealth() })),
  );

  const allReady = results.every((r) => r.health.ready);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ready: allReady, providers: results }, null, 2)}\n`);
  } else {
    for (const { provider, health } of results) {
      process.stdout.write(
        `${provider}: installed=${health.installed} authenticated=${String(health.authenticated)} ready=${health.ready}${health.version ? ` version=${health.version}` : ''}${health.message ? ` (${health.message})` : ''}\n`,
      );
    }
    process.stdout.write(allReady ? 'All providers ready.\n' : 'One or more providers are not ready.\n');
  }

  return allReady ? 0 : 1;
}
