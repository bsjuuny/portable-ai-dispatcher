import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PortableKitResult {
  destination: string;
  copiedAssets: { runtime: boolean; models: boolean };
  bundledDependencies: true;
  copiedNodeRuntime: boolean;
  requiredBeforeUse: string[];
}

/** Creates a self-contained USB layout from a built Dispatcher checkout. */
export function assemblePortableKit(sourceRoot: string, destinationDirectory: string, includeAssets = true, nodeExecutable = process.execPath): PortableKitResult {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationDirectory);
  const dist = join(source, 'dist');
  if (!existsSync(join(dist, 'cli.js'))) throw new Error('Portable assembly requires a built dist/cli.js. Run pnpm build first.');
  if (existsSync(destination)) throw new Error(`Portable destination already exists: ${destination}`);

  mkdirSync(join(destination, 'app'), { recursive: true });
  mkdirSync(join(destination, 'config'), { recursive: true });
  mkdirSync(join(destination, 'bin'), { recursive: true });
  mkdirSync(join(destination, 'runtime', 'node'), { recursive: true });
  mkdirSync(join(destination, 'runtime', 'llamacpp'), { recursive: true });
  mkdirSync(join(destination, 'runtime', 'git'), { recursive: true });
  mkdirSync(join(destination, 'models'), { recursive: true });
  mkdirSync(join(destination, 'templates'), { recursive: true });
  cpSync(dist, join(destination, 'app', 'dist'), { recursive: true, errorOnExist: true });
  writeFileSync(join(destination, 'app', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(destination, 'config', '.ai-dispatcher.yml'), PORTABLE_CONFIG, 'utf8');
  writeFileSync(join(destination, 'bin', 'ai-dispatcher.cmd'), PORTABLE_LAUNCHER, 'utf8');
  writeFileSync(join(destination, 'bin', 'preflight.cmd'), '@echo off\r\ncall "%~dp0ai-dispatcher.cmd" preflight %*\r\n', 'utf8');
  writeFileSync(join(destination, 'bin', 'install-node.cmd'), PORTABLE_NODE_INSTALLER, 'utf8');
  writeFileSync(join(destination, 'bin', 'install-command.cmd'), GLOBAL_COMMAND_INSTALLER, 'utf8');
  writeFileSync(join(destination, 'bin', 'uninstall-command.cmd'), GLOBAL_COMMAND_UNINSTALLER, 'utf8');
  writeFileSync(join(destination, 'bin', 'ai-dispatcher-global.cmd'), GLOBAL_LAUNCHER, 'utf8');
  writeFileSync(join(destination, 'bin', 'git-global.cmd'), GIT_GLOBAL_LAUNCHER, 'utf8');
  writeFileSync(join(destination, 'bin', 'check-vcredist.cmd'), VCREDIST_CHECKER, 'utf8');
  writeFileSync(join(destination, 'bin', 'install-vcredist.cmd'), VCREDIST_INSTALLER, 'utf8');
  writeFileSync(join(destination, 'bin', 'detect-physical-cores.ps1'), DETECT_PHYSICAL_CORES_PS1, 'utf8');
  writeFileSync(join(destination, 'bin', 'start-cpu16.cmd'), CPU16_STARTER, 'utf8');
  writeFileSync(join(destination, 'bin', 'start-cpu32.cmd'), CPU32_STARTER, 'utf8');
  writeFileSync(join(destination, 'bin', 'new-nextjs-project.cmd'), NEW_NEXTJS_PROJECT, 'utf8');
  writeFileSync(join(destination, 'README.txt'), PORTABLE_README, 'utf8');
  writeFileSync(join(destination, '사용방법.txt'), PORTABLE_KOREAN_GUIDE, 'utf8');
  writeFileSync(join(destination, 'kit-준비-가이드.txt'), PORTABLE_KIT_PREP_GUIDE, 'utf8');
  writeFileSync(join(destination, 'portable-kit.json'), '{\n  "schemaVersion": "1",\n  "kitFolderName": "portable-ai-dispatcher"\n}\n', 'utf8');
  writeFileSync(join(destination, 'runtime', 'node', 'PUT_NODE_22_HERE.txt'), 'Place a portable Node.js 22+ node.exe in this directory. It is intentionally not downloaded by Dispatcher.\n', 'utf8');
  writeFileSync(join(destination, 'runtime', 'llamacpp', 'PUT_LLAMA_CPP_RUNTIME_HERE.txt'), 'Place a reviewed CPU-safe llama.cpp runtime artifact and runtime-manifest.json here.\n', 'utf8');
  writeFileSync(join(destination, 'runtime', 'git', 'PUT_GIT_HERE.txt'), 'Place a portable Git for Windows (MinGit, the "cmd" flavor) here, so this directory contains cmd\\git.exe. Every dispatch isolates its task in a git worktree, so git is required even on an air-gapped machine. Get it from https://github.com/git-for-windows/git/releases (MinGit-*-64-bit.zip) and verify its published SHA-256 before extracting.\n', 'utf8');
  writeFileSync(join(destination, 'models', 'PUT_MODEL_PACKS_HERE.txt'), 'Place model pack folders here, each containing model-pack.json and the declared GGUF files.\n', 'utf8');
  writeFileSync(join(destination, 'templates', 'PUT_PROJECT_TEMPLATES_HERE.txt'), 'Place ready-to-use project templates here (e.g. nextjs-starter/), each already a git repo with dependencies installed (node_modules committed to disk, gitignored from tracking) so bin\\new-*.cmd can copy one with zero network access. Scaffolding an empty repo from scratch through the local coding agent is slow and unreliable at this model size (live-reproduced 2026-08-23); a pre-built, already-working template that the AI only adds features to is far more reliable offline.\n', 'utf8');

  const runtimeSource = join(source, 'runtime');
  const modelsSource = join(source, 'models');
  const templatesSource = join(source, 'templates');
  const copiedRuntime = includeAssets && existsSync(runtimeSource);
  const copiedModels = includeAssets && existsSync(modelsSource);
  const copiedTemplates = includeAssets && existsSync(templatesSource);
  if (copiedRuntime) cpSync(runtimeSource, join(destination, 'runtime'), { recursive: true, force: true });
  if (copiedModels) cpSync(modelsSource, join(destination, 'models'), { recursive: true, force: true });
  if (copiedTemplates) cpSync(templatesSource, join(destination, 'templates'), { recursive: true, force: true });
  copyPortableNodeRuntime(destination, nodeExecutable);
  const hasBundledGit = existsSync(join(destination, 'runtime', 'git', 'cmd', 'git.exe'))
    || existsSync(join(destination, 'runtime', 'git', 'bin', 'git'));
  const hasNextjsTemplate = existsSync(join(destination, 'templates', 'nextjs-starter', 'node_modules'));
  return {
    destination,
    copiedAssets: { runtime: copiedRuntime, models: copiedModels },
    bundledDependencies: true,
    copiedNodeRuntime: true,
    requiredBeforeUse: [
      ...(copiedRuntime ? [] : ['a reviewed generic CPU runtime plus runtime-manifest.json under runtime/']),
      ...(copiedModels ? [] : ['at least one verified model pack under models/']),
      // Every dispatch isolates its task in a git worktree, so this is required even
      // when the machine already has a system git - the kit must not depend on it.
      ...(hasBundledGit ? [] : ['a portable git (MinGit, "cmd" flavor) under runtime/git - every dispatch needs it, even air-gapped']),
      // Optional, but bin\new-nextjs-project.cmd needs it - not required for the
      // rest of the kit to work, only for that one convenience script.
      ...(hasNextjsTemplate ? [] : ['(optional) a pre-built templates/nextjs-starter/ with node_modules installed, for bin\\new-nextjs-project.cmd']),
    ],
  };
}

