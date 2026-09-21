# OpenCodex 런타임 전체 작업 독립 판정

부분 충족: 수용 기준 1~8 가운데 충족은 없고 7개가 부분 충족, 1개(기준 8)가 미충족입니다. 구현은 `6db7efc`에서 `npm ci` 후 `npm test`가 526개 중 526개 통과했고, 플랫폼 실측은 `b9b5e7c`의 `runtime-test-results.json` 11개 시나리오로 확인했습니다.

이사가 결정할 사항은 두 가지입니다. 첫째, Claude 구독과 Antigravity 구독에는 runner 경로가 없으므로(`opencodex.mjs:90-134`가 OpenAI 고정 계정만 허용합니다) 이 두 구독을 이번 범위에서 제외하고 릴리스할지 정해야 합니다. 둘째, 이 문서가 통합 단계로 넘긴 항목(PR CI, 최신 `origin/main` 통합 HEAD)을 누가 언제 확인할지 정해야 합니다.

## 판정 범위와 방법

이 문서는 Senior가 W1 조사, W2 구현, W3 수정·가이드·플랫폼 실측 전체를 독립적으로 판정한 결과입니다. 구현 결함은 고치지 않고 finding으로만 기록했습니다.

| 대상 | 기준 위치 | 확인 방법 |
|---|---|---|
| 구현 | 브랜치 `dev-inho/opencodex-w3-review`의 HEAD `6db7efc` (`git diff fbf2d63..6db7efc`, 50개 파일, 삽입 8579행, 삭제 39행) | 코드를 직접 읽고 `npm ci`, `npm test`를 실행했습니다. |
| 가이드 | 커밋 `8e006b5`의 `README.md`, `docs/OPENCODEX_RUNTIME.md` | 문서를 읽었습니다. 이 가이드는 현재 독립 재검토를 받는 중이므로, 아래 판정에서 가이드의 서술만으로는 충족 근거로 삼지 않았습니다. |
| 플랫폼 실측 | 커밋 `b9b5e7c`의 `docs/plan/opencodex-w2-platform-proof.md`, `experiments/opencodex-w2-platform/runtime-test-results.json` | 측정 JSON의 필드를 직접 읽었습니다. |
| 계획·계약 | `docs/plan/opencodex-runtime.md`(W1), `opencodex-runtime-w2-plan.md`, `opencodex-w2-contract.md` | 읽었습니다. |
| 검토 기록 | `w3-mainline-independent-review-1~3`, `w3-platform-proof-independent-review-1~4`, `w3-guide-independent-review-1~4` | finding의 `status`와 결론만 근거로 삼았습니다. |

플랫폼 실측은 커밋 `f6ba787`의 트리에서 수행했고, 이 커밋과 `b9b5e7c`, `8e006b5`는 HEAD `6db7efc`의 조상이 아닙니다. 그래서 `plugins/oh-my-teams` 트리 해시가 같은지 직접 비교했습니다. `f6ba787`과 `6db7efc` 모두 `d9ba65eaea0e9cbb4a9e14d1e48b2acb25613cab`이었고, 측정 JSON의 `repository.plugin_tree`와도 일치했습니다. `scripts`, `tests`, `resources`, `scripts/install.mjs`도 같았습니다. 따라서 실측은 HEAD의 실행 코드에 대한 측정으로 인정했습니다. 다만 이 확인은 통합 단계에서 실제 통합 HEAD로 다시 해야 합니다.

## 기준별 판정

### 기준 1: 세 구독으로 같은 작은 저장소 작업을 실행하고 귀속을 확인

**부분 충족**

- 근거: W1이 ChatGPT, Claude, 추가 Antigravity 두 계정의 동일 픽스처 성공을 기록했습니다(`docs/plan/opencodex-runtime.md:3`, `experiments/opencodex/evidence.json`). 선언된 풀의 전환도 한 건 관측했습니다(같은 문서 94행).
- 한계: 공유 계정 `e4a44806…`의 고정 비교는 실행하지 않았습니다(같은 문서 94, 187행). 이 비교를 성공으로 바꾸지 않았습니다. 풀 전환은 예외 승인된 요청 한 건이며, 동시 요청의 전환 기록은 완전하지 않다고 W1이 밝혔습니다(171행). 어느 실행도 W2가 만든 OMT runner 경로(`headless-runner.mjs`)를 실제 구독으로 통과한 것이 아닙니다. 사용자가 2026-09-21 05:10Z에 Claude와 Agy 추론을 더 하지 않기로 결정했기 때문입니다. OpenCodex 로그인이나 구독 모델 호출은 이번 판정에서도 하지 않았습니다.
- 미실행으로 남는 항목: Claude 구독 OAuth를 OMT runner로 통과하는 실행, Antigravity의 OMT runner 실행, e4a4 고정 비교.

