# OpenCodex 후속 설계: Claude·Agy fixed-account runner와 Windows 프록시 시작

작성 기준은 `b625b25`(OMT 2.8.2)와 설치된 OpenCodex 2.59.0입니다. 이 문서는 설계만 확정하며 로그인, 계정 조작, 프록시 기동, 모델 호출은 하나도 수행하지 않았습니다. 후속 구현 task(claude-agy-runner, windows-proxy, runner-measure)와 사람의 격리 로그인 요청은 이 문서를 근거로 삼습니다.

## 판정 요약

### Claude runner

구현은 가능하지만 지원 완료로 쓸 수 없습니다. 기본 설정의 anthropic 요청 이력에는 계정 표식이 없어서, 계정 홈 `config.json`의 `anthropicAccountPool.enabled`를 켜 `anthropic-p<hex6>` provider 접미사를 표식으로 삼는 설계가 필요합니다. 이 방식이 계정 1개 홈에서 실제로 동작하는지는 실측 전이므로 미검증입니다 [U16].

- 자동으로 증명할 수 있는 것: 계정 홈에 anthropic 계정이 하나뿐이라는 점, 그 계정이 OAuth 자격 증명이라는 점, 요청 이력의 provider 표식과 모델 문자열.
- 사람이 확인해야 하는 것: 로그인한 Claude 계정이 OMT 전용 실행에 써도 되는 계정인지, 구독 등급, 청구 귀속, 제3자 프록시 사용이 약관에 부합하는지.

### Agy runner

구현이 가능하며 현재 구조에 가장 가깝습니다. google-antigravity의 요청 이력은 `o<hex6>` 계정 라벨을 이미 기록하므로 OpenAI 계정 홈 검증과 같은 방식으로 고정을 증명할 수 있습니다. 실측 전에는 미검증입니다.

- 자동으로 증명할 수 있는 것: 계정 1개와 OAuth 출처, 계정 라벨(`o<hex6>`), 요청 모델.
- 사람이 확인해야 하는 것: 로그인 화면에서 올바른 Google 계정을 고르는지, 구독 등급, 청구 귀속, 약관.

### Windows 소유권 증명

조건부로 가능합니다. 프록시를 시작할 때 자식 PID 트리와 리스너 PID를 대조하는 소유권 증명은 구현할 수 있습니다. 그러나 Windows에는 프로세스 그룹이 없어서 종료 완전성은 POSIX보다 약한 "기록한 PID 스냅샷이 모두 사라짐"까지만 증명할 수 있습니다. 이 한계를 받아들일지는 PM 판단 사항이며, 받아들이지 않으면 Windows에서 runner turn은 계속 unverified로 남습니다. 실제 Windows 동작은 CI `windows-latest`로 일부만 확인할 수 있습니다.

### 미확인 항목 수

