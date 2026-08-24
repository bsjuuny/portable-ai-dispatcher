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

---

# Local LLM Adapter + Hardening increment

## 7. `executeDirect` — a second execution seam alongside build-command/spawn/parse

Ollama's `/api/generate` is HTTP, not a spawned CLI process — forcing it through `ProviderCommandPlan`/`runProcess`/`parseOutcome` would mean either faking a `ProcessOutcome` around an HTTP call or teaching `process-runner.ts` about non-process transports. Neither was acceptable, so `AIProvider` gained one new *optional* method, `executeDirect(task, context, opts, executionId): Promise<TaskResult>`. `dispatch-execution.ts`'s `executeOnce()` checks `provider.executeDirect` first; only when it's absent does the exact pre-existing `buildCommand → runProcess → parseOutcome` path run. `ClaudeProvider`/`CodexProvider` never define it, so their behavior is unmodified — proven by `tests/unit/orchestrator.test.ts`'s and `tests/unit/claude-codex-provider.test.ts`'s pre-existing assertions still passing unchanged.

For code-changing tasks, `executeDirect()` now delegates to the runtime-neutral bounded tool loop in `local-coding-agent.ts`. The local backend still only generates text, but that text is constrained to one JSON action and the dispatcher performs the filesystem operation inside the isolated worktree. This supplies real `filesChanged` without coupling the agent to Ollama's API or granting it a shell. Ollama, llama.cpp, OpenAI-compatible servers, and future `LocalRuntimeAdapter` implementations all share the same agent.

## 8. Sole `fetch()` chokepoint, and the `<think>` stripping shape that had to be discovered live

`src/providers/local/local-http-client.ts` is the only file allowed to call the global `fetch()`, mirroring decision #2's process-runner chokepoint — enforced by `tests/security/local-fetch-single-chokepoint.test.ts`, a source-level grep (fetch is a global, not an import, so ESLint's `no-restricted-imports` can't reach it). It rejects any non-loopback host before ever calling `fetch()`.

Live-verified against Ollama 0.32.14 with `qwen3:4b`: even with `"think": false` in the request, the response text still carries a full reasoning preamble — but **not** wrapped in a matching `<think>...</think>` pair the way the model documentation implies. The actual shape has no opening tag at all, only an orphaned closing `</think>` immediately before the real answer (`"...response is ready: OK.\n</think>\n\nOK"`). `stripThinking()` handles both the documented balanced-tag shape and this actually-observed orphaned-tag shape — written from the real captured response, not from the doc.

## 9. Workspace isolation, the safety gate, and why they default the way they do

Code-changing tasks (`fix`/`implement`), with `safety.workspaceIsolation.enabled` (default `true`), now run against a real `git worktree` checked out at the current `HEAD` rather than the caller's actual working tree — `src/safety/workspace.ts`. `Orchestrator`'s existing dispatch/validate/fix-loop/review logic is reused completely unmodified against this isolated copy; the only change is that `task.workingDirectory` is temporarily repointed at the worktree for the duration (every downstream call site already read that field as its single source of truth, so nothing else needed to change) and restored in a `finally` block. An in-memory `RepositoryLock` (`src/safety/repository-lock.ts`, same per-process-only honesty as decision above re: circuit breaker) prevents two concurrent code-changing tasks from racing on one repository.