### 기준 2: 지원 버전 고정, 재현 가능한 설치, 전역 초기화 금지

**부분 충족**

- 충족하는 부분: 버전은 `plugins/oh-my-teams/package.json`과 `package-lock.json`으로 2.59.0에 고정되었고, 설치 위치의 식별자는 두 파일의 sha256입니다(`dependencies.mjs:54-74`). 실측 JSON은 이 식별자를 `sha256:fb0b1f1a…5326f`로 기록했고, 이 문서를 쓰는 중 같은 함수를 실행해 같은 값을 얻었습니다. 전역 초기화 명령(`ocx init`, `ocx service`, Codex 설정 자동 주입)은 스크립트 어디에도 없습니다(`grep`으로 확인). 설치는 `npm ci`를 스테이징에서 실행하고 `ocx --version`, bun, 상태 확인을 통과한 뒤 활성 포인터를 원자적으로 바꿉니다(`dependencies.mjs:368-455`). 실측에서 `real_user_state.diff`의 `~/.codex/config.toml`, `~/.claude/settings*.json`, `~/.omt`, `~/.opencodex`, shell 프로필, `launchctl` 변수가 모두 `unchanged`였습니다.
- 부분인 이유 1: W1 최종 비교에서 기존 Claude 키체인 항목의 메타데이터가 바뀌었고 변경 주체를 확인하지 못했습니다(`opencodex-runtime.md:3`). 전역 상태가 바뀌지 않았다는 증명은 W1에 대해서는 성립하지 않습니다.
- 부분인 이유 2: 플랫폼 실측의 커널 거부 로그는 대조군 탐침조차 기록하지 못해 신뢰할 수 없다고 측정 JSON이 스스로 표시했습니다(`isolation.sandbox_denials_excluding_control.reliable: false`). 파일 비교는 `~/.codex`, `~/.claude`의 세션 로그와 DB를 비교하지 않았습니다(`real_user_state.not_attributable`).
- 부분인 이유 3: 측정은 Node v26.7.0에서 수행했습니다(`environment.node`). 지원 기준이 Node 22라면 그 버전에서의 실측은 없습니다.

### 기준 3: 필수 런타임 의존성 선언과 설치 진입점, 첫 실행 점검, 수리 명령 연결

**부분 충족**

- 충족하는 부분: `package.json` 한 줄이 아니라 `runtime-doctor`, `runtime-install`, `runtime-repair` 명령이 있고(`teams-org.mjs:1114-1128`), `scripts/install.mjs`가 연결되어 있습니다(+21행). 첫 실행 점검은 `startOpenCodexProxy`가 `opencodex-action-required` 등으로 실패를 닫는 방식으로 이어집니다. 실측은 doctor→dry-run→설치→재실행→손상→수리→스테이징 실패→복구의 11개 시나리오를 통과했고, 설치의 `npm ci` 호출 횟수는 첫 설치 1회, 두 번째 설치 0회였습니다(`install-actual`, `install-second`). 수리에 실제 npm을 쓴 시나리오는 `repair-real-npm`입니다.
- 부분인 이유: 호스트의 plugin 설치는 npm을 실행하지 않는다는 W1 관측(`docs/plan/opencodex-plugin-install-proof.md`, `experiments/opencodex-plugin-install/result.json`)이 그대로 유효합니다. 따라서 plugin만 설치한 사용자는 `runtime-install`을 직접 실행해야 하며, 자동으로 준비되지는 않습니다. 또 W1 판정은 전면 전환 보류였는데(`opencodex-runtime.md:171`), W2는 OpenCodex를 카탈로그와 `package.json`에 선언했습니다. 이 불일치는 runner 블록이 있는 프로필에서만 OpenCodex를 쓰고 기본 경로는 기존 방식을 유지하는 설계로 완화되었으며, 그래서 "필수"라기보다 "선택적 runner 의존성"이 정확한 표현입니다.

