# OpenCodex 후속 설계: Claude·Agy fixed-account runner와 Windows 프록시 시작

작성 기준은 `b625b25`(OMT 2.8.2)와 설치된 OpenCodex 2.59.0입니다. 이 문서는 설계만 확정하며 로그인, 계정 조작, 프록시 기동, 모델 호출은 하나도 수행하지 않았습니다. 후속 구현 task(claude-agy-runner, windows-proxy, runner-measure)와 사람의 격리 로그인 요청은 이 문서를 근거로 삼습니다. 독립 검토(`review-runner-design-1`)가 반려한 8건을 반영한 개정판이며, 개정에는 PM 결정 세 가지가 들어 있습니다(D절에 요약했습니다).

## 판정 요약

### Claude runner

구현은 가능하지만 아직 지원 완료로 쓸 수 없습니다. W1 실측이 이미 확인한 것은 다음과 같습니다. `anthropic/claude-sonnet-4-6`을 Codex CLI로 요청하면 프록시가 접두사를 뗀 `claude-sonnet-4-6`으로 라우팅했고, 파일 수정과 테스트 실패에서 성공까지 완료했으며, 요청 이력의 provider는 단일 OAuth 계정에서 `anthropic`이었습니다(W1:91, `experiments/opencodex/evidence.json`의 `requestHistory`). 이 이력에는 계정 표식이 없으므로, 계정 홈에 `anthropicAccountPool.enabled`만 켜서 `anthropic-p<hex6>` 접미사를 표식으로 삼는 설계가 필요합니다. 이 방식이 계정 1개 홈에서 실제로 요청을 통과시키는지, OMT 검증기와 증명 규칙을 연결한 뒤에도 성립하는지, 압축 요청이 다른 provider로 새지 않는지는 실측 전이므로 미검증입니다.

- 자동으로 증명할 수 있는 것: 계정 홈에 대상 provider 계정이 하나뿐이고 다른 provider 경로가 없다는 점, 이력의 provider 표식(접미사 포함)과 모델 문자열.
- 사람이 확인해야 하는 것: 로그인한 Claude 계정이 OMT 전용 실행에 써도 되는 계정인지, 구독 등급, 청구 귀속, 제3자 프록시 사용이 약관에 부합하는지.

### Agy runner

구현이 가능하며 현재 구조에 가장 가깝습니다. W1 실측은 두 Agy 계정에서 HTTP 200 요청 3건씩의 계정 표식(`oa45d2e`, `o097be0`)과 sendCount 1을 실제 행에서 관측했습니다(W1:92-93). 새로 필요한 것은 OMT 검증기와 증명 규칙을 Agy에 연결하는 일이며, 이 연결과 압축 경로는 실측 전이므로 미검증입니다.

- 자동으로 증명할 수 있는 것: 계정 1개와 OAuth 출처, 계정 라벨(`o<hex6>`), 요청 모델.
- 사람이 확인해야 하는 것: 로그인 화면에서 올바른 Google 계정을 고르는지, 구독 등급(W1:84는 API가 등급을 돌려주지 않았다고 기록했습니다), 청구 귀속, 약관.

### Windows 소유권 증명

시작 경로의 소유권 증명은 설계할 수 있습니다. 헬스 응답의 `pid`, 리스너 PID, 스냅샷으로 기록한 자식 프로세스 목록을 대조하는 방식입니다. 다만 이 증명은 런처와 bun의 부모 자식 관계(U6), 실제 bun 명령줄과 실행 파일(U8), shim spawn의 `EINVAL` 여부(U7)가 Windows에서 실측되어야 성립하며, 이 셋은 아직 미확인입니다. 종료는 프로세스 그룹이 없어서 "기록한 PID 스냅샷이 모두 사라짐"까지만 증명할 수 있고, 이를 POSIX의 `"exited"`와 구별하는 `"exited-snapshot"`으로 기록합니다. PM 결정에 따라 `runnerTurnProven`의 요건은 완화하지 않으므로 Windows의 runner turn은 계속 unverified로 남습니다. windows-proxy task의 목표는 시작 경로의 소유권 증명과 그 한계의 정직한 기록입니다.

### 미확인 항목 수

