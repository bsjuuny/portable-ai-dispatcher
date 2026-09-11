# AI Dispatcher 폐쇄망 USB Kit — 준비부터 사용까지

이 문서는 두 파트로 나뉩니다.

- **1부**: 인터넷이 되는 컴퓨터(이 저장소가 있는 개발 PC)에서 USB kit을 준비/갱신하는 방법
- **2부**: 인터넷이 안 되는 폐쇄망 컴퓨터에서 그 USB kit을 사용하는 방법

2부는 USB kit 안에도 `사용방법.txt`로 그대로 들어있어서 폐쇄망 컴퓨터에서 오프라인으로 볼 수 있습니다. 이 문서는 1부까지 포함한 전체 그림을 보기 위한 것입니다.

---

## 1부. 인터넷 되는 컴퓨터에서 준비하기

### 1-1. 필요한 자산 한눈에

USB kit 하나에는 아래 5가지가 들어갑니다. `ai-dispatcher` 소스 자체(`src/`)는 자동으로 빌드되지만, 나머지 4가지(런타임 바이너리, 모델, git, 템플릿)는 **의도적으로 git에 커밋하지 않고** 매번 수동으로 준비합니다(용량이 크고, 실행 파일을 저장소에 넣지 않기 위해서입니다).

| 자산 | 용도 | 용량 | 출처 |
|---|---|---|---|
| Node.js (`runtime/node/node.exe`) | ai-dispatcher 자체 실행 | ~100MB | 현재 실행 중인 node.exe를 그대로 복사 |
| llama.cpp (`runtime/llamacpp/`) | 로컬 모델 서버 | ~50MB | [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) — Windows CPU 빌드 |
| git (`runtime/git/`) | 작업 격리(worktree)에 필수, 예외 없음 | ~90MB | [Git for Windows MinGit](https://github.com/git-for-windows/git/releases) — `MinGit-*-64-bit.zip` |
| VC++ 재배포 (`runtime/vcredist/vc_redist.x64.exe`) | llama.cpp 실행에 필요 | ~25MB | [Microsoft 공식](https://aka.ms/vs/17/release/vc_redist.x64.exe) |
| 모델 (`models/cpu-standard/`, `models/cpu-plus/`) | 실제 코드 생성 | 4.4GB / 8.4GB | [Qwen2.5-Coder-GGUF](https://huggingface.co/Qwen) |
| Next.js 템플릿 (`templates/nextjs-starter/`) | 새 프로젝트 즉시 시작용(선택) | ~460MB | 이 컴퓨터에서 `create-next-app`으로 직접 생성 |

### 1-2. 처음부터 준비하는 순서

```powershell
# 0. 저장소 루트에서 빌드
cd C:\github\ai-dispatcher
pnpm build

# 1. kit 뼈대 생성 (자산 없이 - 이 시점엔 placeholder 안내 파일만 들어있음)
node dist/cli.js portable assemble C:\경로\portable-ai-dispatcher --without-assets
```

이후 아래를 하나씩 그 폴더 안에 채웁니다.

**Node.js** — `bin\install-node.cmd`가 현재 node.exe를 복사해주거나, 그냥 직접:
```
copy "$(where node)" C:\경로\portable-ai-dispatcher\runtime\node\node.exe
```

**llama.cpp** — [릴리스 페이지](https://github.com/ggml-org/llama.cpp/releases)에서 Windows x64 CPU 빌드(`llama-*-bin-win-cpu-x64.zip` 계열)를 받아 `runtime\llamacpp\`에 압축 해제. `runtime-manifest.json`도 같은 폴더에 있어야 preflight가 인식합니다(`{"schemaVersion":"1","runtimeId":"...","acceleration":"cpu","os":"windows","arch":"x64","executable":"llama-server.exe","version":"...","sha256":"..."}`).

**git** — 반드시 **MinGit "cmd" 버전**(GUI/문서 없는 최소 버전)을 받아서, 압축을 풀었을 때 `runtime\git\cmd\git.exe`가 존재하도록 배치:
```powershell
Invoke-WebRequest "https://github.com/git-for-windows/git/releases/download/vX.X.X.windows.X/MinGit-X.X.X.X-64-bit.zip" -OutFile mingit.zip
Expand-Archive mingit.zip -DestinationPath C:\경로\portable-ai-dispatcher\runtime\git
```
다운로드 후 릴리스 페이지에 같이 공개된 SHA-256과 대조해서 검증하는 걸 권장합니다.

**VC++ 재배포** — 공식 링크에서 받아 `runtime\vcredist\vc_redist.x64.exe`로 저장.

**모델** — Qwen2.5-Coder-7B-Instruct-Q4_K_M(16GB PC용)와 14B(32GB PC용) GGUF를 받아 각각 `models\cpu-standard\`, `models\cpu-plus\`에 배치하고, 폴더마다 `model-pack.json`을 같이 둡니다(원본 주소·해시 기록용 — 형식은 기존 kit의 파일을 참고).

**Next.js 템플릿(선택, 강력 권장)** — 로컬 모델이 "빈 프로젝트에서 앱 통째로 만들기"를 잘 못 하기 때문에(실측 확인됨), 이미 동작하는 뼈대를 미리 만들어 둡니다:
```powershell
cd C:\경로\portable-ai-dispatcher\templates
npx create-next-app@latest nextjs-starter --typescript --eslint --tailwind --app --no-src-dir --import-alias "@/*" --use-npm --yes
```
`node_modules`까지 그대로 남겨두면 됩니다(`.gitignore`가 이미 알아서 git 추적에서만 제외하고, 폴더 자체는 그대로 있어서 오프라인 `npm run build`가 즉시 됩니다). `.next` 빌드 캐시 폴더만 지워주세요.

### 1-3. 이미 있는 kit을 갱신할 때 (가장 흔한 경우)

전체를 다시 만들 필요 없이, 바뀐 부분만 새로 만들어서 덮어씁니다.

```powershell
cd C:\github\ai-dispatcher
pnpm build
node dist/cli.js portable assemble C:\임시\새kit --without-assets
```
그다음 `C:\임시\새kit\app\dist` 폴더와, 바뀐 `bin\*.cmd`/`bin\*.ps1`/`config\.ai-dispatcher.yml`/`README.txt`/`사용방법.txt`만 골라서 실제 USB kit 위에 덮어씁니다. `runtime\`, `models\`, `templates\`는 안 바뀌었으면 그대로 둡니다(용량이 크므로 불필요한 재복사를 피하세요).

### 1-4. 마지막 체크

```
node dist/cli.js doctor
```
를 그 kit의 `config\.ai-dispatcher.yml`을 가리키게 해서(`$env:AI_DISPATCHER_CONFIG_PATH = "C:\경로\portable-ai-dispatcher\config\.ai-dispatcher.yml"`) 실행해보고, `Git: available`, 로컬 런타임 `reachable=true` 등이 정상으로 뜨는지 확인한 뒤 USB로 옮깁니다.

---

## 2부. 폐쇄망 컴퓨터에서 사용하기

USB의 `사용방법.txt`와 동일합니다. 순서대로:

1. **`bin\preflight.cmd`** 실행 → `Overall: READY` 확인. `Git: available`도 같이 확인.
2. **`bin\start-cpu16.cmd`** 또는 **`bin\start-cpu32.cmd`** 실행 → 두 런처 모두 preflight가 만든 같은 launch plan을 사용합니다. 로딩 로그가 끝까지 나올 때까지 창을 유지하세요.
3. **새 프로젝트는 템플릿으로 시작**: `bin\new-nextjs-project.cmd C:\작업할\새\폴더` — 인터넷 없이 즉시 완성된 뼈대가 생깁니다. 기존 프로젝트를 쓸 거면 그 폴더에서 `git init` 후 커밋 1개만 만들어두면 됩니다.
4. **작업 요청**: `bin\ai-dispatcher.cmd implement "요청 내용" --cwd "그 폴더"`. 검증과 구현 모델과 실제로 분리된 reviewer의 리뷰까지 통과해야 자동 반영됩니다. 자가 리뷰만 가능하면 `BLOCKED_BY_POLICY`로 보류됩니다.
5. **(선택) 전역 명령 등록**: `bin\install-command.cmd` 한 번 실행하면 이후 어느 폴더에서든 `ai-dispatcher`, `git` 명령을 USB 경로 안 적고 바로 쓸 수 있습니다.

### 3. 문제 해결 (이번에 실제로 겪었던 것들)

| 증상 | 원인 | 해결 |
|---|---|---|
| `start-cpu*.cmd` 실행 시 로그 하나 없이 바로 프롬프트로 돌아옴 | Visual C++ 재배포 패키지 미설치 (exit code 0xC0000135, DLL 못 찾음) | `bin\install-vcredist.cmd` 실행 → 관리자 승인 → 재시도 |
| PowerShell에서 `git`이 "인식할 수 없는 용어" | 그 PC에 시스템 git이 없고, PATH에도 아직 안 잡힘 | `bin\install-command.cmd` 한 번 실행 후 **새** 창을 열거나, 그 창에서만 임시로 `$env:PATH = "X:\portable-ai-dispatcher\runtime\git\cmd;$env:PATH"` |
| `git init` 직후 `ambiguous argument 'HEAD'` | 커밋이 하나도 없는 상태에서 workspace 격리가 HEAD를 찾음 | 그 폴더에서 `git add -A && git commit -m init --allow-empty` |
| `Error [NO_AVAILABLE_PROVIDER] ... fetch failed` | 모델 서버가 아직 로딩 중이거나 꺼져 있음 | `curl http://127.0.0.1:8080/health`로 `{"status":"ok"}` 뜨는지 먼저 확인 후 재시도 |
| `FAILED_PROVIDER`, "실행 기록 없음" | 진짜 에러 메시지가 200자 넘으면 기본적으로 잘려서 안 보임 | 프로젝트의 `.ai-dispatcher.yml`에 `diagnostics: { logPrompts: true }` 추가 후 재시도하면 실제 원인이 보임 |
| "빈 프로젝트에 앱 통째로 만들어줘" 같은 요청이 계속 실패/시간초과 | 로컬 CPU 모델이 처음부터 큰 스캐폴딩을 스스로 계획하는 데 근본적인 한계가 있음(턴 예산을 늘려도 안 풀림, 실측 확인) | `bin\new-nextjs-project.cmd`로 뼈대를 먼저 만들고, 그 위에 "이 페이지에 OO 기능 추가해줘" 식으로 좁게 요청 |
| 요청이 몇 분씩 걸림 | CPU로 14B 모델을 돌리는 거라 원래 클라우드 AI보다 훨씬 느림 | 정상입니다. 30초마다 "...still waiting..." 표시가 나오면 진행 중인 것 |

---

## 참고: 이 kit의 설계상 특징

- **auto-apply + 독립 리뷰 필수**: 자가 리뷰 변경은 자동 반영하지 않습니다. 무인 반영이 필요하면 구현 모델과 별도인 reviewer provider를 구성하세요. 위험도가 높거나 검증/리뷰에서 걸린 변경도 반영되지 않습니다.
- **git은 항상 필요**: 시스템에 git이 있으면 그걸 자동으로 우선 사용하고, 없으면(폐쇄망 기본 상황) USB의 번들 git을 씁니다 — 코드를 다시 설정할 필요가 없습니다.
- **CPU 스레드/컨텍스트/캐시 설정은 이 프로젝트에서 실측 검증된 값**입니다(물리 코어 수 자동 감지, KV 캐시 양자화, 16384 컨텍스트). 다른 하드웨어에서도 `AI_DISPATCHER_CPU_THREADS` 환경변수로 수동 조정 가능합니다.