### 기준 4: 의존성 구분과 OS별 설치·탐지·dry-run·멱등성

**부분 충족**

- 충족하는 부분: `resources/runtime-dependencies.json`이 node, git, codex, opencodex, orca-cli, orca-desktop, gh를 `requiredFor`와 platforms(macos, windows)로 구분하고 안내 문구를 갖습니다. doctor(`dependencies.mjs:165-264`)는 탐지, PATH, 버전, 실패 이유를 보고하고, dry-run은 파일을 만들지 않으며(`install-dryrun`의 `listing_diff.identical: true`), 재실행은 멱등입니다(`install-second`).
- 부분인 이유 1: 자동 설치는 OpenCodex만 합니다. 다른 의존성은 안내만 합니다. GUI 설치와 OAuth 로그인을 사람에게 넘기는 것은 기준이 허용하는 범위입니다.
- 부분인 이유 2: doctor가 Codex와 gh의 로그인 상태를 점검하지 않습니다. 기능별 필수 구분은 있으나, 로그인이 필요하다는 사실은 안내 문구에만 있습니다.
- 부분인 이유 3: Windows에서의 동작은 측정하지 않았습니다(기준 7 참고). Linux는 카탈로그상 macOS 항목으로 처리됩니다(`dependencies.mjs:97`, F-8).

### 기준 5: 역할 프로필 보존, runner 어댑터, 자동 전환 금지, 기록, 호환성

**부분 충족**

- 충족하는 부분(보존): `provider`, `account`, `subscription`, `model`, `effort`, `pool`은 논리 바인딩으로 그대로 남고, `runner`는 선택 항목입니다(`schemas/organization.schema.json` +14행). runner가 있는 프로필은 `openCodexCommand`가 모델과 effort를 필수로 요구합니다(`opencodex.mjs:559-594`). 모델이나 effort가 null이면 `opencodex-model-unproven-or-mismatched` 등으로 닫힙니다.
- 충족하는 부분(자동 전환 금지): 고정 계정 모드에서 홈의 계정 수와 `logLabel`을 검증하고(`opencodex.mjs:90-134`), 풀이 필요한 프로필은 `opencodex-pool-unverified`로 막습니다. API 키 환경 변수는 제거하며(`opencodex.mjs:38-81`), 과금 대체는 `api-key-fallback-blocked`입니다. 요청 이력의 경계와 시도 증명으로 요청 모델, 관측 모델, 라우팅 계정을 기록합니다(`opencodex.mjs:722-769`, 리뷰 finding `request-history-unattributed-attempts` resolved).
- 충족하는 부분(호환성): `runner`가 없는 프로필, 작업자, 턴은 기존 경로를 탑니다. 제거된 옛 역할 이름은 `core.mjs:38`의 `LEGACY_ROLE_ALIASES`로 `junior`로 읽히고, 저장된 깊이 5는 `core.mjs:91-108`에서 4로 읽힙니다. 이 호환 처리에 새 코드를 추가한 흔적은 W2·W3 diff에 없습니다(`grep`으로 확인).
- 부분인 이유: runner가 실제로 지원하는 계정은 OpenAI(ChatGPT) 고정 계정 하나입니다. Claude 구독과 Antigravity 구독의 홈은 거부됩니다(F-1). "같은 Claude 모델의 Claude 구독과 Antigravity 구독의 구분"은 논리 바인딩 수준에서만 유지되고 runner로는 실행되지 않습니다.

### 기준 6: OMT 고유 기능 집중, 중복 코드 제거 보고, 수명주기 실제 확인

**부분 충족**