/** Copies the Node executable currently running Dispatcher into the kit. */
export function copyPortableNodeRuntime(destinationDirectory: string, nodeExecutable = process.execPath): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 22) throw new Error(`Node.js 22+ is required for a portable kit; current runtime is ${process.versions.node}.`);
  if (!existsSync(nodeExecutable)) throw new Error(`Node executable does not exist: ${nodeExecutable}`);
  const targetDirectory = join(resolve(destinationDirectory), 'runtime', 'node');
  const target = join(targetDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  if (existsSync(target)) throw new Error(`Portable Node runtime already exists: ${target}`);
  mkdirSync(targetDirectory, { recursive: true });
  cpSync(nodeExecutable, target, { errorOnExist: true });
}

const PORTABLE_NODE_INSTALLER = `@echo off\r\nsetlocal\r\nset "KIT_ROOT=%~dp0.."\r\nset "SOURCE=%KIT_ROOT%\\runtime\\node\\node.exe"\r\nset "TARGET=%LOCALAPPDATA%\\AI-Dispatcher-Portable\\node"\r\nif not exist "%SOURCE%" (\r\n  echo USB Node.js executable was not found: %SOURCE%\r\n  exit /b 1\r\n)\r\nif not exist "%TARGET%" mkdir "%TARGET%"\r\ncopy /Y "%SOURCE%" "%TARGET%\\node.exe" >nul\r\nif errorlevel 1 (\r\n  echo Node.js copy failed.\r\n  exit /b 1\r\n)\r\necho Node.js was copied to: %TARGET%\\node.exe\r\necho No administrator permission and no internet connection were required.\r\necho The USB launcher already uses its own Node.js, so this step is optional.\r\nexit /b 0\r\n`;

const GLOBAL_LAUNCHER = `@echo off\r\nsetlocal EnableExtensions\r\nset "KIT_ROOT="\r\nif exist "%~dp0ai-dispatcher-location.cmd" call "%~dp0ai-dispatcher-location.cmd"\r\nif defined AI_DISPATCHER_LAST_KIT if exist "%AI_DISPATCHER_LAST_KIT%\\portable-kit.json" set "KIT_ROOT=%AI_DISPATCHER_LAST_KIT%"\r\nfor %%D in (D E F G H I J K L M N O P Q R S T U V W X Y Z C) do (\r\n  if not defined KIT_ROOT if exist "%%D:\\portable-ai-dispatcher\\portable-kit.json" set "KIT_ROOT=%%D:\\portable-ai-dispatcher"\r\n)\r\nif not defined KIT_ROOT (\r\n  echo AI Dispatcher USB kit was not found.\r\n  echo Insert the USB and keep the folder name portable-ai-dispatcher.\r\n  exit /b 1\r\n)\r\ncall "%KIT_ROOT%\\bin\\ai-dispatcher.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n`;

const GLOBAL_COMMAND_INSTALLER = `@echo off\r\nsetlocal\r\nset "KIT_ROOT=%~dp0.."\r\nset "TARGET_BIN=%LOCALAPPDATA%\\AI-Dispatcher-Portable\\bin"\r\nif not exist "%KIT_ROOT%\\portable-kit.json" (\r\n  echo This installer must be run from the portable-ai-dispatcher USB kit.\r\n  exit /b 1\r\n)\r\nif not exist "%TARGET_BIN%" mkdir "%TARGET_BIN%"\r\ncopy /Y "%KIT_ROOT%\\bin\\ai-dispatcher-global.cmd" "%TARGET_BIN%\\ai-dispatcher.cmd" >nul\r\n> "%TARGET_BIN%\\ai-dispatcher-location.cmd" echo set "AI_DISPATCHER_LAST_KIT=%KIT_ROOT%"\r\nif errorlevel 1 (\r\n  echo Global command installation failed.\r\n  exit /b 1\r\n)\r\nif exist "%KIT_ROOT%\\runtime\\git\\cmd\\git.exe" (\r\n  copy /Y "%KIT_ROOT%\\bin\\git-global.cmd" "%TARGET_BIN%\\git.cmd" >nul\r\n) else (\r\n  del /Q "%TARGET_BIN%\\git.cmd" >nul 2>&1\r\n)\r\nset "AI_DISPATCHER_PATH_ENTRY=%TARGET_BIN%"\r\npowershell -NoProfile -Command "$entry=[Environment]::GetEnvironmentVariable('AI_DISPATCHER_PATH_ENTRY','Process'); $current=[Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $current) { $current='' }; $items=@(); foreach($part in ($current -split ';')) { if($part -and -not [string]::Equals($part,$entry,[StringComparison]::OrdinalIgnoreCase)) { $items += $part } }; $items = @($entry) + $items; [Environment]::SetEnvironmentVariable('Path', ($items -join ';'), 'User')"\r\nif errorlevel 1 (\r\n  echo PATH registration failed.\r\n  exit /b 1\r\n)\r\nrundll32.exe user32.dll,UpdatePerUserSystemParameters\r\necho Installed the ai-dispatcher command for this Windows user.\r\nif exist "%TARGET_BIN%\\git.cmd" echo Installed the git command too, backed by this kit's bundled git.\r\necho This CMD window is ready now. Open a new CMD or PowerShell for subsequent sessions.\r\necho The USB must remain connected and its folder name must stay portable-ai-dispatcher.\r\nendlocal & set "PATH=%TARGET_BIN%;%PATH%"\r\nexit /b 0\r\n`;

