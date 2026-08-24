import type { AppContext } from '../bootstrap.js';
import { runOfflinePreflight } from '../../local/preflight.js';

export async function runPreflightCommand(ctx: AppContext, json: boolean): Promise<number> {
  const report = runOfflinePreflight(ctx.cwd, ctx.config);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write('AI Dispatcher Offline Preflight\n\n');
    process.stdout.write(`OS: ${report.hardware.os}\nArchitecture: ${report.hardware.arch}\n`);
    process.stdout.write(`CPU: ${report.hardware.cpu.model ?? 'unknown'}\n`);
    process.stdout.write(`ISA: ${report.hardware.cpu.instructionSets.length ? report.hardware.cpu.instructionSets.join(', ') : 'unknown (generic CPU runtime only)'}\n`);
    process.stdout.write(`RAM: ${formatBytes(report.hardware.memory.totalBytes)} total, ${formatBytes(report.hardware.memory.availableBytes)} available\n`);
    process.stdout.write(`GPU: ${report.hardware.gpu?.model ?? report.hardware.gpu?.vendor ?? 'none/unknown'}\n`);
    process.stdout.write(`Selected Profile: ${report.tier}\n`);
    process.stdout.write(`CPU inference threads: ${report.cpuThreads}\n`);
    process.stdout.write(`Selected Runtime: ${report.selectedRuntime.selected?.runtimeId ?? 'none'} (${report.selectedRuntime.reason})\n`);
    process.stdout.write(`CPU Baseline: ${report.cpuBaselineRuntime.selected?.runtimeId ?? 'not ready'}\n`);
    process.stdout.write(`Git: ${report.git.available ? `available (${report.git.source})` : 'not found'}\n`);
    process.stdout.write(`Selected Model Pack: ${report.selectedPack ?? 'none'}\n`);
    if (report.models.length) {
      process.stdout.write('Models:\n');
      for (const model of report.models) {
        process.stdout.write(`  ${model.id}: ${model.status}${model.recommendedContextTokens ? ` context=${model.recommendedContextTokens}` : ''} — ${model.reason}\n`);
      }
    }
    if (report.overall.reasons.length) {
      process.stdout.write('Notes:\n');
      for (const reason of report.overall.reasons) process.stdout.write(`  - ${reason}\n`);
    }
    process.stdout.write(`Overall: ${report.overall.mode}\n`);
  }
  return report.overall.ready ? 0 : 1;
}

function formatBytes(bytes: number | undefined): string {
  return bytes === undefined ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
