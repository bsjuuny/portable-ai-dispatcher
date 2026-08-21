import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = join(process.cwd(), 'dist');

/**
 * Regression guard independent of source-level ESLint: greps the actually BUILT
 * output for the literal patterns that would indicate a shell got involved somewhere
 * (a bundled dependency inlining `child_process.exec`, or `shell: true` sneaking in),
 * so this fails even if a future change bypasses the eslint no-restricted-imports
 * rule some other way. Requires `pnpm build` to have run first - skips with a clear
 * reason if dist/ doesn't exist yet, rather than silently reporting nothing to check.
 */
describe('dist static scan: no shell execution paths in the built output', () => {
  const distExists = existsSync(DIST_DIR);

  it.skipIf(!distExists)('contains no execSync, unsafe .exec(, or shell:true', () => {
    const files = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(join(DIST_DIR, file), 'utf8');
      expect(content, `${file} should not call execSync`).not.toMatch(/\bexecSync\s*\(/);
      expect(content, `${file} should not force shell:true`).not.toMatch(/shell\s*:\s*true/);
      // child_process.exec( (not execa/execFile/execFileSync) is the unsafe shell-string form.
      expect(content, `${file} should not call the raw child_process exec()`).not.toMatch(
        /\bchild_process\.exec\s*\(/,
      );
    }
  });

  if (!distExists) {
    it('dist/ does not exist yet - run `pnpm build` before this suite for it to check anything', () => {
      expect(distExists).toBe(false); // documents the skip reason as a passing assertion, not a silent no-op
    });
  }
});
