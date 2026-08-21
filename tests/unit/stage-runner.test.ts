import { describe, expect, it } from 'vitest';
import { runValidationStage } from '../../src/validation/stage-runner.js';

describe('runValidationStage', () => {
  it('treats an absent command as passed-by-absence, not a failure', async () => {
    const result = await runValidationStage({ stage: 'lint', command: undefined, cwd: '.' });
    expect(result.passed).toBe(true);
    expect(result.outputExcerpt).toContain('skipped');
  });

  it('treats an empty command array the same as absent', async () => {
    const result = await runValidationStage({ stage: 'lint', command: [], cwd: '.' });
    expect(result.passed).toBe(true);
  });

  it('reports pass for a real command that exits 0', async () => {
    const result = await runValidationStage({
      stage: 'build',
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.',
    });
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('reports failure with output excerpt for a real command that exits non-zero', async () => {
    const result = await runValidationStage({
      stage: 'test',
      command: [process.execPath, '-e', 'console.error("boom"); process.exit(1)'],
      cwd: '.',
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.outputExcerpt).toContain('boom');
  });

  it('truncates very large output rather than keeping it all', async () => {
    const result = await runValidationStage({
      stage: 'test',
      command: [process.execPath, '-e', 'console.error("x".repeat(20000)); process.exit(1)'],
      cwd: '.',
    });
    expect(result.outputExcerpt!.length).toBeLessThan(20000);
    expect(result.outputExcerpt).toContain('truncated');
  });
});