const GLOBAL_COMMAND_UNINSTALLER = `@echo off\r\nsetlocal\r\nset "TARGET_BIN=%LOCALAPPDATA%\\AI-Dispatcher-Portable\\bin"\r\nset "AI_DISPATCHER_PATH_ENTRY=%TARGET_BIN%"\r\npowershell -NoProfile -Command "$entry=[Environment]::GetEnvironmentVariable('AI_DISPATCHER_PATH_ENTRY','Process'); $current=[Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $current) { $current='' }; $items=@(); foreach($part in ($current -split ';')) { if($part -and -not [string]::Equals($part,$entry,[StringComparison]::OrdinalIgnoreCase)) { $items += $part } }; [Environment]::SetEnvironmentVariable('Path', ($items -join ';'), 'User')"\r\ndel /Q "%TARGET_BIN%\\ai-dispatcher.cmd" "%TARGET_BIN%\\ai-dispatcher-location.cmd" "%TARGET_BIN%\\git.cmd" >nul 2>&1\r\necho Removed the ai-dispatcher and git commands from this Windows user.\r\nexit /b 0\r\n`;

// "where git.exe" (not git.cmd, so it can never match this shim itself, whatever
// PATH order puts us in) finds a real installed git ahead of the bundled fallback.
// This is what lets the shim step aside cleanly if the user installs real Git for
// Windows later, without ever having to touch PATH or re-run install-command.cmd.
const GIT_GLOBAL_LAUNCHER = `@echo off\r\nsetlocal EnableExtensions\r\nwhere git.exe >nul 2>&1\r\nif %ERRORLEVEL% EQU 0 (\r\n  for /f "delims=" %%G in ('where git.exe') do (\r\n    "%%G" %*\r\n    exit /b %ERRORLEVEL%\r\n  )\r\n)\r\nset "KIT_ROOT="\r\nif exist "%~dp0ai-dispatcher-location.cmd" call "%~dp0ai-dispatcher-location.cmd"\r\nif defined AI_DISPATCHER_LAST_KIT if exist "%AI_DISPATCHER_LAST_KIT%\\portable-kit.json" set "KIT_ROOT=%AI_DISPATCHER_LAST_KIT%"\r\nfor %%D in (D E F G H I J K L M N O P Q R S T U V W X Y Z C) do (\r\n  if not defined KIT_ROOT if exist "%%D:\\portable-ai-dispatcher\\portable-kit.json" set "KIT_ROOT=%%D:\\portable-ai-dispatcher"\r\n)\r\nif not defined KIT_ROOT (\r\n  echo AI Dispatcher USB kit was not found.\r\n  echo Insert the USB and keep the folder name portable-ai-dispatcher.\r\n  exit /b 1\r\n)\r\nif not exist "%KIT_ROOT%\\runtime\\git\\cmd\\git.exe" (\r\n  echo Bundled git was not found in the USB kit: %KIT_ROOT%\\runtime\\git\\cmd\\git.exe\r\n  exit /b 1\r\n)\r\n"%KIT_ROOT%\\runtime\\git\\cmd\\git.exe" %*\r\nexit /b %ERRORLEVEL%\r\n`;

const VCREDIST_CHECKER = `@echo off\r\nif exist "%SystemRoot%\\System32\\vcruntime140.dll" if exist "%SystemRoot%\\System32\\vcruntime140_1.dll" if exist "%SystemRoot%\\System32\\msvcp140.dll" exit /b 0\r\necho Microsoft Visual C++ Runtime is required by llama.cpp but is not installed.\r\necho Run bin\\install-vcredist.cmd once, approve the Windows administrator prompt, then run start-cpu16.cmd or start-cpu32.cmd again.\r\nexit /b 1\r\n`;

const VCREDIST_INSTALLER = `@echo off\r\nsetlocal\r\nset "INSTALLER=%~dp0..\\runtime\\vcredist\\vc_redist.x64.exe"\r\nif not exist "%INSTALLER%" (\r\n  echo Microsoft Visual C++ installer was not found: %INSTALLER%\r\n  exit /b 1\r\n)\r\necho Installing Microsoft Visual C++ x64 Runtime. A Windows administrator prompt may appear.\r\n"%INSTALLER%" /install /passive /norestart\r\nset "RESULT=%ERRORLEVEL%"\r\nif "%RESULT%"=="0" goto success\r\nif "%RESULT%"=="3010" goto success\r\necho Visual C++ Runtime installation failed with exit code %RESULT%.\r\nexit /b %RESULT%\r\n:success\r\necho Visual C++ Runtime installation completed. You can now run start-cpu16.cmd or start-cpu32.cmd.\r\nexit /b 0\r\n`;

