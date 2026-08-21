# AI Dispatcher v1.0

An AI Development Control Plane: a CLI that routes coding tasks between Claude Code and Codex, verifies the result with real build/test/lint, and has the *other* AI independently review the change before declaring success.

This is not a wrapper that just runs `claude` or `codex` for you. It classifies the task, scores both providers against real health/usage/capability data, dispatches with retry/fallback/circuit-breaking, runs your actual validation pipeline (with a bounded automatic fix loop on failure), routes the diff to an independent reviewer, and records everything to a structured audit log and a local SQLite history — so "the AI said it worked" and "the system verified it worked" are never the same claim.

## Architecture

```
src/
├─ models/        Domain types + DispatcherError (shared by every layer)
├─ core/           State machine, Orchestrator (the runTask() pipeline), execution glue
├─ task/           Task Specification parsing, input resolution, classifier
├─ providers/      AIProvider interface + ProviderRegistry; claude/ and codex/ adapters
├─ routing/        Usage tracking, scoring, provider selection, retry/fallback/circuit-breaker
├─ project/        Project analyzer, memory (JSON), log windowing, context builder
├─ validation/     git-diff, build/test/lint/typecheck runners, pipeline, fix loop
├─ review/         Review coordinator (prompts a reviewer, parses its verdict), conflict resolver
├─ process/        The single execa call site (process-runner.ts)
├─ logging/        pino logger, secret redaction, audit event log
├─ history/        node:sqlite-backed task/execution/audit history
├─ config/         zod schema + YAML loader for `.ai-dispatcher.yml`
└─ cli/            commander-based CLI wiring the above together
```

**The core architectural invariant**: `core/`, `routing/`, `task/classifier.ts`, `validation/`, `review/` never import `ClaudeProvider`/`CodexProvider` by name and never branch on a provider id string. Everything provider-specific is reached only through the `AIProvider` interface via `ProviderRegistry`. Only `providers/index.ts` (the composition root) and tests import both concrete classes. `tests/unit/orchestrator.test.ts` proves this by successfully routing to and executing against a fake provider whose id (`"totally-unknown-provider"`) the orchestrator has never seen before.

## Install

```bash
pnpm install
pnpm build
```

