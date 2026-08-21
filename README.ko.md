[English](README.md) | 한국어

# AI Dispatcher v1.0

Claude Code와 Codex 사이에서 코딩 작업을 라우팅하고, 실제 build/test/lint로 결과를 검증하고, 구현하지 않은 *다른* AI가 독립적으로 리뷰한 뒤에야 성공을 선언하는 CLI — AI Development Control Plane입니다.

`claude`나 `codex`를 그냥 실행해주는 래퍼가 아닙니다. 작업을 분류하고, 실제 health/usage/capability 데이터로 두 provider의 점수를 매기고, retry/fallback/circuit-breaking을 곁들여 디스패치하고, 실제 검증 파이프라인을 돌리고(실패 시 횟수 제한이 있는 자동 fix loop 포함), diff를 독립 리뷰어에게 보내고, 이 모든 과정을 구조화된 audit 로그와 로컬 SQLite history에 기록합니다 — 그래서 "AI가 됐다고 말한 것"과 "시스템이 실제로 검증한 것"이 절대 같은 주장이 되지 않습니다.

## 아키텍처

```
src/
├─ models/        도메인 타입 + DispatcherError (모든 레이어가 공유)
├─ core/           state machine, Orchestrator(runTask() 파이프라인), 실행 연결부
├─ task/           Task Specification 파싱, 입력 리졸버, classifier
├─ providers/      AIProvider 인터페이스 + ProviderRegistry; claude/, codex/ 어댑터
├─ routing/        usage 추적, 스코어링, provider 선택, retry/fallback/circuit-breaker
├─ project/        프로젝트 분석기, memory(JSON), 로그 윈도잉, context builder
├─ validation/     git-diff, build/test/lint/typecheck 러너, 파이프라인, fix loop
├─ review/         리뷰 코디네이터(리뷰어에게 프롬프트, verdict 파싱), 충돌 해소기
├─ process/        유일한 execa 호출 지점 (process-runner.ts)
├─ logging/        pino 로거, 시크릿 마스킹, audit 이벤트 로그
├─ history/        node:sqlite 기반 task/execution/audit history
├─ config/         `.ai-dispatcher.yml`용 zod 스키마 + YAML 로더
└─ cli/            위 모든 걸 연결하는 commander 기반 CLI
```

**핵심 아키텍처 불변식**: `core/`, `routing/`, `task/classifier.ts`, `validation/`, `review/`는 `ClaudeProvider`/`CodexProvider`를 이름으로 import하거나 provider id 문자열로 분기하지 않습니다. provider 관련 동작은 전부 `ProviderRegistry`를 거친 `AIProvider` 인터페이스로만 접근합니다. 두 구체 클래스를 모두 import하는 곳은 `providers/index.ts`(합성 루트)와 테스트뿐입니다. `tests/unit/orchestrator.test.ts`는 오케스트레이터가 한 번도 본 적 없는 provider id(`"totally-unknown-provider"`)로도 실제 라우팅·실행이 성공하는 걸로 이걸 증명합니다.

## 설치

```bash
pnpm install
pnpm build
```