// -c raised from 4096 to 16384 (2026-08-23): the local coding agent's prompt
// carries the full running transcript every turn (bounded at 120,000 chars, see
// MAX_TRANSCRIPT_CHARS in local-coding-agent.ts) - 4096 tokens left almost no room
// for it past the first couple of turns on anything but a trivial task, and
// qwen2.5-coder natively supports up to 131072 (n_ctx_train), so this is still far
// short of the model's own ceiling.
//
// -t: previously a flat guess (8 / 12). Live-measured on a real 8-core/16-thread
// CPU (2026-08-24): -t 12 gave 4.00 tok/s, -t 14 gave 3.53 (SLOWER - more threads
// than physical cores costs throughput on CPU inference), -t 8 (= physical core
// count) gave 4.52, the fastest of the three. So this now detects the machine's
// actual physical core count via detect-physical-cores.ps1 at every startup
// instead of guessing a number that only happens to fit some machines -
// AI_DISPATCHER_CPU_THREADS still overrides it manually if ever needed. The
// detection is a separate .ps1 file, not an inline `powershell -Command` string
// inside a batch `for /f` backtick call: that inline form was the first attempt
// here and it silently returned empty (live-verified, not a guess) - nested
// batch/PowerShell quoting with an embedded pipe is exactly the kind of thing
// that looks right and isn't; a real file sidesteps the quoting entirely.
// -ctk/-ctv q8_0: live-measured with no throughput cost and ~900MB lower RAM use
// at this context size than the f16 default, verified against a real request
// that the output was still coherent - worth it given how much headroom this
// context size already needs.
const DETECT_PHYSICAL_CORES_PS1 = `try {\r\n  (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Measure-Object -Property NumberOfCores -Sum).Sum\r\n} catch {\r\n  ''\r\n}\r\n`;

const CPU16_STARTER = `@echo off\r\nsetlocal\r\nset "KIT_ROOT=%~dp0.."\r\nset "MODEL=%KIT_ROOT%\\models\\cpu-standard\\qwen2.5-coder-7b-instruct-q4_k_m.gguf"\r\nset "SERVER=%KIT_ROOT%\\runtime\\llamacpp\\llama-server.exe"\r\nif not exist "%SERVER%" ( echo llama.cpp runtime is missing.& exit /b 1 )\r\nif not exist "%MODEL%" ( echo 16GB model is missing.& exit /b 1 )\r\ncall "%KIT_ROOT%\\bin\\check-vcredist.cmd" || exit /b 1\r\nif "%AI_DISPATCHER_CPU_THREADS%"=="" (\r\n  for /f "usebackq delims=" %%N in (\`powershell -NoProfile -ExecutionPolicy Bypass -File "%KIT_ROOT%\\bin\\detect-physical-cores.ps1"\`) do set "AI_DISPATCHER_CPU_THREADS=%%N"\r\n)\r\nif "%AI_DISPATCHER_CPU_THREADS%"=="" set "AI_DISPATCHER_CPU_THREADS=8"\r\necho Starting 16GB CPU model at http://127.0.0.1:8080 ^(%AI_DISPATCHER_CPU_THREADS% threads^)...\r\n"%SERVER%" -m "%MODEL%" -c 16384 -t %AI_DISPATCHER_CPU_THREADS% -ctk q8_0 -ctv q8_0 --host 127.0.0.1 --port 8080\r\n`;

const CPU32_STARTER = `@echo off\r\nsetlocal\r\nset "KIT_ROOT=%~dp0.."\r\nset "MODEL=%KIT_ROOT%\\models\\cpu-plus\\qwen2.5-coder-14b-instruct-q4_k_m.gguf"\r\nset "SERVER=%KIT_ROOT%\\runtime\\llamacpp\\llama-server.exe"\r\nif not exist "%SERVER%" ( echo llama.cpp runtime is missing.& exit /b 1 )\r\nif not exist "%MODEL%" ( echo 32GB model is missing.& exit /b 1 )\r\ncall "%KIT_ROOT%\\bin\\check-vcredist.cmd" || exit /b 1\r\nif "%AI_DISPATCHER_CPU_THREADS%"=="" (\r\n  for /f "usebackq delims=" %%N in (\`powershell -NoProfile -ExecutionPolicy Bypass -File "%KIT_ROOT%\\bin\\detect-physical-cores.ps1"\`) do set "AI_DISPATCHER_CPU_THREADS=%%N"\r\n)\r\nif "%AI_DISPATCHER_CPU_THREADS%"=="" set "AI_DISPATCHER_CPU_THREADS=12"\r\necho Starting 32GB CPU model at http://127.0.0.1:8080 ^(%AI_DISPATCHER_CPU_THREADS% threads^)...\r\n"%SERVER%" -m "%MODEL%" -c 16384 -t %AI_DISPATCHER_CPU_THREADS% -ctk q8_0 -ctv q8_0 --host 127.0.0.1 --port 8080\r\n`;

const NEW_NEXTJS_PROJECT = `@echo off\r\nsetlocal EnableExtensions\r\nset "KIT_ROOT=%~dp0.."\r\nset "TEMPLATE=%KIT_ROOT%\\templates\\nextjs-starter"\r\nif "%~1"=="" (\r\n  echo Usage: new-nextjs-project.cmd DESTINATION_FOLDER\r\n  exit /b 1\r\n)\r\nset "DEST=%~1"\r\nif exist "%DEST%" (\r\n  echo Destination already exists: %DEST%\r\n  exit /b 1\r\n)\r\nif not exist "%TEMPLATE%\\node_modules" (\r\n  echo Bundled Next.js template is missing or incomplete: %TEMPLATE%\r\n  echo Put a pre-built template ^(node_modules installed^) in templates\\nextjs-starter and try again.\r\n  exit /b 1\r\n)\r\necho Copying Next.js starter to %DEST% ^(this includes node_modules, so it takes a bit^)...\r\nrobocopy "%TEMPLATE%" "%DEST%" /E /NFL /NDL /NJH /NJS /NC /NS >nul\r\nif %ERRORLEVEL% GEQ 8 (\r\n  echo Copy failed.\r\n  exit /b 1\r\n)\r\necho Done: %DEST%\r\necho This is already a git repo with dependencies installed - no internet needed, and it is\r\necho ready right now for: npm run dev, npm run build, or ai-dispatcher implement/fix.\r\nexit /b 0\r\n`;

