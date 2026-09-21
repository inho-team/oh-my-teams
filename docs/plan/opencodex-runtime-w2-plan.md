# W2: OpenCodex 설치·공통 실행 경로의 구현 분할안

부분 완료: W1에서 세 구독 계열의 작업 성공과 선언된 Agy 풀의 전환을 관측했으므로 설치와 고정 계정 실행의 구현을 설계할 근거는 있습니다. 다만 모든 계정 전환의 완전한 기록, 신뢰 이후 입력 제출, 상위 요청 진행 중 취소와 Windows 실측은 아직 충족하지 못했습니다.

PM은 아래 설계 작업을 먼저 배정하고, 남은 계약을 충족할 구현 경로가 확인된 뒤 공통 경로의 기본 활성화를 결정해야 합니다. 이 문서는 **분할 계획**이며 구현·W2 workflow 생성·조직 변경·전환 승인이 아닙니다. 중첩 worker를 시작하지 않았습니다.

계획의 입력은 [W1 보고서](opencodex-runtime.md), 브리프 수용 기준 3~8, PM state의 `agy-accounts-decision.json`입니다. 마지막 파일의 계정 목록·정책은 W2 생성 시 내용 해시와 함께 스냅샷으로 넣어야 하며 문서에 계정 자격 증명을 복사하지 않습니다. 코드 근거는 조사 HEAD `80cd0e2`와 기준 `184c2de`에 해당합니다. 실제 W2는 Director 작업과 병합한 **최신 origin/main**을 다시 조사하여 base를 고정해야 합니다.

## 구현 전에 유지해야 할 계약

1. 논리적인 `provider`, `account`, `model`, `effort`, quota `pool`은 실행 프로세스가 Codex로 바뀌어도 보존합니다. 예를 들어 `provider=agy`를 `codex`로 덮어써서 Agy 사용량을 ChatGPT 사용량으로 집계하면 안 됩니다. 실행 경로를 나타내는 선택값은 별도로 둡니다.
2. 고정 계정 실행은 계정별 `OPENCODEX_HOME`을 사용합니다. Codex 세션의 `CODEX_HOME`과 프록시의 계정 저장소 수명은 구분합니다. 기존 전역 auth 파일을 자동 복사하지 않으며, 계정 이름만으로 실제 로그인이 바뀌었다고 판단하지 않습니다.
3. 자동 전환은 사용자가 선언한 같은 provider의 구독 계정 풀 안에서만 허용합니다. provider·모델·API 과금 경로는 바꾸지 않고 이전/다음 계정, 이유, 시각, 요청 식별자와 시도의 예산 소비를 남깁니다. 구독 등급이 API에 없으면 사용자 확인과 API 관측을 구분합니다.
4. OpenCodex 2.59.0은 OAuth 계정이 둘 이상이면 `auto-switch=false`여도 reactive 429 전환을 수행합니다. 고정 실행과 풀 실행은 같은 설정을 다른 이름으로 부르는 모드가 아닙니다.
5. 현재 request-history는 `sendCount=2`, `oauth-account-429`, 최종 계정을 남기지만 중간 계정과 정확한 전환 시각을 모두 남기지는 않았습니다. 동시 요청의 전환을 `account current` 전후값만으로 추정하여 완전한 기록으로 승격하지 않습니다.
6. 설치 완료, 프록시 health, 입력 수락, turn 시작, 상위 요청 시작, 작업 완료는 각각 다른 상태입니다. 권한 우회 플래그를 붙여도 새 폴더의 신뢰 질문은 남았습니다. 관측되지 않은 상태를 timeout이나 exit code 하나로 지어내지 않습니다.
7. 기존 조직과 진행 중인 workflow 스냅샷은 원래 실행 경로로 계속 읽힙니다. 새 경로의 명시적 선택이 없는 기존 문서를 자동으로 전환하지 않습니다. 기존 세션의 설정·라우팅·인증과 설치된 예전 실행기를 먼저 제거하지 않습니다.

## 재사용할 현재 코드

아래 줄 번호는 W2 착수 시 다시 대조합니다. `S`는 `plugins/oh-my-teams/scripts/`의 약칭입니다.