- 충족하는 부분: 수명주기 단계를 서로 독립된 값으로 분리했습니다(`inputAccepted`, `turnStarted`, `upstreamRequestStarted`, `completed`, `exitObserved`, `cancelRequested`). 증명이 없으면 결과가 `unverifiable`이 됩니다(`headless.mjs` 831행 부근, `runnerTurnProven`). 화면 출력만으로 단계를 승격하지 않습니다(리뷰 finding `lifecycle-promoted-from-output` resolved). 프로세스 그룹이 비었는지로 종료를 증명하고(`opencodex.mjs:136-228`), 프록시 포트의 단독 수신자를 확인합니다(`opencodex.mjs:468-552`, finding `proxy-port-and-descendant-ownership-unproven` resolved). 폴더 신뢰 질문을 자동으로 응답하지 않으며, 프록시가 이를 해결한다는 주장은 문서에도 코드에도 없습니다.
- 미충족인 부분: 코드 감소가 없습니다. `git diff --shortstat fbf2d63..6db7efc -- plugins scripts`의 삭제는 28행이고 대부분 기존 함수 수정입니다. 실행기별 화면·프로세스·사용량 중복 코드를 제거하고 그 감소량과 남는 경계를 보고하라는 요구는 수행되지 않았습니다. 전환을 통과하지 못했으니 제거하지 않은 것은 기준의 문구와 모순되지 않지만, 보고 자체가 없습니다.
- 확인되지 않은 부분: 입력 수락 이후의 제출과 `turn_started`, 상위 요청 진행 중의 취소는 W1도 미검증으로 남겼습니다(`opencodex-runtime.md:171`). W2의 결정적 테스트는 가짜 프로세스로 이 단계들의 분리를 검증할 뿐 실제 터미널의 확인은 아닙니다.

### 기준 7: 결정적 테스트, 고장 복구 검사, 독립 검토, 명령 통과, PR CI

**부분 충족**

- 충족하는 부분: 이 워크트리에서 `npm ci` 후 `npm test`가 526개 중 526개 통과, 실패 0(16.1초)이었습니다. 검토 기록은 세 갈래 모두 마지막 판이 `approved`입니다(mainline 3, platform-proof 4, guide 4). 각 finding의 최종 `status`는 전부 `resolved`입니다. 고장 복구는 실측 시나리오 `doctor-damaged`, `repair-real-npm`, `failed-staging`, `repair-after-failure`, `doctor-recovered`가 증명합니다. 설치 실패 시 종료 코드 1은 `failed-staging`에서만 나타났습니다.
- 부분인 이유 1: macOS만 실측했습니다(macOS 15.7.4, arm64). Windows는 실측하지 않았고, `tests/dependencies.test.mjs:76`, `tests/opencodex.test.mjs:459`의 `posixOnly` 때문에 Windows에서는 일부 테스트가 건너뛰어집니다. 또한 OpenCodex 프록시 시작은 Windows에서 명시적으로 거부됩니다(`opencodex.mjs:471`). Windows 설치·실행 경로가 결정적 테스트로 검증되었다고 쓸 수 없습니다.
- 부분인 이유 2: `tests/dependencies.test.mjs`의 가짜 `npm`은 항상 실패하도록 만들어져(`healthyRuntime`, 같은 파일 96행 부근) 새 설치가 성공하는 경로를 결정적 테스트가 덮지 않습니다. 이 경로는 실측 JSON(`install-actual`, `repair-real-npm`)으로만 확인됩니다.
- 이 문서를 추가한 뒤의 `npm run format`, `npm run sync`, `npm run lint`, `npm test` 결과는 문서 끝의 "커밋 전 검사"에 적었습니다. PR CI와 관련 eval의 PR 단계 실행은 아직 없으므로 통합 단계에서 확인할 사항입니다.

### 기준 8: 최신 origin/main 기준 검증·검토·수용 증거와 통합 HEAD

**미충족**

- 이 항목은 아직 수행되지 않았습니다. 현재 증거의 기준은 중간 통합 HEAD `6db7efc`(`origin/main`의 `fbf2d63` 병합 커밋)입니다. 브리프가 명시하듯 이 증거만으로 close-ready를 보낼 수 없습니다.
- 통합 단계에서 확인할 사항은 이 문서 끝에 정리했습니다.

## 관점별 판정

### 설치 안전성