const PORTABLE_KOREAN_GUIDE = `AI Dispatcher USB 버전 사용 방법
====================================

이 폴더 전체만 USB에 복사하면 됩니다. 인터넷, npm 설치, 별도 Node.js 설치가 필요 없습니다.
USB 파일시스템은 exFAT 또는 NTFS여야 합니다. FAT32는 4GB를 넘는 GGUF 파일을 저장할 수 없습니다.

이 kit을 새로 만들거나 최신 내용으로 갱신하는 방법(인터넷 되는 컴퓨터에서 하는 작업)은
kit-준비-가이드.txt를 참고하세요. 아래 내용은 이 USB를 받아서 폐쇄망 컴퓨터에서
바로 쓰는 방법입니다.

1. 준비 상태 확인
   - bin\\preflight.cmd를 실행합니다.
   - Overall: READY가 나오면 로컬 AI를 실행할 준비가 된 것입니다.
   - RAM이 16GB면 7B 모델, 32GB 이상이면 14B 모델을 권장합니다.
   - start-cpu 실행 시 VCRUNTIME140.dll 오류가 나면 bin\\install-vcredist.cmd를 한 번 실행합니다.
     Microsoft 공식 x64 런타임 설치이며 Windows 관리자 승인 후 다시 start-cpu를 실행합니다.

2. 모델 서버 시작
   - 16GB PC: bin\\start-cpu16.cmd
   - 32GB PC: bin\\start-cpu32.cmd
   - 창을 닫지 말고 유지합니다. 서버는 이 PC 안에서만(127.0.0.1:8080) 동작합니다.
   - 메모리가 부족하면 프로그램을 닫고 16GB용 모델을 사용합니다.

3. 새 프로젝트 시작하기 (Next.js)
   - 완전히 빈 폴더에서 AI한테 "Next.js 앱 만들어줘"처럼 처음부터 다 만들어달라고 시키면,
     파일이 여러 개 필요한 큰 작업이라 로컬 CPU 모델이 잘 못 끝내고 오래 걸리기만 합니다
     (실측: 20분 넘게 걸리고도 파일 1개). 대신 이미 다 만들어져서 바로 동작하는 뼈대를
     복사해서 시작하세요 - node_modules까지 이미 설치돼 있어서 인터넷 없이 바로 됩니다:
   - X:\\portable-ai-dispatcher\\bin\\new-nextjs-project.cmd C:\\작업할\\새\\프로젝트
   - 복사가 끝나면 그 폴더는 이미 git 저장소이고 npm run dev/build가 바로 됩니다.
     이제 그 폴더를 대상으로 AI한테는 "todo 리스트 페이지 추가해줘"처럼 뼈대 위에
     기능을 얹는 좁은 요청만 시키세요 - 이런 요청은 훨씬 빠르고 잘 됩니다.

4. AI Dispatcher 실행
   - 작업할 프로젝트 폴더에서 아래처럼 실행합니다.
   - 16GB 모델: X:\\portable-ai-dispatcher\\bin\\ai-dispatcher.cmd fix "오류를 확인하고 수정해줘" --provider local-cpu-16
   - 32GB 모델: X:\\portable-ai-dispatcher\\bin\\ai-dispatcher.cmd fix "오류를 확인하고 수정해줘" --provider local-cpu-32
   - 상태 확인: X:\\portable-ai-dispatcher\\bin\\ai-dispatcher.cmd local status
   - 작업 기록(.dispatcher)은 USB가 아니라 현재 작업 프로젝트 폴더에 생성됩니다.
   - CPU로 14B 모델을 돌리는 거라 클라우드 AI보다 훨씬 느립니다. 간단한 요청도 몇 분,
     여러 파일을 새로 만드는 요청은 최대 1시간까지 걸릴 수 있습니다 - 창이 멈춘 것처럼
     보여도 30초마다 "...still waiting..." 진행 표시가 나오면 정상 작동 중입니다.
   - 자체 검증(빌드/테스트)과 다른 로컬 AI의 리뷰까지 통과하면, 사람 승인 없이 바로
     실제 파일에 반영(auto-apply)됩니다. 검증/리뷰에서 걸리거나 위험도가 높은 변경은
     반영되지 않고 버려집니다(BLOCKED_BY_POLICY) - 작업 전 git 커밋을 해두면 언제든
     git으로 되돌릴 수 있습니다.

5. Node.js 설치 여부
   - 별도 설치가 필요 없습니다. USB의 runtime\\node\\node.exe를 사용합니다.
   - USB 밖에서도 Node.js 실행 파일만 복사해 두려면 bin\\install-node.cmd를 실행합니다.
     관리자 권한, 인터넷 연결, Windows PATH 변경은 모두 필요 없습니다.

6. git
   - 별도 설치가 필요 없습니다. ai-dispatcher.cmd를 실행할 때 USB의 runtime\\git을 자동으로 사용합니다.
   - 다만 실제로 작업할 프로젝트 폴더는 그 폴더 자체가 이미 git 저장소여야 합니다
     (커밋이 1개 이상 있어야 함). 작업 전에 격리된 복사본을 만들기 위해서입니다.
     아직 git 저장소가 아니라면 그 폴더에서 git init 후 최소 커밋 1개를 먼저 만드세요.
     (3번의 new-nextjs-project.cmd로 만든 폴더는 이미 git 저장소라 이 단계가 필요 없습니다.)
   - PowerShell/CMD에서 git 명령을 직접 쓰려면(예: git init) 아래 7번 "전역 명령 등록"을
     먼저 하거나, 그 창에서만 임시로 쓰려면 이렇게 입력하세요:
     $env:PATH = "X:\\portable-ai-dispatcher\\runtime\\git\\cmd;$env:PATH"

7. 전역 명령 등록(선택)
   - USB의 bin\\install-command.cmd를 한 번 실행합니다.
   - 새 CMD 또는 PowerShell을 열면 어느 프로젝트 폴더에서나 ai-dispatcher 명령과 git 명령을
     둘 다 바로 쓸 수 있습니다(설치 시 git.cmd도 함께 등록됨).
   - 예: C:\\github\\내-프로젝트에서 ai-dispatcher fix "오류를 확인하고 수정해줘" --provider local-cpu-32
   - USB가 연결돼 있어야 하며 USB 폴더 이름은 portable-ai-dispatcher로 유지해야 합니다. 드라이브 문자는 바뀌어도 됩니다.
   - 이렇게 등록된 git 명령은 이 컴퓨터에 나중에 정식 Git이 따로 설치되면 자동으로 그
     정식 Git을 우선 사용합니다(PATH에서 진짜 git.exe를 먼저 찾아 넘겨줌) - USB의 git은
     그때부터는 실행되지 않고, 아무것도 다시 설정할 필요가 없습니다.
   - 제거는 USB의 bin\\uninstall-command.cmd를 실행합니다(ai-dispatcher, git 둘 다 제거).

8. 라이선스와 보안
   - 포함 모델은 Apache-2.0으로 배포되는 Qwen2.5-Coder GGUF입니다. 모델 팩의 model-pack.json에 원본 주소와 해시를 기록했습니다.
   - templates\\nextjs-starter는 Next.js/React 공식 스캐폴딩(create-next-app) 결과물이며 MIT 라이선스입니다.
   - 무료 사용 여부와 관계없이, 재배포 시에는 원본 모델의 고지·라이선스 조건을 함께 확인합니다.
   - API 키나 계정 정보는 USB 설정 파일에 넣지 않는 것을 권장합니다.
   - USB를 분리하기 전에는 실행 중인 모델 서버와 Dispatcher 명령이 종료됐는지 확인합니다.
`;

