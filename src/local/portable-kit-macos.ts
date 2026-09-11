import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sealPortableKit } from './kit-integrity.js';

export const PORTABLE_TARGETS = ['windows-x64', 'macos-arm64'] as const;
export type PortableTarget = typeof PORTABLE_TARGETS[number];

export interface PortableKitBuildResult {
  destination: string;
  target: PortableTarget;
  copiedAssets: { runtime: boolean; models: boolean };
  bundledDependencies: true;
  integrityLocked: true;
  copiedNodeRuntime: boolean;
  requiredBeforeUse: string[];
}

export function resolvePortableTarget(value?: string): PortableTarget {
  if (value) {
    if ((PORTABLE_TARGETS as readonly string[]).includes(value)) return value as PortableTarget;
    throw new Error(`Unsupported portable target '${value}'. Supported targets: ${PORTABLE_TARGETS.join(', ')}.`);
  }
  if (platform() === 'win32' && arch() === 'x64') return 'windows-x64';
  if (platform() === 'darwin' && arch() === 'arm64') return 'macos-arm64';
  throw new Error(`No default portable target exists for ${platform()}-${arch()}; pass --target explicitly.`);
}

export function assembleMacOSPortableKit(
  sourceRoot: string,
  destinationDirectory: string,
  includeAssets: boolean,
  portableConfig: string,
): PortableKitBuildResult {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationDirectory);
  const dist = join(source, 'dist');
  if (!existsSync(join(dist, 'cli.js'))) throw new Error('Portable assembly requires a built dist/cli.js. Run pnpm build first.');
  if (existsSync(destination)) throw new Error(`Portable destination already exists: ${destination}`);

  for (const directory of [
    join(destination, 'app'),
    join(destination, 'config'),
    join(destination, 'bin'),
    join(destination, 'runtime', 'node', 'bin'),
    join(destination, 'runtime', 'llamacpp', 'bin'),
    join(destination, 'runtime', 'llamacpp', 'lib'),
    join(destination, 'runtime', 'git', 'bin'),
    join(destination, 'models'),
    join(destination, 'templates'),
  ]) mkdirSync(directory, { recursive: true });

  cpSync(dist, join(destination, 'app', 'dist'), {
    recursive: true,
    errorOnExist: true,
    // A Windows build may contain the optional native process-tree fallback.
    // It is behind a win32-only branch and must not be distributed or notarized
    // as part of a Mac kit.
    filter: (sourcePath) => !/^windows_process_tree.*\.node$/i.test(basename(sourcePath)),
  });
  writeFileSync(join(destination, 'app', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(destination, 'config', '.ai-dispatcher.yml'), portableConfig, 'utf8');

  writeExecutable(join(destination, 'bin', 'ai-dispatcher'), MACOS_LAUNCHER);
  writeExecutable(join(destination, 'bin', 'preflight'), MACOS_PREFLIGHT);
  writeExecutable(join(destination, 'bin', 'prepare-macos'), MACOS_PREPARE);
  writeExecutable(join(destination, 'bin', 'start-local'), MACOS_START_LOCAL);
  writeExecutable(join(destination, 'bin', 'install-command'), MACOS_INSTALL_COMMAND);
  writeExecutable(join(destination, 'bin', 'uninstall-command'), MACOS_UNINSTALL_COMMAND);
  writeExecutable(join(destination, 'bin', 'new-nextjs-project'), MACOS_NEW_NEXTJS_PROJECT);

  writeFileSync(join(destination, 'README.txt'), MACOS_README, 'utf8');
  writeFileSync(join(destination, '사용방법.txt'), MACOS_KOREAN_GUIDE, 'utf8');
  writeFileSync(join(destination, 'kit-준비-가이드.txt'), MACOS_PREP_GUIDE, 'utf8');
  writeFileSync(join(destination, 'portable-kit.json'), `${JSON.stringify({
    schemaVersion: '1',
    kitFolderName: 'portable-ai-dispatcher',
    target: 'macos-arm64',
    os: 'darwin',
    arch: 'arm64',
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(destination, 'runtime', 'node', 'PUT_NODE_22_HERE.txt'), 'Place the complete macOS arm64 Node.js 22+ distribution here so runtime/node/bin/node exists. Do not copy a Node binary from another OS or architecture.\n', 'utf8');
  writeFileSync(join(destination, 'runtime', 'llamacpp', 'PUT_LLAMA_CPP_RUNTIME_HERE.txt'), 'Place a reviewed macOS arm64 Metal llama.cpp distribution here. runtime/llamacpp/bin/llama-server, its required dylibs under lib/, and runtime-manifest.json are required.\n', 'utf8');
  writeFileSync(join(destination, 'runtime', 'git', 'PUT_GIT_HERE.txt'), 'Place a relocatable macOS arm64 Git distribution here so runtime/git/bin/git exists. Include every dylib and helper used by that Git build; /usr/bin/git is not a sufficient offline dependency guarantee.\n', 'utf8');
  writeFileSync(join(destination, 'models', 'PUT_MODEL_PACKS_HERE.txt'), 'Place model pack folders here, each containing model-pack.json and the declared GGUF files. GGUF model packs are shared with the Windows kit.\n', 'utf8');
  writeFileSync(join(destination, 'templates', 'PUT_PROJECT_TEMPLATES_HERE.txt'), 'Place ready-to-use project templates here (for example nextjs-starter/), with dependencies already installed for macOS arm64. Native node_modules copied from Windows are not compatible.\n', 'utf8');
  writeFileSync(join(destination, 'runtime', 'llamacpp', 'runtime-manifest.example.json'), `${JSON.stringify({
    schemaVersion: '1',
    runtimeId: 'llamacpp-metal-macos-arm64',
    acceleration: 'metal',
    os: 'darwin',
    arch: 'arm64',
    executable: 'bin/llama-server',
    version: 'REPLACE_WITH_VERSION',
    sha256: 'REPLACE_WITH_64_HEX_SHA256',
  }, null, 2)}\n`, 'utf8');

  const scopedRuntimeSource = join(source, 'runtime', 'macos-arm64');
  const modelsSource = join(source, 'models');
  // Dependency trees may contain target-native binaries and symlinks. Never
  // copy a generic/Windows-prepared node_modules tree into a Mac kit.
  const templatesSource = join(source, 'templates', 'macos-arm64');
  const copiedRuntime = includeAssets && existsSync(scopedRuntimeSource);
  const copiedModels = includeAssets && existsSync(modelsSource);
  const copiedTemplates = includeAssets && existsSync(templatesSource);
  if (copiedRuntime) cpSync(scopedRuntimeSource, join(destination, 'runtime'), { recursive: true, force: true });
  if (copiedModels) cpSync(modelsSource, join(destination, 'models'), { recursive: true, force: true });
  if (copiedTemplates) cpSync(templatesSource, join(destination, 'templates'), { recursive: true, force: true });

  const nodeTarget = join(destination, 'runtime', 'node', 'bin', 'node');
  const copiedNodeRuntime = existsSync(nodeTarget);

  for (const executable of [
    join(destination, 'runtime', 'node', 'bin', 'node'),
    join(destination, 'runtime', 'git', 'bin', 'git'),
    join(destination, 'runtime', 'llamacpp', 'bin', 'llama-server'),
  ]) if (existsSync(executable)) makeExecutable(executable);

  const hasGit = existsSync(join(destination, 'runtime', 'git', 'bin', 'git'));
  const hasLlama = existsSync(join(destination, 'runtime', 'llamacpp', 'bin', 'llama-server'))
    && existsSync(join(destination, 'runtime', 'llamacpp', 'runtime-manifest.json'));
  const hasModelPack = containsNamedFile(join(destination, 'models'), 'model-pack.json');
  const hasNextjsTemplate = existsSync(join(destination, 'templates', 'nextjs-starter', 'node_modules'));
  sealPortableKit(destination);

  return {
    destination,
    target: 'macos-arm64',
    copiedAssets: { runtime: copiedRuntime, models: copiedModels },
    bundledDependencies: true,
    integrityLocked: true,
    copiedNodeRuntime,
    requiredBeforeUse: [
      ...(copiedNodeRuntime ? [] : ['a complete macOS arm64 Node.js 22+ distribution under runtime/node']),
      ...(hasLlama ? [] : ['a reviewed macOS arm64 Metal llama.cpp runtime and runtime-manifest.json under runtime/llamacpp']),
      ...(hasModelPack ? [] : ['at least one verified GGUF model pack under models/']),
      ...(hasGit ? [] : ['a relocatable macOS arm64 Git distribution under runtime/git - every dispatch needs it, even air-gapped']),
      ...(hasNextjsTemplate ? [] : ['(optional) a macOS arm64 pre-built templates/nextjs-starter/ with node_modules installed']),
    ],
  };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 });
  makeExecutable(path);
}

function makeExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // Some Windows/exFAT preparation environments do not expose POSIX modes.
    // bin/prepare-macos is deliberately included so the target Mac can restore them.
  }
}

function containsNamedFile(root: string, filename: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return true;
    if (entry.isDirectory() && containsNamedFile(path, filename)) return true;
  }
  return false;
}

const MACOS_LAUNCHER = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
NODE_EXE="$KIT_ROOT/runtime/node/bin/node"
GIT_BIN="$KIT_ROOT/runtime/git/bin"
if [ ! -x "$NODE_EXE" ]; then
  echo "Portable macOS arm64 Node.js 22+ was not found: $NODE_EXE" >&2
  echo "Run: bash '$KIT_ROOT/bin/prepare-macos'" >&2
  exit 1
fi
export AI_DISPATCHER_PORTABLE_ROOT="$KIT_ROOT"
export AI_DISPATCHER_CONFIG_PATH="$KIT_ROOT/config/.ai-dispatcher.yml"
export PATH="$GIT_BIN:$PATH"
if [ -d "$KIT_ROOT/runtime/git/libexec/git-core" ]; then export GIT_EXEC_PATH="$KIT_ROOT/runtime/git/libexec/git-core"; fi
if [ -d "$KIT_ROOT/runtime/git/share/git-core/templates" ]; then export GIT_TEMPLATE_DIR="$KIT_ROOT/runtime/git/share/git-core/templates"; fi
export DYLD_LIBRARY_PATH="$KIT_ROOT/runtime/llamacpp/lib\${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
exec "$NODE_EXE" --disable-warning=ExperimentalWarning "$KIT_ROOT/app/dist/cli.js" "$@"
`;

const MACOS_PREFLIGHT = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
NODE_EXE="$KIT_ROOT/runtime/node/bin/node"
GIT_EXE="$KIT_ROOT/runtime/git/bin/git"
LLAMA_EXE="$KIT_ROOT/runtime/llamacpp/bin/llama-server"
if [ "$(uname -s)" != "Darwin" ]; then echo "This kit targets macOS, not $(uname -s)." >&2; exit 1; fi
if [ "$(uname -m)" != "arm64" ]; then echo "This kit targets Apple Silicon arm64, not $(uname -m)." >&2; exit 1; fi
for FILE in "$NODE_EXE" "$GIT_EXE" "$LLAMA_EXE"; do
  if [ ! -x "$FILE" ]; then echo "Missing or non-executable required file: $FILE" >&2; exit 1; fi
  if command -v file >/dev/null 2>&1 && ! file "$FILE" | grep -Eq 'arm64|universal'; then
    echo "Required executable is not arm64 or universal: $FILE" >&2; exit 1
  fi
  if command -v xattr >/dev/null 2>&1 && xattr -p com.apple.quarantine "$FILE" >/dev/null 2>&1; then
    echo "Warning: Gatekeeper quarantine metadata is present on $FILE" >&2
    echo "Use a Developer ID signed and notarized kit for distribution." >&2
  fi
  if command -v codesign >/dev/null 2>&1 && ! codesign --verify --strict "$FILE" >/dev/null 2>&1; then
    echo "Warning: executable has no valid strict code signature: $FILE" >&2
  fi
done
NODE_MAJOR=$("$NODE_EXE" -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then echo "Node.js 22+ is required; bundled major version is $NODE_MAJOR." >&2; exit 1; fi
"$GIT_EXE" --version >/dev/null
export DYLD_LIBRARY_PATH="$KIT_ROOT/runtime/llamacpp/lib\${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
"$LLAMA_EXE" --version >/dev/null
exec "$SCRIPT_DIR/ai-dispatcher" preflight "$@"
`;

const MACOS_PREPARE = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
chmod 755 "$KIT_ROOT/bin/ai-dispatcher" "$KIT_ROOT/bin/preflight" "$KIT_ROOT/bin/prepare-macos" "$KIT_ROOT/bin/start-local" "$KIT_ROOT/bin/install-command" "$KIT_ROOT/bin/uninstall-command" "$KIT_ROOT/bin/new-nextjs-project"
for FILE in "$KIT_ROOT/runtime/node/bin/node" "$KIT_ROOT/runtime/git/bin/git" "$KIT_ROOT/runtime/llamacpp/bin/llama-server"; do
  if [ -f "$FILE" ]; then chmod 755 "$FILE"; fi
done
echo "macOS executable permissions prepared."
echo "Next: $KIT_ROOT/bin/preflight"
`;

const MACOS_START_LOCAL = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$SCRIPT_DIR/ai-dispatcher" local start "$@"
`;

const MACOS_INSTALL_COMMAND = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
TARGET_DIR="$HOME/.local/bin"
TARGET="$TARGET_DIR/ai-dispatcher"
SOURCE="$KIT_ROOT/bin/ai-dispatcher"
mkdir -p "$TARGET_DIR"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$SOURCE" ]; then
    echo "Managed symlink is already installed: $TARGET"
  else
    echo "Refusing to overwrite existing command: $TARGET" >&2
    echo "Move it aside explicitly, then run this installer again." >&2
    exit 1
  fi
else
  ln -s "$SOURCE" "$TARGET"
  echo "Installed managed symlink: $TARGET"
fi
case ":$PATH:" in *":$TARGET_DIR:"*) ;; *) printf 'Add this to your shell profile: export PATH="%s:$PATH"\n' "$TARGET_DIR" ;; esac
echo "The external drive must remain mounted at the same path while using this command."
`;

const MACOS_UNINSTALL_COMMAND = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
TARGET="$HOME/.local/bin/ai-dispatcher"
SOURCE="$KIT_ROOT/bin/ai-dispatcher"
if [ ! -L "$TARGET" ]; then
  echo "No managed portable ai-dispatcher symlink was installed."
  exit 0
fi
if [ "$(readlink "$TARGET")" != "$SOURCE" ]; then
  echo "Refusing to remove a symlink owned by another installation: $TARGET" >&2
  exit 1
fi
rm "$TARGET"
echo "Removed managed symlink: $TARGET"
`;

const MACOS_NEW_NEXTJS_PROJECT = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
TEMPLATE="$KIT_ROOT/templates/nextjs-starter"
DEST=\${1:-}
if [ -z "$DEST" ]; then echo "Usage: new-nextjs-project DESTINATION_FOLDER" >&2; exit 1; fi
case "$DEST" in -*) echo "Destination must not begin with '-': $DEST" >&2; exit 1 ;; esac
if [ -e "$DEST" ]; then echo "Destination already exists: $DEST" >&2; exit 1; fi
if [ ! -d "$TEMPLATE/node_modules" ]; then echo "Bundled macOS arm64 Next.js template is missing or incomplete: $TEMPLATE" >&2; exit 1; fi
cp -R "$TEMPLATE" "$DEST"
echo "Done: $DEST"
`;

const MACOS_README = `AI Dispatcher portable kit for Apple Silicon macOS
===================================================

This target runs entirely from an external drive and performs no downloads.
Use APFS for the external drive when possible. exFAT is suitable only when
cross-platform file exchange is required; it does not reliably preserve POSIX
permissions, symlinks, or macOS extended attributes.

1. On the preparation Mac, place reviewed macOS arm64 Node.js, relocatable Git,
   Metal llama.cpp, and verified GGUF model packs in the directories described by
   the PUT_* files.
2. Run: bash bin/prepare-macos
3. After reviewing asset changes, run: bin/ai-dispatcher portable seal .
4. Run: bin/preflight
5. Run: bin/start-local
6. In another Terminal: bin/ai-dispatcher implement "your task" --cwd "/path/to/project"

The target project must already be a Git repository with at least one commit.
Auto-apply requires review by a genuinely separate provider. With only one ready
local model, self-review is recorded but the change is withheld as BLOCKED_BY_POLICY.
For public distribution, sign every Mach-O executable with Developer ID and
notarize the final archive or disk image. Do not bypass Gatekeeper globally.
`;

const MACOS_KOREAN_GUIDE = `AI Dispatcher macOS Portable 사용 방법
===========================================

지원 대상: Apple Silicon M1 이상, macOS arm64

외장 드라이브는 APFS를 권장합니다. exFAT은 Windows와 파일을 공유해야 할 때만
사용하세요. POSIX 권한·symlink·macOS 확장 속성을 안정적으로 보존하지 못합니다.

1. 터미널에서 키트 폴더로 이동합니다.
2. bash bin/prepare-macos 를 한 번 실행해 실행 권한을 복원합니다.
3. 자산을 검토한 뒤 bin/ai-dispatcher portable seal . 을 실행합니다.
4. bin/preflight 를 실행해 Node, Git, Metal llama.cpp, 모델 무결성을 확인합니다.
5. bin/start-local 을 실행하고 모델 서버가 준비될 때까지 기다립니다.
6. 새 터미널에서 다음처럼 실행합니다.
   bin/ai-dispatcher implement "기능을 추가해줘" --cwd "/작업/프로젝트"

프로젝트는 Git 저장소이며 최초 커밋이 하나 이상 있어야 합니다.
포터블 기본 정책은 독립 reviewer를 자동 반영의 필수 조건으로 삼습니다. 로컬 모델이
하나뿐이면 자가 리뷰 결과는 남지만 변경은 BLOCKED_BY_POLICY로 보류됩니다.
다른 사용자에게 배포할 때는 Developer ID 서명과 Apple 공증이 필요합니다.
`;

const MACOS_PREP_GUIDE = `AI Dispatcher macOS arm64 키트 준비 가이드
===============================================

필수 자산
- runtime/node/bin/node: Node.js 22+ macOS arm64 전체 배포본
- runtime/git/bin/git: 의존 라이브러리와 helper를 포함한 relocatable Git
- runtime/llamacpp/bin/llama-server: Metal 지원 macOS arm64 빌드
- runtime/llamacpp/lib: llama-server가 요구하는 dylib
- runtime/llamacpp/runtime-manifest.json: 예제 파일을 복사해 버전과 SHA-256 입력
- models: 라이선스와 SHA-256이 기록된 GGUF 모델 팩

외장 드라이브는 APFS를 권장합니다. exFAT은 교차 호환이 필요한 경우에만 사용하고,
대상 Mac에서 bash bin/prepare-macos로 실행 권한을 복원한 뒤 다시 seal하세요.

소스 저장소에서 생성
  pnpm build
  node dist/cli.js portable assemble /Volumes/USB/portable-ai-dispatcher --target macos-arm64 --without-assets

자산을 자동 복사하려면 저장소의 runtime/macos-arm64 아래에 node, git,
llamacpp 디렉터리를 위 구조로 준비하고, 템플릿은 templates/macos-arm64 아래에
준비한 뒤 --without-assets 없이 실행합니다.
Windows에서 설치한 node_modules에는 네이티브 모듈이 포함될 수 있으므로 Mac
템플릿은 반드시 macOS arm64에서 별도로 pnpm/npm install 후 준비합니다.

배포 전
- bash bin/prepare-macos
- 자산 검토 후 bin/ai-dispatcher portable seal .
- bin/preflight
- 모든 Mach-O 실행 파일의 Developer ID 서명 확인
- 최종 zip, pkg 또는 dmg를 Apple notarytool로 공증
- 실제 오프라인 Apple Silicon Mac에서 모델 기동과 작업 적용 검증
- 무인 자동 반영이 필요하면 구현 모델과 분리된 reviewer provider 구성 검증
`;
