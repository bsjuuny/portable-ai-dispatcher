# macOS ARM64 Portable Kit 가이드

`macos-arm64` 대상은 Apple Silicon M1 이상을 위한 완전 오프라인 키트입니다. Windows 실행 파일이나 Windows에서 설치한 네이티브 `node_modules`를 재사용하지 않습니다.

외장 드라이브는 APFS를 권장합니다. exFAT은 Windows와 교차 사용해야 할 때만 선택하세요. exFAT은 POSIX 권한, symlink, macOS 확장 속성을 안정적으로 보존하지 못하므로 대상 Mac에서 `prepare-macos`를 실행한 뒤 다시 seal해야 합니다.

## 키트 생성

```bash
pnpm build
node dist/cli.js portable assemble /Volumes/USB/portable-ai-dispatcher \
  --target macos-arm64 \
  --without-assets
```

자산을 자동으로 포함하려면 소스 저장소에 다음 구조를 먼저 준비한 후 `--without-assets`를 제거합니다.

```text
runtime/macos-arm64/
├─ node/bin/node
├─ git/bin/git
└─ llamacpp/
   ├─ bin/llama-server
   ├─ lib/*.dylib
   └─ runtime-manifest.json

templates/macos-arm64/
└─ nextjs-starter/
   ├─ package.json
   └─ node_modules/
```

`runtime-manifest.example.json`을 `runtime-manifest.json`으로 복사하고 실제 버전과 `llama-server` SHA-256을 기록합니다. 모델은 Windows 키트와 동일한 GGUF 팩을 사용할 수 있지만, 템플릿의 `node_modules`는 macOS ARM64에서 별도로 설치해야 합니다.

## 첫 실행

```bash
cd /Volumes/USB/portable-ai-dispatcher
bash bin/prepare-macos
bin/ai-dispatcher portable seal .
bin/preflight
bin/start-local
```

다른 터미널에서 실행합니다.

```bash
bin/ai-dispatcher implement "기능을 추가해줘" --cwd "/path/to/project"
```

대상 프로젝트는 최초 커밋이 존재하는 Git 저장소여야 합니다. Dispatcher는 키트에 포함된 Git을 우선 사용합니다.

포터블 기본 설정은 `safety.autoApply.requireIndependentReview: true`입니다. 구현 모델과 실제로 분리된 reviewer provider가 없으면 자가 리뷰 결과는 기록되지만 변경은 `BLOCKED_BY_POLICY`로 보류됩니다. 이는 하나의 모델이 자신의 변경을 승인해 무인 반영하는 경로를 막는 정책입니다.

## 자산 조건

- Node.js 22+ macOS ARM64 전체 배포본
- helper와 동적 라이브러리를 포함한 relocatable Git
- Metal 지원 macOS ARM64 `llama.cpp`
- 라이선스·출처·SHA-256을 기록한 GGUF 모델 팩
- 선택 사항: macOS ARM64에서 의존성을 설치한 Next.js 템플릿

`llama.cpp` manifest는 `acceleration: metal`, `os: darwin`, `arch: arm64`, `executable: bin/llama-server`를 사용합니다. `start-local`은 preflight가 선택한 모델 경로·컨텍스트·스레드·GPU layer를 그대로 사용하고 모델 ID를 서버 alias로 지정합니다. 따라서 `/v1/models` 결과와 설정된 프로필 모델이 일치하지 않으면 해당 프로필은 준비 완료로 처리되지 않습니다.

`llama-server`와 포함된 `.dylib`는 외장 드라이브의 마운트 경로가 바뀌어도 로딩되도록 `@loader_path` 또는 `@rpath` 기반으로 빌드해야 합니다. `preflight`는 `llama-server --version`을 실제 실행해 누락된 동적 라이브러리를 탐지합니다.

## 배포 보안

자신의 Mac에서 직접 만든 내부 테스트 키트와 다른 사용자에게 배포할 제품은 구분해야 합니다. 외부 배포 전에는 다음을 수행합니다.

1. 모든 Mach-O 실행 파일과 포함된 동적 라이브러리를 Developer ID로 서명합니다.
2. Hardened Runtime과 secure timestamp를 적용합니다.
3. 최종 ZIP, PKG 또는 DMG를 `notarytool`로 공증합니다.
4. 공증된 최종 산출물을 실제 오프라인 Apple Silicon Mac에서 검증합니다.

키트의 `preflight`는 운영체제·아키텍처·실행 권한·Git 실행 여부·Gatekeeper quarantine 표시·런타임/모델 manifest와 `kit-lock.json` 무결성을 검사합니다. 자산을 변경한 뒤에는 내용을 검토하고 `portable seal`을 다시 실행해야 합니다. 무결성 잠금은 손상 탐지용이며 Developer ID 서명과 Apple 공증을 대신하지는 않습니다.