const PORTABLE_KIT_PREP_GUIDE = "AI Dispatcher 폐쇄망 USB Kit - 준비부터 사용까지\n====================================\n\n이 문서는 두 파트입니다.\n- 1부: 인터넷이 되는 컴퓨터(이 저장소가 있는 개발 PC)에서 USB kit을 준비/갱신하는 방법\n- 2부: 인터넷이 안 되는 폐쇄망 컴퓨터에서 그 USB kit을 사용하는 방법 (사용방법.txt와 동일)\n\n=====================================\n1부. 인터넷 되는 컴퓨터에서 준비하기\n=====================================\n\n1-1. 필요한 자산 한눈에\n\nUSB kit 하나에는 아래 5가지가 들어갑니다. ai-dispatcher 소스 자체(src\\)는 자동으로\n빌드되지만, 나머지는 의도적으로 git에 커밋하지 않고 매번 수동으로 준비합니다\n(용량이 크고, 실행 파일을 저장소에 넣지 않기 위해서입니다).\n\n  - Node.js (runtime\\node\\node.exe)\n    용도: ai-dispatcher 자체 실행 / 용량: 약 100MB\n    출처: 현재 실행 중인 node.exe를 그대로 복사\n\n  - llama.cpp (runtime\\llamacpp\\)\n    용도: 로컬 모델 서버 / 용량: 약 50MB\n    출처: https://github.com/ggml-org/llama.cpp/releases (Windows CPU 빌드)\n\n  - git (runtime\\git\\)\n    용도: 작업 격리(worktree)에 필수, 예외 없음 / 용량: 약 90MB\n    출처: https://github.com/git-for-windows/git/releases\n          MinGit-*-64-bit.zip 파일\n\n  - VC++ 재배포 (runtime\\vcredist\\vc_redist.x64.exe)\n    용도: llama.cpp 실행에 필요 / 용량: 약 25MB\n    출처: https://aka.ms/vs/17/release/vc_redist.x64.exe (Microsoft 공식)\n\n  - 모델 (models\\cpu-standard\\, models\\cpu-plus\\)\n    용도: 실제 코드 생성 / 용량: 4.4GB / 8.4GB\n    출처: https://huggingface.co/Qwen (Qwen2.5-Coder-GGUF)\n\n  - Next.js 템플릿 (templates\\nextjs-starter\\, 선택)\n    용도: 새 프로젝트 즉시 시작용 / 용량: 약 460MB\n    출처: 이 컴퓨터에서 create-next-app으로 직접 생성\n\n1-2. 처음부터 준비하는 순서\n\n  0) 저장소 루트에서 빌드\n       cd C:\\github\\ai-dispatcher\n       pnpm build\n\n  1) kit 뼈대 생성 (자산 없이 - 이 시점엔 안내 파일만 들어있음)\n       node dist/cli.js portable assemble C:\\경로\\portable-ai-dispatcher --without-assets\n\n  이후 아래를 하나씩 그 폴더 안에 채웁니다.\n\n  Node.js\n    bin\\install-node.cmd가 현재 node.exe를 복사해주거나, 그냥 직접:\n       copy \"$(where node)\" C:\\경로\\portable-ai-dispatcher\\runtime\\node\\node.exe\n\n  llama.cpp\n    릴리스 페이지(위 주소)에서 Windows x64 CPU 빌드(llama-*-bin-win-cpu-x64.zip 계열)를\n    받아 runtime\\llamacpp\\에 압축 해제. runtime-manifest.json도 같은 폴더에 있어야\n    preflight가 인식합니다. 예시:\n       {\n         \"schemaVersion\": \"1\",\n         \"runtimeId\": \"...\",\n         \"acceleration\": \"cpu\",\n         \"os\": \"windows\",\n         \"arch\": \"x64\",\n         \"executable\": \"llama-server.exe\",\n         \"version\": \"...\",\n         \"sha256\": \"...\"\n       }\n\n  git\n    반드시 MinGit \"cmd\" 버전(GUI/문서 없는 최소 버전)을 받아서, 압축을 풀었을 때\n    runtime\\git\\cmd\\git.exe가 존재하도록 배치:\n       Invoke-WebRequest \"https://github.com/git-for-windows/git/releases/download/vX.X.X.windows.X/MinGit-X.X.X.X-64-bit.zip\" -OutFile mingit.zip\n       Expand-Archive mingit.zip -DestinationPath C:\\경로\\portable-ai-dispatcher\\runtime\\git\n    다운로드 후 릴리스 페이지에 같이 공개된 SHA-256과 대조해서 검증하는 걸 권장합니다.\n\n  VC++ 재배포\n    위 공식 링크에서 받아 runtime\\vcredist\\vc_redist.x64.exe로 저장.\n\n  모델\n    Qwen2.5-Coder-7B-Instruct-Q4_K_M(16GB PC용)와 14B(32GB PC용) GGUF를 받아 각각\n    models\\cpu-standard\\, models\\cpu-plus\\에 배치하고, 폴더마다 model-pack.json을\n    같이 둡니다(원본 주소·해시 기록용 - 형식은 기존 kit의 파일을 참고).\n\n  Next.js 템플릿 (선택, 강력 권장)\n    로컬 모델이 \"빈 프로젝트에서 앱 통째로 만들기\"를 잘 못 하기 때문에(실측 확인됨),\n    이미 동작하는 뼈대를 미리 만들어 둡니다:\n       cd C:\\경로\\portable-ai-dispatcher\\templates\n       npx create-next-app@latest nextjs-starter --typescript --eslint --tailwind --app --no-src-dir --import-alias \"@/*\" --use-npm --yes\n    node_modules까지 그대로 남겨두면 됩니다(.gitignore가 이미 알아서 git 추적에서만\n    제외하고, 폴더 자체는 그대로 있어서 오프라인 npm run build가 즉시 됩니다).\n    .next 빌드 캐시 폴더만 지워주세요.\n\n1-3. 이미 있는 kit을 갱신할 때 (가장 흔한 경우)\n\n  전체를 다시 만들 필요 없이, 바뀐 부분만 새로 만들어서 덮어씁니다.\n       cd C:\\github\\ai-dispatcher\n       pnpm build\n       node dist/cli.js portable assemble C:\\임시\\새kit --without-assets\n\n  그다음 C:\\임시\\새kit\\app\\dist 폴더와, 바뀐 bin\\*.cmd / bin\\*.ps1 /\n  config\\.ai-dispatcher.yml / README.txt / 사용방법.txt / 이 가이드 파일만 골라서\n  실제 USB kit 위에 덮어씁니다. runtime\\, models\\, templates\\는 안 바뀌었으면\n  그대로 둡니다(용량이 크므로 불필요한 재복사를 피하세요).\n\n1-4. 마지막 체크\n\n       node dist/cli.js doctor\n\n  를 그 kit의 config\\.ai-dispatcher.yml을 가리키게 해서 실행해보고\n       $env:AI_DISPATCHER_CONFIG_PATH = \"C:\\경로\\portable-ai-dispatcher\\config\\.ai-dispatcher.yml\"\n  \"Git: available\", 로컬 런타임 \"reachable=true\" 등이 정상으로 뜨는지 확인한 뒤\n  USB로 옮깁니다.\n\n=====================================\n2부. 폐쇄망 컴퓨터에서 사용하기\n=====================================\n\nUSB의 사용방법.txt와 동일합니다. 순서대로:\n\n  1. bin\\preflight.cmd 실행 -> Overall: READY 확인. Git: available도 같이 확인.\n  2. bin\\start-cpu16.cmd(16GB PC) 또는 bin\\start-cpu32.cmd(32GB PC) 실행\n     -> 로딩 로그가 끝까지 나올 때까지 창을 유지. 시작하자마자 아무 로그도 없이\n     바로 프롬프트로 돌아오면 -> 아래 3부 문제 해결 참고.\n  3. 새 프로젝트는 템플릿으로 시작:\n       bin\\new-nextjs-project.cmd C:\\작업할\\새\\폴더\n     인터넷 없이 즉시 완성된 뼈대가 생깁니다. 기존 프로젝트를 쓸 거면 그 폴더에서\n     git init 후 커밋 1개만 만들어두면 됩니다.\n  4. 작업 요청:\n       bin\\ai-dispatcher.cmd implement \"요청 내용\" --cwd \"그 폴더\" --provider local-cpu-16\n     (또는 -32). 검증+리뷰까지 자동으로 통과하면 사람 승인 없이 바로 실제 파일에\n     반영됩니다.\n  5. (선택) 전역 명령 등록: bin\\install-command.cmd 한 번 실행하면 이후 어느\n     폴더에서든 ai-dispatcher, git 명령을 USB 경로 안 적고 바로 쓸 수 있습니다.\n\n=====================================\n3부. 문제 해결 (이번에 실제로 겪었던 것들)\n=====================================\n\n  증상: start-cpu*.cmd 실행 시 로그 하나 없이 바로 프롬프트로 돌아옴\n  원인: Visual C++ 재배포 패키지 미설치 (exit code 0xC0000135, DLL 못 찾음)\n  해결: bin\\install-vcredist.cmd 실행 -> 관리자 승인 -> 재시도\n\n  증상: PowerShell에서 git이 \"인식할 수 없는 용어\"\n  원인: 그 PC에 시스템 git이 없고, PATH에도 아직 안 잡힘\n  해결: bin\\install-command.cmd 한 번 실행 후 새 창을 열거나, 그 창에서만\n        임시로: $env:PATH = \"X:\\portable-ai-dispatcher\\runtime\\git\\cmd;$env:PATH\"\n\n  증상: git init 직후 ambiguous argument 'HEAD'\n  원인: 커밋이 하나도 없는 상태에서 workspace 격리가 HEAD를 찾음\n  해결: 그 폴더에서 git add -A && git commit -m init --allow-empty\n\n  증상: Error [NO_AVAILABLE_PROVIDER] ... fetch failed\n  원인: 모델 서버가 아직 로딩 중이거나 꺼져 있음\n  해결: curl http://127.0.0.1:8080/health 로 {\"status\":\"ok\"} 뜨는지 먼저 확인 후 재시도\n\n  증상: FAILED_PROVIDER, \"실행 기록 없음\"\n  원인: 진짜 에러 메시지가 200자 넘으면 기본적으로 잘려서 안 보임\n  해결: 프로젝트의 .ai-dispatcher.yml에 아래를 추가 후 재시도하면 실제 원인이 보임\n          diagnostics:\n            logPrompts: true\n\n  증상: \"빈 프로젝트에 앱 통째로 만들어줘\" 같은 요청이 계속 실패/시간초과\n  원인: 로컬 CPU 모델이 처음부터 큰 스캐폴딩을 스스로 계획하는 데 근본적인 한계가\n        있음(턴 예산을 늘려도 안 풀림, 실측 확인)\n  해결: bin\\new-nextjs-project.cmd로 뼈대를 먼저 만들고, 그 위에 \"이 페이지에\n        OO 기능 추가해줘\" 식으로 좁게 요청\n\n  증상: 요청이 몇 분씩 걸림\n  원인: CPU로 14B 모델을 돌리는 거라 원래 클라우드 AI보다 훨씬 느림\n  해결: 정상입니다. 30초마다 \"...still waiting...\" 표시가 나오면 진행 중인 것\n\n=====================================\n참고: 이 kit의 설계상 특징\n=====================================\n\n  - auto-apply 기본 켜짐: 검증(빌드/린트/테스트)과 독립된 다른 로컬 모델의\n    리뷰까지 통과한 변경은 사람 승인 없이 바로 반영됩니다. 위험도가 높다고\n    판단되거나 검증/리뷰에서 걸리면 반영되지 않고 버려집니다.\n  - git은 항상 필요: 시스템에 git이 있으면 그걸 자동으로 우선 사용하고,\n    없으면(폐쇄망 기본 상황) USB의 번들 git을 씁니다 - 코드를 다시 설정할\n    필요가 없습니다.\n  - CPU 스레드/컨텍스트/캐시 설정은 이 프로젝트에서 실측 검증된 값입니다\n    (물리 코어 수 자동 감지, KV 캐시 양자화, 16384 컨텍스트). 다른 하드웨어에서도\n    AI_DISPATCHER_CPU_THREADS 환경변수로 수동 조정 가능합니다.\n";