Node.js 22+ 필요. [`claude`](https://claude.com/product/claude-code)와/또는 [`codex`](https://github.com/openai/codex) CLI가 별도로 설치·인증되어 있어야 합니다 — 아래 참고.

### CLI 실행하기

`pnpm build`는 `dist/cli.js`를 만들 뿐, `ai-dispatcher`라는 명령을 자동으로 PATH에 등록하지 **않습니다**. 둘 중 하나를 선택하세요:

```bash
# 별도 설정 없이 항상 되는 방법 - 직접 실행:
node dist/cli.js doctor
```

또는 `ai-dispatcher`를 PATH에 등록된 실제 명령으로 만들 수 있습니다:

```bash
pnpm link --global .   # 이 프로젝트 디렉터리에서 - 끝의 `.`을 빼먹지 마세요
ai-dispatcher doctor   # 이제 새 셸이면 어디서든 동작합니다
```

이 머신에서 pnpm 전역 링크를 처음 쓰는 경우 겪을 수 있는 두 가지 문제(둘 다 Windows에서 실제로 라이브로 확인했고, 겪는 순서도 이대로입니다):

1. **`The configured global bin directory "..." is not in PATH`** — `pnpm setup`을 한 번 실행한 뒤 **완전히 새로운 터미널 창**을 여세요(이미 열려 있던 터미널의 새 탭이 아니고, 도구가 재시작한 셸도 아닙니다 — `pnpm setup`의 환경변수 변경은 Windows 레지스트리에 기록되고, 그 이후에 새로 실행되는 프로세스만 이걸 읽습니다).
2. **`Aborted removal of modules directory due to no TTY`** — `pnpm link --global`은 전역 링크에 맞는 구조로 `node_modules`를 재설치해야 하는데, 이때 pnpm이 대화형 확인을 요구합니다. `CI=true pnpm link --global .`을 한 번 실행해서 비대화형으로 답하세요(안전합니다 — lockfile에 고정된 동일한 의존성을 재설치할 뿐, 다운그레이드되거나 바뀌는 건 없습니다). 이후 `--global` 없이 실행한 `pnpm build`/`pnpm test`에서도 같은 "no TTY" 에러가 또 나오면, 그 재설치가 pnpm의 의존성-드리프트 검사가 싫어하는 상태로 `node_modules`를 남긴 겁니다 — `CI=true pnpm install`을 한 번 깨끗하게 돌리면 정리되고, 이후엔 `CI=true` 없이도 평소처럼 됩니다.

이 문서의 나머지 부분에서는 `ai-dispatcher <command>`를 둘 중 어느 쪽을 쓰든 상관없는 축약형으로 사용합니다 — 전역 링크를 안 하셨다면 `node dist/cli.js`로 바꿔 읽으세요. 전역 링크를 해제하려면: `pnpm unlink --global`(이 프로젝트 디렉터리에서 실행).

## Provider 인증

**Dispatcher는 Credential Manager가 아닙니다.** API 키, OAuth 토큰, 세션 쿠키를 읽거나 저장하거나 건드리는 일이 절대 없습니다. 공식 CLI 자신의 상태 확인 명령(`claude auth status`, `codex login status`)을 실행해서 *당신이* 이미 로그인되어 있는지만 확인합니다.

```bash
claude auth login
codex login
```

provider가 인증되어 있지 않으면 `ai-dispatcher doctor`가 정확히 그렇게 알려주고 멈춥니다 — 로그인 흐름을 자동화하려는 시도는 절대 하지 않습니다.

## CLI 명령어

```bash
ai-dispatcher ask <task-spec>          # 분석/질의응답, 검증·리뷰 없음
ai-dispatcher analyze <task-spec>
ai-dispatcher review <task-spec>
ai-dispatcher fix <task-spec>          # 코드 변경: 검증 + fix loop + 리뷰까지 수행
ai-dispatcher implement <task-spec>    # 코드 변경: 위와 동일

ai-dispatcher doctor [--json]          # 두 provider 헬스체크
ai-dispatcher providers [--json]       # capability 목록
ai-dispatcher usage [provider] [--json]# 1h/24h/7d/all 요청·비용 통계
ai-dispatcher history [--limit N]      # 최근 작업 목록
ai-dispatcher inspect <taskId>         # 작업 하나의 전체 상세
ai-dispatcher explain <taskId>         # 왜 이 provider가 선택됐는지, 점수 내역과 함께
```

디스패치 명령은 모두 다음을 지원합니다:

| 플래그 | 의미 |
|---|---|
| `--file <path>` | 파일에서 task specification 읽기 |
| `--stdin` | stdin에서 task specification 읽기 |
| `--path <paths...>` | context로 포함할 관련 파일/디렉터리 경로 |
| `--cwd <path>` | 작업 디렉터리 (기본값: 현재 디렉터리) |
| `--timeout <ms>` | 실행 타임아웃 |
| `--provider <id>` | 라우팅 대신 `claude` 또는 `codex`를 강제 지정 |
| `--dry-run` | 라우팅 결정과 생성될 명령만 출력, 실행은 안 함 |
| `--json` | 기계 판독용 출력 |
| `--debug` | 애플리케이션 로그를 debug 레벨로 (stdout에 NDJSON) |

### Task Specification 작성법

작업 설명은 한 줄짜리 프롬프트가 아니라, 온전한 인시던트 리포트여도 됩니다. 아래 전부 정상 동작합니다:

```bash
# 짧게
ai-dispatcher fix "로그인 오류를 수정해줘"

# 여러 줄, 오류 코드와 스택 트레이스 포함
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

# 파일에서
ai-dispatcher fix --file bug-report.md

# stdin에서
cat bug-report.md | ai-dispatcher fix

# 조합: 설명 + 첨부 로그 + 관련 경로
ai-dispatcher fix --file error.log --path src/main/java/com/example \
  "이 오류의 근본 원인을 분석하고 회귀 테스트까지 작성해줘"
```

원문 텍스트는 classifier가 추출한 것(오류 코드, 스택 트레이스, 번호 붙은 재현 절차, 불릿 요구사항/제약사항)과 별개로 **항상 그대로 보존**됩니다 — 분류가 잘못되더라도 provider가 활용할 수 있었던 정보를 잃는 일은 없습니다.

대용량 첨부(스택 트레이스, 빌드 로그)는 절대 통째로 전송되지 않습니다. `project/log-windowing.ts`가 에러 키워드/스택 트레이스/실패한 테스트의 앵커 라인을 찾아 그 주변에 context window를 만들고, 가까운 window끼리 병합하고, 중복 블록을 제거하고, 아무것도 못 찾으면 head+tail 윈도잉으로 폴백합니다 — 자세한 내용은 `docs/architecture.md` 참고.

### 셸 안전성

사용자가 입력한 모든 텍스트 — task description, 파일 경로, 로그 내용 — 는 provider에게 `stdin`으로 전달되며, 셸 명령 문자열로 이어붙여지는 일이 절대 없습니다. `process/process-runner.ts`가 프로세스를 스폰할 수 있는 *유일한* 파일이고(ESLint 규칙과, 빌드 결과물에서 위험한 패턴을 grep하는 `tests/security/dist-static-scan.test.ts`로 강제됨), `shell: false`를 명시해서 `execa`를 호출합니다. 이걸 검증하는 전체 페이로드는 `tests/security/shell-injection.test.ts`를 참고하세요 — OS argv 길이 제한에 기대지 않는다는 걸 증명하는 100KB 초과 페이로드도 포함되어 있습니다.

## 라우팅

Provider 선택은 역할 고정이 아니라 가중치 스코어입니다:

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

`ai-dispatcher explain <taskId>`는 그 결정을 만든 정확한 점수 내역을 출력합니다 — 라우팅 로그에서 보게 될 것과 같은 형식으로, 모든 구성요소와 모든 provider에 대해.

## 검증과 fix loop

`fix`/`implement` 작업은 실행 후: `git diff`(protected path 변경 여부 확인) → typecheck → lint → build → test 순서로 진행하며, 첫 실패에서 멈춥니다. 실패하면 실패한 단계의 출력이 후속 작업에 첨부되어 *같은* 구현자에게 다시 보내지고, 검증이 재실행됩니다 — `validation.maxFixAttempts`(기본 2)로 횟수가 제한되며, 절대 무한 반복하지 않습니다.

명령어는 프로젝트에서 자동 감지되지만(`package.json` scripts + lockfile → pnpm/yarn/npm; `pom.xml` → Maven; `build.gradle(.kts)` → Gradle; `pyproject.toml` → pytest/ruff), 명시적인 `.ai-dispatcher.yml`이 항상 우선합니다:

```yaml
validation:
  commands:
    test: [pnpm, run, test]
  maxFixAttempts: 2
```

## 리뷰

검증을 통과하면 diff가 독립 리뷰어에게 전달됩니다 — 기본값은 이번 변경을 구현하지 *않은* provider입니다. 리뷰어에게는 정확성, 요구사항 준수, 회귀, 보안, 동시성, null 처리, 오류 처리, 리소스 누수, 성능, 유지보수성, 테스트 커버리지, 무관한 변경, 아키텍처 일관성을 확인하고 fenced JSON verdict로 답하도록 요청합니다. `request_changes`/`critical` 판정이 나오면 fix→재검증→재리뷰 사이클이 한 번 더 도는데, `review.maxReviewCycles`(기본 2)로 제한됩니다.

`Ready`(installed + authenticated + reachable) 상태인 provider가 하나뿐이면, 막혀서 멈추는 대신 스스로 리뷰합니다 — 다만 결과와 history에 `independentReview: false`가 기록되며, 독립 검수인 것처럼 조용히 위장하지 않습니다.

리뷰어의 말과 검증 결과가 어긋날 때는 다수결이 아니라 증거로 판단합니다(어차피 한 사이클에 활성 리뷰어는 항상 하나뿐이기도 합니다): `review/conflict-resolver.ts`가 최신 `ValidationResult`를 확인해서 계속 남아있는 finding을 경고로 받아들일지 사용자에게 에스컬레이션할지 결정합니다.

## Audit와 History

모든 작업은 `taskId`를 받고, 모든 실행 시도(retry·fallback 포함)는 각자 `executionId`를 받으며, 전부 같은 task에 연결됩니다. 구조화된 audit 이벤트(`task.created`, `provider.selected`, `retry.started`, `validation.failed`, `review.completed` 등)는 `ai-dispatcher`를 실행한 프로젝트 안의 `.dispatcher/history.sqlite`라는 로컬 SQLite 데이터베이스에 추가만 됩니다(다시 쓰이지 않음).

**기본적으로 prompt와 response 텍스트는 절대 저장되지 않습니다** — SHA-256 해시와 길이만 저장됩니다. config에서 `diagnostics.logPrompts: true`로 설정하면 원문 저장을 선택할 수 있는데, 그때도 먼저 시크릿 마스킹을 거칩니다(AWS/OpenAI/Anthropic/GitHub 토큰 형태 문자열, JWT, PEM 블록, `.env` 형태의 시크릿 라인이 `[REDACTED]`로 치환됩니다).

`ai-dispatcher history [--limit N]`은 최근 작업 목록을 보여주고, `ai-dispatcher inspect <taskId>`는 작업 하나와 그에 대한 모든 실행 시도(provider, 타이밍, 토큰/비용 사용량)를 보여주며, `ai-dispatcher explain <taskId>`는 어떤 provider가 왜 선택됐는지 점수 내역을 보여줍니다(위 [라우팅](#라우팅) 참고).

### Failure Artifact

실행 시도가 실패하거나, 타임아웃되거나, 프로세스/파싱 레이어에서 아예 에러가 나면, 전체 상세 정보가 프로젝트 디렉터리의 `.dispatcher/runs/<executionId>/`에 저장됩니다:

```
.dispatcher/runs/<executionId>/
├─ metadata.json   # provider, 명령어, 인자, cwd, exit code, 타이밍
├─ error.json      # DispatcherError(code, message) - 없었으면 생략
├─ stdout.log      # 원본 stdout, 시크릿 마스킹 적용
└─ stderr.log      # 원본 stderr, 시크릿 마스킹 적용
```

이 덕분에 아무것도 다시 실행하지 않고도 실패를 재진단할 수 있습니다: `ai-dispatcher inspect <taskId>`는 실행이 실패했다는 *사실*을 알려주고, 아티팩트 디렉터리는 `diagnostics.logPrompts: true` 없이도 바이트 단위로 *왜* 실패했는지 알려줍니다. task prompt 자체(`stdinContent`)는 audit 로그와 동일한 기본 정책에 따라 여기에도 절대 저장되지 않습니다. `diagnostics.saveFailureArtifacts`(기본 `true`)로 제어되며, 실패한 `TaskResult.rawOutputPath`가 아티팩트를 저장했을 때 그 디렉터리를 가리킵니다. 성공한 실행은 여기에 아무것도 남기지 않습니다.

### `.dispatcher/` 아래에 뭐가 있나

프로젝트를 대상으로 `ai-dispatcher`를 실행하면 그 안에 `.dispatcher/` 디렉터리가 생깁니다: `history.sqlite`(위), `runs/<executionId>/`(Failure Artifact, 위), `project/memory.json`(아래 [Project Memory](#project-memory) 참고). 이 중 커밋할 게 하나도 없습니다 — 그 프로젝트의 `.gitignore`에 `.dispatcher/`를 추가하세요(이 저장소 자신의 `.gitignore`는 dispatcher 자체의 셀프 테스트·도그푸딩용이고, *dispatcher를 적용하는 대상 프로젝트*는 자기 것을 따로 추가해야 합니다).

### Project Memory

`project/memory.ts`는 짧은 결정/요약 스니펫을(전체 소스코드는 절대 저장 안 함) `.dispatcher/project/memory.json`에 저장하고, 현재 작업과의 최신성 + 키워드 중복도로 순위를 매겨(임베딩 없음 — Known Limitations 참고) context builder를 통해 provider에게 전달합니다. **v1.0에서는 디스패치 파이프라인 어디에서도 아직 `remember()`를 호출하지 않습니다** — 읽기 경로(`relevantTo()`)는 모든 작업의 context에 연결돼 있지만, 작업이 끝난 뒤 자동으로 memory 항목을 쓰는 곳은 없습니다. 클래스 자체는 프로그래밍 방식으로 사용 가능하지만(테스트 참고), 기본 상태로는 외부에서 채워주지 않는 한 memory 파일이 비어 있습니다. 숨긴 게 아니라 정직하게 밝히는 갭입니다 — 이걸 메우려면 완료된 작업의 *무엇을* 기억할 가치가 있는지 결정해야 하는데, v1.0 구현 중엔 정하지 않았습니다.

## Config

프로젝트 루트의 `.ai-dispatcher.yml`(또는 `.ai-dispatcher.yaml` — 둘 다 있으면 `.yml`이 우선), 모든 필드는 선택사항입니다(전체 구조와 기본값은 `src/config/schema.ts` 참고):

```yaml
execution:
  timeoutMs: 300000
  sandbox: workspace-write      # read-only | workspace-write | danger-full-access
  approval: never                # untrusted | on-request | never (Codex의 -a 플래그)
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

**보안 관련 기본값 — 선언만 하지 않고 이유까지**: `execution.approval: never`는 Codex를 `-a never`로 실행한다는 뜻인데(승인을 절대 묻지 않음), 비대화형 자동화에는 프롬프트에 답할 대상이 없기 때문입니다 — `on-failure`는 Codex 자체에서 deprecated됐고, `untrusted`/`on-request`는 영영 오지 않을 입력을 기다리며 멈춰버립니다. `execution.sandbox: workspace-write`(`danger-full-access`가 아님)는 구현자가 파일을 편집할 수 있는 가장 좁은 모드입니다. 둘 다 조용히 기본값으로 정한 게 아니라 의도적으로 고른 값입니다 — threat model이 더 엄격해야 한다면 config에서 override하세요(순수 분석용 배포라면 `read-only` 등).

## 개발

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
node dist/cli.js doctor
```

## 알려진 한계

- **Circuit breaker 상태는 프로세스 내 메모리에만 있습니다.** CLI 실행 하나하나가 짧게 끝나기 때문에, 한 실행에서 열린 circuit이 다음 실행에는 보이지 않습니다. 실행 간 영속화(예: SQLite history 활용)는 v1.0 범위 밖입니다.
- **Project memory에는 임베딩/벡터 검색이 없고, 아직 아무도 쓰지 않습니다.** 관련성 순위는 최신성 + 키워드 중복도뿐이고, 읽기 경로는 모든 작업의 context에 완전히 연결돼 있지만 — v1.0 디스패치 파이프라인에 자동 `remember()` 호출이 없어서 외부에서 채우지 않는 한 memory 파일이 비어 있습니다. 위 [Project Memory](#project-memory) 참고.
- **애플리케이션 로그(`logging/logger.ts`, pino)는 최소한으로만 연결돼 있습니다.** `--debug`는 실제로 레벨을 올리고 `cli/commands/dispatch.ts`가 생애주기 이벤트 2개(task 생성, orchestrator 결과)를 남기지만, 파이프라인 대부분(라우팅, 검증, 리뷰, retry/fallback)은 아직 이 로그를 거치지 않습니다 — 지금 실제로 완전한 구조화 기록은 이 로그가 아니라 audit trail(SQLite)과 failure artifact입니다.
- **Codex의 성공 경로 JSONL 이벤트 형태는 실제 출력으로 완전히 검증되지 않았습니다.** 구현 도중 설정된 OpenAI/ChatGPT 계정이 사용량 한도에 걸려서 성공하는 `codex exec --json` 실행을 캡처하지 못했습니다(`docs/fixtures/raw-probes/codex-stderr.log` 참고). 실패 경로 이벤트(`thread.started`, `turn.started`, `error`, `turn.failed`)는 라이브로 검증됐고 엄격하게 검증(validate)합니다. 최종 응답 텍스트는 추측한 성공 경로 JSONL 형태를 파싱하는 대신 Codex의 `--output-last-message` 파일(별도로 문서화된 독립적인 플래그)에서 읽어오기 때문에 정상 동작을 막지는 않지만, 다른 성공 경로 이벤트 타입에 대한 zod 스키마는 실제로 캡처된 샘플이 생기기 전까지 의도적으로 느슨하게(passthrough) 열어뒀습니다.
- **CLI 명령 계층 파일(`cli/commands/*.ts`, `cli/bootstrap.ts`)에는 자동화된 테스트 커버리지가 없습니다.** 다만 구현 중 모든 명령을 실제 설치된 CLI로 end-to-end 라이브 검증했습니다(`doctor`, `providers`, `--dry-run` 라우팅, 실제 `ask` 디스패치, `history`, `usage`를 전부 실행하고 출력을 확인함). 이 얇은 배선 계층의 정식 vitest 커버리지는 시간 제약상 핵심 엔진(라우팅, 검증, 리뷰, 보안) 쪽을 우선하느라 뒤로 미뤘습니다. 모듈별 정확한 커버리지 수치는 최종 구현 보고서를 참고하세요.
- **`node:sqlite`는 Node의 "Experimental" API 등급입니다**(아직 안정 버전 아님). 모든 접근이 `history/db.ts` + `history/repository.ts` 뒤로 격리돼 있어서, 나중에 `better-sqlite3`로 바꾸는 것도(예: 대상 환경에 관리자 권한도 미리 빌드된 바이너리도 없는 경우 — 이 구현이 실제로 맞닥뜨린 바로 그 제약) 파일 2개만 바꾸면 됩니다.
- **CI/`pnpm test:coverage`에 커버리지 임계값 게이트가 없습니다.** 의도적인 선택입니다: 강제 실패하는 임계값은 숫자를 맞추려고 assertion을 약화시키거나 테스트를 건너뛰게 만드는 유인이 되는데, 여기선 명백히 잘못된 트레이드오프이기 때문입니다. 대신 모듈별 실제 퍼센티지를 그대로 보고합니다.
- **`ProviderHealth.reachable`은 독립적인 네트워크 프로브가 아닙니다.** `doctor` 출력에는 `installed`/`authenticated`/`reachable`/`ready`가 별도 필드로 있어서(원칙적으로는 폐쇄망 환경에서 "CLI는 있는데 로그인한 적이 없음"과 "로그인은 됐는데 지금 도달 불가"를 구분할 수 있게 하려는 의도), 지금 구현된 헬스체크에서는 `reachable`이 실제 독립적인 연결성 확인이 아니라 그냥 `authenticated`에서 파생된 값입니다(인증됐으면 `true`, 아니면 `null`) — 불필요한 외부 ping은 안 하지만, 이 필드가 아직 `authenticated`보다 더 많은 정보를 담고 있진 않습니다.