이 문서가 "미확인"으로 표시한 항목은 모두 19개이며 [C절](#c-미확인-목록)에 `U1`부터 `U19`까지 모았습니다.

## 0. 근거 표기 규칙

- `PKG`는 설치된 OpenCodex 패키지 루트 `~/.omt/runtime/opencodex/runtimes/<fingerprint의 hex>/node_modules/@bitkyc08/opencodex`입니다. 이 문서의 `PKG/src/...:줄` 인용은 읽기 전용으로 확인한 사실입니다.
- OMT 저장소의 파일은 `plugins/oh-my-teams/scripts/opencodex.mjs:줄`처럼 인용합니다.
- 소스로 확인하지 못했거나 실행해 보지 못한 내용은 "미확인"이라 쓰고 `[U번호]`를 붙였습니다. 실측하지 못한 동작은 지원 완료로 쓰지 않고 "미검증"이라 씁니다.
- 활성 런타임은 `~/.omt/runtime/opencodex/active.json`이 가리키며 이 문서를 쓸 때 확인한 버전은 2.59.0입니다.

## A. Claude·Agy fixed-account runner

### A1. 계정 홈 구조와 "계정 하나로 고정됨"의 검증 조건

OpenAI(Codex) 전용 검증기 `validateFixedOpenCodexAccountHome`(`plugins/oh-my-teams/scripts/opencodex.mjs:84-134`)은 `config.json`의 `codexAccounts`와 `codex-accounts.json`을 읽습니다. 그리고 `resolveOpenCodexBinding`(`opencodex.mjs:783-805`)은 항상 이 검증기를 호출합니다. Claude와 Agy에는 같은 검증기가 없으므로 provider별 검증기가 새로 필요합니다.

계정 하나로 고정해야 하는 이유는 OpenCodex가 두 번째 계정이 있을 때 스스로 다른 계정으로 넘어가기 때문입니다.

- generic OAuth 429 failover는 재인증이 필요 없는 계정이 둘 이상이면 켜지고 끌 수 없습니다(`PKG/src/oauth/generic-account-failover.ts:68`, `:100-157`).
- anthropic 429 rotation도 같은 조건으로 켜지고 끌 수 없습니다(`PKG/src/oauth/anthropic-routing.ts:101-112`, `:332-350`).
- 따라서 계정 하나만 둔 홈이 유일한 방어이며, OMT는 "계정 홈에 계정이 정확히 하나"라는 사실을 매 turn 시작 전에 검증합니다. 이 방어는 다른 구독이나 API 과금으로 자동 전환하는 경로를 만들지 않기 위한 것이기도 합니다.

계정 홈의 파일 구조는 다음과 같습니다.

| 파일 | 내용 | 근거 |
|---|---|---|
| `auth.json` | provider별 `accounts` 배열과 `activeAccountId`. 자격 증명이 들어 있으므로 OMT는 내용을 출력하지 않고 개수·플래그만 읽습니다. | `PKG/src/oauth/store.ts`, `PKG/src/oauth/types.ts:79-96` |
| `config.json` | 프록시 설정, 시작 동기화 가드, 풀 설정, combos, provider별 API 키 항목. | `PKG/src/cli/index.ts:596-650`, `PKG/src/oauth/pool-settings-capability.ts` |
| `admin-api-token` | 요청 이력 조회용 토큰. OMT가 헤더에만 싣고 값은 기록하지 않습니다. | `opencodex.mjs`의 `readOpenCodexHistory`(615행 이후) |

새 검증기 `validateFixedOpenCodexOAuthHome(accountHome, provider)`가 통과시켜야 하는 조건은 다음과 같습니다.

1. `auth.json[provider].accounts.length === 1`이고 `activeAccountId`가 그 계정의 id와 같습니다. provider는 `anthropic` 또는 `google-antigravity`입니다.
2. 그 계정의 `credential.source === "oauth"`입니다. API 키 자격 증명이면 거부합니다.
3. `needsReauth`가 설정되어 있지 않습니다. 재인증이 필요한 계정은 failover 판정에서 "쓸 수 없는 계정"으로 취급되므로 계정 수 계산에 영향을 줍니다.
4. `config.json`에 `combos`가 없고 `providers.<name>.apiKey*` 항목이 없습니다. `anthropic-apikey`라는 API 키 provider가 registry에 따로 있어서(`PKG/src/providers/registry/entries-core.ts:386-428`, `:994`) 접두사 없는 `claude-*` 모델은 키 경로로 라우팅될 수 있기 때문입니다.
5. 시작 동기화 가드가 있습니다. `runtimeRole === "hub"`, `clientIntegrations.codex === false`, `claudeCode.enabled === false`(또는 `systemEnv`와 `injectAgents`가 모두 `false`)입니다. 기존 OpenAI 검증기가 이미 같은 가드를 요구합니다(`opencodex.mjs:120-133`). `ocx start`가 전역 환경 변수 설정, 셸 훅 설치, Claude 에이전트 목록 변경을 하지 않도록 막는 조건입니다(`PKG/src/cli/index.ts:596-650`, `PKG/src/codex/desired-state.ts:120-140`).
6. 계정 라벨을 `auth.json`의 계정 id에서 해시로 계산해 프로필 표식과 대조합니다(A2). id와 이메일은 출력하지 않고 계산한 라벨만 다룹니다.

`ocx account login <provider>`가 남긴 자격 증명이 `oauth` 출처인지, 그리고 key-store와 `canonicalAuthMode`가 이 판정에 영향을 주는지는 확인하지 못했습니다 [U4].

### A2. 요청 이력으로 증명하는 방법과 증명할 수 없는 것

OMT는 turn 뒤에 `/api/request-history`를 `X-OpenCodex-API-Key` 헤더(계정 홈의 `admin-api-token`)로 커서 페이지 조회하고, turn 시작 전에 잡아 둔 boundary 이전의 ID를 제외합니다(`opencodex.mjs:615-702`, `:727-774`). 이력 행에서 증명하는 항목은 provider, 계정 표식, 모델입니다.

**provider와 계정 표식**

| provider | 이력의 provider 필드 | 계정 표식 | 근거 |
|---|---|---|---|
| google-antigravity | `google-antigravity` | attempt의 `accountLogLabel = o<hex6>`. `hex6 = sha256(baseProvider + "\0" + storeAccountId)[0:6]`입니다. | `PKG/src/providers/label.ts:59-70`, `PKG/src/codex/account-label.ts:36-38` |
| anthropic(풀 꺼짐, 계정 1개) | `anthropic` | 없음. 그래서 계정 증명이 불가능합니다. | 소스 직접 확인 |
| anthropic(풀 켜짐) | `anthropic-p<hex6>`. `hex6 = sha256(storeAccountId)[0:6]` | provider 접미사 자체가 표식입니다. | `PKG/src/oauth/anthropic-routing.ts:859-870` |

`isCodexUsageAccountLogLabel`을 통과하지 못한 라벨은 attempt에서 삭제되므로(`PKG/src/server/request-log.ts:1570-1585`), agy의 `o<hex6>` 형식은 이 검사를 통과하는 형식이어야 합니다. 이 점은 소스에서 확인했지만 실제 이력 행으로는 확인하지 못했습니다(미검증).

anthropic은 계정 홈 `config.json`에 `anthropicAccountPool.enabled: true`를 넣어 provider 접미사를 표식으로 삼는 후보 설계를 씁니다. 계정 1개인 홈에서 `resolveAnthropicAccountForSession`이 유일한 계정을 고른다는 것은 소스로 읽었으나(`PKG/src/oauth/anthropic-routing.ts:711-717`), 풀을 켠 채 1개 계정으로 실제 요청이 통과하고 접미사가 붙는지는 미검증입니다 [U16].

OMT 쪽 변경 사항은 다음과 같습니다.

- `openCodexProvider`(`opencodex.mjs:606-613`)는 `claude`를 항상 `anthropic`으로 옮깁니다. 풀을 켠 홈에서는 `anthropic-p<hex6>`를 기대값으로 만들도록 `accountLogLabel`을 받아야 합니다.
- `attemptsProveFixedAccount`(`opencodex.mjs:683-702`)는 attempt의 `accountLogLabel` 일치를 요구합니다. anthropic은 attempt 라벨이 없으므로 "provider 접미사 일치" 규칙을 별도로 둡니다.
- 계정 라벨은 auth.json의 계정 id에서 해시로 계산하며 `codex-accounts.json`에서 읽지 않습니다.

**모델**

- `requestedModel`은 클라이언트가 보낸 원문이고, `resolvedModel`과 `attempt.model`은 provider 접두사를 뗀 값입니다. 응답 payload의 model이 이 값을 덮을 수 있습니다(`PKG/src/server/responses/request-prepare.ts:381`, `:549`, `PKG/src/server/responses/request-transport.ts:466-575`). 실제 `resolvedModel` 값은 미확인입니다 [U17].
- 프로필 모델은 `anthropic/<id>`, `google-antigravity/<id>` 형태의 접두사를 붙인 문자열로 지정해 API 키 경로를 피합니다(`PKG/src/router.ts:735-800`). 기대값은 `requestedModel`이 프로필 모델 전체 문자열과 같고 `attempt.model`이 접두사를 뗀 값과 같은 것입니다. 현재 `readOpenCodexObservation`은 `requestedModel === model`과 `model === input.model`을 요구하므로(`opencodex.mjs:727-774`) 접두사 정규화가 필요합니다.
- Codex CLI가 접두사가 붙은 `--model` 문자열을 그대로 받아 프록시에 전달하는지는 확인하지 못했습니다 [U1].

**증명할 수 없는 것**

- 구독 등급: OpenCodex는 계정의 plan을 항상 null로 기록하므로 이력에서 알 수 없습니다.
- 청구 귀속: 요청이 어느 결제 주체에 청구되었는지는 프록시 바깥의 일이며 이력에 남지 않습니다.
- 약관 준수: 제3자 프록시를 거친 구독 OAuth 사용이 약관에 부합하는지는 사람이 판단합니다.
- 이력이 얼마 동안 보존되는지도 확인하지 못했습니다 [U5]. 실측에서는 turn 직후에 조회하고, 보존 정책이 확인되기 전까지 지연 조회에 의존하지 않습니다.

### A3. 실제 실행기와 경로별 동작

claude·agy 프로필이 runner를 가져도 실제로 실행되는 것은 Claude나 Antigravity의 CLI가 아닙니다. `openCodexCommand`(`opencodex.mjs:564-599`)가 만드는 것은 Codex CLI(`codex exec --json ...`)이고, `model_provider=omt-opencodex`, `base_url=http://127.0.0.1:<port>/v1`, `wire_api="responses"`로 로컬 OpenCodex 프록시에 요청합니다. 모델 인자는 프로필의 모델(접두사 형태)이고, `model_reasoning_effort`는 프로필 effort입니다.

- effort 허용 값은 provider마다 다릅니다: claude는 `low`부터 `max`, agy는 `low`, `medium`, `high`, codex는 `low`부터 `ultra`입니다(`plugins/oh-my-teams/scripts/providers/{claude,agy,codex}.mjs`). OpenCodex가 Codex CLI의 effort를 anthropic·antigravity 어댑터에서 어떤 값으로 옮기는지는 미확인입니다 [U15].
- Codex CLI가 요구하는 도구(파일 읽기·수정, 명령 실행)를 anthropic·antigravity 어댑터가 어디까지 변환하는지는 확인하지 못했습니다 [U2]. 어댑터별 usage 추정치도 미확인입니다 [U3].

경로별 동작은 다음과 같습니다.

| 경로 | 진입 | runner 처리 | 현재 상태 | 설계 |
|---|---|---|---|---|
| headless-start | `teams-org.mjs:815-850` → `startHeadlessWorker`(`headless.mjs:626-690`) | `command.runner`를 그대로 전달하고, `launchTurn`(`headless.mjs:580-625`)이 프록시를 띄웁니다. | `HEADLESS_PROVIDERS` 검사(`teams-org.mjs:824`)와 스트림 파서가 `worker.provider`를 기준으로 고릅니다(`headless.mjs:696`, `:806`, `:823`). claude 프로필은 claude 스트림 파서를 고르므로 Codex 스트림을 잘못 해석합니다. | 파서를 `actualRunner`(codex 스트림) 기준으로 고르도록 바꿉니다. `runnerTurnProven`(`headless.mjs:745-770`)은 그대로 씁니다. |
| work | `teams-org.mjs:1370` → `worker.mjs` `invoke` → `providers.mjs:205-330`의 runner 분기 | detached로 spawn하고 그룹 kill을 씁니다(`providers.mjs:246-265`). 디코더는 `adapterFor({...profile, provider:"codex"}).decode`입니다(`providers.mjs:267`). | 이미 Codex 스트림 디코더를 쓰므로 provider와 무관하게 동작할 수 있습니다. | 프로필 검증을 provider별 검증기(A1)와 표식 규칙(A2)으로 연결하는 변경이 핵심입니다. |
| role-command | `teams-org.mjs:1282-1294` | runner 프로필을 거부합니다. | 그대로 둡니다. | role은 대화형 터미널이며 프록시 turn 수명과 맞지 않으므로 거부를 유지합니다. |
| role-terminal | `teams-org.mjs:1282-1294` | runner 프로필을 거부합니다. | 병렬 kickoff 소유이므로 이 task에서 손대지 않습니다. | 거부를 유지합니다. |
| worker-start | `role-launch.mjs:246-262` | runner 프로필을 거부합니다. | 그대로 둡니다. | 거부를 유지합니다. |

`role-launch.mjs:366-408`의 `roleCommand`는 `actualRunner: "codex"`를 명시합니다(375~386행). `launchableProfile`(`role-launch.mjs:152-176`)은 `ORCA_LAUNCH`에 없는 provider를 대화형 터미널로 열 수 없다고 거부하고 runner 프로필은 예외로 통과시킵니다. 이 예외는 headless-start와 work에서만 유효합니다.

runner를 가진 프로필이 지원되려면 `OPENCODEX_RUNNER_PROVIDERS`(`opencodex.mjs`가 export하는 동결 배열)에 해당 provider가 들어 있어야 합니다. 이 이름은 병렬 task가 추가하고 있으며(이 워크트리에는 아직 없습니다), 지원 목록의 정본으로 가정합니다.

### A4. 격리 로그인 절차와 사용자 확인 항목

이 절차는 사람이 직접 실행합니다. 이 task는 로그인을 수행하지 않았습니다. `ocx account ...` 명령은 실행 중인 프록시가 필요하므로 터미널 A에서 프록시를 foreground로 띄우고 터미널 B에서 로그인합니다.

**공통 준비 (터미널 A와 B 모두)**

```sh
# 어느 provider를 쓰는지: anthropic 또는 google-antigravity
PROVIDER=anthropic
REF=claude-oauth               # 프로필의 account 이름. 환경 변수 이름에 쓰입니다.
PORT=47831                     # 다른 프록시와 겹치지 않는 임의의 빈 포트

# ocx 실행 파일 경로 (활성 런타임의 fingerprint에서 계산. active.json은 읽기만 합니다)
FP=$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.omt/runtime/opencodex/active.json","utf8"));console.log(a.fingerprint.replace(/^sha256:/,""))')
OCX="$HOME/.omt/runtime/opencodex/runtimes/$FP/node_modules/.bin/ocx"
test -x "$OCX" && "$OCX" --version

# 계정 홈 규칙: 빈 디렉터리여야 하고, 작업 디렉터리(저장소)와 ~/.opencodex,
# ~/.omt/runtime 밖에 둡니다. 계정마다 하나씩 따로 만듭니다.
ACC="$HOME/.omt/opencodex-accounts/$REF"
[ -e "$ACC" ] && echo "이미 존재합니다. 새 REF를 쓰고 이 줄 아래를 실행하지 마십시오"
mkdir -p -m 700 "$ACC/home" "$ACC/codex-home" "$ACC/proxy-home"
export OPENCODEX_HOME="$ACC/home"     # 계정 홈
export CODEX_HOME="$ACC/codex-home"   # 세션 홈. OMT가 미리 존재하기를 요구합니다.
export HOME="$ACC/proxy-home"         # ocx가 사용자 홈을 건드리지 않게 격리합니다.
```

`HOME`을 바꾸면 이후 명령이 `~`를 잘못 해석하므로, 위 변수는 로그인 전용 새 셸에서만 설정합니다. 이 셸에서는 `OCX`를 절대 경로로 이미 계산했으므로 문제가 없습니다. macOS 키체인이 `HOME` 변경의 영향을 받는지는 확인하지 못했습니다 [U6].

**시작 동기화 가드 (터미널 A, 프록시를 띄우기 전에 한 번)**

`ocx start`가 전역 환경 변수 설정, 셸 훅 설치, Claude 에이전트 목록 변경을 하지 않도록 계정 홈 `config.json`에 가드를 먼저 씁니다. 항목 이름은 `opencodex.mjs:120-133`의 검증기가 읽는 이름과 같습니다. anthropic이면 풀 설정도 함께 씁니다.

```sh
node -e '
const fs=require("fs");
const config={runtimeRole:"hub",clientIntegrations:{codex:false},claudeCode:{enabled:false}};
if(process.env.PROVIDER==="anthropic")config.anthropicAccountPool={enabled:true};
fs.writeFileSync(process.env.OPENCODEX_HOME+"/config.json",JSON.stringify(config,null,2),{mode:0o600});
'
```

`config.json`을 이렇게 미리 써 두어도 시작 동기화가 그 값을 유지하는지, 그리고 `anthropicAccountPool`의 정확한 키 이름과 구조는 확인하지 못했습니다 [U12]. 로그인 뒤 `ocx`가 파일을 덮어쓰지 않았는지 A4의 확인 단계에서 다시 봅니다.

**프록시 시작 (터미널 A, 그대로 두고 로그인이 끝날 때까지 유지)**

```sh
"$OCX" start --port "$PORT"
```

**로그인 (터미널 B, 같은 변수를 다시 설정한 새 셸)**

터미널 B에서도 위 공통 준비의 `OCX`, `ACC`, `OPENCODEX_HOME`, `CODEX_HOME`, `HOME`, `PROVIDER`를 같은 값으로 설정한 다음 다음 명령을 실행합니다. 프록시 주소가 필요하면 `--port "$PORT"`에 해당하는 옵션을 붙이는 방법은 확인하지 못했으므로 `"$OCX" account --help`로 먼저 확인합니다.

```sh
# 반드시 ocx account login 을 씁니다. `ocx login anthropic`은 로컬 ~/.claude 와 키체인의
# 자격 증명을 가져오므로 쓰지 않습니다.
"$OCX" account login "$PROVIDER"
```

- anthropic: `ocx account login anthropic`은 `addAccount=true`라서 `forceLogin`이 되고 `importLocal`이 `"off"`입니다(`PKG/src/cli/account.ts:42-69`, `PKG/src/cli/account-auth.ts:36-75`). 이 경로는 로컬 Claude 자격 증명을 가져오지 않습니다. `ocx login anthropic`은 `importLocal`이 `"fallback"`이라 로컬 자격 증명을 가져올 수 있습니다(`PKG/src/cli/account-auth.ts:194-226`).
- google-antigravity: 같은 명령이며 `forceLogin`일 때 브라우저에 `prompt: "consent select_account"`를 보내 계정 선택 화면이 항상 뜹니다(`PKG/src/oauth/google-antigravity.ts`). 사람이 이 화면에서 OMT 전용으로 승인된 Google 계정을 골라야 합니다.
- 이 머신에 브라우저가 없으면 `--no-wait` 뒤에 `ocx account code`(stdin)로 코드를 입력하는 경로가 있습니다(`PKG/src/cli/account-extended.ts`). agy에서도 같은 수동 입력이 동작하는지는 확인하지 못했습니다 [U14]. `ocx account import-orca`는 이 절차에서 쓰지 않으며 동작은 확인하지 못했습니다 [U7].

**계정 하나만 남기고 고정 (터미널 B)**

```sh
"$OCX" account list "$PROVIDER" --json      # 출력 구조는 미확인 [U18]. 필요하면 --json 없이 보십시오.
# 계정이 둘 이상이면 이번에 로그인한 계정만 남깁니다. <ID>는 list 출력에서 읽습니다.
"$OCX" account remove "$PROVIDER" <불필요한-계정-ID> --yes
"$OCX" account use "$PROVIDER" <남길-계정-ID>
"$OCX" account current "$PROVIDER"
```

계정 ID와 이메일은 터미널 화면에서 사람이 확인하되 보고서, 채팅, 커밋에는 옮겨 적지 않습니다. 계정을 다 정리했으면 터미널 A의 프록시를 Ctrl-C로 종료합니다.

**검증과 라벨 계산 (프록시 종료 후, 터미널 B)**

```sh
node -e '
const fs=require("fs"),crypto=require("crypto");
const auth=JSON.parse(fs.readFileSync(process.env.OPENCODEX_HOME+"/auth.json","utf8"));
const entry=auth[process.env.PROVIDER];
const accounts=entry?.accounts??[];
console.log("accounts:",accounts.length,"active-matches:",accounts[0]?.id===entry?.activeAccountId);
console.log("source:",accounts[0]?.credential?.source);
const id=accounts[0]?.id;
const h=(s)=>crypto.createHash("sha256").update(s).digest("hex").slice(0,6);
if(process.env.PROVIDER==="google-antigravity")console.log("label: o"+h("google-antigravity\0"+id));
else console.log("provider-suffix: anthropic-p"+h(id));
'
```

이 스크립트는 계정 id 원문을 출력하지 않고 개수, 일치 여부, 출처, 해시 라벨만 출력합니다. `auth.json`의 실제 필드 이름(`accounts`, `activeAccountId`, `credential.source`)은 `PKG/src/oauth/types.ts:79-96`에서 읽었지만 로그인 뒤의 실제 파일로는 확인하지 못했습니다. 위 스크립트가 `accounts: 1 active-matches: true source: oauth`를 출력하지 않으면 등록하지 말고 절차를 중단합니다.

**OMT에 넘길 환경 변수**

`<REF>`는 프로필의 `account` 이름을 대문자로 바꾸고 영문자·숫자가 아닌 문자를 `_`로 바꾼 값입니다(예: `claude-oauth`는 `CLAUDE_OAUTH`).

| 환경 변수 | 값의 출처 |
|---|---|
| `OMT_OPENCODEX_<REF>_HOME` | 위 `ACC/home`의 절대 경로 |
| `OMT_OPENCODEX_<REF>_LABEL` | 위 검증 스크립트가 출력한 라벨(agy는 `o<hex6>`, anthropic은 provider 접미사 `anthropic-p<hex6>`) |
| `OMT_OPENCODEX_SESSION_HOME` | 위 `ACC/codex-home`의 절대 경로. 계정마다 별도 빈 디렉터리이며 미리 존재해야 합니다. |

이 값은 이 셸의 `HOME`을 바꾼 상태에서 계산하지 말고, 원래 사용자 셸에서 `ACC`의 절대 경로를 직접 적어 설정합니다.

**PM이 이사에게 전달할 "사용자 확인 항목"**

1. 로그인할 Claude 계정과 Google 계정이 OMT 전용 실행에 써도 되는 계정인지 확인합니다.
2. 실측(A5)이 그 구독의 사용량 한도를 소모한다는 점을 승인합니다.
3. 제3자 프록시(OpenCodex)를 거친 구독 OAuth 사용이 각 서비스의 약관에 부합하는지 판단합니다. 이 항목은 자동으로 증명할 수 없습니다.
4. 로그인을 수행할 머신과 브라우저를 정합니다. 브라우저가 없으면 `--no-wait` 경로를 쓸지 정합니다.
5. Google 계정 선택 화면에서 승인된 계정을 고르는지 사람이 직접 확인합니다.
6. 계정 홈 디렉터리의 `auth.json`을 공유하거나 백업하지 않는다는 데 동의합니다.
7. 이 설계와 실측은 Codex 주간 한도가 리셋되는 2026-09-26 06:11 KST 전에 OpenAI 계정으로 모델을 호출하지 않는다는 점을 확인합니다.

### A5. 실측 계획과 지원 목록 편입 규칙

실측은 A4를 마치고 승인이 끝난 계정 홈 하나마다 한 번씩, 작은 저장소에서 다음 작업을 headless-start 경로와 work 경로로 각각 수행합니다. 이 task에서는 실행하지 않았고, 후속 task `runner-measure`가 담당합니다.

1. 파일 읽기: 저장소의 특정 파일 내용을 요약해 답하게 합니다.
2. 파일 수정: 지정한 한 줄을 고치게 하고 저장소 diff가 그 한 줄뿐인지 확인합니다.
3. 테스트 실행: 저장소의 테스트 명령을 실행하게 하고 통과 여부를 그대로 보고하게 합니다.
4. 완료 감지: `runnerTurnProven`(`headless.mjs:745-770`)의 조건(입력 수락, turn 시작, 상위 요청, 완료, 종료 관측, 후손 종료, 프록시 종료, termination `"exited"`)이 모두 충족되는지 봅니다.
5. 요청·실행 모델 일치: 요청 이력의 `requestedModel`이 프로필 모델 전체 문자열과 같고 `attempt.model`이 접두사를 뗀 값과 같은지, `resolvedModel`이 무엇인지 기록합니다 [U1, U17].
6. 계정 표식: 이력의 계정 표식이 A4에서 계산한 라벨과 같은지 봅니다(anthropic은 provider 접미사).
7. 계정 홈이 실측 전후로 계정 1개를 유지하는지 A1의 검증기로 다시 확인합니다.

**지원 목록 편입 규칙**

- provider가 `OPENCODEX_RUNNER_PROVIDERS`에 추가되는 조건은 위 7개 항목이 모두 통과한 것입니다.
- 하나라도 실패하면 그 provider를 `OPENCODEX_RUNNER_PROVIDERS`에 추가하지 않고, 문서에 "미검증"과 실패한 항목을 남깁니다.
- 실측 결과가 부분 통과이면 통과한 경로(headless-start 또는 work)만 기록하되, 목록에는 추가하지 않습니다.
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
| `terminateGroup` | `opencodex.mjs:214-228` | 그룹이 비었음을 `processGroupMembers`로 관측해야 통과하므로, `null`이면 `opencodex-proxy-exit-unverifiable`입니다. |

이 밖에 headless 경로는 Windows에서 이미 다르게 동작합니다.

- `headless-runner.mjs:267-276`은 win32에서 detached로 spawn하지 않습니다.
- `settleDescendants`(`headless-runner.mjs:312-325`)는 win32에서 `descendantsExited: false`를 돌려주므로 `runnerTurnProven`(`headless.mjs:745-770`)이 성립하지 않습니다. 결과적으로 Windows의 runner turn은 지금 항상 unverified입니다.
- `killTree`(`headless-runner.mjs:117-138`)는 win32에서 `taskkill /T /F /PID`를 씁니다. 종료 요청은 하지만 종료했다는 증명은 하지 않습니다.
- `core.mjs`의 `run`은 win32에서 `detached` 옵션을 무시합니다(`core.mjs:559`).
- `openCodexEnvironment`와 프록시 자식 격리는 `HOME`만 바꾸며(`opencodex.mjs:492-505`), `USERPROFILE`을 다루는 코드는 없습니다. Windows의 홈 디렉터리 조회가 `USERPROFILE`을 우선하는지는 이 문서에서 확인하지 못했지만, 격리를 Windows에서 주장하려면 함께 덮어써야 합니다.

OpenCodex 쪽 사실은 다음과 같습니다.

- `PKG/bin/ocx.mjs`는 Node 런처이며 자식 bun 프로세스를 spawn하고 종료 시그널을 자식에게 전달합니다(`PKG/bin/ocx.mjs:764-774` 근처의 주석). 포트를 잡는 프로세스는 런처가 아니라 bun입니다.
- 헬스 응답은 `port` 필드를 담아서 돌려줍니다(`PKG/src/server/index/serve-options.ts:526-545`). 이것이 소유권 증명의 첫 번째 조건입니다.
- 포트 회수와 종료 로직은 `PKG/src/lib/process-control.ts:333-346`, `PKG/src/server/port-reclaim.ts:99-118`, `PKG/src/config/process-state.ts`, `PKG/src/server/proxy-liveness.ts`에 있습니다. `/api/stop`이 토큰 없이 어떤 인증을 요구하는지는 확인하지 못했습니다 [U19].
- Windows에서 실제 bun 프로세스의 명령줄과 `bun.exe` 존재 여부, 런처와 bun의 부모 자식 관계를 조회할 수 있는지는 확인하지 못했습니다 [U8, U10].
- `.cmd` shim을 shell 없이 spawn하면 Node 22 이상에서 `EINVAL`이 날 수 있는지는 확인하지 못했습니다 [U9]. `dependencies.mjs:236`, `:406`이 win32에서 `.cmd`를 쓰므로 영향을 받는 경로입니다.
- `buildDesktop3pRegistry`가 Windows에서 하는 일은 확인하지 못했습니다 [U13].

### B2. Windows 소유권 증명 후보와 한계

POSIX 증명은 "헬스 바디의 port가 일치하고, 소유 프로세스 그룹에서 유일한 리스너가 그 포트를 잡고 있으며, 종료 뒤에 그룹이 비어 있다"는 세 조건입니다. Windows에는 프로세스 그룹이 없으므로 다음으로 바꿉니다.

**후보: 자식 PID 트리와 리스너 PID 대조**

1. 시작: `spawn`으로 얻은 런처 PID를 lease에 기록하고, 프로세스 목록에서 부모 링크(`ParentProcessId`)를 따라 후손 트리를 구성합니다. 조회 수단은 PowerShell의 `Get-CimInstance Win32_Process`(`ProcessId`, `ParentProcessId`, `CreationDate`, `CommandLine`)입니다. `wmic`은 Windows 11에서 제거되었으므로 쓰지 않습니다.
2. 리스너 PID: `Get-NetTCPConnection -State Listen -LocalPort <port>`의 `OwningProcess`, 또는 `netstat -ano -p tcp`의 출력을 읽습니다. 결과가 정확히 하나이고 그 PID가 1번 후손 트리에 속해야 합니다. 이것이 `ownedListenerPid`의 대응물입니다.
3. 헬스: 기존과 같이 `/healthz` 바디의 port가 일치해야 합니다.
4. pid 재사용 구별: `processStartTime`의 대응으로 `CreationDate`를 lease에 기록합니다. 후손 트리의 각 PID를 `(pid, CreationDate)` 쌍으로 스냅샷합니다.
5. 종료: `taskkill /T /F /PID <런처>` 뒤에 스냅샷의 모든 쌍이 사라졌음을 다시 조회로 확인합니다. 이것이 `terminateGroup`의 대응물입니다.

**한계**

- 부모가 먼저 죽으면 Windows는 자식의 `ParentProcessId`를 갱신하지 않으므로 후손 링크가 끊깁니다. 런처가 종료되고 bun만 남으면 트리로는 bun을 찾을 수 없습니다. 이 경우 리스너 PID의 `CommandLine`에서 `--port <port>`와 계정 홈을 대조하는 보조 증거가 필요하지만, 실제 명령줄 형태는 확인하지 못했습니다 [U10].
- 스냅샷을 찍은 뒤에 새로 만들어진 후손은 종료 증명에서 놓칠 수 있습니다. POSIX의 "그룹이 비었다"는 것보다 약한 증명이므로 결과에 `termination`을 `"exited"`로 그대로 주면 안 되고, 구별되는 값(예: `"exited-snapshot"`)을 두어 `runnerTurnProven`의 요건을 어떻게 다룰지 PM이 결정해야 합니다.
- Job Object는 프로세스 그룹에 가장 가까운 수단이지만 Node만으로는 만들 수 없고 네이티브 애드온이 필요하므로 채택하지 않습니다.
- `taskkill /F`로 강제 종료하면 OpenCodex의 pid 파일이나 포트 파일이 남는지는 확인하지 못했습니다 [U11]. 남으면 다음 시작이 이를 stale로 처리하는지 실측이 필요합니다.
- lease의 hard link 프로토콜(`fs.linkSync`, `opencodex.mjs:249`)은 NTFS에서 동작할 것으로 보이지만 Windows에서 실행해 확인하지 않았습니다. 소스의 다른 원자 연산은 `renameSync`(`opencodex.mjs:435`)입니다.

**판정**: 시작 시점의 소유권(리스너가 자식 트리에 속함)은 증명할 수 있습니다. 종료의 완전성은 스냅샷 한계 안에서만 증명할 수 있고, 이 한계를 결과에 그대로 드러내는 것이 설계의 조건입니다.

### B3. `dependencies.mjs` 상태 확인 종료의 Windows 동작

`healthCheck`(`dependencies.mjs:314-360`)는 격리 config와 임시 홈으로 `ocx`를 spawn하고 `/healthz`가 성공하면 `child.kill("SIGTERM")`으로 끝냅니다(352행). Node.js 문서에 따르면 Windows에서 `kill`의 시그널은 구별 없이 프로세스를 즉시 종료하고 자식 프로세스에는 영향을 주지 않습니다. 따라서 Windows에서는 런처만 죽고 bun이 남아서 포트를 계속 잡을 수 있습니다. 이 동작은 문서에서 온 사실이며 실제 Windows에서는 확인하지 못했습니다 [U8]. 런처가 종료 시그널을 자식에게 전달하는 로직(`PKG/bin/ocx.mjs:764-774` 근처)은 POSIX 시그널을 전제로 하므로 Windows에서는 동작하지 않을 수 있습니다.

`healthCheck`는 상태 진단이지 계정 홈 lease를 쓰는 경로가 아니라서 소유권 증명은 필요하지 않습니다. 그러나 남은 bun이 다음 진단의 포트를 점유하는 문제는 있으므로, Windows에서는 진단 종료를 `taskkill /T /F /PID`로 바꾸고 임의 빈 포트를 쓰는 것이 안전한 후보입니다. `dependencies.mjs`가 win32에서 `.cmd`를 쓰는 부분(236행, 406행)은 위 [U9]와 연결됩니다.

### B4. posixOnly 표

정본 정의는 두 곳입니다. `tests/dependencies.test.mjs:76`은 win32이면 건너뛰고, `tests/opencodex.test.mjs:459`는 win32이거나 `lsof -v`가 실패하면 건너뜁니다. `grep -rn posixOnly tests`의 25줄에는 정의 2줄과 테스트 사용 23줄이 함께 들어 있으며, 표는 이 25줄을 모두 다룹니다.

"Windows 실행 가능"은 지금 코드와 지금 테스트 그대로 Windows에서 돌릴 수 있는지를 뜻합니다. 유지 사유는 B 구현 뒤에도 skip을 유지해야 하는 이유이고, "이식 후보"는 대체 검증을 새로 쓰면 Windows에서 돌릴 수 있는 것입니다.

| # | 파일:줄 | 테스트 이름 | Windows 실행 가능 | 이유와 유지 사유 |
|---|---|---|---|---|
| 1 | `tests/dependencies.test.mjs:76` | (정의) `posixOnly` | 해당 없음 | win32이면 건너뜁니다. 가짜 런타임이 POSIX 셸 스크립트라는 이유를 씁니다. 이식 후보: 가짜를 `.cmd`나 Node 스크립트로 바꾸면 정의를 줄일 수 있습니다. |
| 2 | `tests/dependencies.test.mjs:136` | a healthy runtime is reused when only unrelated catalog checks fail | 아니오 | 가짜 `ocx`, `npm`, `codex`, `git`, `node`가 `#!/bin/sh` 또는 shebang 파일입니다. 이식 후보이며 `.cmd` 실행이 `EINVAL` 없이 되어야 합니다 [U9]. |
| 3 | `tests/dependencies.test.mjs:160` | a failing check the backend requires blocks turns but never replaces a healthy runtime | 아니오 | 같은 셸 스크립트 가짜(`codex`가 `exit 1`)입니다. 이식 후보입니다. |
| 4 | `tests/dependencies.test.mjs:178` | an unhealthy runtime is still reinstalled | 아니오 | 가짜 `ocx`를 `#!/bin/sh` 스크립트로 덮어씁니다. 이식 후보입니다. |
| 5 | `tests/dependencies.test.mjs:195` | the installer reports the plan when the runtime install fails after the plugins | 아니오 | 위와 같은 가짜 런타임을 씁니다. 이식 후보입니다. |
| 6 | `tests/opencodex.test.mjs:459` | (정의) `posixOnly` | 해당 없음 | win32이거나 `lsof`가 없으면 건너뜁니다. B 구현 뒤에는 조건을 "win32가 아니면서 `lsof` 없음"과 "win32이면서 PowerShell 없음"으로 나눕니다. |
| 7 | `tests/opencodex.test.mjs:567` | an owned proxy is accepted only as the sole listener of its own process group | 아니오 | `lsof`와 프로세스 그룹에 의존합니다. Windows에서는 "유일한 리스너가 자식 트리에 속함"으로 새로 씁니다(B2). |
| 8 | `tests/opencodex.test.mjs:589` | a healthy responder that another process group owns is refused | 아니오 | 다른 그룹의 detached 프로세스가 헬스에 응답하는 상황을 만듭니다. Windows에서는 "트리 밖 PID가 리스너"로 바꿔 쓸 수 있습니다. |
| 9 | `tests/opencodex.test.mjs:605` | a health body that does not name the port is refused | 아니오 | 로직은 플랫폼 무관하지만 가짜 `ocx`가 shebang 스크립트이고 현재 `startOpenCodexProxy`가 win32를 거부합니다. 이식 후보입니다. |
| 10 | `tests/opencodex.test.mjs:618` | a descendant left behind by an exited launcher is ended, not ignored | 아니오 | 같은 그룹의 후손이 런처 종료 뒤에도 남는 상황입니다. Windows는 부모 링크가 끊기므로 [B2 한계]가 걸립니다. 스냅샷 방식으로 일부만 이식할 수 있고 완전한 동치는 아닙니다. |
| 11 | `tests/opencodex.test.mjs:633` | stopping ends every member of the owned group, including one that ignores SIGTERM | 아니오 | Windows에는 SIGTERM 무시라는 개념이 없고 모든 kill이 강제입니다. 유지 사유: 전제가 성립하지 않으므로 POSIX 전용으로 남깁니다. |
| 12 | `tests/opencodex.test.mjs:650` | a tree whose exit cannot be inspected is unverifiable and keeps its lease | 아니오 | PATH에서 `ps`를 없애는 시나리오입니다. Windows에서는 PowerShell 조회가 실패하는 시나리오로 대체해야 합니다. 이식 후보입니다. |
| 13 | `tests/opencodex.test.mjs:707` | the proxy child runs with a private HOME, not the user's | 아니오 | 가짜 `ocx`가 `process.env.HOME`을 기록합니다. Windows에서는 `USERPROFILE`을 함께 검증해야 합니다. 이식 후보입니다. |
| 14 | `tests/opencodex.test.mjs:774` | a lease records its owner and, after spawn, the proxy group | 아니오 | `ps -o lstart=`로 processStart를 읽고 detached 그룹 리더를 만듭니다. Windows에서는 `CreationDate`와 PID 트리로 다시 씁니다. |
| 15 | `tests/opencodex.test.mjs:799` | a live owner keeps the home and is told apart from a dead one | 아니오 | `ps lstart`와 POSIX pid에 의존합니다. Windows에서는 `CreationDate` 비교로 이식할 수 있습니다. |
| 16 | `tests/opencodex.test.mjs:819` | a dead owner's lease is taken over and its orphaned proxy group is ended | 아니오 | 고아 프록시 그룹을 그룹 kill로 종료합니다. 스냅샷 방식으로 일부 이식 가능하며 부모 링크 소실 한계가 있습니다. |
| 17 | `tests/opencodex.test.mjs:846` | a reused owner pid does not count as a live owner | 아니오 | processStart 불일치로 pid 재사용을 판별합니다. `CreationDate`로 이식 후보입니다. |
| 18 | `tests/opencodex.test.mjs:864` | a reused proxy group id is not ended | 아니오 | 프로세스 그룹 id 재사용이라는 개념이 Windows에 없습니다. 유지 사유: "PID와 `CreationDate`가 다르면 종료하지 않는다"는 별도 테스트로 대체합니다. |
| 19 | `tests/opencodex.test.mjs:881` | a lease whose state cannot be proven clean is kept and reported as unverifiable | 아니오 | `ps` 부재 시나리오입니다. 12번과 같은 방식으로 이식합니다. |
| 20 | `tests/opencodex.test.mjs:914` | a turn killed with SIGKILL leaves a lease and proxy that the next turn cleans up | 아니오 | 러너를 SIGKILL하고 고아 프록시를 다음 turn이 정리합니다. 스냅샷 기반 정리가 가능하면 이식할 수 있으나 부모 링크 소실로 완전하지 않습니다. |
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
- `.cmd` shim spawn의 `EINVAL` 여부 [U9].
- `HOME`과 `USERPROFILE` 격리가 가짜 자식에서 반영되는지.
- 포맷, 린트, 정적 감사(`quality`)가 Windows 경로 구분자에서 깨지지 않는지.

**확인할 수 없는 것**

- 실제 OpenCodex 프록시(bun)의 부모 자식 관계, 명령줄, pid 파일 잔존 [U8, U10, U11]. CI 러너에 이 설치본이 없고 네트워크·인증이 필요한 실행을 이 task는 하지 않습니다.
- Windows에서 실제 Claude·Agy 계정 홈과 로그인 흐름. 사람이 격리 로그인을 해야 하며 CI는 자격 증명을 가지지 않습니다.
- 사용자 환경의 백신·방화벽이 `taskkill`이나 포트 조회에 미치는 영향.
- 장시간 실행 turn과 실제 모델 응답의 완료 감지.

## C. 미확인 목록

| 번호 | 미확인 내용 | 관련 절 |
|---|---|---|
| U1 | Codex CLI가 접두사가 붙은 `--model`을 그대로 받아 프록시에 전달하는지 | A2, A5 |
| U2 | 도구 호출 변환에서 anthropic·antigravity 어댑터가 지원하지 않는 범위 전체 | A3 |
| U3 | 어댑터별 usage 추정치를 Codex CLI 스트림에 어떻게 공급하는지 | A3 |
| U4 | key-store와 `canonicalAuthMode`가 OAuth 출처 판정에 미치는 영향 | A1 |
| U5 | 요청 이력의 보존 정책 | A2 |
| U6 | macOS 키체인이 `HOME` 변경의 영향을 받는지 | A4 |
| U7 | `ocx account import-orca`의 동작 | A4 |
| U8 | Windows에서 런처와 bun의 부모 자식 관계를 조회할 수 있는지, 종료 시그널 전달 여부 | B1, B3 |
| U9 | shell 없이 `.cmd` shim을 spawn할 때 Node 22에서 `EINVAL`이 나는지 | B1, B4, B5 |
| U10 | Windows에서 실제 bun 명령줄 형태와 `bun.exe` 존재 여부 | B1, B2 |
| U11 | `taskkill /F` 뒤 pid 파일과 포트 파일이 남는지 | B2 |
| U12 | 시작 동기화를 끄는 `config.json` 항목을 사전 설정으로 유지할 수 있는지, `anthropicAccountPool`의 정확한 키 | A4 |
| U13 | `buildDesktop3pRegistry`의 Windows 동작 | B1 |
| U14 | agy에서 `--no-wait`와 수동 코드 입력 경로가 동작하는지 | A4 |
| U15 | agy·claude에서 `model_reasoning_effort`가 실제로 어떤 값으로 변환되는지 | A3 |
| U16 | anthropic 풀을 켠 1계정 홈에서 요청이 통과하고 provider 접미사가 붙는지 | 판정 요약, A2 |
| U17 | 실제 이력 행의 `resolvedModel` 값 | A2, A5 |
| U18 | `ocx account list --json` 출력 형태 | A4 |
| U19 | `/api/stop`이 토큰 없이 요구하는 인증 조건 | B1 |

## D. 후속 task로 넘기는 결정 사항

- `claude-agy-runner`: A1의 검증기, A2의 provider별 증명 규칙, A3의 파서 선택 변경을 구현합니다. `OPENCODEX_RUNNER_PROVIDERS`에는 A5 통과 전에 추가하지 않습니다.
- `windows-proxy`: B2의 소유권 증명과 스냅샷 종료 증명을 구현합니다. `termination` 값과 `runnerTurnProven` 요건 변경은 PM의 결정이 필요합니다. B4의 표에서 "이식 후보"부터 옮깁니다.
- `runner-measure`: A4가 끝난 뒤 A5를 실행하고 U1, U15, U16, U17을 확정합니다.
- 사람: A4 절차를 실행하고 사용자 확인 항목 7개를 이사에게서 받아 옵니다.