const PORTABLE_CONFIG = `# Portable kit defaults. Project .ai-dispatcher.yml values override these values.\nproviders:\n  claude: { enabled: false }\n  codex: { enabled: false }\nlocal:\n  runtimes:\n    ollama: { enabled: false }\n    llamacpp: { enabled: true, host: http://127.0.0.1:8080 }\n    openai-compatible: { enabled: false }\n  profiles:\n    - name: cpu-16\n      runtime: llamacpp\n      model: Qwen2.5-Coder-7B-Instruct-Q4_K_M\n      capabilities: [analysis, review, documentation, implementation, bugfix]\n    - name: cpu-32\n      runtime: llamacpp\n      model: Qwen2.5-Coder-14B-Instruct-Q4_K_M\n      capabilities: [analysis, review, documentation, implementation, bugfix]\n  allowAutoDownload: false\n  cpu: { maxThreads: auto, reserveCores: 2 }\n  bundle:\n    runtimeDirectory: runtime\n    modelPacksDirectory: models\n    offlineKitRequired: true\n    requireModelLicenseMetadata: true\n# CPU inference of a 14B model is far slower than a cloud provider - the global\n# default (5m simple / 30m max) live-reproduced a timeout on a plain "scaffold a\n# Next.js todo app" implement request (2026-08-23). Raised for this kit only;\n# a project's own .ai-dispatcher.yml can still override these.\nexecution:\n  timeoutMs: 900000\n  adaptiveTimeout:\n    simpleMs: 900000\n    normalMs: 1800000\n    complexMs: 3600000\n    idleMs: 3600000\n    maximumMs: 3600000\n# Off by default upstream (spec: a real behavior change requires opt-in), but this\n# kit's whole point is unattended local dispatch - without this, every successful,\n# reviewed, approved change is still discarded (live-confirmed 2026-08-23: a\n# passing README.md task ended BLOCKED_BY_POLICY and wrote nothing to disk).\n# maxRiskLevel stays at its MEDIUM default; CRITICAL-risk changes are still never\n# auto-applied, no override exists for that.\nsafety:\n  autoApply:\n    enabled: true\n`;

