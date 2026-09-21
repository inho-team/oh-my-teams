# 런타임 의존성 공식 출처와 진단 절차

이 문서는 `plugins/oh-my-teams/resources/runtime-dependencies.json`의 출처와 운영 진단 기준을 설명합니다. 카탈로그는 설치가 완료되었다는 사실, 실행 파일이 PATH에서 발견되었다는 사실, 기능이 실제로 활성화되었다는 사실, 서비스가 실행 중이라는 사실, 사용자가 로그인했다는 사실을 서로 다른 상태로 취급합니다.

## 범위와 버전 원칙

Node.js는 저장소의 `package.json`이 요구하는 `>=22.13.0`을 필수 런타임으로 취급합니다. Git은 worktree와 저장소 증거에 필요하며, Codex 공식 설치 문서가 권장하는 2.23 이상을 최소 권장 기준으로 기록합니다. OpenCodex 버전은 미래에 추가될 `plugins/oh-my-teams/package.json`의 dependency가 정본이며, 이 카탈로그에는 별도의 버전 상수를 두지 않습니다.

Codex CLI와 OpenCodex는 서로 다른 구성 요소입니다. Codex CLI는 실행기와 로그인 상태를 제공하고, OpenCodex는 Codex 앞의 로컬 라우팅 계층을 제공합니다. Orca CLI는 worktree와 terminal을 관리하며, Orca desktop은 GUI와 호스트 런타임을 제공합니다. `gh`는 GitHub 원격 작업과 pull request 기능을 사용할 때만 필수입니다.

## 공식 설치 경로