| 근거 | 이미 있는 기능 | W2에서의 사용 |
|---|---|---|
| [scripts/install.mjs:84](../../scripts/install.mjs#L84), [252](../../scripts/install.mjs#L252) | 현재 상태로 dry-run 계획을 만들고 설치 후 버전을 검증합니다. | 같은 plan→execute→verify 흐름에 런타임 의존성을 연결합니다. 별도 경쟁 설치기를 만들지 않습니다. |
| [scripts/install.mjs:174](../../scripts/install.mjs#L174), [213](../../scripts/install.mjs#L213) | Claude/Codex plugin 명령을 실행한 뒤 새 설치를 확인하고 기존 plugin을 처리합니다. | npm lifecycle 실행을 추정하지 않고 별도 실측을 넣습니다. 의존성 준비 실패 시 기존 plugin을 먼저 제거하지 않습니다. |
| [install.sh:6](../../install.sh#L6), [install.ps1:5](../../install.ps1#L5) | 모든 인수를 공유 Node 설치기로 전달합니다. | Node가 없는 경우의 최소 진단·공식 설치 안내만 wrapper에 둡니다. 나머지 OS별 정책은 공유 구현에 둡니다. |
| [S/core.mjs:461](../../plugins/oh-my-teams/scripts/core.mjs#L461), [485](../../plugins/oh-my-teams/scripts/core.mjs#L485) | 명령 해석, shell 없는 실행, 시간 제한이 있습니다. | Windows npm shim·공백 경로·종료 코드를 다시 구현하지 않고 재사용합니다. |
| [S/core.mjs:220](../../plugins/oh-my-teams/scripts/core.mjs#L220), [381](../../plugins/oh-my-teams/scripts/core.mjs#L381) | 파일 잠금과 경로 범위 검사가 있습니다. | 설치 경합과 소유한 prefix의 경로 검사를 재사용합니다. |
| [S/core.mjs:603](../../plugins/oh-my-teams/scripts/core.mjs#L603), [944](../../plugins/oh-my-teams/scripts/core.mjs#L944) | provider/account/model/effort/pool 및 비밀값이 아닌 환경변수 참조를 검증합니다. | 기존 검증을 유지하며 새 실행 경로의 실제 계정 바인딩만 추가합니다. |
| [S/providers.mjs:57](../../plugins/oh-my-teams/scripts/providers.mjs#L57), [116](../../plugins/oh-my-teams/scripts/providers.mjs#L116), [185](../../plugins/oh-my-teams/scripts/providers.mjs#L185) | 요청 생성, 요청/관측 모델 대조, 호출과 오류 정규화가 있습니다. | 공통 어댑터를 이 경계에 연결합니다. 모델 부재는 계속 unproven으로 남깁니다. |
| [S/providers/codex.mjs:28](../../plugins/oh-my-teams/scripts/providers/codex.mjs#L28) | 읽기 전용·ephemeral Codex exec 인수를 만듭니다. | 제한된 `work/assist` 호출에 재사용합니다. 쓰기 가능한 worker와 같은 권한으로 합치지 않습니다. |
| [S/headless.mjs:89](../../plugins/oh-my-teams/scripts/headless.mjs#L89), [273](../../plugins/oh-my-teams/scripts/headless.mjs#L273), [742](../../plugins/oh-my-teams/scripts/headless.mjs#L742) | Codex JSONL, 세션 재개, 완료·liveness·사용량 수집이 있습니다. | 실제 runner가 Codex인 새 경로에 이 디코더를 사용하면서 논리 provider를 별도로 보존합니다. |
| [S/headless-runner.mjs:33](../../plugins/oh-my-teams/scripts/headless-runner.mjs#L33), [62](../../plugins/oh-my-teams/scripts/headless-runner.mjs#L62) | POSIX process group/Windows taskkill, stop.request, exit 기록이 있습니다. | 취소와 자손 종료의 소유권을 유지합니다. exit 1과 사용자가 요청한 취소를 구별합니다. |
| [S/role-launch.mjs:326](../../plugins/oh-my-teams/scripts/role-launch.mjs#L326), [S/role-terminal.mjs:248](../../plugins/oh-my-teams/scripts/role-terminal.mjs#L248), [678](../../plugins/oh-my-teams/scripts/role-terminal.mjs#L678) | 저장된 역할 모델·권한 플래그, OS별 셸 인수, 신뢰·준비 상태를 처리합니다. | 프록시를 붙인다고 이 단계를 삭제하지 않습니다. 실제 runner 기준의 launch matrix와 논리 provider를 구분합니다. |
| [S/launch-matrix.mjs:71](../../plugins/oh-my-teams/scripts/launch-matrix.mjs#L71) | 패치 차이를 실행 실패와 구별합니다. | 단순 버전 일치보다 필요한 기능과 관측 근거를 확인합니다. |
| [S/orca-adapter.mjs:128](../../plugins/oh-my-teams/scripts/orca-adapter.mjs#L128), [191](../../plugins/oh-my-teams/scripts/orca-adapter.mjs#L191) | 실행 파일 선택, 버전별 가이드, status를 조회합니다. | Orca 설치·실행 준비 점검의 정본으로 사용합니다. 다른 바이너리로 조용히 fallback하지 않습니다. |
| [S/usage-ledger.mjs:127](../../plugins/oh-my-teams/scripts/usage-ledger.mjs#L127), [S/usage.mjs:43](../../plugins/oh-my-teams/scripts/usage.mjs#L43) | 역할·profile·workflow 귀속과 사용량 합산이 있습니다. | 프록시 관측과 계정 표식을 연결하고 CLI·프록시 토큰을 중복 합산하지 않습니다. |
| [S/quota.mjs:13](../../plugins/oh-my-teams/scripts/quota.mjs#L13), [101](../../plugins/oh-my-teams/scripts/quota.mjs#L101) | quota 출처·계정·시각을 검증하고 귀속 불명인 차감을 unknown으로 남깁니다. | OpenCodex quota를 이 형식으로 변환하며 퍼센트를 토큰·비용으로 바꾸지 않습니다. |
| [S/workflow.mjs:228](../../plugins/oh-my-teams/scripts/workflow.mjs#L228), [S/evidence.mjs:86](../../plugins/oh-my-teams/scripts/evidence.mjs#L86) | 불변 조직·task 스냅샷과 HEAD/base/환경 기반 검증이 있습니다. | 새 binding과 의존성 버전을 스냅샷·환경 지문에 넣고 기존 불변성을 유지합니다. |

## 의존성 분류와 공식 설치 경로

공식 자료는 2026-09-21에 확인했습니다. 다음 표는 W2 구현의 입력이며, 이 조사에서 아래 설치를 새로 수행한 것은 아닙니다. 실제 명령과 지원 범위는 구현 시 대상 버전의 공식 자료 및 설치된 CLI 도움말로 다시 확인합니다.

| 의존성 | 필요한 기능 | macOS·Windows 준비 원칙 | 검사와 완료 조건 |
|---|---|---|---|
| Node.js·npm | Node는 OMT 실행에 필수이고 npm은 관리되는 OpenCodex 설치·수리에 필요합니다. | 기존 실행 파일을 우선 재사용합니다. 없으면 [Node 공식 배포](https://nodejs.org/en/download)의 OS·아키텍처에 맞는 설치 파일과 검증 정보를 사용합니다. Node가 없는데 Node 설치기부터 실행하려 하지 않습니다. | 현재 package.json의 engines 하한 22.13을 유지하고 실행 파일 실경로·버전·npm 동작을 기록합니다. 머신에 설치된 버전과 실제 child가 쓰는 버전이 같은지 확인합니다. |
| Git | worktree·commit·증거 비교에 필수입니다. | [Git 공식 설치 안내](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git)의 macOS CLI 도구/배포 파일과 Windows 배포 경로를 사용합니다. 기존 Git을 불필요하게 교체하지 않습니다. | 버전과 필요한 worktree·rev-parse 명령을 확인하고 PATH 누락과 기능 부재를 구분합니다. |
| Codex CLI | OpenCodex 공통 실행에 필수입니다. | [OpenAI 공식 Codex CLI 문서](https://learn.chatgpt.com/docs/codex/cli)의 플랫폼별 설치 경로를 사용합니다. npm 설치와 standalone 설치를 같은 파일 위치로 가정하지 않습니다. | W1 관측 버전은 0.155.1입니다. exec JSONL, model/provider config, 세션 재개와 취소 기능을 probe하며 업데이트 후 패치 차이만으로 거부하지 않습니다. |
| OpenCodex | 전환한 경로의 필수 런타임입니다. | plugin 내부 manifest·lockfile로 2.59.0을 고정하고 OMT 소유 prefix에 준비합니다. [공식 기동 문서](https://opencodex.me/getting-started/for-agents/)와 설치 소스를 근거로 foreground·loopback·별도 홈을 사용합니다. | ocx --version, 실제 Bun 실행, proxy health/ready, 제공자와 계정 binding을 확인합니다. `npm install -g`, init, service로 전역 라우팅을 바꾸지 않습니다. |
| Orca CLI·데스크톱 | 이 조직의 감독·터미널·worktree 경로에는 필수입니다. 단순 비대화 호출과 구별해 진단합니다. | [Orca 공식 설치 문서](https://www.onorca.dev/docs/install)는 macOS cask `stablyai/orca/orca`와 Windows installer를 제공합니다. 공식 무인 설치 계약이 확인되지 않은 GUI 단계나 최초 OS 권한은 정확한 사람 조작으로 남깁니다. | CLI 발견과 데스크톱 running/runtime ready를 분리합니다. 선택한 바이너리의 status와 필요한 capability를 확인합니다. 임의의 Windows silent 플래그나 별도 npm 패키지를 추정하지 않습니다. |
| gh | GitHub PR 전달과 CI 확인에 필요하며 로컬 실행만 할 때는 기능별 의존성입니다. | [GitHub CLI 공식 설치 안내](https://github.com/cli/cli#installation)의 macOS Homebrew/배포 파일, Windows WinGet/배포 파일을 사용합니다. | --version과 auth status를 비밀값 없이 확인합니다. CLI 없음과 사용자 로그인 필요를 구분하고 GitLab 전달에는 적용하지 않습니다. |

OAuth는 자동 의존성 설치의 부수 효과로 실행하지 않습니다. 이미 승인된 설치 범위는 재승인을 요구하지 않되, 실제로 사람이 수행해야 하는 OAuth·OS 대화상자는 준비된 명령·대상 계정·디렉터리·포트와 함께 보고합니다. 자동 설치에 사용할 공식 경로가 없으면 이를 정확히 표시하고 가상의 성공을 반환하지 않습니다.

### Plugin 설치 시 npm 실행은 별도 실측 대상입니다

현재 설치기는 plugin host 명령을 실행할 뿐이고 현재 두 manifest에는 npm lifecycle 실행을 선언한 내용이 없습니다. 또한 저장소 루트 package.json이 plugin 캐시에 함께 들어간다고 가정할 수 없습니다.

[Claude 공식 plugin reference](https://code.claude.com/docs/en/plugins-reference#nodejs-package-dependencies)는 복사된 plugin 루트의 manifest와 지원 lockfile이 있으면 의존성을 설치하되 lifecycle scripts를 끈다고 설명합니다. 로컬에서 원위치로 로드하는 plugin은 별도 조건입니다. W1의 OpenCodex 설치에서는 Bun postinstall이 실행됐으므로, host의 의존성 설치가 끝났다는 사실만으로 ocx 실행 가능성을 보장할 수 없습니다. 이 문서 근거와 대상 host 버전의 실제 동작은 분리해서 기록합니다.

W2는 Claude·Codex host 각각에 임시 로컬 plugin을 설치하여 manifest/lockfile 복사, npm 실행 흔적, 무해한 lifecycle 표식의 실행 여부, ocx --version을 확인해야 합니다. Codex의 동작은 아직 이 계획에서 실측하지 않았습니다. 전역 plugin 목록을 바꾸지 않는 격리 host 홈을 먼저 입증하고, 입증되지 않으면 해당 host의 실측을 멈추고 환경 제약을 보고합니다.

## 작업 소유권과 실행 파동

모든 leaf task의 `files`는 서로 겹치지 않습니다. 구현은 Junior 한 명이 맡고 설치·binding·실행·계측의 네 milestone으로 나눕니다. 이는 병렬성을 줄이는 선택입니다. 이 저장소는 활성 모듈·export·태그·테스트 수를 세 문서에 자동 반영하므로, 여러 코드 task가 각각 sync→lint→전체 테스트→commit을 완료하면서 동시에 생성 문서의 소유권까지 겹치지 않게 하기는 어렵습니다. 코드와 그 자동 생성물은 한 owner에게 묶고, 독립 조사·공식 경로 정리·OS 실측·문서화·의미 검토를 다른 역할에 배정합니다. 공통 생성 문서를 각자 수동 수정하거나 검사를 생략하는 방식은 사용하지 않습니다.

각 task의 공통 검사 `C`는 `npm ci`가 준비된 상태에서 `npm run format`, `npm run sync`, `npm run lint`, `npm test`를 순서대로 수행하고 결과를 기록하는 것입니다. 조사·문서 task도 해당 체크아웃의 C를 통과한 후 커밋합니다. 구현 task 외에는 활성 .mjs·최상위 테스트·eval 시나리오를 추가하지 않으므로 감사 수치 정본을 바꾸지 않습니다.

| ID | 목표 | 역할 | dependencies |
|---|---|---|---|
| W2-01-contract | 실행·설치·전환 기록 계약과 미해결 사항의 해법을 확정합니다. | Senior가 설계합니다. | W1 결과를 PM이 확인해야 합니다. |
| W2-02-host-probe | 두 plugin host의 실제 의존성 설치 동작을 검증합니다. | Junior가 제한된 실험을 수행하고 Senior가 결과를 검토합니다. | W2-01-contract |
| W2-03-catalog | 공식 OS별 설치·탐지 정책을 데이터로 정리합니다. | Junior가 작성하고 Senior가 내용 검토를 맡습니다. | W2-01-contract |
| W2-04-implementation | 설치부터 공통 어댑터·증거·복구까지 구현합니다. | Junior가 구현합니다. | W2-01-contract, W2-02-host-probe, W2-03-catalog |
| W2-05-guide | 검증된 설치·수리·계정 운용 절차를 문서화합니다. | Junior가 작성합니다. | W2-04-implementation |
| W2-06-platform-proof | macOS·Windows의 실제 통합·고장 복구 증거를 수집합니다. | 두 번째 Junior가 검증합니다. | W2-04-implementation |
| W2-07-review | 구현과 실제 플랫폼 증거를 독립적으로 의미 검토합니다. | Senior가 검토합니다. | W2-04-implementation, W2-05-guide, W2-06-platform-proof |
| W2-integration | 최신 base에서 통합하고 PM 수용 입력을 준비합니다. | PL이 통합하고 PM이 수용합니다. | 위 모든 task |

### W2-01-contract

- **goal:** 기존 프로필 의미와 호환성을 유지하는 설치·실행·전환 관측 계약을 작성합니다.
- **files:** `docs/plan/opencodex-w2-contract.md`만 소유합니다. 코드와 이 계획 문서는 수정하지 않습니다.
- **checks:** C와 현재 source/CLI 근거 대조를 수행합니다.
- **acceptance:** 요청 모델, transport 모델, 관측 모델, 논리 provider, runner, account binding, declared pool, quota source, liveness·종료·취소의 의미가 명시되어야 합니다. 모델을 확인하지 못한 상태는 matched가 아니어야 합니다. 기존 조직과 workflow snapshot 읽기 계약이 포함되어야 합니다.
- **중요한 설계 결정:** raw OpenCodex 다계정 풀의 기록 부족을 해소할 공식 관측 경로를 확인합니다. 해결되지 않으면 계정별 단일 홈과 기존 실패 처리 경계를 이용해 OMT가 선언 풀 안의 전환을 소유하는 방안을 평가합니다. 이때 이미 수행한 도구 작업을 전체 재실행하지 않고 세션을 안전하게 재개할 수 있어야 합니다. 둘 다 증명하지 못하면 풀 모드는 차단 상태로 남기며 W2 전체 완료로 수용하지 않습니다.

### W2-02-host-probe

- **goal:** Claude·Codex의 plugin 설치가 package 의존성과 postinstall을 실제로 어떻게 처리하는지 증거를 만듭니다.
- **files:** `experiments/opencodex-plugin-install/`과 `docs/plan/opencodex-plugin-install-proof.md`를 소유합니다. 디렉터리 안에는 Python·JSON·CJS fixture와 비밀값 없는 결과만 두며 활성 .mjs를 추가하지 않습니다.
- **checks:** C, 격리 host 홈 검증, 임시 plugin의 설치·업데이트·첫 세션·반복 설치를 수행합니다. host별 원본 버전·명령·종료 코드·표식·ocx 버전을 기록합니다.
- **acceptance:** 단순히 npm 명령이 보였는지가 아니라 lifecycle 표식 실행 여부와 OpenCodex의 실제 실행 가능 여부가 구분되어야 합니다. manifest만 있는 경우, lockfile 있는 경우, install-script 제한과 부분 설치 실패가 구분되어야 합니다. 기존 plugin 및 전역 홈은 그대로여야 합니다. 수행하지 못한 host/OS는 미실행 사유를 남깁니다.

### W2-03-catalog

- **goal:** 설치 코드가 사용할 도구별 필요 범위, 공식 출처, OS/아키텍처별 탐지와 복구 정책을 정리합니다.
- **files:** `plugins/oh-my-teams/resources/runtime-dependencies.json`과 `docs/plan/runtime-dependencies-sources.md`를 소유합니다.
- **checks:** C, JSON 문법 검사, 각 URL의 공식 출처 확인과 현재 CLI 도움말 대조를 수행합니다.
- **acceptance:** Node/Git/Codex/OpenCodex/Orca CLI/Orca desktop/gh가 빠짐없이 분류되어야 합니다. PATH 누락, 미설치, 기능 부족, app 미실행, 로그인 필요를 구분해야 합니다. 검증하지 않은 silent install 인수를 넣지 않습니다. OpenCodex 버전은 plugin package.json의 정본을 참조하고 같은 버전 문자열을 두 군데에서 관리하지 않습니다.

### W2-04-implementation

- **goal:** 검증된 공통 경로의 필수 의존성을 실제로 준비하고, 기존 프로필·workflow 계약을 보존하는 Codex/OpenCodex 실행을 완성합니다.
- **files:** 아래 목록을 단독 소유합니다. `S`와 `T`는 task JSON 생성 시 각각 `plugins/oh-my-teams/scripts/`, `tests/`로 확장합니다. 실제 구현에 필요하지 않은 파일은 수정하지 않습니다.

```text
scripts/install.mjs
install.sh
install.ps1
plugins/oh-my-teams/package.json
plugins/oh-my-teams/package-lock.json
S/dependencies.mjs                  # 새 의존성 준비 경계입니다.
S/opencodex.mjs                     # 새 proxy/binding 경계입니다.
S/core.mjs
S/providers.mjs
S/providers/codex.mjs
S/headless.mjs
S/headless-runner.mjs
S/role-launch.mjs
S/role-terminal.mjs
S/launch-matrix.mjs
S/teams-org.mjs
S/failures.mjs
S/worker.mjs
S/usage.mjs
S/usage-sources.mjs
S/usage-ledger.mjs
S/usage-report.mjs
S/quota.mjs
plugins/oh-my-teams/schemas/organization.schema.json
T/dependencies.test.mjs
T/opencodex.test.mjs
T/runtime.test.mjs
T/cleanup-and-portability.test.mjs
T/provider-adapters.test.mjs
T/headless.test.mjs
T/role-terminal.test.mjs
T/launch-matrix.test.mjs
T/cli-integration.test.mjs
T/workflow-recovery.test.mjs
.github/workflows/ci.yml
evals/organization/scenarios.json
scripts/metadata.mjs
docs/PLAN_STATUS.md
docs/SAFETY_AUDIT.md
docs/CODE_QUALITY.md
```

마지막 세 문서는 `npm run sync`로만 생성합니다. `scripts/metadata.mjs`는 정본 위치나 문구를 실제로 바꿔야 할 때만 수정합니다. plugin package.json의 정확한 OpenCodex dependency와 해당 lockfile이 설치 버전의 정본입니다. 제품 버전과 기존 두 plugin manifest의 버전은 이 task에서 올리지 않습니다.

**Milestone I1: 설치 준비와 수리.** 기존 설치 계획에 의존성 단계를 연결하고 runtime doctor/install/repair에 해당하는 공유 진입점을 마련합니다. 실제 공개 명령 이름은 W2-01에서 확정합니다. plugin 캐시 루트가 아닌 OMT 소유의 영속 prefix에 manifest·lockfile 지문별 런타임을 준비합니다. 이미 올바르면 다운로드·설정 변경을 하지 않고, 불완전하면 staging에서 설치·실행 확인 후 활성 경로를 바꿉니다. 실패한 staging 때문에 기존 동작 중인 버전을 지우지 않습니다. 첫 사용은 같은 점검 함수를 호출하며 설치가 필요한 사실과 사람 로그인 필요를 구분합니다. dry-run은 파일·프로세스·서비스를 변경하거나 로그인·추론을 호출하지 않습니다.

**Milestone I2: binding과 공통 호출.** 기존 provider registry와 검증을 재사용하고 실행 경로 선택을 논리 provider와 분리합니다. 같은 Claude 모델의 Claude/Agy 경로, named account의 실제 홈, 명시한 effort와 quota pool을 보존합니다. null 모델의 실제 기본값은 기존 host-default 관측 방식으로 확인하고 임의 최신 모델을 선택하지 않습니다. W1에서 통과한 gpt-6-astra와 Claude Sonnet만으로 조직의 Opus thinking·GPT-OSS 등 나머지 저장된 모델까지 지원했다고 선언하지 않습니다. 실제 W2 조직의 모든 선택 모델과 effort 조합을 별도로 대조하고 미검증 조합의 기존 경로를 유지합니다. read-only `work/assist`, 쓰기 가능한 headless, 감독 터미널의 권한 계약을 서로 유지합니다. API 키 환경변수가 구독 경로를 덮어쓰지 못하게 합니다. proxy는 loopback에 두고 전역 init/service 주입 없이 소유한 프로세스만 관리합니다.

**Milestone I3: 완료·계정·전환 증거.** input_accepted/turn_started와 proxy 요청 시작을 구분하고 원래 runtime 식별자 및 task/dispatch 연결을 유지합니다. 세션·요청 ID로 CLI와 proxy 관측을 연결하고 계정 표식을 저장된 binding에 대조합니다. CLI 사용량과 proxy usage를 합쳐 두 번 계산하지 않습니다. 풀 변경·provider 변경·모델 변경·API 키 fallback을 차단하는 음성 검사를 둡니다. 모든 전환을 입증할 수 없는 경우 관측 상태를 불완전으로 남기고 해당 풀 모드를 완료 처리하지 않습니다. 계정별 credential refresh와 프로세스 소유권을 확인하며 한 refresh token을 여러 프로세스가 무분별하게 갱신하지 않게 합니다.

**Milestone I4: 복구와 제한된 중복 제거.** 설치 실패·프록시 중단·포트 충돌·인증 만료·429·출력 단절·취소 후 자손 잔존을 기존 실패/복구 분류에 연결합니다. 종료가 확인되지 않은 실행은 대체 실행을 자동으로 만들지 않습니다. 이전 조직·workflow와 새 경로를 함께 검사한 뒤 전환이 검증된 중복만 제거합니다. 현재 구조에서 유일한 provider별 기능과 기존 스냅샷의 decoder는 남깁니다.

- **checks:** 각 milestone에서 관련 node --test 선택 실행 후 C를 수행하고 커밋합니다. 최종 단계에서는 `npm run eval:organization`과 macOS·Windows CI를 추가합니다. 인터페이스 변경마다 이전 조직·스냅샷 fixture를 검증합니다.
- **acceptance:** 설치 명령·plugin 설치·첫 사용 점검·수리가 실제 같은 경계를 사용하고, 반복 실행이 무변경이어야 합니다. 단순 package.json 추가만으로 완료하지 않습니다. 지원한 세 구독 경로의 모델·계정·사용량 근거, 실패·재개·취소·신뢰 단계가 검증되어야 합니다. pool 계약을 충족하지 못하면 나머지 구현이 통과해도 전체 전환 완료로 표시하지 않습니다.

### W2-05-guide

- **goal:** 실제 구현과 일치하는 설치·첫 실행·로그인·진단·수리·이전 조직 유지 절차를 제공합니다.
- **files:** `README.md`, `docs/OPENCODEX_RUNTIME.md`를 소유합니다.
- **checks:** C와 문서에 있는 모든 로컬 명령의 도움말·dry-run 대조를 수행합니다. 한국어 작성에는 fluent-korean 전체 지침을 적용합니다.
- **acceptance:** macOS·Windows, 기존 설치/미설치, 고정 계정/선언 풀, GUI·OAuth의 사람 조작, 실패 뒤 재실행을 구분해야 합니다. 미검증 기능이나 미수용 풀 모드를 지원 완료로 쓰지 않습니다. 조사 버전과 제품 버전을 혼동하지 않습니다.

### W2-06-platform-proof

- **goal:** 구현자가 아닌 다른 Junior가 실제 OS에서 설치·실행·복구 계약을 검증합니다.
- **files:** `experiments/opencodex-w2-platform/`, `docs/plan/opencodex-w2-platform-proof.md`를 소유합니다. Python·JSON·텍스트 증거만 추가하고 구현 및 .mjs 테스트는 바꾸지 않습니다.
- **checks:** C, `npm run eval:organization`, 아래 결정적 검사 표, 해당 OS에서 가능한 실제 설치·첫 실행·수리·취소와 PR CI 결과 대조를 수행합니다.
- **acceptance:** mock·소스 대조·현지 실행·실제 Windows 실행을 구분합니다. Windows 호스트가 없으면 Windows 실측은 미완료이며 macOS 결과로 대체하지 않습니다. 발견한 문제는 W2-04 owner에게 반환하고 수정 HEAD에서 다시 검증합니다. OAuth를 필요 이상으로 재로그인하거나 소진된 계정을 반복 호출하지 않습니다.

### W2-07-review

- **goal:** 설치 안전성, 구독 계약, 호환성, 중복 제거와 근거의 충분성을 독립적으로 판정합니다.
- **files:** `docs/plan/opencodex-w2-review.md`만 소유합니다. 구조화된 review 기록은 PM state에 별도로 남깁니다.
- **checks:** C, W2-06 증거와 정확한 source/task hash 대조, 기존 `review-record`·`gate-check` 절차를 수행합니다.
- **acceptance:** W2-01 작성자와 다른 독립 Senior 검토 실행을 배정하고, 구현자의 작업 공간에 검토자를 띄우지 않습니다. 같은 조직 프로필을 사용해도 별도 Dispatch와 독립 문맥으로 검토하며 설계의 가정도 검토 대상에 포함합니다. 전환 누락·credential 노출·전역 주입·묵시적 모델/계정 교체·출력만 보고 완료 판단·미검증 Windows를 finding으로 남깁니다. 통과하지 않은 항목은 PM acceptance로 우회하지 않습니다.

### W2-integration: 필수 integrationTask

- **goal:** 최신 origin/main 기준의 통합 HEAD와 모든 review·검증 증거를 PM에게 전달합니다.
- **files:** 계약의 변경 허용 범위는 모든 leaf task files의 합집합과 `docs/plan/opencodex-w2-integration.md`입니다. 이는 merge 결과를 검증할 범위이며 leaf 소스의 동시 편집 소유권을 PL에게 추가하는 뜻은 아닙니다. PL은 merge와 통합 기록을 맡고 충돌 수정은 원 owner에게 반환합니다.
- **dependencies:** W2-01부터 W2-07까지 모두 완료되어야 합니다. 최초 workflow-create 요청부터 integrationTask를 포함합니다. 전체 maxAttempts/maxCalls를 task별 예산으로 오해하지 않습니다.
- **checks:** 최신 remote base 조회와 통합, C, `npm run eval:organization`, 두 OS의 CI, `verify`, `merge-check`, source/task hash에 연결된 Senior review와 PM acceptance를 확인합니다. base가 움직이면 검증 전제를 다시 계산합니다.
- **acceptance:** 호환성·격리·설치·전환 관측·실측·고장 복구의 미충족 항목이 없어야 전체 전환을 수용할 수 있습니다. 최종 HEAD, base, 환경 지문, 검사 결과, PR CI와 남은 제한을 전달합니다. 원본 체크아웃에 직접 커밋·병합하거나 이 계획만으로 배포·버전 변경을 수행하지 않습니다.

## 결정적 테스트와 복구 검사

| 분류 | 최소 시나리오와 확인할 결과 |
|---|---|
| 설치 | 미설치·정상 재사용·manifest/lock 불일치·npm 실패·Bun script 미실행·부분 node_modules·권한 거부·중단 후 재실행·동시 설치를 주입합니다. 정상 재실행은 네트워크/변경이 없고 실패 시 예전 런타임이 보존되어야 합니다. |
| 플랫폼 | macOS arm64/x64 경로, Windows 드라이브·공백·한글·PowerShell 인수, npm cmd shim, 실행 파일이 여러 개인 PATH를 결정적으로 검사합니다. 실제 지원 범위와 검증한 아키텍처를 구분합니다. |
| Orca | 바이너리 없음·CLI 있음/app 없음·runtime 미준비·필수 capability 없음·패치 차이·선택 바이너리 실패를 구분합니다. 다른 Orca나 GNOME screen reader로 fallback하지 않아야 합니다. |
| 격리 | 홈·포트 충돌, 다른 workflow가 쓰는 프로세스, 종료 미확인, 키체인 쓰기 경로, 전역 config 변경을 검사합니다. 소유하지 않은 프로세스·설정은 수리 대상으로 삼지 않습니다. |
| identity | Claude/Agy의 같은 모델, 고정 계정·허용 풀·풀 밖 계정, model/effort 불일치·관측값 부재, API 키 환경변수 오염, null 모델 기본값을 검사합니다. 불명확한 상태는 matched로 바뀌지 않아야 합니다. |
| 전환 | 첫 계정 429→두 번째 성공, 두 번 이상 전환, 전부 소진, 같은 pool의 동시 요청, 앱 재시작·기록 누락을 검사합니다. 이전/다음 계정·이유·시각·요청 상관관계가 남거나 관측 불완전으로 실패해야 합니다. |
| 실행 상태 | input accepted만 있음, turn 시작 전 단절, 시작 뒤 실패, 도구 권한 질문·폴더 신뢰, exit 0이지만 완료 이벤트 없음, 완료 표식만 있고 테스트 실패를 구분합니다. |
| 취소·복구 | 시작 직후 취소, 상위 스트림 진행 중 취소, SIGTERM 후 자손 잔존, Windows taskkill 실패, runner만 죽은 상태, proxy 중단과 세션 재개를 검사합니다. 불명확한 생존 상태는 새 호출의 근거가 아니어야 합니다. |
| 호환성 | 기존 조직과 진행 중 workflow snapshot을 변경 없이 읽고 실행합니다. 새 binding은 새 snapshot에만 적용하며 구버전 기록을 새 계정 정책으로 재해석하지 않습니다. |
| 계측 | 중복 usage 이벤트·프록시 집계와 CLI 합계 중복·계정 표식 충돌·quota reset·다른 작업의 소비·구독 등급 부재를 검사합니다. 누락은 0이 아니어야 합니다. |

CI는 현재 Ubuntu와 Windows, Node 22를 사용합니다. W2-04가 기존 Linux 검사를 유지하고 macOS를 추가하며, engines 하한과 검증한 최신 Node 계열의 결정적 검사를 명시합니다. 실제 OAuth E2E는 CI에 토큰을 넣어 무조건 실행하는 검사가 아닙니다. 사람이 준비한 계정과 승인된 호출 수 안에서 별도 실측하고, 그 결과를 정확한 HEAD와 연결합니다.

## 중복 제거의 기준과 남길 경계

새 경로가 실제로 통과한 뒤 headless의 provider별 명령·JSONL 처리 중 Codex로 대체된 부분, 호출자가 중복 구성하던 proxy 인수, 동일한 의존성 탐지만 줄입니다. 삭제 전후 줄 수와 제거된 분기, 여전히 그 코드를 쓰는 기존 스냅샷·Ollama·기타 미전환 경로를 함께 기록합니다. 감소 수치를 목표로 정하고 먼저 코드를 지우지는 않습니다.

역할 배정, task 계약, 예산, review·acceptance, 계정 풀 허용 정책은 OMT에 남습니다. provider 변환·OAuth 프로토콜은 OpenCodex에 맡깁니다. worktree·터미널·Dispatch·입력 제출 receipt와 원격 프로세스 관측은 Orca의 공식 계약을 사용합니다. Git evidence와 기존 실패/복구·usage/quota helper는 재사용합니다. OpenCodex의 화면, 서비스 관리자, OAuth 서버나 Orca의 터미널 감독 기능을 OMT 안에 복제하지 않습니다.