const PORTABLE_LAUNCHER = `@echo off\r\nsetlocal\r\nset "KIT_ROOT=%~dp0.."\r\nset "AI_DISPATCHER_PORTABLE_ROOT=%KIT_ROOT%"\r\nset "AI_DISPATCHER_CONFIG_PATH=%KIT_ROOT%\\config\\.ai-dispatcher.yml"\r\nset "NODE_EXE=%KIT_ROOT%\\runtime\\node\\node.exe"\r\nif not exist "%NODE_EXE%" (\r\n  echo Portable Node.js was not found: %NODE_EXE%\r\n  echo Put a Node.js 22+ node.exe in runtime\\node and run preflight again.\r\n  exit /b 1\r\n)\r\nif exist "%KIT_ROOT%\\runtime\\git\\cmd\\git.exe" set "PATH=%KIT_ROOT%\\runtime\\git\\cmd;%PATH%"\r\n"%NODE_EXE%" --disable-warning=ExperimentalWarning "%KIT_ROOT%\\app\\dist\\cli.js" %*\r\nexit /b %ERRORLEVEL%\r\n`;

const PORTABLE_README = `AI Dispatcher portable kit\n==========================\n\nCopy this entire folder to USB. It has no network installer or model downloader.\n\nBefore first use:\n1. Run bin\\preflight.cmd and confirm READY.\n2. Run bin\\start-cpu16.cmd on a 16GB PC or bin\\start-cpu32.cmd on a 32GB PC.\n3. Use bin\\ai-dispatcher.cmd from the working project, forcing local-cpu-16 or local-cpu-32 when needed.\n\nRun bin\\ai-dispatcher.cmd from any project folder. The project remains the working directory; models, runtimes, and portable defaults remain on the USB kit.\n\ngit ships in runtime\\git and is used automatically by ai-dispatcher.cmd - no system install needed, even air-gapped. The project folder you point ai-dispatcher.cmd at must itself already be a git repository with at least one commit, since every task is isolated in a worktree before it runs.\n\nRun bin\\install-command.cmd to also register a global git command (bin\\git-global.cmd) alongside ai-dispatcher, for typing plain git commands (git init, etc.) in any shell. It prefers a real system git if one is ever installed later - it looks for git.exe on PATH first and only falls back to the USB copy - so nothing needs to be reconfigured if that happens.\n\nThis kit ships with safety.autoApply.enabled: true - a change that passes validation and independent local-model review is written straight to your real files with no human approval step. Anything that fails validation/review, or is classified high-risk, is discarded instead (BLOCKED_BY_POLICY/FAILED). Commit before running a task if you want an easy way back.\n\nDo not ask the local model to scaffold a new project from an empty folder - a CPU-run 14B model handling that as a long open-ended multi-file plan is slow and unreliable (live-reproduced: 20+ minutes for a single file). Instead run bin\\new-nextjs-project.cmd DESTINATION to copy a working Next.js starter (dependencies already installed, already a git repo, builds offline immediately), then only ask the local model to add features on top of it - narrow, few-file requests against an existing structure are what it's actually good at.\n`;
