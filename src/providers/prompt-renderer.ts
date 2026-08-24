import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';

/**
 * Composes the final text sent to a provider from the task specification and the
 * context builder's output. The raw description is always included verbatim (spec
 * requirement 21/23) even though structured fields and windowed attachments are also
 * rendered - a provider must be able to fall back to the original text.
 */
export function renderTaskPrompt(task: DispatcherTask, context: TaskContext): string {
  const sections: string[] = [];

  sections.push(`# Task (${task.command})\n\n${task.specification.rawDescription}`);

  if (task.executionPlan) {
    const providerUnits = task.executionPlan.workUnits
      .filter((unit) => unit.owner === 'provider')
      .map((unit) => `- [${unit.id}] ${unit.objective}`)
      .join('\n');
    sections.push(
      `## Dispatcher Plan\n- intent: ${task.executionPlan.intent}\n- scope: ${task.executionPlan.scope}\n- complexity: ${task.executionPlan.complexity}\n\n### Your Work Units\n${providerUnits || '(none)'}`,
    );
  }

  const structured = task.specification.structured;
  if (structured?.errorCodes?.length) {
    sections.push(`## Error Codes\n${structured.errorCodes.join(', ')}`);
  }
  if (structured?.requirements?.length) {
    sections.push(`## Requirements\n${structured.requirements.map((r) => `- ${r}`).join('\n')}`);
  }
  if (structured?.constraints?.length) {
    sections.push(`## Constraints\n${structured.constraints.map((c) => `- ${c}`).join('\n')}`);
  }

  if (context.project) {
    const p = context.project;
    sections.push(
      `## Project Context\n- language: ${p.language ?? 'unknown'}\n- framework: ${p.framework ?? 'unknown'}\n- buildTool: ${p.buildTool ?? 'unknown'}\n- testFramework: ${p.testFramework ?? 'unknown'}`,
    );
  }

  if (context.memorySnippets?.length) {
    sections.push(
      `## Project Memory\n${context.memorySnippets.map((m) => `- ${m.summary}${m.path ? ` (${m.path})` : ''}`).join('\n')}`,
    );
  }

  if (context.windowedAttachments?.length) {
    for (const wa of context.windowedAttachments) {
      const attachment = context.attachments?.find((a) => a.id === wa.attachmentId);
      const header = `## Attachment: ${attachment?.name ?? wa.attachmentId}${wa.truncated ? ' (truncated)' : ''}`;
      const body = wa.windows
        .map((w) => `--- lines ${w.startLine}-${w.endLine} (${w.reason}) ---\n${w.text}`)
        .join('\n\n');
      sections.push(`${header}\n${body}`);
    }
  } else if (context.attachments?.length) {
    for (const attachment of context.attachments) {
      if (!attachment.content) continue;
      sections.push(`## Attachment: ${attachment.name ?? attachment.id}\n${attachment.content}`);
    }
  }

  if (context.validationResults?.length) {
    const last = context.validationResults[context.validationResults.length - 1];
    if (last && !last.passed) {
      const failedStage = last.stages.find((s) => !s.passed);
      sections.push(
        `## Previous Validation Failure (${last.failedStage ?? 'unknown stage'})\n${failedStage?.outputExcerpt ?? ''}`,
      );
    }
  }

  if (context.reviewResults?.length) {
    const last = context.reviewResults[context.reviewResults.length - 1];
    if (last && last.findings.length > 0) {
      const findings = last.findings
        .map((f) => `- [${f.severity}] ${f.category}: ${f.message}${f.file ? ` (${f.file})` : ''}`)
        .join('\n');
      sections.push(`## Previous Review Findings (from ${last.reviewer})\n${findings}`);
    }
  }

  return sections.join('\n\n');
}
