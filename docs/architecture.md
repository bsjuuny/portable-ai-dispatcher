# Architecture Decision Record

## 1. Provider Adapter seam

`src/core/`, `src/routing/`, `src/task/classifier.ts`, `src/validation/`, `src/review/` must never import `ClaudeProvider`/`CodexProvider` by name and must never branch on a provider id string (`if (provider.id === 'claude')`). All provider-specific behavior goes through the `AIProvider` interface (`src/providers/types.ts`), obtained from `ProviderRegistry`. Only `src/providers/index.ts` (the composition root) and test files may import both concrete classes.

Enforced by: `tests/unit/orchestrator.test.ts`'s "never branches on provider name" test, which registers a fake provider under an id the orchestrator has never seen (`"totally-unknown-provider"`) and proves the full pipeline routes to and executes against it successfully.

## 2. Shell-injection prevention

Exactly one function, `src/process/process-runner.ts`'s `runProcess()`, is allowed to call `execa`. `shell: false` is passed explicitly (execa's own default, but stated so nobody "fixes a quoting bug" later by flipping it). Enforced two ways:

1. `eslint.config.mjs`'s `no-restricted-imports` bans `child_process`/`execa` everywhere except that one file.
2. `tests/security/dist-static-scan.test.ts` greps the *built* `dist/*.js` for `execSync(`, `shell:true`, and raw `child_process.exec(` after `pnpm build` — a regression guard independent of source-level lint, in case a future dependency inlines something unsafe.

User-controlled text (task description, file/log content) is always sent via `stdinContent`, never as a positional argv element — this sidesteps OS argv-length limits entirely rather than needing to size-check them, and is why the command builders (`providers/claude/command-builder.ts`, `providers/codex/command-builder.ts`) are pure functions: plain data in, `string[]` argv out, testable without spawning anything.

## 3. Two logging layers, deliberately separate

- **Application log** (`src/logging/logger.ts`, pino): debugging, process state, errors. NDJSON only in v1.0 — `pino.transport()` was deliberately avoided because it spawns a worker thread that dynamically resolves its target module (e.g. `pino-pretty`) as a file on disk, which breaks under `tsup`/esbuild bundling. TTY pretty-printing was cut rather than working around that fragility (see `tsup.config.ts` comment).
- **Audit log** (`src/logging/audit.ts` + `src/history/repository.ts`): task lifecycle events, append-only, persisted to SQLite. Default policy never stores raw prompt/response text — only SHA-256 hash + length (`src/logging/redaction.ts`) — because Task Specifications can contain internal/sensitive information the user never intended to persist to disk indefinitely.

## 4. `node:sqlite` over `better-sqlite3`

Chosen because this implementation's own dev environment had no MSVC/`cl.exe` toolchain and no admin rights (confirmed by an unrelated `corepack enable` EPERM failure encountered while scaffolding) — exactly the condition under which a native-addon dependency like `better-sqlite3` would fail to install without a prebuilt binary matching the exact Node ABI. `node:sqlite` (`DatabaseSync`) has zero native compilation and zero install-time network fetch, at the cost of being Node's "Experimental" API tier. All access is isolated behind `history/db.ts` + `history/repository.ts` so a future swap is a two-file change.

Getting `node:sqlite` to survive bundling required a workaround: `import { DatabaseSync } from 'node:sqlite'` — both as a static import and as a dynamic `await import('node:sqlite')` — was observed to be rewritten by esbuild to the bare specifier `sqlite` (a nonexistent npm package), even with `platform: 'node'` and an explicit `external: ['node:sqlite']` in `tsup.config.ts`. `process.getBuiltinModule('node:sqlite')` (Node 22+) sidesteps this because it's a plain runtime function call with a string argument, invisible to esbuild's static import-graph analysis. See `src/history/db.ts`.

## 5. Large-log context windowing

Two separate, deliberately distinct layers:

1. **Hard byte cap** (`src/task/input-resolver.ts`, 10 MiB) — a blunt OOM guard applied at attachment *read* time, before anything else touches the content.
2. **Semantic windowing** (`src/project/log-windowing.ts`) — applied later, when `context-builder.ts` assembles what actually gets sent to a provider. Detects error-keyword / stack-trace / failed-test anchor lines, expands a symmetric context window around each, merges nearby windows, dedupes byte-identical repeats (common when a fix-loop retry re-attaches the same failure output), caps total kept lines by detector priority, and falls back to head+tail windowing when no anchors are found at all (e.g. a large clean build log, where the tail usually holds the final status).

Keeping these separate matters: the hard cap exists so pathological input never reaches memory in full; windowing exists to not waste a model's context budget even on input that already fit under the hard cap.

## 6. Validation command resolution — single call site

`Orchestrator.runValidationForTask()` is the only place `runValidationPipeline()` is called from within the orchestrator. This was not the original design — three separate inline call sites existed until `tests/unit/orchestrator.test.ts` caught that one of them omitted `commandOverrides`, silently ignoring a user's configured `validation.commands` and falling back to project-analyzer auto-detection (which returns empty commands on a repo with no recognizable build tool, making validation trivially "pass" by having nothing to run). Consolidating to one call site makes that class of bug structurally harder to reintroduce.