Once validation passes and review is non-blocking, `src/safety/risk-classifier.ts` classifies the change (protected-path or CI/CD-pipeline-file touch is always `CRITICAL`; otherwise LOW/MEDIUM/HIGH from how far over `safety.blastRadius`'s per-task-type limits the file/line counts are), and `src/safety/auto-apply-gate.ts`'s `decideAutoApply()` — a pure, fail-closed function taking a `CompletionEvidence` record with no optional fields — decides `AUTO_APPLY | BLOCKED_BY_POLICY | FAILED`. Only `AUTO_APPLY` reaches `src/safety/patch-apply.ts`, which re-checks base-revision and content-hash TOCTOU guards immediately before merging (not just once at task start), then applies the worktree's diff into the real tree via `git apply` through the existing `process-runner.ts` chokepoint — landing as an ordinary uncommitted change, never auto-committed.

`safety.autoApply.enabled` defaults to `false`. Combined with `workspaceIsolation` defaulting to `true`, this is a deliberate, real behavior change for a config that previously had no opinion on the matter: a `fix`/`implement` task that fully succeeds now reports `BLOCKED_BY_POLICY`, not `SUCCESS`, until an operator explicitly opts in after reviewing the risk thresholds. See README's "Autonomous operation" section for the full rationale — the alternative (auto-apply on by default) would have made upgrading this dependency a silent, unreviewed change in what happens to a repository.

## 10. A real bug found by testing the TOCTOU guards against a real git repo: execa strips the trailing newline

`src/safety/content-hash-lock.ts` and `src/safety/patch-apply.ts` both compare/consume text captured through `process-runner.ts` (`git show <rev>:path`, `git diff --cached --binary HEAD`). Live-verified while writing this module's own tests: execa strips a captured process's single trailing newline by default (`stdout` for content `"hello\n"` comes back as `"hello"`), while the same unchanged file read straight off disk via `fs.readFile` still has its `"\n"`. Without accounting for this:

- Every file would register as content-hash-"stale" even with zero real changes (`checkContentHashesUnchanged`'s two sides disagreed purely on a trailing newline) — this would have made the safety gate permanently unable to reach `AUTO_APPLY`, not a rare edge case.
- `git apply` failed with `error: corrupt patch at line 14` on a multi-file diff, because a valid patch's last hunk line must end in a newline and the captured diff text didn't.

Fixed locally in both files (normalizing before hashing in `content-hash-lock.ts`; restoring the trailing newline before handing the patch to `git apply` in `patch-apply.ts`) rather than changing `process-runner.ts`'s capture behavior globally, which is shared by every other caller (Claude/Codex output parsing, `validation/git-diff.ts`, ...) and not worth the collateral risk for two patch-format-sensitive consumers. Found and fixed by writing `tests/unit/patch-apply.test.ts` against a real temporary git repository rather than mocking `runProcess` — the exact reason this increment's tests favor real git subprocesses over mocks wherever practical.

## 11. Four more issues found on a deliberate second-pass review, after Batch 1 was otherwise complete

Requested explicitly by the user as a "does anything here conflict with Phase 1-8" audit, rather than found incidentally while building something else - worth recording the same way, since they're exactly the kind of cross-cutting interaction bug that unit-testing each module in isolation doesn't surface.

**Failure artifacts written during isolated execution were being deleted along with the worktree.** `dispatch-execution.ts`'s `persistFailureArtifact()` derived its save location from `task.workingDirectory` - correct for the non-isolated path, but during an isolated `fix`/`implement` task that field is temporarily the worktree path (decision #9). A failed provider-execution or review-dispatch attempt inside that window wrote its artifact into the worktree, which `releaseWorkspace()` then deletes wholesale in the `finally` block - silently defeating the entire failure-artifact feature for exactly the autonomous scenario it matters most for. Fixed by adding `ExecuteOnceOptions.artifactRoot` (an explicit override, defaulting to the old `task.workingDirectory` behavior when omitted) and threading the real repository directory through `Orchestrator.dispatchWithRetryAndFallback()`/`validateAndReview()` only from `runIsolatedCodeChangingTask()`. Regression-tested end to end in `tests/unit/orchestrator.test.ts` by asserting the artifact directory still exists, and is under the real repo path, after the task (and its worktree) are gone.

**A malformed reviewer response used to downgrade a failed review to a pass.** `review-schema.ts` now treats invalid structured JSON as blocking `request_changes`, so autonomous apply fails closed regardless of whether the reviewer is cloud or local. `Orchestrator.pickReviewer()` independently selects a ready provider with the `review` capability, prefers a non-local reviewer, and only falls back to a local reviewer (still better than pure self-review) when no cloud reviewer is ready.

**Two `local.profiles[]` entries sharing a `name` silently overwrote each other.** Each profile becomes provider id `local-<name>`, and `ProviderRegistry.register()` is a plain `Map.set()` - no uniqueness check existed anywhere, so a duplicate name meant the second profile's provider silently replaced the first with no error, no warning, nothing in `local status` to explain why the first one "isn't there." `config/schema.ts`'s `LocalSchema.profiles` now `.refine()`s uniqueness (and `name` additionally requires `.min(1)`, since an empty name is a degenerate case of the same problem: `local-`).

**A file rename wasn't a real path, and both TOCTOU checks silently no-op'd on it.** `git diff --numstat` (git 2.53.0, rename detection on by default with no `-M` needed) reports a rename as a *single* line whose "path" field is a rewrite notation, not a real path: `old.txt => new.txt` with no shared prefix, or `dir/{old.txt => new.txt}` when part of the path is shared. `change-scope.ts`'s numstat parser was treating that whole notation as one literal (nonexistent) file path. Both `risk-classifier.ts` (pattern-matching against protected/CI paths) and `content-hash-lock.ts` (`git show <rev>:<path>` / `fs.readFile`) would silently fail to find any real file at that "path," each treating the failure as `ABSENT_SENTINEL` on both sides of the comparison - which reads as "unchanged," not as "couldn't check." Fixed by resolving both rename notations into the real old and new paths and including *both* in `ChangeScope.files`, so a rename into/out of a protected or CI-pattern path is still classified correctly, and the content-hash guard verifies both "the old path is what it was" and "the new path didn't already exist for an unrelated reason."

## 12. Supervisor planning, adaptive leases, and timeout continuation

Task classification now consumes bounded repository metrics from `project/repository-metrics.ts` in addition to the request text. This corrects a live failure where a natural Korean repository-wide audit-and-fix request was classified as a `simple` bugfix solely because its prompt was short. Repository-wide code-changing requests become `repository-remediation`/`complex`, receive a deterministic work-unit plan, and are routed with the repository evidence recorded in the audit trail.

`execution/budget.ts` maps simple/normal/complex work to configurable hard ceilings. `process-runner.ts` independently maintains an idle lease that is renewed by real stdout/stderr activity. The hard ceiling prevents infinite work; the idle lease stops genuinely silent processes without killing an agent that is still emitting commands and file-change events. On Windows, `taskkill /T` remains the first termination path, but an access-denied environment falls back to Microsoft's `@vscode/windows-process-tree` native enumerator and kills only the exact descendant PID set. The detached-grandchild regression test proves both prompt return and process cleanup.

A timed-out attempt no longer receives the original prompt verbatim on retry. The orchestrator records a checkpoint audit event and sends a continuation instruction that first inspects the existing isolated worktree diff, preserves completed work, and resumes unfinished plan units. This is an in-task checkpoint: crash-safe cross-process `resume <taskId>` remains future work and must not be implied by the current event name.

## 13. Structured completion evidence (5W1H)

`reporting/task-result-report.ts` turns every completed `TaskOutcome` into one stable 5W1H report used by both human and JSON CLI output. It records the actors, wall-clock interval, real repository path and changed files, task intent and final verdict, original request and routing evidence, and the work-unit/attempt/validation/review chain. Change disposition is modeled independently from success: isolated failures are `discarded`, policy blocks are `withheld`, successful code changes are `applied`, and failures in explicitly non-isolated mode are truthfully marked `left-in-place`. The sanitized structure is also appended to the audit log as `task.report.created`.

## 14. Closed-network verification boundary

`tests/security/closed-environment.test.ts` exercises the supported closed-network configuration: both cloud providers disabled, only a loopback local profile registered, no cloud fallback when the local runtime is unavailable, forced cloud selection rejected, and repository remediation routed to the autonomous local provider. `tests/contract/closed-environment-live.test.ts` joins configuration and routing to real loopback generation, while `tests/contract/local-autonomous-coding-live.test.ts` proves a real `qwen3:4b` can inspect and edit a temporary workspace through the bounded tool loop. The boundary is intentionally honest: provider egress is prevented by composition plus the loopback-only HTTP choke point, while network isolation for arbitrary validation scripts remains the host firewall/sandbox's responsibility. This is a tested deployment profile, not the still-deferred first-class Offline Mode policy engine.