| 의존성 | macOS | Windows | 필수 기능 |
| --- | --- | --- | --- |
| Node.js | [공식 다운로드](https://nodejs.org/en/download/)의 LTS installer 또는 binary | 같은 공식 다운로드 페이지의 Windows installer | OMT 실행, npm 설치, OpenCodex |
| Git | `git --version`으로 Xcode Command Line Tools를 요청하거나 [공식 설치 페이지](https://git-scm.com/install/mac)를 사용 | [Git for Windows 공식 설치 페이지](https://git-scm.com/install/windows) 또는 그 페이지에 명시된 winget | worktree와 저장소 증거 |
| Codex CLI | [공식 standalone installer](https://chatgpt.com/codex/install.sh), npm 또는 Homebrew | [공식 PowerShell installer](https://chatgpt.com/codex/install.ps1) 또는 npm | Codex 실행과 OAuth/API 인증 |
| OpenCodex | Node와 npm을 준비한 뒤 `package.json`에 선언된 버전을 npm으로 설치 | Node와 npm을 준비한 뒤 동일한 npm 경로를 사용 | 모델 라우팅과 로컬 서버 |
| Orca CLI | [공식 desktop download](https://onorca.dev/download) 또는 `brew install --cask stablyai/orca/orca`로 설치한 앱의 bundled CLI | [공식 Windows download](https://onorca.dev/download)의 `.exe` 설치 | Orca worktree와 terminal 조작 |
| Orca desktop | Apple Silicon 또는 Intel 공식 build | 공식 Windows installer | GUI, 감독 terminal, desktop runtime |
| `gh` | [GitHub CLI 공식 페이지](https://cli.github.com/)와 Homebrew 경로 | 같은 공식 페이지의 installer 또는 winget 경로 | GitHub API와 PR |

공식 설치 문서에 없는 silent-install 인수나 자동 로그인 절차는 카탈로그에 포함하지 않습니다. 설치 프로그램을 실행하는 행위와 사용자가 브라우저에서 로그인하는 행위도 자동 복구로 합치지 않습니다.

## 상태별 진단

먼저 실행 파일과 PATH를 확인하고, 다음으로 버전과 기능 도움말을 확인합니다. 마지막으로 인증과 서비스 상태를 확인합니다. 진단 명령은 자격 증명을 출력하지 않는 명령만 사용합니다.

| 상태 | 확인 방법 | 복구 원칙 |
| --- | --- | --- |
| 미설치 | macOS에서 `command -v <command>`, PowerShell에서 `Get-Command <command>`를 실행 | 해당 도구의 공식 설치 경로를 사용자에게 안내하고, 전역 설치를 대신 수행하지 않습니다. |
| PATH 누락 또는 잘못된 실행 파일 | `<command> --version`과 resolved path를 함께 확인 | 새 셸을 열고 PATH를 다시 확인합니다. 여러 관리 방식이 보이면 사용자의 선택 없이 하나를 삭제하지 않습니다. |
| 버전 부족 또는 불일치 | Node/Git 버전과 OpenCodex의 package.json dependency를 대조하고, Orca CLI와 desktop의 버전을 대조 | staging에서 지원 버전을 확인한 뒤 활성 경로를 바꿉니다. 기존 정상 실행기를 먼저 삭제하지 않습니다. |
| 기능 부족 | `git worktree list`, `codex exec --help`, `orca worktree --help`, `gh pr --help`를 실행 | 기능이 확인되지 않으면 해당 기능을 비활성화하고, 다른 도구나 다른 provider로 묵시적으로 전환하지 않습니다. |
| 로그인 필요 | Codex는 `codex login status`, GitHub CLI는 `gh auth status`를 실행 | 사용자가 직접 `codex login` 또는 `gh auth login`을 수행합니다. `auth.json`, 토큰, `gh auth token` 출력은 수집하거나 보고하지 않습니다. |
| Orca 앱 미실행 | CLI 확인과 별도로 Orca desktop 프로세스 및 요청한 capability를 확인 | 앱을 사용자가 실행한 뒤 CLI/runtime 버전을 다시 발견합니다. CLI가 있다는 이유만으로 desktop 서비스가 실행 중이라고 판단하지 않습니다. |
| OpenCodex 서버 또는 backend 미준비 | `ocx --version`, `opencodex --version`, `ocx --help`와 Codex backend 진단을 각각 확인 | 명령 이름 둘 중 하나만 발견해 성공으로 판단하지 않습니다. package.json 버전과 설치 버전을 대조하고, 서버·Codex 로그인·provider 설정을 별도로 복구합니다. |

## 복구 경계와 기능 선언

정상적인 재실행은 파일, 프로세스, 전역 설정과 인증을 변경하지 않아야 합니다. 설치가 필요하면 OMT가 소유한 staging 또는 prefix에서 설치·검증한 뒤에만 활성 경로를 변경해야 합니다. 설치 실패, 부분 `node_modules`, 포트 충돌, 서비스 중단, 인증 만료, 429, 출력 단절과 상위 요청 취소는 서로 다른 실패 상태로 기록해야 합니다.

특히 OpenCodex의 healthy process는 계정 전환이나 quota pool 전환의 증거가 아닙니다. provider, account, model, effort, pool을 바꾸지 않고, 전환 이전·이후 계정과 이유·시각·요청 상관관계를 완전히 기록할 수 없으면 pool 기능을 활성화하지 않습니다. 사용자 요청이 끝났는지 여부도 입력 수락, turn 시작, proxy 요청 시작, 작업 완료 이벤트를 각각 관측한 뒤에만 판정합니다.

Windows에 대해서는 공식 설치 경로와 명령 형식만 문서화합니다. 이 작업에서는 Windows 통합 설치, PATH shim, desktop capability와 고장 복구를 실측하지 않았으므로 macOS 결과를 Windows 지원 증거로 승격하지 않습니다. Windows가 필요한 기능은 실제 Windows 검증이 완료될 때까지 미실측 또는 차단 상태로 남겨야 합니다.

## 공식 출처

- [Node.js 다운로드](https://nodejs.org/en/download/) 및 [릴리스 정책](https://nodejs.org/en/about/previous-releases)은 지원 LTS와 OS별 installer·binary를 제공합니다.
- [Pro Git 설치 안내](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git)와 [Git for Windows 설치 페이지](https://git-scm.com/install/windows)는 macOS와 Windows의 공식 경로를 설명합니다.
- [OpenAI Codex CLI README](https://github.com/openai/codex/blob/main/README.md), [설치 문서](https://github.com/openai/codex/blob/main/docs/install.md), [Codex CLI 문서](https://developers.openai.com/codex/cli)는 standalone, npm, Homebrew 및 Windows PowerShell 설치와 `codex login status`를 설명합니다.
- [OpenCodex 설치 문서](https://opencodex.me/getting-started/installation/)는 `ocx`와 `opencodex` 명령, npm 설치, Codex 선행 조건을 설명합니다. 이는 OpenAI Codex CLI의 공식 문서가 아니라 OpenCodex 프로젝트의 공식 문서입니다.
- [Orca 공식 저장소 README](https://github.com/stablyai/orca/blob/main/README.md), [Orca CLI skill guide](https://github.com/stablyai/orca/blob/main/skill-guides/orca-cli.md), [desktop download](https://onorca.dev/download)는 desktop build, Homebrew cask와 CLI 사용 범위를 설명합니다.
- [GitHub CLI 공식 페이지](https://cli.github.com/)와 [공식 manual](https://cli.github.com/manual/)은 macOS·Windows 설치와 `gh auth status`·`gh auth login`을 설명합니다.

이 출처 목록은 조사 시점의 공식 문서 링크입니다. 제품이 지원하는 설치 방식이나 명령이 바뀌면 먼저 공식 문서와 현재 CLI 도움말을 다시 대조하고, 그 결과를 카탈로그와 이 문서에 함께 반영해야 합니다.