Requires Node.js 22+. Requires the [`claude`](https://claude.com/product/claude-code) and/or [`codex`](https://github.com/openai/codex) CLIs to be installed and authenticated separately — see below.

### Running the CLI

`pnpm build` produces `dist/cli.js` — it is **not** automatically put on your PATH as a bare `ai-dispatcher` command. Pick one:

```bash
# Always works, no setup - run it directly:
node dist/cli.js doctor
```

Or make `ai-dispatcher` available as a real command on PATH via `pnpm link --global`. If pnpm has never been set up on this machine before, that command fails with `The configured global bin directory "..." is not in PATH` — fix it once, then **open a brand new terminal window** (verified live: env var changes from `pnpm setup` are written to the Windows registry and are not picked up by any shell/tool session that was already running, only by ones started afterward):

```bash
pnpm setup              # one-time, only if `pnpm link --global` complains about PATH
# → close this terminal and open a new one, then:
pnpm link --global      # from this project's directory
ai-dispatcher doctor    # now works in any new shell
```

The rest of this README uses `ai-dispatcher <command>` as shorthand for whichever of the two you're using — substitute `node dist/cli.js` if you haven't linked it globally. To undo the global link: `pnpm unlink --global` (run from this project's directory).

## Provider authentication

**The dispatcher is not a credential manager.** It never reads, stores, or touches an API key, OAuth token, or session cookie. It only shells out to the official CLIs' own health/status commands (`claude auth status`, `codex login status`) to check whether *you* are already logged in.

```bash
claude auth login
codex login
```

If a provider isn't authenticated, `ai-dispatcher doctor` tells you exactly that and stops — it never attempts to automate a login flow.

## CLI commands

```bash
ai-dispatcher ask <task-spec>          # analysis / Q&A, no validation or review
ai-dispatcher analyze <task-spec>
ai-dispatcher review <task-spec>
ai-dispatcher fix <task-spec>          # code-changing: runs validation + fix loop + review
ai-dispatcher implement <task-spec>    # code-changing: same as above

ai-dispatcher doctor [--json]          # health-check both providers
ai-dispatcher providers [--json]       # list capabilities
ai-dispatcher usage [provider] [--json]# 1h/24h/7d/all request+cost stats
ai-dispatcher history [--limit N]      # recent tasks
ai-dispatcher inspect <taskId>         # full detail for one task
ai-dispatcher explain <taskId>         # why a provider was selected, with score breakdown
```

Every dispatch command accepts:

| Flag | Meaning |
|---|---|
| `--file <path>` | Read the task specification from a file |
| `--stdin` | Read the task specification from stdin |
| `--path <paths...>` | Related file/directory paths to include as context |
| `--cwd <path>` | Working directory (default: current directory) |
| `--timeout <ms>` | Execution timeout |
| `--provider <id>` | Force `claude` or `codex` instead of routing |
| `--dry-run` | Print the routing decision and built command, execute nothing |
| `--json` | Machine-readable output |
| `--debug` | Raise the application log to debug level (NDJSON to stdout) |

### Writing a Task Specification

A task description is not a one-line prompt — it can be a full incident report. All of these work:

```bash
# Short
ai-dispatcher fix "로그인 오류를 수정해줘"

# Multi-line, with an error code and a stack trace
ai-dispatcher fix "
로그인 API 호출 시 다음 오류가 발생한다.

ERR-USER-1042

java.lang.NullPointerException:
Cannot invoke User.getId() because user is null
    at com.example.service.UserService.findUser(UserService.java:128)

요구사항:
- 기존 API 변경 금지
- Regression Test 추가
"

# From a file
ai-dispatcher fix --file bug-report.md

# From stdin
cat bug-report.md | ai-dispatcher fix

# Combined: description + attached log + related path
ai-dispatcher fix --file error.log --path src/main/java/com/example \
  "이 오류의 근본 원인을 분석하고 회귀 테스트까지 작성해줘"
```

The raw text is **always preserved verbatim** alongside whatever the classifier extracts (error codes, stack traces, numbered reproduction steps, bulleted requirements/constraints) — a misclassification never loses information a provider could otherwise have used.

Large attachments (stack traces, build logs) are never sent whole. `project/log-windowing.ts` finds error-keyword/stack-trace/failed-test anchor lines, expands a context window around each, merges nearby windows, dedupes repeated blocks, and falls back to head+tail windowing when nothing is found — see `docs/architecture.md`.

### Shell safety

Every piece of user-controlled text — the task description, file paths, log content — is sent to providers via `stdin`, never concatenated into a shell command string. `process/process-runner.ts` is the *only* file allowed to spawn a process (enforced by an ESLint rule and by `tests/security/dist-static-scan.test.ts`, which greps the built output for unsafe patterns), and it calls `execa` with `shell: false` explicit. See `tests/security/shell-injection.test.ts` for the full payload matrix this is tested against, including a >100KB payload proving there's no reliance on OS argv-length limits.

## Routing

Provider selection is a weighted score, not role-fixed:

```yaml
routing:
  weights:
    capability: 0.35
    usage: 0.20
    successRate: 0.20
    latency: 0.10
    availability: 0.10
    failurePenalty: 0.05
```

`ai-dispatcher explain <taskId>` prints the exact score breakdown that produced a decision — every component, every provider, in the same format you'd see in the routing log.

## Validation and the fix loop

For `fix`/`implement` tasks, after execution: `git diff` (checks for protected-path modifications) → typecheck → lint → build → test, in that order, stopping at the first failure. On failure, the failed stage's output is attached to a follow-up task sent back to the *same* implementer, and validation re-runs — bounded by `validation.maxFixAttempts` (default 2). It never loops unboundedly.

Commands are auto-detected from the project (`package.json` scripts + lockfile → pnpm/yarn/npm; `pom.xml` → Maven; `build.gradle(.kts)` → Gradle; `pyproject.toml` → pytest/ruff) but an explicit `.ai-dispatcher.yml` always wins:

```yaml
validation:
  commands:
    test: [pnpm, run, test]
  maxFixAttempts: 2
```

## Review

Once validation passes, the diff goes to an independent reviewer — by default, the provider that *didn't* implement the change. The reviewer is asked to check correctness, requirement compliance, regressions, security, concurrency, null handling, error handling, resource leaks, performance, maintainability, test coverage, unrelated changes, and architecture consistency, and to return a fenced JSON verdict. `request_changes`/`critical` findings trigger another fix→re-validate→re-review cycle, bounded by `review.maxReviewCycles` (default 2).

If only one provider is `Ready` (installed + authenticated + reachable), the dispatcher self-reviews rather than blocking — but `independentReview: false` is recorded on the result and in history, never silently presented as an independent check.

Disagreement between what a reviewer says and what validation shows is resolved by evidence, not majority vote (there's only ever one active reviewer per cycle anyway): `review/conflict-resolver.ts` checks the latest `ValidationResult` before deciding whether a persisting finding gets accepted as a warning or escalated to the user.

## Audit and history

Every task gets a `taskId`; every execution attempt (including retries and fallbacks) gets its own `executionId`, all linked to the same task. Structured audit events (`task.created`, `provider.selected`, `retry.started`, `validation.failed`, `review.completed`, ...) are appended (never rewritten) to a local SQLite database at `.dispatcher/history.sqlite` in the project you ran `ai-dispatcher` against.

**By default, prompt and response text are never stored** — only their SHA-256 hash and length. Set `diagnostics.logPrompts: true` in config to opt into storing raw text, and even then it passes through secret scrubbing first (AWS/OpenAI/Anthropic/GitHub-token-shaped strings, JWTs, PEM blocks, `.env`-style secret lines are replaced with `[REDACTED]`).

`ai-dispatcher history [--limit N]` lists recent tasks; `ai-dispatcher inspect <taskId>` shows one task plus every execution attempt made for it (provider, timing, token/cost usage); `ai-dispatcher explain <taskId>` shows the routing score breakdown that led to the provider that was picked (see [Routing](#routing) above).

### Failure artifacts

When an execution attempt fails, times out, or errors out of the process/parsing layer entirely, the full detail is written to `.dispatcher/runs/<executionId>/` in the project directory:

```
.dispatcher/runs/<executionId>/
├─ metadata.json   # provider, command, args, cwd, exit code, timing
├─ error.json      # the DispatcherError (code, message) - omitted if there wasn't one
├─ stdout.log      # raw stdout, secret-scrubbed
└─ stderr.log      # raw stderr, secret-scrubbed
```

This is what makes a failure re-diagnosable without re-running anything: `ai-dispatcher inspect <taskId>` tells you *that* an execution failed, the artifact directory tells you *why*, byte-for-byte, without needing `diagnostics.logPrompts: true`. The task prompt itself (`stdinContent`) is deliberately never written here, matching the audit log's default policy. Controlled by `diagnostics.saveFailureArtifacts` (default `true`); a failed `TaskResult.rawOutputPath` points at the directory when one was written. A successful execution never writes anything here.

### What lives under `.dispatcher/`

Running `ai-dispatcher` against a project creates a `.dispatcher/` directory inside it: `history.sqlite` (above), `runs/<executionId>/` (failure artifacts, above), and `project/memory.json` (see [Project memory](#project-memory) below). None of this is meant to be committed — add `.dispatcher/` to that project's `.gitignore` (this repository's own `.gitignore` already does this for the dispatcher's own self-tests and dogfooding runs, but a *project you point the dispatcher at* needs its own entry).

### Project memory

`project/memory.ts` stores short decision/summary snippets (never full source) in `.dispatcher/project/memory.json`, ranked by recency + keyword overlap against the current task (no embeddings — see Known Limitations) and surfaced to providers via the context builder. **In v1.0, nothing in the dispatch pipeline calls `remember()` yet** — the read path (`relevantTo()`) is wired into every task's context, but nothing automatically writes a memory entry after a task completes. The class is usable programmatically (see its tests), but out of the box the memory file stays empty unless something external populates it. This is an honest gap, not a hidden one — closing it means deciding *what* about a completed task is worth remembering, which wasn't settled during v1.0 implementation.

## Config

`.ai-dispatcher.yml` (or `.ai-dispatcher.yaml` — `.yml` wins if both exist) in the project root, all fields optional (see `src/config/schema.ts` for the full shape and defaults):

```yaml
execution:
  timeoutMs: 300000
  sandbox: workspace-write      # read-only | workspace-write | danger-full-access
  approval: never                # untrusted | on-request | never (Codex's -a flag)
retry:
  maxRetries: 1
circuitBreaker:
  failureThreshold: 4
  sampleSize: 5
  cooldownMs: 600000
validation:
  maxFixAttempts: 2
review:
  maxReviewCycles: 2
  preferIndependentReviewer: true
safety:
  protectedPaths: [.env, secrets/, production.yml]
```

**Security-relevant defaults, explained, not just declared**: `execution.approval: never` means Codex is run with `-a never` (never prompts for approval) because nothing is present to answer a prompt in non-interactive automation — `on-failure` is deprecated by Codex itself, and `untrusted`/`on-request` would hang waiting for input that will never come. `execution.sandbox: workspace-write` (not `danger-full-access`) is the narrowest mode that still lets an implementer edit files. Both are deliberately chosen, not silently defaulted — override them in config if your threat model needs something stricter (e.g. `read-only` for a pure-analysis deployment).

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
node dist/cli.js doctor
```

## Known Limitations

- **Circuit breaker state is per-process, in-memory only.** Each CLI invocation is short-lived, so a circuit opened in one invocation is not visible to the next. Cross-invocation persistence (e.g. via the SQLite history) is out of scope for v1.0.
- **Project memory has no embeddings/vector search, and nothing writes to it yet.** Relevance ranking is recency + keyword overlap only, and the read path is fully wired into every task's context — but no automatic `remember()` call exists in the dispatch pipeline in v1.0, so the memory file stays empty unless populated externally. See [Project memory](#project-memory) above.
- **The application log (`logging/logger.ts`, pino) is minimally wired.** `--debug` correctly raises its level and `cli/commands/dispatch.ts` emits two lifecycle events (task built, orchestrator outcome), but most of the pipeline (routing, validation, review, retry/fallback) does not yet log through it — the audit trail (SQLite) and failure artifacts are the actually-complete structured records right now, not this log.
- **Codex's success-path JSONL event shape is not fully verified against live output.** During implementation, the configured OpenAI/ChatGPT account hit its usage limit before a successful `codex exec --json` run could be captured (see `docs/fixtures/raw-probes/codex-stderr.log`). The error-path events (`thread.started`, `turn.started`, `error`, `turn.failed`) *were* verified live and are strictly validated; the final response text is instead read from Codex's `--output-last-message` file (a separate, independently-documented flag) rather than parsed from a guessed success-path JSONL shape, so this doesn't block correct operation — but the zod schema for other success-path event types is intentionally loose (passthrough) pending a real captured sample.
- **CLI command-layer files (`cli/commands/*.ts`, `cli/bootstrap.ts`) have no automated test coverage**, though every command was manually verified end-to-end against the real installed CLIs during implementation (`doctor`, `providers`, `--dry-run` routing, a real `ask` dispatch, `history`, `usage` were all run and their output inspected). Formal vitest coverage for this thin wiring layer was deprioritized under time constraints in favor of the core engine (routing, validation, review, security). See the final implementation report for exact coverage numbers per module.
- **`node:sqlite` is Node's "Experimental" API tier** (not yet stable). All access is isolated behind `history/db.ts` + `history/repository.ts`, so swapping to `better-sqlite3` later (e.g. if a target environment has no admin rights and no prebuilt binary available, mirroring the exact constraint this implementation hit) is a two-file change.
- **No coverage threshold gate in CI/`pnpm test:coverage`.** This is deliberate: a hard-failing threshold creates an incentive to weaken assertions or skip tests to hit a number, which is explicitly the wrong tradeoff here. Real per-module percentages are reported instead.
- **`ProviderHealth.reachable` is not an independent network probe.** `doctor`'s output has separate `installed`/`authenticated`/`reachable`/`ready` fields (so a restricted-network deployment can in principle distinguish "CLI present, never logged in" from "logged in, but currently unreachable"), but in the current health-check implementations `reachable` is simply derived from `authenticated` (`true` if authenticated, `null` otherwise) rather than from a real independent connectivity check — no unnecessary external ping is made, but the field doesn't yet carry more signal than `authenticated` does.