설치는 `~/.omt/runtime/opencodex/` 아래의 소유 접두사에서만 일어나고, 스테이징에서 `npm ci`와 검증을 마친 뒤 활성 포인터를 바꿉니다. 잠금(`runtime-install-locked`)과 원자적 교체가 있고, 실측에서 실제 사용자 상태는 바뀌지 않았습니다. 이 결론은 격리된 HOME으로 실행한 측정에만 해당합니다. 실제 HOME에서 상태 확인을 실행하는 경로는 측정되지 않았습니다(F-4).

### 구독 계약

provider, account, subscription, model, effort, pool은 논리 바인딩으로 보존됩니다. 실제 실행은 OpenAI 고정 계정으로 제한되고, 그 밖의 경우는 실행이 아니라 차단으로 끝납니다. API 키 과금으로 대체하는 경로는 코드에 없고 테스트가 이를 확인합니다. 풀 모드의 자동 전환은 OpenCodex가 2개 이상의 계정에서 429 재시도를 끌 수 없으므로 막는 쪽으로 처리했습니다(`opencodex-pool-unverified`).

### 호환성

기존 조직과 진행 중인 workflow 스냅샷은 `runner`가 없으면 기존 경로로 읽힙니다. 옛 역할 이름과 깊이 5의 읽기 처리는 유지되고 새로 추가된 곳은 없습니다. 이 항목은 `tests/`의 회귀 테스트와 `role-dispatch` 테스트가 통과한 것으로 확인했습니다. 실제 진행 중인 스냅샷 파일로 읽어 본 검증은 하지 않았습니다.

### 중복 제거와 남는 경계

중복 제거는 수행되지 않았고, 남는 경계는 다음과 같습니다. Claude와 Agy 실행기, 폴더 신뢰 질문과 Enter 제출, 상위 요청 중 취소, Windows 프록시 시작이 그대로 기존 코드에 남습니다.

### 근거의 충분성

코드 수준의 근거는 충분합니다(테스트 526개 통과, 세 갈래 검토 approved). 구독 수준의 근거는 W1의 조사 실행에 한정되며 OMT runner를 거친 실행은 없습니다. 플랫폼 근거는 macOS 한 대, Node v26.7.0 한 벌입니다.

## 별도 finding

### 전환 누락

**발견함.**

- F-1 (중간): runner는 OpenAI 고정 계정만 지원합니다. `validateOpenCodexRunner`(`opencodex.mjs:15-31`)와 계정 홈 검증(`opencodex.mjs:90-134`)이 Claude와 Agy 홈을 거부합니다. 브리프의 세 구독 중 두 구독이 OMT runner로 전환되지 않았습니다.
- F-2 (중간): 수용 기준 6이 요구한 중복 코드 제거와 코드 감소 보고가 없습니다. 삭제 28행이 전부이며 실행기 코드 제거는 없습니다.
- F-3 (낮음): W1 판정은 전면 전환 보류였는데 OpenCodex는 카탈로그에 선언되어 있습니다. 실행은 runner 블록이 있는 프로필로만 일어나므로 강제 전환은 아닙니다.

### 자격 증명 노출

**발견함(낮음).**

- F-5: `readOpenCodexObservation`은 OpenCodex 2.59.0의 요청 이력 행을 그대로 `opencodex.json`에 남깁니다(`opencodex.mjs:722-769`). 행에는 PII가 아닌 `accountLogLabel` 외에 `conversationId`, `apiKeyId`, `routeDecision`이 있습니다. 토큰이나 키 값이 아님을 코드로 확인했지만, 허용 목록으로 필드를 제한하지 않아 버전이 바뀌면 다른 필드가 들어올 수 있습니다.
- 확인 방법: 환경 변수 제거 코드(`opencodex.mjs:38-81`)와 플랫폼 실측 JSON을 읽었습니다. 실측 JSON에는 `~/.codex/auth.json`의 크기와 수정 시각만 있고 내용이나 해시는 없습니다. 자격 증명을 출력하는 코드 경로는 발견하지 못했습니다.

### 전역 주입

**발견함(미검증 경로, 낮음).**