이 문서가 "미확인"으로 표시한 항목은 모두 17개이며 [C절](#c-미확인-목록)에 `U1`부터 `U17`까지 모았습니다. 첫 판의 19개 가운데 W1 실측이 이미 답한 3개(접두사가 붙은 모델의 통과, 실제 모델 값, usage 보고)는 확인된 사실로 옮겼고, 새로 1개(U17)를 더했습니다.

## 0. 근거 표기 규칙

- `PKG`는 설치된 OpenCodex 패키지 루트 `~/.omt/runtime/opencodex/runtimes/<fingerprint의 hex>/node_modules/@bitkyc08/opencodex`입니다. `PKG/src/...:줄` 인용은 읽기 전용으로 확인한 사실입니다.
- `W1`은 `docs/plan/opencodex-runtime.md`이고 `W1:91`은 그 문서의 줄입니다. W1의 실측 원본은 `experiments/opencodex/evidence.json`입니다.
- OMT 저장소의 파일은 `plugins/oh-my-teams/scripts/opencodex.mjs:줄`처럼 인용하거나, 같은 디렉터리이면 `opencodex.mjs:줄`로 줄여 씁니다.
- 소스로 확인하지 못했거나 실행해 보지 못한 내용은 "미확인"이라 쓰고 `[U번호]`를 붙였습니다. 실측하지 못한 동작은 지원 완료로 쓰지 않고 "미검증"이라 씁니다. 미확인은 사실을 모르는 것이고 미검증은 소스로 예상한 동작을 실측하지 않은 것입니다.
- 활성 런타임은 `~/.omt/runtime/opencodex/active.json`이 가리키며 이 문서를 쓸 때 확인한 버전은 2.59.0입니다.

## A. Claude·Agy fixed-account runner

### A1. 계정 홈 구조와 "계정 하나로 고정됨"의 검증 조건

OpenAI(Codex) 전용 검증기 `validateFixedOpenCodexAccountHome`(`plugins/oh-my-teams/scripts/opencodex.mjs:84-134`)은 `config.json`의 `codexAccounts`와 `codex-accounts.json`을 읽습니다. 그리고 `resolveOpenCodexBinding`(`opencodex.mjs:783-805`)은 항상 이 검증기를 호출합니다. Claude와 Agy에는 같은 검증기가 없으므로 provider별 검증기가 새로 필요합니다.

**두 번째 계정이 있으면 OpenCodex가 스스로 다른 계정으로 넘어갑니다. provider마다 활성 조건이 다릅니다.**

- google-antigravity는 generic OAuth 429 failover 대상입니다. `authMode`가 `oauth`이고 `openai`, `anthropic`이 아닌 provider가 대상이며(`PKG/src/oauth/generic-account-failover.ts:68`, `:100-157`), 재인증이 필요하지 않은 계정이 둘 이상이면 켜집니다. W1은 설치 모듈에 `enabled=false`를 넘겨도 `reactiveFailoverEnabled=true`임을 확인해 끌 수 없다고 기록했습니다(W1:104-106).
- anthropic은 generic failover에서 제외되고 자체 규칙을 씁니다(`PKG/src/oauth/generic-account-failover.ts:68`). 회전 함수 `rotateAnthropicAccountOn429`는 첫 분기에서 "pool이 꺼져 있고 failover quorum도 없으면" 회전하지 않습니다(`PKG/src/oauth/anthropic-routing.ts:703-717`). quorum은 재인증이 필요하지 않고 자격 증명이 쓸 수 있는 계정이 둘 이상일 때 성립합니다(`PKG/src/oauth/anthropic-routing.ts:332-350`). 따라서 pool이 꺼져 있으면 계정이 둘 이상일 때 회전이 켜지고, pool이 켜져 있으면 계정 수와 무관하게 회전 경로가 실행됩니다. pool 설정을 읽는 helper는 `PKG/src/oauth/anthropic-routing.ts:101-112`에 있습니다.
- 계정 하나만 든 홈은 이 모든 경로에서 대안이 없으므로 유일한 방어입니다. W1은 단일 계정 홈에서 failover 판정이 false였고 요청 이력도 다른 계정으로 바뀌지 않았음을 확인했습니다(W1:112-116). 이 방어는 다른 구독이나 API 과금으로 자동 전환하는 경로를 만들지 않기 위한 것이기도 합니다.

계정 홈의 파일 구조는 다음과 같습니다.

| 파일 | 내용 | 근거 |
|---|---|---|
| `auth.json` | provider별 `activeAccountId`와 `accounts` 배열. 자격 증명이 들어 있으므로 OMT는 내용을 출력하지 않고 개수와 플래그만 읽습니다. | `PKG/src/oauth/types.ts:79-96`, W1:58 |
| `config.json` | 프록시 설정, 시작 동기화 가드, 풀 설정, combos, provider별 항목. | `PKG/src/cli/index.ts:596-650`, `PKG/src/oauth/pool-settings-capability.ts` |
| `ocx.pid`, `runtime-port.json` | 실행 중인 프록시의 pid와 포트 기록. `ocx account ...`가 프록시를 찾는 데 씁니다. | `PKG/src/config/process-state.ts:14`, `:18` |
| `admin-api-token` | 요청 이력 조회용 토큰. OMT가 헤더에만 싣고 값은 기록하지 않습니다. | `opencodex.mjs`의 `readOpenCodexHistory`(615행 이후) |

새 검증기 `validateFixedOpenCodexOAuthHome(accountHome, provider)`가 turn 시작 전에 통과시켜야 하는 조건은 다음과 같습니다. provider는 `anthropic` 또는 `google-antigravity`입니다.

1. `auth.json[provider].accounts`가 정확히 하나이고 `activeAccountId`가 그 계정의 id와 같습니다.
2. `auth.json`에 다른 provider 항목의 계정이 없고, `codexAccounts`와 `codex-accounts.json`이 없거나 비어 있습니다. 대상이 아닌 provider의 자격 증명이 홈에 남아 있으면 라우터가 그 경로로 떨어질 수 있기 때문입니다.
3. 그 계정의 `credential.source`가 `oauth`이고 `needsReauth`가 설정되어 있지 않습니다. `source` 값의 집합은 `oauth`, `local-cli`, `credential-file`, `environment`, `manual`이며 필드는 선택입니다(`PKG/src/oauth/types.ts:2`, `:64`). 로그인 직후 실제로 어떤 값이 기록되는지는 미확인입니다 [U2].
4. `config.json`에 `combos`가 없고 어떤 `providers.<name>`에도 `apiKey*` 항목이 없습니다. `anthropic-apikey`라는 API 키 provider가 registry에 따로 있어서 접두사 없는 `claude-*` 모델은 키 경로로 라우팅될 수 있기 때문입니다(`PKG/src/providers/registry/entries-core.ts:386-428`, `:994`).
5. 라우팅 조건: `providers.<대상>`이 존재하고 `authMode`가 `oauth`이며 `disabled`가 아니고, `defaultProvider`가 대상 provider입니다. `providers.openai`는 없거나 `disabled`입니다. 라우터는 `<provider>/<모델>` 접두사가 구성된 provider와 맞을 때만 그 provider로 보내고 그렇지 않으면 접두사 모델을 그대로 통과시켜 `defaultProvider`로 보냅니다(`PKG/src/router.ts:697-745`, `:844-850`). Codex CLI는 압축 때 접두사 없는 모델을 보내며, `gpt-`·`o1-` 같은 모델은 `openai` provider로, 나머지는 압축 전용 경로에서 `defaultProvider`로 갑니다(`PKG/src/router.ts:551-553`, `:776-803`). 이 조건은 그 요청이 다른 계정이나 provider로 나가지 않고 대상 provider로 가거나 실패하게 만듭니다. 이력 검사는 요청이 나간 뒤에 걸러내므로 이 조건을 대신하지 못합니다. 빈 홈에서 `ocx`가 provider 항목과 `defaultProvider`를 자동으로 만드는지는 미확인이므로 로그인 뒤 검증 스크립트가 값을 읽어 확인합니다 [U17].
6. anthropic 전용 pool 조건: `anthropicAccountPool`은 `enabled: true` 키 하나만 허용합니다. `autoSwitchThreshold`, `strategy`, `stickyLimit`, `quotaWindow` 같은 다른 키가 있으면 거부합니다(`PKG/src/oauth/anthropic-routing.ts:57-66`, 기본 임계값 80은 `:51`). pool 활성은 세션 친화, 할당량 순위 선택, 임계값 기반 사전 라우팅을 함께 켜지만(`PKG/src/oauth/anthropic-routing.ts:566-640`) 계정이 하나이면 고를 대안이 없습니다. 모든 계정이 쿨다운이면 프록시는 429를 그대로 돌려주고(`PKG/src/server/responses/request-transport.ts:466-480`), 회전 함수도 대안이 없으면 429를 반환합니다(`PKG/src/oauth/anthropic-routing.ts:747`). 즉 429는 다른 계정이나 provider로 넘어가지 않고 실패로 드러나야 하며, 이 동작은 미검증입니다. 이력에서 서로 다른 `anthropic-p<hex6>` 접미사가 하나라도 나오면 그 turn을 거부합니다(A2).
7. agy 전용 조건: generic failover 설정 항목(`oauthAccountFailover`)을 config에 두지 않습니다. 이 항목이 켜짐을 바꾸는지는 W1:104가 "확인하지 않는다"고 기록했으므로 기대하지 않습니다.
8. 시작 동기화 가드가 있습니다. `runtimeRole === "hub"`, `clientIntegrations.codex === false`, `claudeCode.enabled === false`(또는 `systemEnv`와 `injectAgents`가 모두 `false`)입니다. 기존 OpenAI 검증기가 이미 같은 가드를 요구합니다(`opencodex.mjs:120-133`). `ocx start`는 시스템 환경 변수 주입과 셸 훅 정리(`PKG/src/cli/index.ts:576-579`), Codex 설정 동기화(`PKG/src/cli/index.ts:587`, 허용 조건은 `PKG/src/codex/desired-state.ts:132-139`), Claude 에이전트 목록 동기화(`PKG/src/cli/index.ts:590`), Claude Desktop 레지스트리 등 다른 클라이언트 동기화(`PKG/src/cli/index.ts:596-650`)를 호출합니다. W1도 두 홈 환경 변수만으로는 무변경을 보장할 수 없어 hub 역할과 비활성화 설정을 함께 썼다고 기록했습니다(W1:64).
9. 계정 라벨을 `auth.json`의 계정 id에서 해시로 계산해 프로필 표식과 대조합니다(A2). id와 이메일은 출력하지 않고 계산한 라벨만 다룹니다.

`ocx account login <provider>`가 남긴 자격 증명의 정확한 필드값과 key-store, `canonicalAuthMode`가 이 판정에 주는 영향은 미확인입니다 [U2]. key-store가 opt-in이고 W1이 켜지 않았다는 점은 확인했습니다(W1:60).

### A2. 요청 이력으로 증명하는 방법과 증명할 수 없는 것

OMT는 turn 뒤에 `/api/request-history`를 `X-OpenCodex-API-Key` 헤더(계정 홈의 `admin-api-token`)로 커서 페이지 조회하고, turn 시작 전에 잡아 둔 boundary 이전의 ID를 제외합니다(`opencodex.mjs:615-702`, `:727-774`). 이력 행에서 증명하는 항목은 provider, 계정 표식, 모델입니다.

**provider와 계정 표식**

| provider | 이력의 provider 필드 | 계정 표식 | W1 실측 | 근거 |
|---|---|---|---|---|
| google-antigravity | `google-antigravity` | attempt의 `accountLogLabel = o<hex6>`. `hex6 = sha256(baseProvider + "\0" + storeAccountId)[0:6]`입니다. | 계정 둘의 HTTP 200 요청 3건씩에서 `oa45d2e`, `o097be0`를 관측했고 sendCount는 1이었습니다(W1:92-93). | `PKG/src/providers/label.ts:59-70`, `PKG/src/codex/account-label.ts:36-38` |
| anthropic(pool 꺼짐, 계정 1개) | `anthropic` | 없음. 계정 증명이 불가능합니다. | 3건 모두 provider가 `anthropic`이었고 OAuth 단일 계정이었습니다(W1:91). | 표식은 pool이 켜진 선택(`PKG/src/server/responses/request-transport.ts:466-490`)이나 실패 후 회전(`:239-241`)에서만 provider에 붙습니다. pool이 꺼져 있으면 계정 identity를 기록하지 않는다는 주석이 `:560-566`에 있습니다. |
| anthropic(pool 켜짐, 계정 1개) | `anthropic-p<hex6>`. `hex6`은 계정 id의 해시입니다. | provider 접미사 자체가 표식입니다. | 실측 전입니다 [U14]. | `PKG/src/oauth/anthropic-routing.ts:859-870`, `PKG/src/providers/label.ts:52` |

`isCodexUsageAccountLogLabel`을 통과하지 못한 라벨은 attempt에서 삭제되는데(`PKG/src/server/request-log.ts:1570-1585`), agy의 `o<hex6>` 라벨은 W1의 실제 이력 행에 남았으므로 이 검사를 통과하는 형식임이 확인되었습니다(W1:92-93).

OMT 쪽 변경 사항은 다음과 같습니다.

- `openCodexProvider`(`opencodex.mjs:606-613`)는 `claude`를 항상 `anthropic`으로 옮깁니다. pool을 켠 홈에서는 라벨에서 계산한 `anthropic-p<hex6>`를 기대 provider로 만들어야 합니다.
- `attemptsProveFixedAccount`(`opencodex.mjs:683-702`)는 attempt의 `accountLogLabel` 일치를 요구합니다. anthropic은 attempt 라벨이 없으므로 "모든 anthropic 행의 provider가 기대 접미사와 정확히 같다"는 규칙을 별도로 둡니다. 한 turn의 행에서 다른 접미사나 접미사 없는 `anthropic`이 하나라도 나오면 거부합니다.
- 계정 라벨은 `auth.json`의 계정 id에서 해시로 계산하며 `codex-accounts.json`에서 읽지 않습니다.

**모델**

- W1 실측은 `anthropic/claude-sonnet-4-6`과 `google-antigravity/claude-sonnet-4-6`을 Codex CLI의 `--model`로 요청했을 때 접두사가 붙은 값이 프록시까지 전달되고 프록시가 접두사를 뗀 `claude-sonnet-4-6`으로 라우팅했음을 확인했습니다(W1:91-93). `evidence.json`의 요청 이력에서 이 값들은 `requestedModel = <provider>/claude-sonnet-4-6`, `model`, `resolvedModel`, `attempts[0].model = claude-sonnet-4-6`이었습니다. 이것으로 접두사 형태의 프로필 모델이 API 키 경로를 피하고 대상 provider로 가는 방식은 확인된 사실입니다(라우팅 근거는 `PKG/src/router.ts:697-745`).
- 이 절에서 프로필 모델을 `M`, 접두사를 뗀 값을 `strip(M)`이라 씁니다. 프로필의 논리 provider가 `claude`이면 접두사는 `anthropic/`, `agy`이면 `google-antigravity/`이며, `M`이 그 접두사로 시작하면 `strip(M)`은 접두사 뒤의 나머지이고 아니면 `M` 그대로입니다. 프로필의 provider와 다른 provider의 접두사가 붙은 `M`(예: `claude` 프로필에 `google-antigravity/...`)은 turn 전에 프로필 검증에서 거부합니다. 논리 provider가 `codex`인 OpenAI 프로필에는 이 규칙을 적용하지 않으므로 `strip(M) = M`이고 기존 비교는 바뀌지 않습니다.
- W1 실측이 확인한 이력 값과 맞추면 기대값은 `requestedModel = M`, `model`, `resolvedModel`, `attempt.model = strip(M)`입니다. 현재 `readOpenCodexObservation`은 `requestedModel`, `model`, `attempt.model`이 모두 `input.model`과 같다고 요구하므로(`opencodex.mjs:727-774`, `:683-702`) 접두사 프로필에서는 `strip(M)`을 비교 대상으로 나누어야 합니다. 이 함수가 반환하는 `model`은 지금처럼 프로필 모델 `M`으로 두고, 이력에서 관측해 `strip(M)`과 일치함을 확인한 값은 새 필드 `resolvedModel`로 함께 반환합니다. 반환 시점은 모든 이력 행이 검사를 통과한 뒤이므로, 지금 OpenAI 프로필에서 `model: input.model`이 하는 역할(이력과 일치가 확인된 뒤에만 존재하는 값)이 그대로 유지되고 증명의 강도는 약해지지 않습니다. 소비하는 두 경로는 이 `model`을 그대로 받아 비교하므로 소비 쪽 코드의 비교식은 바꾸지 않아도 됩니다.

접두사가 붙은 프로필 모델에서 각 지점이 어떤 값끼리 비교하는지는 다음과 같이 정합니다.

| # | 지점 | 위치 | 왼쪽 값 | 오른쪽 값 | 접두사 프로필의 판정 | OpenAI 프로필 | 불일치 시 |
|---|---|---|---|---|---|---|---|
| 1 | 관측: 이력 행의 요청 모델 | `opencodex.mjs:727-774` | 행의 `requestedModel` | `M` | 같아야 통과 | 변경 없음(`M`) | 관측이 `opencodex-binding-unverified`로 실패하고 turn을 증명하지 못합니다. |
| 2 | 관측: 이력 행의 실행 모델 | `opencodex.mjs:727-774` | 행의 `resolvedModel ?? model` | `strip(M)` | 같아야 통과 | `strip(M) = M`이라 변경 없음 | 위와 같습니다. |
| 3 | 관측: attempt의 모델 | `opencodex.mjs:683-702` | 각 attempt의 `model` | `strip(M)` | 모든 attempt가 같아야 통과 | 변경 없음 | 위와 같습니다. |
| 4 | 관측: 반환값 | `opencodex.mjs:727-774` | 해당 없음 | 해당 없음 | `model = M`, `resolvedModel = strip(M)`를 반환하고 이는 1~3번 통과 뒤에만 존재합니다. | `model = M`이고 `resolvedModel`은 같은 값 | 반환하지 않고 실패합니다. |
| 5 | headless-start: worker 기록의 모델 판정 | `headless.mjs:517-529`, `:849-852` | `observation.model`(4번의 `M`) | `worker.modelRequested`(`startHeadlessWorker`가 받은 프로필 모델 `M`, `headless.mjs:672`) | 문자열이 같으므로 `matched` | 변경 없음 | 값이 다르면 `mismatched`, 관측 파일이 없으면 스트림의 값으로 대체되며 이때는 `runnerTurnProven`이 실패합니다(`headless.mjs:756`). |
| 6 | work: `modelBinding` | `providers.mjs:132-146`, `:278-285` | `profile.model`(`M`) | `effectiveModel`(4번의 `observed.model`, 곧 `M`) | 같으므로 `matched` | 변경 없음 | 관측이 이미 실패했으면 `modelBinding`에 닿기 전에 예외로 끝나고, 값이 다르면 `opencodex-model-unproven-or-mismatched`로 거부합니다. |

- 1~3번이 이력에서 관측한 값과 대조하는 유일한 증명 지점이며, 5번과 6번은 그 증명을 통과한 `M`이 프로필 모델과 같은지 다시 확인하는 정합 검사입니다. 정규화 구현자가 4번에서 `strip(M)`을 `model`로 반환하면 6번이 모든 turn을 거부하므로 `model`은 `M`으로 유지해야 하며, 이 조건을 claude-agy-runner의 테스트로 고정합니다.
- 접두사 프로필의 1~3번은 W1이 관측한 값에 맞추는 것이고, OMT 경로에서 재현되는지는 A5의 5번이 확인합니다.

**증명할 수 없는 것**

- 구독 등급: W1은 API가 `currentTier`와 `paidTier`를 돌려주지 않았고 API plan이 null이었다고 기록했습니다(W1:84, W1:91). 등급은 사람의 로그인 확인이 유일한 근거입니다.
- 청구 귀속: 요청이 어느 결제 주체에 청구되었는지는 프록시 바깥의 일이며 이력에 남지 않습니다. W1도 Codex의 usage 보고가 청구서 금액이나 구독 차감량을 뜻하지 않는다고 기록했습니다(W1:98).
- 약관 준수: 제3자 프록시를 거친 구독 OAuth 사용이 약관에 부합하는지는 사람이 판단합니다.
- 이력의 보존 정책은 확인하지 못했습니다 [U3]. 실측에서는 turn 직후에 조회하고, 보존 정책이 확인되기 전까지 지연 조회에 의존하지 않습니다.

### A3. 실제 실행기와 경로별 동작

claude·agy 프로필이 runner를 가져도 실제로 실행되는 것은 Claude나 Antigravity의 CLI가 아닙니다. `openCodexCommand`(`opencodex.mjs:564-599`)가 만드는 것은 Codex CLI(`codex exec --json ...`)이고, `model_provider=omt-opencodex`, `base_url=http://127.0.0.1:<port>/v1`, `wire_api="responses"`로 로컬 OpenCodex 프록시에 요청합니다. 모델 인자는 프로필의 모델(접두사 형태)이고, `model_reasoning_effort`는 프로필 effort입니다.

- effort 허용 값은 provider마다 다릅니다. claude는 `low`부터 `max`, agy는 `low`, `medium`, `high`, codex는 `low`부터 `ultra`입니다(`plugins/oh-my-teams/scripts/providers/{claude,agy,codex}.mjs`). OpenCodex가 Codex CLI의 effort를 anthropic·antigravity 어댑터에서 어떤 값으로 옮기는지는 미확인입니다 [U13].
- W1은 Codex CLI가 Claude와 Agy 어댑터를 통해 파일 읽기, 수정, 테스트 실행을 수행함을 확인했습니다(W1:91-93). W1이 실행하지 않은 도구 종류가 어디까지 변환되는지는 미확인입니다 [U1]. Codex가 보고한 usage는 W1:98에 기록되어 있습니다.

**두 경로의 샌드박스는 다릅니다.** `openCodexCommand`는 `writable`이 참이면 `--dangerously-bypass-approvals-and-sandbox`를, 아니면 `--sandbox read-only --ephemeral`을 붙입니다(`opencodex.mjs:573-575`). headless-start의 `prepareOpenCodexTurn`은 `writable: true`를 넘기고(`headless-runner.mjs:182`), work의 `invoke`는 `writable`을 넘기지 않습니다(`providers.mjs:236-244`). 따라서 headless-start는 파일 수정과 명령 실행이 가능하고 work는 읽기 전용으로 실행되며 세션도 저장하지 않습니다. 이 차이가 A5의 경로별 측정 항목을 결정합니다.

경로별 동작은 다음과 같습니다.

| 경로 | 진입 | runner 처리 | 샌드박스 | 현재 상태 | 설계 |
|---|---|---|---|---|---|
| headless-start | `teams-org.mjs:815-850` → `startHeadlessWorker`(`headless.mjs:626-690`) | `command.runner`를 그대로 전달하고 `launchTurn`(`headless.mjs:580-625`)이 프록시를 띄웁니다. | 쓰기 가능 | `HEADLESS_PROVIDERS` 검사(`teams-org.mjs:824`)와 스트림 파서가 `worker.provider`를 기준으로 고릅니다(`headless.mjs:696`, `:806`, `:823`). claude 프로필은 claude 스트림 파서를 고르므로 Codex 스트림을 잘못 해석합니다. | 파서를 `actualRunner`(codex 스트림) 기준으로 고르도록 바꿉니다. `runnerTurnProven`(`headless.mjs:745-770`)은 그대로 씁니다. |
| work | `teams-org.mjs:1370` → `worker.mjs` `invoke` → `providers.mjs:205-330`의 runner 분기 | detached로 spawn하고 그룹 kill을 씁니다(`providers.mjs:246-265`). 디코더는 `adapterFor({...profile, provider:"codex"}).decode`입니다(`providers.mjs:267`). | 읽기 전용, 세션 저장 안 함 | 이미 Codex 스트림 디코더를 쓰므로 스트림 해석은 provider와 무관하게 동작할 수 있습니다. | 프로필 검증을 provider별 검증기(A1)와 표식 규칙(A2)에 연결합니다. 쓰기 권한은 넓히지 않습니다(A5의 PM 결정 필요 항목). |
| role-command | `teams-org.mjs:1278-1287` | runner 프로필을 거부합니다(assert는 `:1282-1286`). | 해당 없음 | 그대로 둡니다. | role은 대화형 터미널이며 프록시 turn 수명과 맞지 않으므로 거부를 유지합니다. |
| role-terminal | `teams-org.mjs:1289-1296` | runner 프로필을 거부합니다(assert는 `:1291-1295`). | 해당 없음 | 병렬 kickoff 소유이므로 이 task에서 손대지 않습니다. | 거부를 유지합니다. |
| worker-start | `role-launch.mjs:246-262` | runner 프로필을 거부합니다(`role-launch.mjs:250-256`). | 해당 없음 | 그대로 둡니다. | 거부를 유지합니다. |

`roleCommand`(`role-launch.mjs:366-408`)는 runner가 있으면 `actualRunner`를 `argv[0]`의 basename에서 동적으로 계산한 객체를 만듭니다(`:386`, validation 이전 코드 기준). `launchableProfile`(`role-launch.mjs:152-176`)은 `ORCA_LAUNCH`에 없는 provider를 예외 없이 거부하고(`:153-156`), runner 예외는 그 뒤의 "현재 계정, env 없음, 단일 명령" 검사에만 적용됩니다(`:161-166`).

runner를 가진 프로필이 지원되려면 `OPENCODEX_RUNNER_PROVIDERS`(`opencodex.mjs`가 export하는 동결 배열)에 해당 provider가 들어 있어야 합니다. 이 이름은 병렬 task가 추가하고 있으며(이 워크트리에는 아직 없습니다), 지원 목록의 정본으로 가정합니다.

**세션 홈은 계정별 변수로 지정합니다.** 지금 `resolveOpenCodexBinding`은 세션 홈을 계정 이름이 붙지 않은 단일 변수 `OMT_OPENCODEX_SESSION_HOME`에서 읽습니다(`opencodex.mjs:793`). Claude 계정과 Agy 계정을 서로 다른 runner 프로필로 한 실행에서 쓰면 두 계정이 같은 `CODEX_HOME`을 공유하거나 한쪽이 잘못된 홈을 쓰게 됩니다. 설계는 다음과 같습니다.

- 새 변수 `OMT_OPENCODEX_<REF>_SESSION_HOME`을 `OMT_OPENCODEX_<REF>_HOME`, `OMT_OPENCODEX_<REF>_LABEL`과 같은 `<REF>` 규칙으로 도입합니다.
- claude와 agy runner 프로필은 이 계정별 변수만 받습니다. 단일 변수 `OMT_OPENCODEX_SESSION_HOME`이 설정되어 있어도 무시하고, 계정별 변수가 없으면 `opencodex-action-required`로 거부합니다.
- 기존 OpenAI(codex) runner 프로필은 호환을 위해 계정별 변수가 있으면 그것을, 없으면 단일 변수를 씁니다. 이 경우의 동작은 지금과 같습니다.
- 한 실행에서 쓰는 세션 홈은 서로 달라야 하고, 어떤 계정 홈과도 달라야 합니다. 기존 검증은 한 프로필의 계정 홈과 세션 홈이 다를 것만 요구합니다(`opencodex.mjs:38-59`).
- 이 변경은 D절의 claude-agy-runner 범위에 포함합니다.

### A4. 격리 로그인 절차와 사용자 확인 항목

이 절차는 사람이 직접 실행합니다. 이 task는 로그인을 수행하지 않았습니다. `ocx account ...` 명령은 실행 중인 프록시가 필요하므로 터미널 A에서 프록시를 foreground로 띄우고 터미널 B에서 로그인합니다. 두 터미널은 사용자 환경을 물려받지 않는 새 셸에서 실행하며, 어떤 확인 단계든 실패하면 그 자리에서 절차를 중단하고 다음 단계로 넘어가지 않습니다.

**환경을 정리하지 않으면 생기는 문제**

- `ocx` 런처는 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`이 있는지 기록합니다(`PKG/bin/ocx.mjs:787`). 이 값이 있으면 구독 OAuth와 다른 결제 경로가 섞일 수 있습니다.
- 같은 런처의 주석은 Node 런처가 프로젝트 `.env`와 `.env.local`을 읽지 않고, 실제로 실행되는 Bun 자식이 작업 디렉터리의 dotenv를 먼저 읽는다고 설명합니다. 그 값이 구독 OAuth를 API 과금으로 옮기거나 OAuth bearer를 다른 목적지로 보낼 수 있다는 점도 적혀 있습니다(`PKG/bin/ocx.mjs:774-787`). 이 경로는 셸 환경 변수 검사로 보이지 않으므로 절차의 작업 디렉터리를 빈 격리 디렉터리로 고정합니다. OMT 자신의 프록시 spawn도 작업 디렉터리를 런타임 접두사로 고정합니다(`opencodex.mjs:492-505`). 프록시가 이 값을 실제로 소비하는지는 확인하지 못했지만, 절차가 그 가능성을 막지 않는 상태를 허용하지 않습니다.
- 로그인 URL은 기본적으로 프록시가 OS 기본 브라우저에서 자동으로 엽니다. 서버 라우트는 `shouldOpenBrowserForLogin`이 참이면 `openUrl(authUrl)`을 호출하고(`PKG/src/server/management/oauth-account-routes.ts:211-214`), 그 함수는 요청의 `openBrowser`가 없을 때 `config.oauthOpenBrowser`가 명시적 `false`가 아니면 참을 돌려줍니다(`PKG/src/oauth/open-browser-choice.ts:22-25`, 키 타입은 `PKG/src/types/config.ts:422`). `ocx account login`의 요청 본문에는 `openBrowser`가 없으므로(`PKG/src/cli/account-auth.ts:196`) 설정값이 그대로 적용됩니다. 라우트의 주석은 이 설정이 기본 브라우저가 아닌 프로필에서 로그인을 끝내는 유일한 방법이라고 적습니다(`oauth-account-routes.ts:203-209`). 그래서 이 절차는 `oauthOpenBrowser: false`를 가드 config에 넣습니다.
- 로컬 Claude 자격 증명 탐색은 `CLAUDE_CONFIG_DIR`을 읽고 macOS에서는 키체인을 읽습니다(`PKG/src/oauth/local-token-detect.ts:73-78`). W1도 `CLAUDE_CONFIG_DIR`만 바꿔서는 키체인 읽기가 없어지지 않는다고 기록했습니다(W1:62).
- OMT 런타임은 `OPENAI`, `ANTHROPIC`, `GOOGLE`, `GEMINI`, `API` 계열 `KEY`·`TOKEN` 변수와 `OPENCODEX_HOME`, `CODEX_HOME`을 지웁니다(`opencodex.mjs:67-80`). 사람 절차도 같은 수준으로 정리해야 하므로 `env -i`로 새 환경을 만듭니다.

**1단계: 변수 정의 (사용자의 원래 셸, 부작용 없음)**

```sh
PROVIDER=anthropic             # anthropic 또는 google-antigravity
REF=claude-oauth               # 프로필의 account 이름. 환경 변수 이름에 쓰입니다.
PORT=47831                     # 다른 프록시와 겹치지 않는 임의의 빈 포트

FP=$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.omt/runtime/opencodex/active.json","utf8"));console.log(a.fingerprint.replace(/^sha256:/,""))')
OCX="$HOME/.omt/runtime/opencodex/runtimes/$FP/node_modules/.bin/ocx"
ACC="$HOME/.omt/opencodex-accounts/$REF"
```

**2단계: 빈 홈 만들기와 가드 쓰기 (한 번만, 실패하면 중단)**

계정 홈 규칙은 다음과 같습니다. 홈은 작업 디렉터리(저장소), `~/.opencodex`, `~/.omt/runtime` 밖에 있어야 하고, 계정마다 하나씩 따로 만들며, 이미 있는 디렉터리는 재사용하지 않고 거부합니다. 아래 블록은 하위 셸에서 `set -eu`로 실행하므로 어느 줄이든 실패하면 즉시 끝나며 마지막에 `PREPARED`를 출력하지 못합니다. `PREPARED`가 보이지 않으면 다음 단계로 가지 않습니다.

```sh
(
set -eu
test -x "$OCX"; "$OCX" --version
case "$ACC" in "$PWD"/*|"$HOME"/.opencodex*|"$HOME"/.omt/runtime/*) echo "허용되지 않는 위치"; exit 1;; esac
test ! -e "$ACC"                                   # 이미 있으면 여기서 중단합니다. 재사용하지 않습니다.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "포트 사용 중"; exit 1; fi
mkdir -p -m 700 "$ACC" "$ACC/home" "$ACC/codex-home" "$ACC/proxy-home" "$ACC/empty-cwd"
PROVIDER="$PROVIDER" PORT="$PORT" ACC="$ACC" node -e '
const fs=require("fs");
const config={runtimeRole:"hub",clientIntegrations:{codex:false},claudeCode:{enabled:false},oauthOpenBrowser:false,port:Number(process.env.PORT)};
if(process.env.PROVIDER==="anthropic")config.anthropicAccountPool={enabled:true};
fs.writeFileSync(process.env.ACC+"/home/config.json",JSON.stringify(config,null,2),{mode:0o600});
'
echo PREPARED
)
```

- `oauthOpenBrowser: false`는 프록시가 로그인 URL을 기본 브라우저에서 자동으로 열지 않게 하는 소스의 설정입니다(위 "환경을 정리하지 않으면 생기는 문제"의 세 번째 항목). `empty-cwd`는 3단계 이후 모든 명령의 작업 디렉터리이며 계속 비어 있어야 합니다.
- `config.json`의 `port`는 `ocx account ...`가 프록시를 찾지 못했을 때 되돌아가는 조회 포트입니다. 기록이 없으면 `config.port ?? 10100`을 조회하므로(`PKG/src/server/proxy-liveness.ts:281-283`) 이 값을 격리 포트로 미리 정해 사용자가 실제로 쓰는 프록시(기본 10100)에 계정이 추가되는 경로를 막습니다.
- 가드 항목 이름은 `opencodex.mjs:120-133`의 검증기가 읽는 이름과 같습니다. 이 파일을 미리 써 두어도 시작 동기화가 그 값을 유지하는지, `oauthOpenBrowser`가 프록시 시작과 로그인 뒤에도 그대로 남는지, `anthropicAccountPool`의 정확한 구조는 미확인입니다 [U10]. 그래서 5단계가 로그인 전에, 8단계가 로그인 뒤에 파일을 다시 읽습니다.

**3단계: 격리 셸 열기 (터미널 A와 터미널 B 모두)**

터미널 A와 B는 이 절차 전용으로 새로 연 터미널이어야 합니다. 작업 디렉터리를 저장소가 아니라 2단계에서 만든 빈 디렉터리로 옮긴 뒤 새 셸을 엽니다.

```sh
cd "$ACC/empty-cwd" && env -i PATH="$PATH" TERM="$TERM" LANG="${LANG:-en_US.UTF-8}" \
  HOME="$ACC/proxy-home" OPENCODEX_HOME="$ACC/home" CODEX_HOME="$ACC/codex-home" \
  PROVIDER="$PROVIDER" PORT="$PORT" OCX="$OCX" ACC="$ACC" \
  bash --noprofile --norc
```

새 셸에서 다음을 실행해 환경과 작업 디렉터리가 정리되었는지 확인합니다. `중단`이 출력되면 그 셸을 닫고 다시 시작합니다.

```sh
env | cut -d= -f1 | grep -Ei 'anthropic|claude|openai|google|gemini|api|token|key' && echo 중단
test "$(pwd -P)" = "$(cd "$ACC/empty-cwd" && pwd -P)" || echo 중단   # 작업 디렉터리가 격리 디렉터리인지
test -z "$(ls -A)" || echo 중단                                      # .env 계열을 포함해 아무 파일도 없어야 함
```

**4단계: 프록시 시작 (터미널 A, 로그인이 끝날 때까지 유지)**

```sh
"$OCX" start --port "$PORT"
```

**5단계: 대상 프록시 확인 (터미널 B, 로그인 전에 반드시)**

`ocx account ...`는 홈의 `ocx.pid`와 `runtime-port.json`을 먼저 보고 프록시를 찾습니다(`PKG/src/server/proxy-liveness.ts:225-262`, 파일 위치는 `PKG/src/config/process-state.ts:14`, `:18`). 아래 세 값이 모두 격리 포트와 같은 프록시를 가리키는지 확인합니다.

```sh
curl -fsS "http://127.0.0.1:$PORT/healthz"   # port 가 $PORT 이고 service 가 opencodex 인지 확인하고 pid 를 기록합니다.
cat "$OPENCODEX_HOME/ocx.pid"                # healthz 의 pid 와 같아야 합니다.
cat "$OPENCODEX_HOME/runtime-port.json"      # port 가 $PORT 여야 합니다.
node -e 'console.log("oauth-open-browser:",JSON.parse(require("fs").readFileSync(process.env.OPENCODEX_HOME+"/config.json","utf8")).oauthOpenBrowser)'   # false 여야 합니다.
test -z "$(ls -A)" || echo 중단              # 작업 디렉터리가 여전히 비어 있어야 합니다.
```

healthz가 `pid`와 `port`를 돌려주는 것은 소스로 확인했습니다(`PKG/src/server/index/serve-options.ts:526-545`). 세 값이 하나라도 다르거나 파일이 없거나, `oauth-open-browser`가 `false`가 아니거나(프록시 시작이 값을 바꾸거나 지웠을 수 있습니다 [U10]), 작업 디렉터리가 비어 있지 않으면 로그인하지 않고 중단합니다. 다른 리스너가 10100 등에서 실행 중이면 그 프록시에는 이 명령이 닿지 않아야 하므로, 위 확인이 통과하지 못하는 한 로그인 명령을 실행하지 않습니다.

**6단계: 로그인 (터미널 B)**

```sh
# 반드시 ocx account login 을 씁니다. `ocx login anthropic`은 로컬 ~/.claude 와 키체인의
# 자격 증명을 가져올 수 있으므로 쓰지 않습니다.
"$OCX" account login "$PROVIDER"
```

- anthropic: `ocx account login`은 `addAccount: true`를 보내고(`PKG/src/cli/account-auth.ts:196`), 서버가 이를 `forceLogin`으로 바꾸며(`PKG/src/server/management/oauth-account-routes.ts:190-192`), anthropic의 `importLocal`은 `forceLogin`이면 `"off"`, 아니면 `"fallback"`입니다(`PKG/src/oauth/index.ts:254`). 따라서 `account login`은 로컬 Claude 자격 증명을 가져오지 않고 `ocx login anthropic`은 가져올 수 있습니다. W1도 이 경로를 확인했습니다(W1:62-63).
- google-antigravity: 계정 추가일 때 `prompt: "consent select_account"`를 보내 계정 선택 화면이 뜹니다(`PKG/src/oauth/google-antigravity.ts:188-189`). 사람이 이 화면에서 OMT 전용으로 승인된 Google 계정을 골라야 합니다.
- 명령은 로그인 URL을 출력합니다(`PKG/src/cli/account-auth.ts:198-204`). 소스의 기본 동작은 프록시가 이 URL을 OS 기본 브라우저에서 자동으로 여는 것이지만, 2단계의 `oauthOpenBrowser: false`와 5단계의 재확인 때문에 이 절차에서는 열리지 않아야 합니다. 사람은 출력된 URL을 복사해 **전용 브라우저 프로필**에서 엽니다. 브라우저는 그 프로필의 claude.ai 또는 Google 세션에 승인을 붙이므로, 승인 전에 화면에 보이는 계정이 OMT 전용으로 승인된 계정인지 사람이 직접 확인합니다. 그래도 기본 브라우저 창이 자동으로 열렸다면 그 창에서는 승인하지 않고 닫은 뒤 로그인을 중단하고 PM에게 알립니다. 설정이 로그인 시점에 실제로 적용되는지는 실측 전이므로 이 지시를 유지합니다 [U10].
- 이 머신에 브라우저가 없으면 `--no-wait`로 시작하고 `ocx account code <provider> --flow <flow-id>`로 코드를 stdin에 넣습니다(`PKG/src/cli/account-auth.ts:36-37`, `:110`). agy에서 같은 수동 입력이 동작하는지는 미확인입니다 [U12]. `ocx account import-orca`는 이 절차에서 쓰지 않으며 동작은 미확인입니다 [U5].

**7단계: 계정 하나만 남기고 고정 (터미널 B)**

```sh
"$OCX" account list "$PROVIDER"              # --json 출력 구조는 미확인입니다 [U15].
# 계정이 둘 이상이면 이번에 로그인한 계정만 남깁니다. <ID>는 list 출력에서 읽습니다.
"$OCX" account remove "$PROVIDER" <불필요한-계정-ID> --yes
"$OCX" account use "$PROVIDER" <남길-계정-ID>
"$OCX" account current "$PROVIDER"
```

계정 ID와 이메일은 터미널 화면에서 사람이 확인하되 보고서, 채팅, 커밋에는 옮겨 적지 않습니다. 계정을 정리했으면 터미널 A의 프록시를 Ctrl-C로 종료합니다.

**8단계: 검증과 라벨 계산 (프록시 종료 후, 터미널 B)**

```sh
node -e '
const fs=require("fs"),crypto=require("crypto");
const home=process.env.OPENCODEX_HOME,provider=process.env.PROVIDER;
const auth=JSON.parse(fs.readFileSync(home+"/auth.json","utf8"));
const cfg=JSON.parse(fs.readFileSync(home+"/config.json","utf8"));
const entry=auth[provider],accounts=entry?.accounts??[],id=accounts[0]?.id;
console.log("accounts:",accounts.length,"active-matches:",id===entry?.activeAccountId);
console.log("source:",accounts[0]?.credential?.source,"needsReauth:",accounts[0]?.needsReauth===true);
console.log("other-auth-providers:",Object.keys(auth).filter(k=>k!==provider&&(auth[k]?.accounts?.length??0)>0).length);
console.log("config-providers:",Object.keys(cfg.providers??{}).join(","),"defaultProvider:",cfg.defaultProvider);
console.log("guards:",cfg.runtimeRole,cfg.clientIntegrations?.codex,JSON.stringify(cfg.claudeCode),"port:",cfg.port);
console.log("pool-keys:",Object.keys(cfg.anthropicAccountPool??{}).join(","));
console.log("oauth-open-browser:",cfg.oauthOpenBrowser,"cwd-entries:",fs.readdirSync(".").length);
const h=(s)=>crypto.createHash("sha256").update(s).digest("hex").slice(0,6);
console.log(provider==="google-antigravity"?"label: o"+h("google-antigravity\0"+id):"provider-suffix: anthropic-p"+h(id));
'
```

이 스크립트는 계정 id 원문을 출력하지 않고 개수, 일치 여부, 출처, provider 이름 목록, 해시 라벨만 출력합니다. 다음이 모두 맞아야 등록합니다. `accounts: 1 active-matches: true`, `source: oauth`, `needsReauth: false`, `other-auth-providers: 0`, `defaultProvider`가 대상 provider, `config-providers`에 대상 외의 활성 항목이 없음, 가드가 로그인 뒤에도 유지됨, anthropic이면 `pool-keys`가 `enabled` 하나, `oauth-open-browser: false`(로그인 뒤에도 설정이 유지됨), `cwd-entries: 0`(작업 디렉터리에 `.env` 계열을 포함한 파일이 생기지 않음). 하나라도 다르면 손으로 고치지 않고 등록을 중단해 PM에게 결과를 알립니다. `auth.json`의 필드 이름은 `PKG/src/oauth/types.ts:79-96`에서 읽었지만 로그인 뒤의 실제 파일로는 확인하지 못했습니다 [U2, U17].

**OMT에 넘길 환경 변수**

`<REF>`는 프로필의 `account` 이름을 대문자로 바꾸고 영문자·숫자가 아닌 문자를 `_`로 바꾼 값입니다(예: `claude-oauth`는 `CLAUDE_OAUTH`). 값은 위 절차에서 만든 `ACC`의 절대 경로와 검증 스크립트가 출력한 라벨에서 가져오며, 원래 사용자 셸에서 절대 경로를 직접 적어 설정합니다.

| 환경 변수 | 값의 출처 |
|---|---|
| `OMT_OPENCODEX_<REF>_HOME` | `ACC/home`의 절대 경로 |
| `OMT_OPENCODEX_<REF>_LABEL` | 검증 스크립트가 출력한 라벨. agy는 `o<hex6>`, anthropic은 provider 접미사 `anthropic-p<hex6>`입니다. |
| `OMT_OPENCODEX_<REF>_SESSION_HOME` | `ACC/codex-home`의 절대 경로. 계정마다 별도의 빈 디렉터리이며 미리 존재해야 합니다. 이 변수는 A3에서 설계한 새 이름이며 구현 전에는 OMT가 읽지 않습니다. 구현 전에 실측이 필요하면 단일 변수 `OMT_OPENCODEX_SESSION_HOME`을 한 계정 실행에만 쓰고 두 계정을 한 실행에서 함께 쓰지 않습니다. |

**PM이 이사에게 전달할 "사용자 확인 항목"**

1. 로그인할 Claude 계정과 Google 계정이 OMT 전용 실행에 써도 되는 계정인지 확인합니다.
2. 실측(A5)이 그 구독의 사용량 한도를 소모한다는 점을 승인합니다. 압축이 일어나는 긴 turn(A5의 8번)은 한도를 더 소모합니다.
3. 제3자 프록시(OpenCodex)를 거친 구독 OAuth 사용이 각 서비스의 약관에 부합하는지 판단합니다. 이 항목은 자동으로 증명할 수 없습니다.
4. 로그인을 수행할 머신과 브라우저를 정합니다. 브라우저가 없으면 `--no-wait` 경로를 쓸지 정합니다.
5. Claude 로그인은 전용 브라우저 프로필에서 하고, 승인 화면에 보이는 claude.ai 계정이 OMT 전용으로 승인된 계정인지 사람이 직접 확인합니다.
6. Google 계정 선택 화면에서 승인된 계정을 고르는지 사람이 직접 확인합니다.
7. 사용자가 실제로 쓰는 OpenCodex 프록시(기본 포트 10100 등)와 실제 홈(`~/.opencodex`)에는 이 절차가 아무 변경도 하지 않아야 한다는 점을 확인하고, 5단계의 대상 프록시 확인(작업 디렉터리가 비어 있고 `oauthOpenBrowser`가 `false`라는 확인 포함)이 통과하지 않으면 로그인하지 않는다는 데 동의합니다.
8. 계정 홈 디렉터리의 `auth.json`을 공유하거나 백업하지 않는다는 데 동의합니다.
9. 이 설계와 실측은 Codex 주간 한도가 리셋되는 2026-09-26 06:11 KST 전에 OpenAI 계정으로 모델을 호출하지 않는다는 점을 확인합니다.

### A5. 실측 계획과 지원 목록 편입 규칙

실측은 A4를 마치고 승인이 끝난 계정 홈 하나마다 한 번씩, 작은 저장소에서 수행합니다. 이 task에서는 실행하지 않았고 후속 task `runner-measure`가 담당합니다. 측정 항목은 경로별 샌드박스(A3)와 모순되지 않게 나눕니다.

| # | 항목 | headless-start (쓰기 가능) | work (읽기 전용) |
|---|---|---|---|
| 1 | 파일 읽기: 저장소의 특정 파일 내용을 요약해 답하게 합니다. | 측정 | 측정 |
| 2 | 파일 수정: 지정한 한 줄을 고치게 하고 저장소 diff가 그 한 줄뿐인지 확인합니다. | 측정 | 측정하지 않음 |
| 3 | 테스트 실행: 저장소의 테스트 명령을 실행하게 하고 통과 여부를 그대로 보고하게 합니다. | 측정 | 측정하지 않음 |
| 4 | 완료 감지: `runnerTurnProven`(`headless.mjs:745-770`)의 조건(입력 수락, turn 시작, 상위 요청, 완료, 종료 관측, 후손 종료, 프록시 종료, termination `"exited"`)이 모두 충족되는지 봅니다. | 측정 | work의 `invoke`가 기록하는 lifecycle 항목만 측정 |
| 5 | 요청·실행 모델 일치: `requestedModel`이 프로필 모델 전체 문자열이고 `model`, `resolvedModel`, `attempt.model`이 접두사를 뗀 값인지 봅니다. W1이 같은 값을 관측했으므로 OMT 명령 경로에서 재현되는지 확인합니다(W1:91-93). | 측정 | 측정 |
| 6 | 계정 표식: 이력의 계정 표식이 A4에서 계산한 라벨과 같은지 봅니다. anthropic은 모든 행의 provider가 기대 접미사와 같은지 봅니다. | 측정 | 측정 |
| 7 | 계정 홈이 실측 전후로 계정 1개를 유지하는지 A1의 검증기로 다시 확인합니다. | 측정 | 측정 |
| 8 | 압축 경로: 압축이 일어나는 긴 turn을 실행해 압축 요청 행의 provider가 대상 provider이거나 요청이 실패하는지, `openai`나 다른 provider 행이 없는지 봅니다(A1의 5번). | 측정 | 측정하지 않음 |

work 경로의 2번과 3번을 측정하려면 `--sandbox read-only --ephemeral`을 풀어야 합니다. 이는 샌드박스 권한을 넓히는 일이므로 이 설계에 넣지 않으며, 아래 "PM 결정 필요" 항목으로 분리합니다.

**PM 결정 필요**

- work 경로에서 파일 수정과 테스트 실행을 지원하고 측정할지 여부. 지원하려면 work의 `invoke`가 쓰기 가능한 샌드박스로 실행되도록 권한을 넓혀야 하고, 이는 provider와 무관한 권한 변경이므로 PM 승인 없이 설계에 포함하지 않았습니다. 승인하지 않으면 work는 읽기 전용 실행으로만 문서화합니다.

**지원 목록 편입 규칙**

- provider가 `OPENCODEX_RUNNER_PROVIDERS`에 추가되는 조건은 headless-start에서 1번부터 8번까지가 모두 통과하고, work에서 표에 "측정"으로 적힌 항목(1, 4의 lifecycle 부분, 5, 6, 7)이 모두 통과한 것입니다. work에서 "측정하지 않음"인 항목은 편입 조건에서 제외하며, 그 항목을 지원한다고 쓰지 않습니다.
- 하나라도 실패하면 그 provider를 `OPENCODEX_RUNNER_PROVIDERS`에 추가하지 않고 문서에 "미검증"과 실패한 항목을 남깁니다.
- 실측 결과가 부분 통과이면 통과한 경로(headless-start 또는 work)만 기록하되 목록에는 추가하지 않습니다.
- 다른 구독이나 API 과금으로 자동 전환하는 코드와 절차는 어떤 경우에도 만들지 않습니다. 실패 시 대체 provider로 재시도하는 로직도 두지 않습니다.
- 실측 로그와 문서에는 토큰, `auth.json` 내용, 계정 ID·이메일 원문을 넣지 않습니다.

## B. Windows 프록시 시작

### B1. 현재 Windows에서 거부되는 지점

| 함수 | 위치 | Windows 동작 |
|---|---|---|
| `processGroupMembers` | `opencodex.mjs:151-160` | `win32`이면 즉시 `null`을 돌려줍니다. POSIX 전용 `ps -axo pid=,pgid=`에 의존합니다. |
| `ownedListenerPid` | `opencodex.mjs:164-180` | `win32`이면 `null`입니다. `lsof`와 프로세스 그룹 멤버십에 의존합니다. |
| `processStartTime` | `opencodex.mjs:194-201` | `win32`이면 `null`입니다. `null`이면 lease의 `recordOwnerLive`가 pid 생존만 보므로 pid 재사용을 구별하지 못합니다. |
| `startOpenCodexProxy` | `opencodex.mjs:473-557` | 시작 직후 `opencodex-proxy-ownership-unverifiable`로 거부합니다(475~478행). |
| `terminateGroup` | `opencodex.mjs:214-228` | 그룹이 비었음을 `processGroupMembers`로 관측해야 통과하므로 `null`이면 `opencodex-proxy-exit-unverifiable`입니다. |

이 밖에 headless 경로는 Windows에서 이미 다르게 동작합니다.

- `headless-runner.mjs:267-276`은 win32에서 detached로 spawn하지 않습니다.
- `settleDescendants`(`headless-runner.mjs:312-325`)는 win32에서 `descendantsExited: false`를 돌려주므로 `runnerTurnProven`(`headless.mjs:745-770`)이 성립하지 않습니다. 결과적으로 Windows의 runner turn은 지금 항상 unverified이며 PM 결정에 따라 앞으로도 그대로 둡니다.
- `killTree`(`headless-runner.mjs:117-138`)는 win32에서 `taskkill /T /F /PID`를 씁니다. 종료 요청은 하지만 종료했다는 증명은 하지 않습니다.
- `core.mjs`의 `run`은 win32에서 `detached` 옵션을 무시합니다(`core.mjs:559`).
- 프록시 자식 격리는 `HOME`만 바꾸며(`opencodex.mjs:492-505`) `USERPROFILE`을 다루는 코드는 없습니다. Windows의 홈 디렉터리 조회가 `USERPROFILE`을 우선하는지는 이 문서에서 확인하지 못했지만, 격리를 Windows에서 주장하려면 함께 덮어써야 합니다.

**실행 대상**

`startOpenCodexProxy`는 `<runtimePrefix>/node_modules/.bin/ocx`를 shell 없이 spawn합니다(`opencodex.mjs:492-505`). 반면 `dependencies.mjs`는 win32에서 `ocx.cmd`를 씁니다(`dependencies.mjs:236`, `:406`). 이 두 경로는 같지 않습니다. 패키지의 `bin` 항목은 `ocx`와 `opencodex` 모두 `./bin/ocx.mjs`를 가리킵니다(`PKG/package.json:14-17`). 설계는 Windows에서 shim을 spawn하지 않고 `process.execPath`로 `PKG/bin/ocx.mjs`를 직접 실행하는 것입니다. 이렇게 하면 shell 없이 `.cmd`를 spawn할 때 Node 22에서 `EINVAL`이 나는지(U7)를 피할 수 있고, 트리에 `cmd.exe` 층이 끼지 않습니다. 직접 실행이 shim과 같은 동작을 하는지는 Windows에서 확인하지 못했습니다 [U7].

**OpenCodex 쪽 사실**

- `PKG/bin/ocx.mjs`는 Node 런처이며 자식 bun 프로세스를 spawn하고 종료 시그널을 자식에게 전달합니다(`PKG/bin/ocx.mjs:764-774` 근처의 주석). 포트를 잡는 프로세스는 런처가 아니라 bun입니다.
- 헬스 응답은 `service`, `pid: process.pid`, `port`를 담습니다(`PKG/src/server/index/serve-options.ts:526-545`). `pid`는 응답한 bun 프로세스의 PID이므로 리스너 PID와 직접 대조할 수 있습니다. 이 응답은 로컬 attestation 헤더도 지원하지만(`PKG/src/server/index/serve-options.ts:538-543`) OMT가 이를 쓸 수 있는지는 확인하지 못했습니다.
- OpenCodex는 Windows에서 프록시 종료에 `taskkill.exe /PID <pid> /T /F`를 쓰고 그 주석은 Windows의 `process.kill(SIGTERM/SIGINT)`가 `TerminateProcess`이며 graceful하지 않다고 적습니다(`PKG/src/lib/process-control.ts:333-346`).
- Windows 포트 소유 조회에는 `netstat -ano -p tcp`를 쓰며, 지역화된 출력을 피하려고 `cmd.exe /d /c chcp 437>nul & netstat -ano -p tcp`로 영어 상태 이름을 강제합니다. 그 호출이 실패하면 그냥 `netstat`으로 되돌아갑니다(`PKG/src/server/port-reclaim.ts:99-118`).
- 프로세스 명령줄은 `WMIC.exe`를 먼저 쓰고 없으면 고정 경로의 PowerShell `Get-CimInstance Win32_Process`로 되돌아갑니다(`PKG/src/config/process-state.ts:287-320`). 실행 파일 경로는 `PATH`나 환경 변수의 루트가 아니라 신뢰된 시스템 디렉터리에서 고릅니다.
- `/api/stop`이 토큰 없이 어떤 인증을 요구하는지는 확인하지 못했습니다 [U16].
- Windows에서 실제 bun 프로세스의 명령줄과 `bun.exe` 존재 여부는 미확인입니다 [U8]. 런처와 bun의 부모 자식 관계를 Windows에서 조회할 수 있는지도 미확인입니다 [U6].
- `buildDesktop3pRegistry`가 Windows에서 하는 일은 미확인입니다 [U11].

### B2. Windows 소유권 증명 후보와 한계

POSIX 증명은 "헬스 바디의 port가 일치하고, 소유 프로세스 그룹에서 유일한 리스너가 그 포트를 잡고 있으며, 종료 뒤에 그룹이 비어 있다"는 세 조건입니다. Windows에는 프로세스 그룹이 없으므로 다음으로 바꿉니다.

**후보: PID 트리 스냅샷, 리스너 PID, 헬스 pid 대조**

1. 도구: 프로세스 조회는 `PATH`가 아니라 `%SystemRoot%` 아래 고정 경로의 PowerShell `Get-CimInstance Win32_Process`(`ProcessId`, `ParentProcessId`, `CreationDate`, `CommandLine`)를 씁니다. OpenCodex도 같은 방식을 씁니다(`PKG/src/config/process-state.ts:287-320`). `wmic`은 최신 Windows 이미지에서 빠질 수 있으므로 의존하지 않습니다.
2. 시작 스냅샷: `spawn`이 돌려준 런처 PID와 그 `CreationDate`를 lease에 기록하고, 헬스가 성공한 직후 후손을 `(pid, CreationDate)` 쌍의 목록으로 한 번 기록합니다. 후손은 `ParentProcessId`가 기록된 런처 PID이고 `CreationDate`가 런처의 것 이상인 프로세스를 재귀로 모은 것입니다.
3. 리스너 PID: `Get-NetTCPConnection -State Listen -LocalPort <port>`의 `OwningProcess`를 쓰거나, `netstat -ano -p tcp`를 `chcp 437`로 영어 출력에 고정해 읽습니다. 지역화된 출력에서는 상태 이름이 달라 파싱이 실패할 수 있으므로 고정하지 않은 `netstat`은 쓰지 않습니다(`PKG/src/server/port-reclaim.ts:99-118`).
4. 소유권 판정: 리스너가 정확히 하나이고, 그 PID가 2번 스냅샷의 `(pid, CreationDate)` 쌍에 들어 있으며, 헬스 응답의 `pid`가 그 리스너 PID와 같고 `port`가 일치해야 합니다. 이것이 `ownedListenerPid`의 대응물이며 POSIX보다 하나 많은 대조(헬스 pid)를 씁니다.
5. 종료: `taskkill /PID <런처> /T /F`를 실행한 뒤 스냅샷의 모든 `(pid, CreationDate)` 쌍이 목록에서 사라졌음을 다시 조회해 확인하고 포트가 풀렸음을 확인합니다. 이것이 `terminateGroup`의 대응물이며 결과의 `termination`은 `"exited-snapshot"`입니다.

**한계**

- 부모가 먼저 죽어도 Windows는 자식의 `ParentProcessId`를 갱신하지 않습니다. 고아 프로세스는 옛 부모 PID를 그대로 보관하므로 `ParentProcessId` 조회로 여전히 찾을 수 있습니다. 실제 위험은 반대 방향입니다. 죽은 런처의 PID를 무관한 새 프로세스가 재사용하면 그 프로세스나 그 자식이 후손으로 잘못 잡히는 거짓 양성이 생깁니다. 이를 `CreationDate`로 거릅니다. 후손 판정에 부모의 `CreationDate` 이상이라는 조건을 두고, 종료 증명은 트리를 다시 계산하지 않고 시작 스냅샷의 `(pid, CreationDate)` 쌍이 그대로 남아 있는지만 확인합니다. 쌍이 일치하지 않으면 재사용된 PID이므로 종료된 것으로 봅니다.
- 시작 스냅샷을 찍은 뒤에 새로 생긴 후손은 종료 증명에서 놓칩니다. 이 때문에 증명의 강도가 POSIX의 "그룹이 비었다"보다 약하고, 결과를 `"exited"`가 아닌 `"exited-snapshot"`으로 기록해야 합니다.
- PM 결정에 따라 `runnerTurnProven`의 요건(termination `"exited"`)은 완화하지 않습니다. 따라서 `"exited-snapshot"`은 그 요건을 만족하지 않고 Windows의 runner turn은 계속 unverified로 남습니다. 이 한계는 오류가 아니라 정직한 기록이며, 나중에 요건을 바꾸려면 PM의 별도 결정이 필요합니다.
- 리스너 대조에서 헬스 pid는 응답한 프로세스가 스스로 보고하는 값이므로, 다른 프로세스가 같은 포트로 가짜 헬스를 돌려주는 경우는 리스너 PID가 스냅샷에 들지 않는 것으로 걸러집니다. 반대로 스냅샷 안의 프로세스가 가짜 응답을 하는 경우는 걸러지지 않지만 OMT가 spawn한 자식 트리 안이라는 전제가 이를 제한합니다.
- Job Object는 프로세스 그룹에 가장 가까운 수단이지만 Node만으로는 만들 수 없고 네이티브 애드온이 필요하므로 채택하지 않습니다.
- `taskkill /F`로 강제 종료하면 OpenCodex의 pid 파일이나 포트 파일이 남는지는 확인하지 못했습니다 [U9]. 남으면 다음 시작이 이를 stale로 처리하는지 실측이 필요합니다.
- lease의 hard link 프로토콜(`fs.linkSync`, `opencodex.mjs:249`)은 NTFS에서 동작할 것으로 보이지만 Windows에서 실행해 확인하지 않았습니다. 소스의 다른 원자 연산은 `renameSync`(`opencodex.mjs:435`)입니다.

**판정**: 시작 경로의 소유권은 위 4번 조건으로 증명하도록 설계할 수 있지만, 그 전제인 "bun이 spawn한 PID의 후손"이라는 관계(U6), 실제 bun 명령줄과 실행 파일(U8), 실행 대상을 `bun`으로 직접 잇는지 Node 런처로 잇는지(U7)가 Windows에서 실측되기 전에는 성립한다고 쓸 수 없습니다. 종료 완전성은 스냅샷 한계 안에서만 증명하며 그 한계를 결과에 `"exited-snapshot"`으로 드러냅니다. windows-proxy task의 목표는 시작 경로의 소유권 증명과 이 한계의 기록입니다.

### B3. `dependencies.mjs` 상태 확인 종료의 Windows 동작

`healthCheck`(`dependencies.mjs:314-360`)는 격리 config와 임시 홈으로 `ocx`를 spawn하고 `/healthz`가 성공하면 `child.kill("SIGTERM")`으로 끝냅니다(352행). OpenCodex 소스의 주석에 따르면 Windows에서 `process.kill(SIGTERM/SIGINT)`은 `TerminateProcess`이고 graceful한 신호가 아니며, 프로세스 트리를 끝내려면 `taskkill /T /F`를 씁니다(`PKG/src/lib/process-control.ts:333-346`). 따라서 Windows에서는 런처만 죽고 bun이 남아서 포트를 계속 잡을 수 있습니다. 이 동작은 소스 주석에서 추론한 것이며 실제 Windows에서는 확인하지 못했습니다 [U6]. 런처가 종료 시그널을 자식에게 전달하는 로직(`PKG/bin/ocx.mjs:764-774` 근처)은 POSIX 시그널을 전제로 하므로 Windows에서는 동작하지 않을 수 있습니다.

`healthCheck`는 상태 진단이지 계정 홈 lease를 쓰는 경로가 아니라서 소유권 증명은 필요하지 않습니다. 그러나 남은 bun이 다음 진단의 포트를 점유하는 문제는 있으므로, Windows에서는 진단 종료를 `taskkill /T /F /PID`로 바꾸고 임의의 빈 포트를 쓰는 것이 안전한 후보입니다. `dependencies.mjs`가 win32에서 `.cmd`를 쓰는 부분(236행, 406행)은 위 B1의 실행 대상 결정과 U7에 연결됩니다.

### B4. posixOnly 표

정본 정의는 두 곳입니다. `tests/dependencies.test.mjs:76`은 win32이면 건너뛰고, `tests/opencodex.test.mjs:459`는 win32이거나 `lsof -v`가 실패하면 건너뜁니다. `grep -rn posixOnly tests`의 25줄에는 정의 2줄과 테스트 사용 23줄이 함께 들어 있으며, 표는 이 25줄을 모두 다룹니다.

"Windows 실행 가능"은 지금 코드와 지금 테스트 그대로 Windows에서 돌릴 수 있는지를 뜻합니다. 유지 사유는 B 구현 뒤에도 skip을 유지해야 하는 이유이고, "이식 후보"는 대체 검증을 새로 쓰면 Windows에서 돌릴 수 있는 것입니다.

| # | 파일:줄 | 테스트 이름 | Windows 실행 가능 | 이유와 유지 사유 |
|---|---|---|---|---|
| 1 | `tests/dependencies.test.mjs:76` | (정의) `posixOnly` | 해당 없음 | win32이면 건너뜁니다. 가짜 런타임이 POSIX 셸 스크립트라는 이유를 씁니다. 이식 후보: 가짜를 `.cmd`나 Node 스크립트로 바꾸면 정의를 줄일 수 있습니다. |
| 2 | `tests/dependencies.test.mjs:136` | a healthy runtime is reused when only unrelated catalog checks fail | 아니오 | 가짜 `ocx`, `npm`, `codex`, `git`, `node`가 `#!/bin/sh` 또는 shebang 파일입니다. 이식 후보이며 `.cmd` 실행이 `EINVAL` 없이 되어야 합니다 [U7]. |
| 3 | `tests/dependencies.test.mjs:160` | a failing check the backend requires blocks turns but never replaces a healthy runtime | 아니오 | 같은 셸 스크립트 가짜(`codex`가 `exit 1`)입니다. 이식 후보입니다. |
| 4 | `tests/dependencies.test.mjs:178` | an unhealthy runtime is still reinstalled | 아니오 | 가짜 `ocx`를 `#!/bin/sh` 스크립트로 덮어씁니다. 이식 후보입니다. |
| 5 | `tests/dependencies.test.mjs:195` | the installer reports the plan when the runtime install fails after the plugins | 아니오 | 위와 같은 가짜 런타임을 씁니다. 이식 후보입니다. |
| 6 | `tests/opencodex.test.mjs:459` | (정의) `posixOnly` | 해당 없음 | win32이거나 `lsof`가 없으면 건너뜁니다. B 구현 뒤에는 조건을 "win32가 아니면서 `lsof` 없음"과 "win32이면서 PowerShell 없음"으로 나눕니다. |
| 7 | `tests/opencodex.test.mjs:567` | an owned proxy is accepted only as the sole listener of its own process group | 아니오 | `lsof`와 프로세스 그룹에 의존합니다. Windows에서는 "유일한 리스너가 자식 트리에 속함"으로 새로 씁니다(B2). |
| 8 | `tests/opencodex.test.mjs:589` | a healthy responder that another process group owns is refused | 아니오 | 다른 그룹의 detached 프로세스가 헬스에 응답하는 상황을 만듭니다. Windows에서는 "트리 밖 PID가 리스너"로 바꿔 쓸 수 있습니다. |
| 9 | `tests/opencodex.test.mjs:605` | a health body that does not name the port is refused | 아니오 | 로직은 플랫폼 무관하지만 가짜 `ocx`가 shebang 스크립트이고 현재 `startOpenCodexProxy`가 win32를 거부합니다. 이식 후보입니다. |
| 10 | `tests/opencodex.test.mjs:618` | a descendant left behind by an exited launcher is ended, not ignored | 아니오 | 같은 그룹의 후손이 런처 종료 뒤에도 남는 상황입니다. Windows에는 프로세스 그룹이 없으므로 [B2 한계]의 PID 재사용 거짓 양성과 스냅샷 한계가 걸립니다. 스냅샷 방식으로 일부만 이식할 수 있고 완전한 동치는 아닙니다. |
| 11 | `tests/opencodex.test.mjs:633` | stopping ends every member of the owned group, including one that ignores SIGTERM | 아니오 | Windows에는 SIGTERM 무시라는 개념이 없고 모든 kill이 강제입니다. 유지 사유: 전제가 성립하지 않으므로 POSIX 전용으로 남깁니다. |
| 12 | `tests/opencodex.test.mjs:650` | a tree whose exit cannot be inspected is unverifiable and keeps its lease | 아니오 | PATH에서 `ps`를 없애는 시나리오입니다. Windows에서는 PowerShell 조회가 실패하는 시나리오로 대체해야 합니다. 이식 후보입니다. |
| 13 | `tests/opencodex.test.mjs:707` | the proxy child runs with a private HOME, not the user's | 아니오 | 가짜 `ocx`가 `process.env.HOME`을 기록합니다. Windows에서는 `USERPROFILE`을 함께 검증해야 합니다. 이식 후보입니다. |
| 14 | `tests/opencodex.test.mjs:774` | a lease records its owner and, after spawn, the proxy group | 아니오 | `ps -o lstart=`로 processStart를 읽고 detached 그룹 리더를 만듭니다. Windows에서는 `CreationDate`와 PID 트리로 다시 씁니다. |
| 15 | `tests/opencodex.test.mjs:799` | a live owner keeps the home and is told apart from a dead one | 아니오 | `ps lstart`와 POSIX pid에 의존합니다. Windows에서는 `CreationDate` 비교로 이식할 수 있습니다. |
| 16 | `tests/opencodex.test.mjs:819` | a dead owner's lease is taken over and its orphaned proxy group is ended | 아니오 | 고아 프록시 그룹을 그룹 kill로 종료합니다. 스냅샷 방식으로 일부 이식 가능하며 PID 재사용 거짓 양성과 스냅샷 한계가 있습니다. |
| 17 | `tests/opencodex.test.mjs:846` | a reused owner pid does not count as a live owner | 아니오 | processStart 불일치로 pid 재사용을 판별합니다. `CreationDate`로 이식 후보입니다. |
| 18 | `tests/opencodex.test.mjs:864` | a reused proxy group id is not ended | 아니오 | 프로세스 그룹 id 재사용이라는 개념이 Windows에 없습니다. 유지 사유: "PID와 `CreationDate`가 다르면 종료하지 않는다"는 별도 테스트로 대체합니다. |
| 19 | `tests/opencodex.test.mjs:881` | a lease whose state cannot be proven clean is kept and reported as unverifiable | 아니오 | `ps` 부재 시나리오입니다. 12번과 같은 방식으로 이식합니다. |
| 20 | `tests/opencodex.test.mjs:914` | a turn killed with SIGKILL leaves a lease and proxy that the next turn cleans up | 아니오 | 러너를 SIGKILL하고 고아 프록시를 다음 turn이 정리합니다. 스냅샷 기반 정리가 가능하면 이식할 수 있으나 스냅샷 이후 생긴 후손을 놓치므로 완전하지 않습니다. |
| 21 | `tests/opencodex.test.mjs:956` | a live owner that appears during a reclaim is never displaced | 아니오 | reclaim 경합의 파일 프로토콜이 핵심이라 이식 가능성이 가장 높지만, 지금은 `deadPid`, `processStart`, detached 그룹 도우미가 POSIX입니다. |
| 22 | `tests/opencodex.test.mjs:1007` | a reclaimer that finds the lease replaced while it waited leaves the new owner alone | 아니오 | 21번과 같습니다. |
| 23 | `tests/opencodex.test.mjs:1063` | many acquirers racing for a dead owner's lease leave exactly one holder | 아니오 | 21번과 같고, 여러 프로세스 spawn과 hard link 원자성이 Windows에서 같은지 실측이 필요합니다. |
| 24 | `tests/opencodex.test.mjs:1125` | a reclaim mutex left by a dead reclaimer blocks only that lease and is reported as stuck | 아니오 | 21번과 같습니다. |
| 25 | `tests/opencodex.test.mjs:1151` | a reclaim in progress by a live process is waited for, then reported as held | 아니오 | 21번과 같습니다. |

요약하면 25줄 모두 지금은 Windows에서 실행할 수 없습니다. 이식 후보는 2~5, 9, 12~13, 15, 17, 19, 21~25입니다. 대체 검증이 필요한 것은 7~8, 10, 14, 16, 20이고, POSIX 전용으로 유지해야 하는 것은 11과 18입니다.

### B5. CI `windows-latest`로 확인할 수 있는 것과 없는 것

`.github/workflows/ci.yml`은 3 OS 매트릭스이며 `windows-latest`에서 Node 22로 `npm ci`, `quality`, `format:check`, `test`를 실행합니다.

**확인할 수 있는 것**

- PowerShell 조회(`Get-CimInstance`, `Get-NetTCPConnection`)와 `taskkill /T /F`의 사용 가능 여부와 출력 형태. 가짜 프로세스(Node 스크립트)를 띄워 트리와 리스너를 조회하는 테스트로 확인합니다.
- 위 4번의 `CreationDate` 기반 pid 재사용 구별.
- lease 파일 프로토콜(hard link, rename, mutex 파일)이 NTFS에서 원자적으로 동작하는지. 이식한 21~25번이 이를 확인합니다.
- `.cmd` shim spawn의 `EINVAL` 여부 [U7].
- `HOME`과 `USERPROFILE` 격리가 가짜 자식에서 반영되는지.
- 포맷, 린트, 정적 감사(`quality`)가 Windows 경로 구분자에서 깨지지 않는지.

**확인할 수 없는 것**

- 실제 OpenCodex 프록시(bun)의 부모 자식 관계, 명령줄, pid 파일 잔존 [U6, U8, U9]. CI 러너에 이 설치본이 없고 네트워크·인증이 필요한 실행을 이 task는 하지 않습니다.
- Windows에서 실제 Claude·Agy 계정 홈과 로그인 흐름. 사람이 격리 로그인을 해야 하며 CI는 자격 증명을 가지지 않습니다.
- 사용자 환경의 백신·방화벽이 `taskkill`이나 포트 조회에 미치는 영향.
- 장시간 실행 turn과 실제 모델 응답의 완료 감지.


## C. 미확인 목록

W1 실측(`docs/plan/opencodex-runtime.md`, `experiments/opencodex/evidence.json`)이 이미 답한 사실은 이 목록에 넣지 않고 본문에서 줄 번호로 인용했습니다. 첫 판(`b8213e9`)은 19개였고 이번 판은 17개이며, 목록 전체에 번호를 다시 매겼으므로 같은 번호가 첫 판과 다른 항목을 가리킵니다. 첫 판 번호는 이 문서 밖의 보고에만 남아 있고, 이 문서의 본문과 표는 모두 아래 새 번호를 씁니다.

- 삭제한 3개(내용으로 적습니다): 접두사가 붙은 `--model`이 그대로 프록시에 전달되는지, 요청 이력의 실제 `resolvedModel` 값, 어댑터의 usage를 Codex CLI 스트림에 공급하는지. 이 셋은 W1:91-93, W1:98에서 확인된 사실입니다. 첫 판의 번호는 순서대로 U1, U17, U3이었습니다.
- 새로 더한 1개: 빈 계정 홈에서 `ocx start`나 로그인이 provider 항목과 `defaultProvider`를 자동으로 기록하는지(새 U17).
- 남은 항목의 번호 대응(첫 판 → 이번 판): U2→U1, U4→U2, U5→U3, U6→U4, U7→U5, U8→U6, U9→U7, U10→U8, U11→U9, U12→U10, U13→U11, U14→U12, U15→U13, U16→U14, U18→U15, U19→U16.

| 번호 | 미확인 내용 | 관련 절 |
|---|---|---|
| U1 | W1이 실행하지 않은 도구 종류를 anthropic·antigravity 어댑터가 어디까지 변환하는지 | A3 |
| U2 | 로그인 직후 `credential.source`의 기록값, key-store와 `canonicalAuthMode`가 출처 판정에 미치는 영향(key-store는 opt-in이라는 사실은 W1:60에서 확인) | A1, A4 |
| U3 | 요청 이력의 보존 정책 | A2 |
| U4 | macOS 키체인 읽기가 `HOME` 변경의 영향을 받는지(W1:62, 64는 읽기가 남는다는 사실까지만 확인) | A4 |
| U5 | `ocx account import-orca`의 동작 | A4 |
| U6 | Windows에서 런처와 bun의 부모 자식 관계를 조회할 수 있는지, 종료 시그널 전달 여부 | B1, B2, B3, B5 |
| U7 | shell 없이 `.cmd` shim을 spawn할 때 Node 22에서 `EINVAL`이 나는지, `process.execPath`로 `bin/ocx.mjs`를 직접 실행하는 방식이 shim과 같은 동작을 하는지 | B1, B2, B4, B5 |
| U8 | Windows에서 실제 bun 명령줄 형태와 `bun.exe` 존재 여부 | B1, B2, B5 |
| U9 | `taskkill /F` 뒤 pid 파일과 포트 파일이 남는지 | B2, B5 |
| U10 | 시작 동기화를 끄는 `config.json` 항목과 `oauthOpenBrowser: false`를 사전 설정으로 두었을 때 프록시 시작과 로그인 뒤에도 유지되는지, 로그인 시점에 자동 열기가 실제로 꺼지는지, `anthropicAccountPool`의 정확한 구조 | A1, A4 |
| U11 | `buildDesktop3pRegistry`의 Windows 동작 | B1 |
| U12 | agy에서 `--no-wait`와 수동 코드 입력 경로가 동작하는지 | A4 |
| U13 | agy·claude에서 `model_reasoning_effort`가 실제로 어떤 값으로 변환되는지 | A3 |
| U14 | anthropic 풀을 켠 1계정 홈에서 요청이 통과하는지, provider 접미사가 실제로 붙는지, 429가 실패로 드러나는지, OMT 검증기와 연결한 뒤에도 성립하는지 | 판정 요약, A1, A2 |
| U15 | `ocx account list --json` 출력 형태 | A4 |
| U16 | `/api/stop`이 토큰 없이 요구하는 인증 조건 | B1 |
| U17 | 빈 계정 홈에서 `ocx start`나 로그인이 `providers.<대상>` 항목과 `defaultProvider`를 자동으로 기록하는지 | A1, A4 |

## D. 후속 task로 넘기는 결정 사항

이 개정에서 PM이 내린 결정은 세 가지입니다. 각각 본문에 반영했습니다.

1. Windows 종료 증명은 스냅샷 방식이면 `"exited-snapshot"`으로 기록하고 POSIX의 `"exited"`와 구별합니다. `runnerTurnProven`의 요건은 완화하지 않으므로 Windows의 runner turn은 계속 unverified입니다. windows-proxy task의 목표는 시작 경로의 소유권 증명과 그 한계의 정직한 기록입니다(B2).
2. work 경로의 read-only 샌드박스 권한은 PM 승인 없이 넓히지 않습니다. A5의 실측은 경로별 권한과 모순되지 않게 나누었고, 권한을 넓혀야만 측정할 수 있는 항목은 "PM 결정 필요"로 분리했습니다(A3, A5).
3. W1에서 이미 확인된 사실은 미확인에 넣지 않고 줄 번호로 인용했으며, 미확인 개수는 19개에서 17개로 다시 세었습니다(C).

- `claude-agy-runner`: A1의 provider별 검증기(다른 provider 경로 차단과 anthropic 풀 설정 제한 포함), A2의 provider별 증명 규칙과 모델 접두사 정규화, A3의 파서 선택 변경과 계정별 `OMT_OPENCODEX_<REF>_SESSION_HOME` 도입을 구현합니다. `OPENCODEX_RUNNER_PROVIDERS`에는 A5 통과 전에 추가하지 않습니다.
- `windows-proxy`: B2의 시작 경로 소유권 증명(리스너 PID, 헬스 pid, `(pid, CreationDate)` 스냅샷 대조)과 스냅샷 종료 증명을 구현하고 종료 결과를 `"exited-snapshot"`으로 기록합니다. `runnerTurnProven`의 요건은 바꾸지 않습니다. 실행 대상(`process.execPath` + `bin/ocx.mjs`)과 진단 종료(`taskkill /T /F`)도 이 task에서 다룹니다. B4의 표에서 "이식 후보"부터 옮깁니다.
- `runner-measure`: A4가 끝난 뒤 A5를 실행하고 U1, U13, U14, U17을 확정합니다. work 경로의 쓰기·테스트 실측은 PM 결정이 있을 때에만 수행합니다.
- 사람: A4 절차를 실행하고 사용자 확인 항목 9개를 이사에게서 받아 옵니다.