- 스크립트에서 `ocx init`, `ocx service`, Codex·Claude 설정 파일 쓰기는 발견하지 못했습니다. `grep`으로 `init`, `service`, `config.toml`, `settings.json` 쓰기를 찾았습니다.
- F-4: 설치 중 상태 확인(`dependencies.mjs:314-360`)은 `OPENCODEX_HOME`과 `CODEX_HOME`만 격리하고 `HOME`은 실제 값을 유지합니다. 임시 설정으로 `clientIntegrations.codex`와 Claude 통합을 끄지만, 실제 HOME에서 `ocx start`가 어떤 파일을 쓰는지는 측정되지 않았습니다. 플랫폼 실측은 HOME까지 임시 디렉터리로 바꿨기 때문에 이 경로를 덮지 못합니다. 또한 종료는 리더 프로세스에만 `SIGTERM`을 보내며(`dependencies.mjs:352` 부근), 어떤 응답이든 `/healthz`의 `response.ok`면 통과합니다(`dependencies.mjs:345`).

### 묵시적 모델·계정 교체

**발견함(낮음, 차단급 아님).**

- F-6: `role-command`는 runner 블록이 있는 프로필에 대해서도 일반 `codex` 실행 인수를 반환합니다. 임시 조직 파일로 재현했습니다(`runner.accountHomeRef: codex-chatgpt`, 프로필 `gpt-5.6-sol`). 출력은 `codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol --config model_reasoning_effort=high`이며 `runner.actualRunner`는 `"codex"`로 표시됩니다. `role-terminal`은 `teams-org.mjs:1213-1216`의 단언으로 이를 막지만 `role-command`에는 같은 단언이 없습니다. `worker-start --terminal`은 runner 프로필의 이름 있는 계정을 허용하도록 완화되어 있어(`role-launch.mjs:151-160`) 사람이 손으로 연 터미널이면 통과할 수 있습니다. 이 경로로 실행되면 활성 Codex 로그인이 프로필의 계정과 다른 계정일 수 있고 OMT는 이를 검증하지 않습니다. 다만 출력 메타데이터가 `actualRunner: "codex"`를 명시하므로 조용한 교체는 아니고, OMT 자동 경로에서는 발생하지 않습니다.
- F-7 (낮음): runner 헤드리스 실행은 항상 승인 우회 플래그를 씁니다(`headless-runner.mjs:182`, `writable: true`). 이는 기존 프로필의 우회 플래그 관례와 같습니다.
- 자동으로 다른 구독·계정·모델·API 과금으로 넘어가는 코드 경로는 발견하지 못했습니다. 확인 방법은 `opencodex.mjs`의 고정 계정 검증, `api-key-fallback-blocked`, 풀 차단 코드를 읽고 관련 테스트가 통과함을 확인한 것입니다.

### 출력만 보고 완료 판단

**발견하지 못함.** 확인 방법: `headless.mjs`의 결과 판정(`runnerTurnProven`, `unverifiable`)과 `headless-runner.mjs`의 수명주기 생성 코드를 읽고, 화면 출력이 아니라 프로세스 종료와 요청 이력 증명으로 단계가 올라가는지 확인했습니다. 리뷰 finding `lifecycle-promoted-from-output`이 resolved였고, 관련 테스트(`tests/headless.test.mjs`)가 통과했습니다. 다만 입력 수락 이후 제출과 `turn_started`의 실제 터미널 확인은 없으므로 이 부분은 "출력만 보고 판단"이 아니라 "미확인"으로 남습니다(기준 6).

### 미검증 Windows

**발견함.**

- F-9 (중간): Windows 실측이 전혀 없습니다. 프록시 시작은 Windows에서 거부되고(`opencodex.mjs:152, 165, 195, 471`), `posixOnly` 테스트는 건너뛰어집니다. 카탈로그에는 windows 항목이 있으나 실측으로 검증되지 않았습니다. 가이드와 문서가 Windows 지원을 주장하지 않는지는 가이드 리뷰 4(`guide-support-limits-overclaim` resolved)로 확인했습니다.

### 그 밖의 finding

- F-8 (낮음): Linux가 카탈로그의 macOS 항목으로 조용히 매핑됩니다(`dependencies.mjs:97`). 지원 플랫폼 표현과 어긋날 수 있습니다.
- F-10 (낮음): 플랫폼 실측은 Node v26.7.0, 커널 거부 로그 신뢰 불가, `~/.codex`와 `~/.claude` 전체 비교 없음이라는 한계를 스스로 밝혔습니다. 이 한계를 이 문서에서 해소하지 않았습니다.
- F-11 (낮음): 가이드 `8e006b5`는 리뷰 4에서 approved였으나 지금 독립 재검토 중입니다. 재검토 결과가 나오면 이 문서의 기준 3, 4 판정을 다시 확인해야 합니다.
- F-12: W1의 Claude 키체인 메타데이터 변경 원인이 확인되지 않았습니다(`opencodex-runtime.md:3`).

## 실행한 검증

- `npm ci`를 새 워크트리에서 실행했습니다.
- `npm test`: 526개 중 526개 통과, 실패 0(16.1초). 문서 추가 전 기준선입니다.
- `runtimeIdentity()` 실행: `sha256:fb0b1f1a6b0b01aa0589b35da8969c010a76c52c3e41d3c6ed6061155e35326f`, 실측 JSON과 일치했습니다.
- 임시 조직 파일(작업 디렉터리 밖)로 `validate`, `role-command`를 실행했습니다(F-6).
- 문서 추가 후 `npm run format`, `npm run sync`, `npm run lint`, `npm test` 결과는 아래 "커밋 전 검사"에 적었습니다.

## 남은 한계

1. Claude 구독 OAuth와 Antigravity 구독은 OMT runner로 한 번도 실행되지 않았고 runner가 지원하지도 않습니다.
2. e4a4 고정 비교와 풀 전환의 동시 요청 기록은 실행하지 않았습니다.
3. 입력 수락 이후의 제출, `turn_started`, 상위 요청 중 취소는 실제 터미널에서 확인되지 않았습니다.
4. Windows 설치와 실행은 실측하지 않았고 프록시 시작이 거부됩니다.
5. 실측은 macOS 15.7.4, arm64, Node v26.7.0 한 환경입니다.
6. 실제 HOME에서의 상태 확인 실행은 측정되지 않았습니다.
7. 중복 코드 제거와 코드 감소 보고가 없습니다.
8. W1의 키체인 메타데이터 변경 주체를 확인하지 못했습니다.

## 통합 단계에서 확인할 사항

이 항목들은 충족으로 표시하지 않습니다.

1. 기준 7의 PR CI(`CI` 워크플로 실행 결과)와 관련 eval의 PR 단계 통과.
2. 기준 8의 실제 최신 `origin/main`에 대한 통합 HEAD, 그 HEAD에서의 `npm ci`, `npm run sync`, `npm run lint`, `npm test`, 검토, 수용 증거.
3. 통합 HEAD에서 플랫폼 실측의 `plugin_tree` 일치 재확인.
4. 가이드 `8e006b5`의 재검토 결과 반영.

## 이사에게 보고할 사항

1. 수용 기준 8개 중 충족은 없습니다. 7개가 부분 충족이고, 기준 8은 통합 전이라 미충족입니다.
2. Claude 구독과 Antigravity 구독은 runner 경로가 없습니다. 이번 범위에서 제외할지, 후속 작업으로 둘지 결정이 필요합니다(F-1).
3. 중복 코드 제거와 코드 감소 보고가 이루어지지 않았습니다. 후속으로 둘지 기준 6을 조정할지 결정이 필요합니다(F-2).
4. Windows는 실측이 없으므로 지원을 선언하지 않는 표현을 유지해야 합니다(F-9).
5. `role-command`가 runner 프로필에 일반 Codex 실행 인수를 반환합니다. 결함 수정은 이 작업의 범위 밖이어서 고치지 않았습니다(F-6).
6. 실제 HOME에서의 상태 확인과 W1 키체인 변경은 사용자의 관찰이 필요할 수 있습니다(F-4, F-12).
7. 통합 단계 확인 사항 4가지를 담당할 역할을 정해야 합니다.

## 커밋 전 검사

이 문서를 추가한 작업 트리에서 다음 결과를 확인한 뒤 커밋했습니다.

- `npm run format`: 완료, 이 문서 외 변경 없음.
- `npm run sync`: `changed`와 `missing`이 모두 빈 목록.
- `npm run lint`: `quality` 감사 finding 없음, `format:check` 통과.
- `npm test`: 526개 중 526개 통과, 실패 0, 건너뜀 0.
