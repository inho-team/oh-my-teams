# OpenCodex 2.59.0 격리 검증

부분 완료: ChatGPT·Claude와 추가 Antigravity 두 계정이 같은 픽스처 작업을 완료했습니다. 다만 풀 안 자동 전환도 한 번 관측했지만 모든 전환의 정확한 시각·이전 계정 기록, 공유 계정 고정 비교와 신뢰 이후 입력 제출·진행 중인 상위 요청 취소 검증이 남아 있어 OMT의 공통 실행 경로 전환은 아직 보류합니다.

이 문서는 조사 결과이며 OMT 런타임의 지원 선언이 아닙니다. 작업은 `origin/main`의 `184c2de`를 기준으로 한 `docs/opencodex-probe` 브랜치에서 수행했습니다. 관측 환경은 macOS, Codex CLI 0.155.1, OpenCodex 2.59.0이며 Windows에서는 실행하지 않았습니다. 조직 revision 1의 구독을 유지하고 모델이나 계정을 대신 선택하지 않았습니다.

## 설치와 재현 환경

상위 지시의 임시 파일 규칙에 따라 설치물은 워크트리 밖 `/tmp/omt-opencodex-probe.dAKX3U`에 두었습니다. task의 `.omt-lab/` 예시는 사용하지 않았으며 전역 설치, `ocx init`, `ocx service`는 실행하지 않았습니다.

```sh
npm install --prefix /tmp/omt-opencodex-probe.dAKX3U/install \
  --foreground-scripts @bitkyc08/opencodex@2.59.0
```

설치는 종료 코드 0으로 끝났고 100개 패키지를 추가했습니다. 표시된 설치 스크립트는 `bun@1.4.0 postinstall: node install.js` 하나였습니다. OpenCodex 자체의 postinstall은 없습니다. `@napi-rs/keyring@1.3.0`은 의존성에 포함되어 있습니다. 실행 파일은 `/tmp/omt-opencodex-probe.dAKX3U/install/node_modules/.bin/ocx`이며, `--version` 출력은 `opencodex 2.59.0`이었습니다. 설치 lockfile의 해시, 로그와 조사한 소스의 해시는 [evidence.json](../../experiments/opencodex/evidence.json)에 보존했습니다. 최상위 버전만 고정한 npm 설치이므로 전이 의존성까지 재현하려면 해당 lockfile도 재사용해야 합니다.

격리 디렉터리 `ocx/`와 `codex/`를 만들고, `ocx/config.json`에 다음 값을 넣었습니다. 첫 기동은 생략한 `defaultProvider`를 `openai`로 보완했다고 알렸습니다. 제공자는 빈 객체로 유지되었습니다.

```json
{
  "port": 18473,
  "hostname": "127.0.0.1",
  "runtimeRole": "hub",
  "providers": {},
  "defaultProvider": "openai",
  "clientIntegrations": { "codex": false },
  "claudeCode": { "enabled": false, "systemEnv": false, "injectAgents": false },
  "syncResumeHistory": false,
  "tokenGuardian": { "enabled": false }
}
```

추가 방어로 `readonly-home.sb`에 다음 macOS sandbox 정책을 적용했습니다. 이는 이 컴퓨터에서 실행한 실험용 제한이며 공식적인 크로스 플랫폼 격리 계약은 아닙니다. 특히 securityd가 대신 수행하는 키체인 쓰기까지 막는 정책은 아닙니다.

```scheme
(version 1)
(allow default)
(deny file-write* (subpath "/Users/jinsungkim"))
```

```sh
OPENCODEX_HOME=/tmp/omt-opencodex-probe.dAKX3U/ocx \
CODEX_HOME=/tmp/omt-opencodex-probe.dAKX3U/codex \
sandbox-exec -f /tmp/omt-opencodex-probe.dAKX3U/readonly-home.sb \
  /tmp/omt-opencodex-probe.dAKX3U/install/node_modules/.bin/ocx start --port 18473
```

foreground 프로세스의 `/healthz`는 `status=ok`, `version=2.59.0`, `port=18473`을 반환했습니다. `lsof`로 PID 18274의 `127.0.0.1:18473` LISTEN을 확인했습니다. 기동 로그에는 `Codex integration OFF; startup left Codex native.`가 표시되었습니다. 설치 승인과 별개로 로그인은 사람이 수행해야 하므로 자동으로 시작하지 않았습니다.

## 격리 범위와 소스 근거

[공식 Agent Quickstart](https://opencodex.me/getting-started/for-agents/)는 foreground 기동과 `OPENCODEX_HOME`을 설명하지만, 환경변수 두 개만으로 모든 사용자 전역 상태가 격리된다고 보장하지 않습니다. [공식 Providers 문서](https://opencodex.me/guides/providers/)에 소개된 로그인 경로는 아래의 설치된 2.59.0 소스와 대조했습니다. 웹 문서와 npm 버전의 차이가 있을 수 있으므로 판정은 설치된 소스와 실제 관측에 한정합니다.

| 대상 | 확인 결과 |
|---|---|
| OpenCodex 설정 | `src/config/paths.ts`의 `getConfigDir()`는 `OPENCODEX_HOME`을 사용합니다. 기본값은 `~/.opencodex`입니다. |
| OAuth 저장소 | `src/oauth/store.ts`는 격리 홈의 `auth.json`에 저장합니다. ChatGPT pool은 `src/codex/account-store.ts`의 `codex-accounts.json`을 사용합니다. 사람이 공식 로그인 명령으로 격리 저장소를 생성했습니다. 이후 PM의 명시적 지시에 따라 기존 격리 Agy 저장소에서 계정별 홈으로 해당 계정 하나만 분리했습니다. 전역 자격 증명 파일은 복사하지 않았습니다. |
| Codex 설정 | `src/codex/paths.ts`는 `CODEX_HOME`을 적용합니다. 이 실험에서는 자동 주입을 껐고 CLI `-c`로 로컬 프록시를 지정했습니다. |
| API 키의 키체인 저장 | `src/providers/key-store.ts`는 opt-in이며 서비스 이름은 `opencodex.provider-api-key.v1`입니다. 이를 켜지 않았고 API 키를 사용하지 않았습니다. |
| native main profile | `src/codex/native-profile-store.ts`는 `@napi-rs/keyring`의 `AsyncEntry`를 사용하고 서비스 이름은 `opencodex.native-main-profile.v1`입니다. 이 기능의 키체인 없는 모드는 확인하지 못했으므로 사용하지 않습니다. |
| Claude 전역 자격 증명 | 일반 `ocx login anthropic`은 `importLocal=fallback` 경로로 `Claude Code-credentials` 키체인과 `~/.claude/.credentials.json`을 읽을 수 있습니다. `CLAUDE_CONFIG_DIR`만 바꿔도 키체인 읽기는 없어지지 않습니다. |
| 새 Claude 계정 로그인 | `ocx account login anthropic`은 `src/cli/account-auth.ts`에서 `addAccount=true`를 보내고, `oauth-account-routes.ts`가 `forceLogin=true`로 전달하므로 로컬 CLI 자격 증명 가져오기를 건너뜁니다. 이 경로를 사람에게 안내했습니다. |
| 시작 시 전역 접근 | `src/cli/index.ts`는 셸 훅 정리와 Claude agent 동기화를 호출합니다. `system-env-shell.ts`는 `$HOME/.zshrc`를 읽고 기존 OpenCodex 훅이 있으면 제거할 수 있습니다. 따라서 두 홈 환경변수만으로 일반적인 무변경을 보장할 수 없습니다. hub 역할과 비활성화 설정, 추가 sandbox를 함께 사용했습니다. |
| Gemini | 조사한 `oauth/google-antigravity.ts`에서는 `~/.gemini` 파일 접근을 발견하지 못했습니다. 모든 동적 경로를 추적한 것은 아니므로 읽기 없음까지 입증하지는 않습니다. |

### 전후 비교

설치 전에는 두 전역 설정 파일의 내용 해시와 수정 시각, `.opencodex`와 `.gemini`의 존재 및 수정 시각을 기록했습니다. 키체인은 프록시 시작 전에 비밀값을 요청하지 않는 `security find-generic-password -s <서비스>`로 메타데이터 해시를 기록했습니다. 시작과 로컬 연결 검사 뒤에도 해당 값은 같았습니다. `.zshrc`는 시작 후 로그인 전부터 추가로 관측했으므로 설치 전 비교로 표시하지 않습니다.

| 대상 | 설치 전 또는 시작 전 → 시작 후 |
|---|---|
| `~/.codex/config.toml` | SHA-256 `7cdc764a7f203224592abae5b4b838e06c5a530ba45bd5030161375a0d83cb98`과 mtime_ns `1789960577809199061`이 같았습니다. |
| `~/.claude/settings.json` | SHA-256 `6eabc551fb3052311834595d2d24f836341757d3889717c4e5a75bead57a7be6`과 mtime_ns `1789642503855339875`가 같았습니다. |
| `~/.opencodex` | 전후 모두 존재하지 않았습니다. |
| `~/.gemini` | 전후 모두 존재했고 디렉터리 mtime_ns `1789341168660791558`이 같았습니다. 내부 전체 파일은 비교하지 않았습니다. |
| OpenCodex의 키체인 서비스 두 개 | 전후 모두 `security` 종료 코드 44로 조회되지 않았습니다. |
| `Claude Code-credentials` | 조회 종료 코드 0과 메타데이터 SHA-256 `063b400b4f0f4099f03c8547fd250f7a7d293b800d7bd4839f817da4627a3c67`이 같았습니다. |

[snapshot.py](../../experiments/opencodex/snapshot.py)는 비교 방법을 재현합니다. 메타데이터 해시에는 조회된 항목의 수정 날짜 정보가 포함되지만 키체인 전체나 모든 동명 계정을 열거하지 않습니다. 비밀값의 해시는 계산하지 않았습니다. 다른 세션이 동시에 동작하므로 미래의 변화가 발견되더라도 이 프록시의 변화로 바로 단정할 수 없습니다. 2026-09-21T03:55:54Z의 로그인 후 비교와 네 작업 실행 후 비교에서도 같은 파일·키체인 항목은 변하지 않았습니다. 각 단계의 전체 수치와 시각은 evidence.json의 postLoginSnapshot과 postFourRunsSnapshot에 있습니다.

## 구독별 동일 작업 결과

사람이 `account login openai`, `account login anthropic`, `account login google-antigravity`로 격리 로그인을 완료했고 PM이 터미널 출력을 확인했습니다. 이후 Agy 계정이 세 개로 늘었습니다. 사용자는 세 Agy 계정 모두 구독 계정이라고 확인했습니다. API는 `currentTier`와 `paidTier`를 반환하지 않았으므로 구독 등급은 API로 확인하지 못했습니다.

[픽스처](../../experiments/opencodex/fixture/sum.js)는 덧셈 대신 뺄셈을 수행합니다. [probe.py](../../experiments/opencodex/probe.py)는 임시 복사본에서 baseline 실패를 확인하고 Codex에 파일 읽기, 수정, 테스트를 요청합니다. 원래 테스트 파일의 해시가 유지되면서 수정 파일의 해시가 바뀌고 테스트가 통과해야 작업 완료로 판정합니다. 테스트 결과만 조작하여 통과하는 경우는 허용하지 않습니다.

| 구독·계정 | 요청 모델·프록시 관측 모델 | 작업 및 계정 관측 결과 |
|---|---|---|
| ChatGPT Pro | 저장된 `gpt-6-astra`, effort `medium`을 요청했고 프록시의 `resolvedModel`도 같았습니다. | 작업이 완료되었습니다. 명령 2개와 파일 변경 이벤트 1개, `turn.completed`, 종료 코드 0, 테스트 실패→성공을 관측했습니다. HTTP 200 요청 3건의 계정 표식 `p51c91e`는 고정한 Pro 계정의 저장된 logLabel과 일치했습니다. |
| Claude Max | `anthropic/claude-sonnet-4-6`을 요청했고 프록시의 실제 라우팅 모델은 `claude-sonnet-4-6`이었습니다. | 작업이 완료되었습니다. 명령 2개, `turn.completed`, 종료 코드 0, 파일 내용 변경과 테스트 실패→성공을 관측했습니다. HTTP 200 요청 3건은 `anthropic` 제공자였습니다. OAuth 단일 계정이었고 API 키 경로는 사용하지 않았습니다. API plan은 null이며 Max 구독이라는 근거는 사람의 로그인 확인입니다. |
| Agy 추가 계정 `143f974f…` | `google-antigravity/claude-sonnet-4-6`을 요청했고 프록시의 모델은 `claude-sonnet-4-6`이었습니다. | 한 번의 작업이 완료되었습니다. 읽기 명령 분류 2건과 테스트 명령 1건, 파일 수정, `turn.completed`, 종료 코드 0, 테스트 성공을 관측했습니다. HTTP 200 요청 3건 모두 계정 표식 `oa45d2e`였으며 각 요청의 sendCount는 1이었습니다. |
| Agy 추가 계정 `5926ffe8…` | 위와 같은 모델을 요청·관측했습니다. | 한 번의 작업이 완료되었습니다. 읽기 명령 분류 1건과 테스트 명령 1건, 파일 수정, `turn.completed`, 종료 코드 0, 테스트 성공을 관측했습니다. HTTP 200 요청 3건 모두 계정 표식 `o097be0`였으며 각 요청의 sendCount는 1이었습니다. |
| Agy 공유 계정 `e4a44806…` | 풀 전환 실험에서 같은 Claude 모델을 요청했습니다. | 사용자 예외 승인에 따라 04:09Z에 요청 한 건을 보냈고 OAuth 429 회복 뒤 추가 계정으로 전환되어 성공했습니다. 공유 계정 자체의 고정 픽스처 비교는 06:04:01Z 이후로 남아 있습니다. |

원시 계정 ID와 이메일은 보고서에 복사하지 않았습니다. evidence.json에는 계정 ID의 SHA-256, 요청 기록의 비밀값 없는 계정 표식, 전후 선택 상태를 보존했습니다. OpenAI는 자동 전환 기본값이 켜져 있어 이 실험 인스턴스에서만 끈 뒤 사용할 Pro 계정을 고정했습니다. `account list`에는 재인증이 필요한 다른 항목도 있었지만 실제 요청 3건의 계정 표식은 모두 고정한 계정과 같았습니다.

Codex가 보고한 사용량은 각각 ChatGPT 입력 35,543/출력 201, Claude 입력 36,440/출력 305, Agy 첫 계정 입력 36,368/출력 242, 둘째 계정 입력 36,312/출력 199토큰입니다. 이는 여러 요청을 포함하는 CLI turn의 사용량 보고이며 청구서 금액이나 정확한 구독 차감량을 뜻하지 않습니다. 프록시 요청별 usage도 evidence.json에 별도로 보존했습니다. 요청 모델과 프록시 라우팅 모델의 일치는 확인했지만 제공자 내부의 모델 실행을 독립적으로 증명하는 자료는 아닙니다.

Claude와 Agy는 동일한 Claude 모델에 대해 제공자와 계정 표식이 서로 다른 요청 기록을 남겼습니다. 따라서 두 구독 경로를 라우팅과 사용량 기록에서 구별할 근거가 있습니다. 다만 실제 구독 등급과 청구 내역까지 모든 API가 알려 주지는 않으므로 사람의 확인과 API 관측을 구분해야 합니다.

## 다계정 격리와 자동 전환 제약

설치된 `src/oauth/generic-account-failover.ts`는 재인증이 필요하지 않은 계정이 둘 이상이면 reactive 429 failover를 활성화합니다. `isGenericOAuthFailoverEnabled()`는 이 계정 수를 사용하며 `oauthAccountFailover.enabled=false`를 확인하지 않습니다. `src/oauth/pool-settings-capability.ts`도 proactive 선택과 reactive 429 회전을 구분하고, 후자는 계정 존재로 활성화되며 끌 수 없다고 명시합니다.

실제 세 계정 저장소를 읽는 설치 모듈에 메모리상 `enabled=false`, `autoSwitchThreshold=0`을 전달해도 `reactiveFailoverEnabled=true`였습니다. 이 검사는 추론을 호출하지 않았습니다. 따라서 `account auto-switch ... status`가 false라는 결과만으로 실패 시 다른 계정으로 전환되지 않는다고 판단하면 안 됩니다.

PM의 지시에 따라 다음 홈을 분리했습니다. 각 홈의 auth.json은 이미 사람이 로그인한 **격리 저장소**에서 해당 Agy 계정 하나만 담아 만들었으며 디렉터리 권한은 0700, 자격 증명 파일 권한은 0600입니다. 자격 증명 값은 로그·보고서·커밋에 포함하지 않았습니다. 원래 세 계정 홈은 후속 풀 실험을 위해 보존했습니다.

| 계정 | OPENCODEX_HOME | 포트 | 검증 |
|---|---|---:|---|
| `143f974f…` | `/tmp/omt-opencodex-probe.dAKX3U/agy-143f974f/ocx` | 18474 | 실행 전후 account list가 1개였고 current 계정 해시가 같았으며 reactive failover는 false였습니다. |
| `5926ffe8…` | `/tmp/omt-opencodex-probe.dAKX3U/agy-5926ffe8/ocx` | 18475 | 위와 같은 검사를 통과했습니다. |
| `e4a44806…` | `/tmp/omt-opencodex-probe.dAKX3U/agy-e4a44806/ocx` | 18476 | 홈만 준비했고 추론은 실행하지 않았습니다. |

이 구성은 공식 문서의 `OPENCODEX_HOME`, 설치 소스의 홈별 auth 저장, 공식 `start --port` 기능을 조합한 것입니다. 단일 계정 저장소에서는 설치 모듈의 failover 판정이 실제로 false였고 요청 기록도 다른 계정으로 바뀌지 않았습니다. 그러나 계정 레코드를 별도 홈으로 분리하는 전체 절차가 공식 지원되는 계정 이동 명령이라고 주장하지는 않습니다. 원래 홈과 복제한 홈이 같은 refresh token을 동시에 갱신하면 충돌할 수 있으므로 장기 운용에서는 계정마다 독립 로그인하고 단일 프로세스가 갱신을 소유하는 정책이 필요합니다.

사용자는 이후 정책을 완화하여 **명시한 같은 provider의 구독 계정 풀 안에서만** 자동 전환을 허용했습니다. 다른 provider, 다른 모델, API 과금으로의 전환은 여전히 금지됩니다. 전환 시 이전/다음 계정, 이유와 시각을 기록해야 합니다. 계정별 비교는 계속 단일 계정 홈에서 수행하고, 풀의 전환 동작은 별도 실험으로 검증합니다. 이 결정은 `.omt/agy-accounts-decision.json`의 switchPolicy와 PM 메시지 `msg_9bbba52b5826`에 근거합니다.

OMT 어댑터에는 고정 계정 모드와 선언된 풀 모드를 구분하는 계약이 필요합니다. 고정 계정 모드는 계정별 `OPENCODEX_HOME`을 사용해야 합니다. 풀 모드에서는 OAuth pool의 계정 목록을 선언된 목록과 대조하고 요청의 모든 attempts에서 provider, model, accountLogLabel과 상태를 확인해야 합니다. `account current`만 조회하면 한 요청 안의 일시적인 전환을 놓칠 수 있습니다. 아래 풀 실험에서 이 한계를 구체적으로 확인했습니다.

계정별 할당량은 `ocx account refresh google-antigravity --json`으로 관측할 수 있으나 이는 모델 추론과 다른 메타데이터 호출입니다. 구독 등급 미노출과 할당량 창은 별개입니다. 사용자 확인에 따른 구독 여부, API가 관측한 사용률·재설정 시각, 실제 추론의 계정 표식을 따로 기록해야 합니다.

### 선언된 풀의 전환 실측

PM은 사용자 승인을 확인한 메시지 `msg_db97868379da`에서 재설정 전 공유 계정 요청 **한 건만** 예외로 허용했습니다. [pool.py](../../experiments/opencodex/pool.py)는 세 계정 목록을 선언된 목록과 대조하고 공유 계정을 active로 둔 뒤 단일 `/v1/responses` 요청을 보냈습니다. 외부 재시도는 하지 않았고 재실행 방지 lock을 남겼습니다.

- 시작은 2026-09-21T04:09:07.250888Z, 종료는 04:09:10.059271Z였습니다. HTTP 200, responseStatus `completed`, responseModel `claude-sonnet-4-6`을 받았습니다.
- account current의 전후 해시는 공유 계정 표식 `o7bcb01`에서 추가 계정 표식 `oa45d2e`로 바뀌었습니다. provider와 모델은 유지되었습니다.
- request-history의 회복 사유는 `oauth-account-429`, sendCount는 2, 최종 계정 표식은 `oa45d2e`였습니다. 이 요청에서 선언한 다른 provider나 API 과금 경로로 이동한 흔적은 없었습니다.
- 응답에는 account 이름을 포함한 헤더가 없었습니다. 요청 기록의 attempts도 전환 전후 두 항목이 아니라 최종 계정의 한 항목으로 집계되었습니다. 이전 계정과 전환 순간의 개별 시각, 최초 429 응답 원문은 이 기록에 노출되지 않았습니다.

따라서 **풀 안의 회복 전환과 모델 유지**는 관측했습니다. 이번처럼 요청이 하나뿐이면 실행 전후 current와 요청 구간을 결합하여 이전·다음 계정, 이유와 관측 시간 구간을 기록할 수 있습니다. 그러나 동시 요청에서 모든 전환의 정확한 시각과 이전 계정을 완전하게 복원할 수 있다고 판정할 수는 없습니다. OMT가 요청별 전환 이벤트를 받을 수 있는 공식 API가 추가되거나 요청 소유권과 동시성 제약을 명확하게 정하지 않는 한, 사용자의 전환 기록 계약을 완전히 충족했다고 선언해서는 안 됩니다.

## 실행 단계의 관측 범위

| 단계 | 확인 범위 |
|---|---|
| 입력 수락과 turn 시작 | 네 작업에서 `thread.started`와 `turn.started`를 관측했습니다. |
| 파일 수정 및 테스트 | 네 작업 모두 파일 해시 변경, 테스트 원본 유지, 테스트 성공을 확인했습니다. ChatGPT·Claude의 최초 기록기는 명령 원문을 버렸으므로 파일 읽기를 명령 단위로 따로 분류하지 않았습니다. Agy 두 작업에서는 읽기·테스트 명령 분류도 기록했습니다. |
| 성공 완료 | 네 작업에서 `turn.completed`와 종료 코드 0을 함께 확인했습니다. |
| 실패 종료 | 로그인 전 로컬 음성 대조에서 인증 401, `turn.failed`, 종료 코드 1을 확인했습니다. 원문은 `OpenAI account pool has no usable account credential`이었습니다. |
| 모델 관측 | CLI 이벤트에는 model 필드가 없어 배열이 비어 있습니다. 별도의 프록시 request-history에서 requestedModel과 resolvedModel을 대조했습니다. |
| 권한 질문·폴더 신뢰 | 새 Git 폴더와 새 CODEX_HOME에서 권한 우회 플래그를 사용했는데도 폴더 신뢰 질문이 나타났습니다. 지시에 따라 답하지 않고 관측 후 터미널을 닫았습니다. |
| 취소 | ChatGPT 경로에서 turn.started 직후 SIGINT를 보내 종료 코드 1을 관측했습니다. 직후 자손 PID 하나가 남았으나 후속 관측에서는 알려진 PID가 모두 사라졌습니다. 프록시에는 새 요청이 없었으므로 진행 중인 상위 요청 취소까지 입증하지는 않습니다. |

### 취소와 대화형 화면 실측

[cancel.py](../../experiments/opencodex/cancel.py)는 고정한 ChatGPT Pro 계정, gpt-6-astra/medium 경로에서 한 번만 실행했습니다. 04:22:24.155810Z에 시작했고 `thread.started`, `turn.started`를 읽은 직후인 04:22:24.307327Z에 해당 프로세스 그룹으로 SIGINT를 보냈습니다. 04:22:24.343338Z에 종료 코드 1을 받았으며 추가 SIGTERM은 필요하지 않았습니다. 완료나 실패 turn 이벤트는 없었습니다. SIGINT 직전 발견한 프로세스 여섯 개 중 하나가 직후 관측에 남았지만 후속 ps 관측에서는 모두 없어졌습니다. 정확한 후속 관측 시각은 evidence.json의 laterObservationAt에 있습니다.

프록시 request-history는 기존 9건에서 늘지 않았습니다. 따라서 이번 관측은 **로컬 turn 시작 후 상위 요청 기록이 생기기 전의 취소**입니다. 상위 제공자의 스트리밍 요청이 이미 시작된 상태에서의 취소나 과금 중단을 입증하지는 않습니다. OMT는 사용자의 취소 의도와 신호 기록을 보존해야 하며 종료 코드 1만으로 일반 실패라고 단정해서는 안 됩니다.

대화형 실험에서는 `/tmp/omt-opencodex-probe.dAKX3U/tui-trust`에 픽스처와 새 Git 저장소를 만들고, 새 `tui-codex` 홈과 프록시 CLI 인수, `--dangerously-bypass-approvals-and-sandbox`로 Codex를 띄웠습니다. 최초 실행 명령에 exec 전용 `--ignore-user-config`를 넣어 CLI 오류가 발생했으므로 이를 제거하고 같은 빈 홈으로 실행했습니다. 이 오류 단계에서는 모델을 호출하지 않았습니다. 최초 terminal create 뒤에는 셸 명령만 보였고 별도 Enter 뒤 CLI가 실행되었으므로, 터미널 생성 자체도 모델 turn 시작의 증거가 되지 않았습니다.

`orca terminal read --screen`은 실제 렌더링 화면에서 다음 내용을 반환했습니다.

```text
Do you trust the contents of this directory?
Trusting the directory allows project-local config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```

신뢰 질문에는 답하지 말라는 PM 지시가 있어 모델 프롬프트와 Enter를 보내지 않았습니다. 이 화면에서 Enter는 단순 제출이 아니라 신뢰 승인으로 작동하기 때문입니다. 셸 실행 명령의 send receipt는 `input_accepted`, provider `unsupported`였으며, 이를 모델 프롬프트의 제출 증거로 사용하지 않았습니다. 신뢰 이후의 `terminal send --enter --wait-submit`과 `turn_started` 구분은 아직 미검증입니다. 관측 터미널은 `terminal close`의 `ptyKilled=true`로 종료했습니다.

프록시와 권한 우회 플래그를 함께 사용해도 폴더 신뢰 단계가 남는다는 반례는 확보했습니다. OMT가 신뢰·권한 대화상자와 일반 프롬프트를 구분해야 한다는 요구는 공통 프록시 도입 후에도 유지됩니다.

## 판정과 남은 검증

세 구독 계열에서 같은 작은 저장소 작업을 수행할 수 있다는 긍정적인 증거가 생겼습니다. 그러나 공통 실행 경로의 전면 전환은 아직 보류합니다. 동시 요청에서 풀 전환을 완전하게 기록할 수 있는지, 공유 계정의 고정 비교, 신뢰 이후 입력 제출과 상위 요청 진행 중 취소, Windows 실행과 Senior 독립 검토가 남아 있기 때문입니다.

계정별 고정 실행은 단일 계정 홈으로 격리하고, 선언된 풀 안의 자동 전환은 요청별 계정 표식을 보존하는 별도 계약으로 다뤄야 합니다. OpenCodex의 auto-switch 표시를 그대로 OMT의 자동 전환 금지 정책으로 해석해서는 안 됩니다. 프로세스·토큰 갱신 소유권과 OAuth 파일 취급도 설치기의 `npm install` 한 줄로 해결되지 않습니다.

현재 대안은 기존 실행기를 유지하면서 이 증거를 바탕으로 제한된 공통 어댑터를 설계하는 것입니다. OMT 런타임 구현, 필수 의존성 승격, 버전 변경은 이 작업에서 수행하지 않았습니다.

## 재현과 검사

Codex는 격리 `CODEX_HOME`과 CLI `-c`만으로 프록시를 지정했습니다. 자동 Codex 설정 주입은 사용하지 않았습니다. `--port`는 계정별 프록시를 선택하고, `--not-before`는 해당 계정에 적용되는 호출 가능 시각을 명시합니다. 이 인수는 시간 제한을 임의로 해제하는 승인이 아니며 사용자가 허용한 계정과 시각만 지정해야 합니다. Antigravity는 각 lab의 attempt lock을 생성한 뒤 한 번만 실행합니다.

[collect.py](../../experiments/opencodex/collect.py)는 격리 홈의 관리 토큰을 메모리에서만 사용하고 요청 기록의 허용된 필드만 남깁니다. 원문 프롬프트, 자격 증명, 이메일은 저장하지 않습니다. [snapshot.py](../../experiments/opencodex/snapshot.py)는 전역 파일과 키체인의 제한된 메타데이터 전후 비교를 재현합니다.

최초 조사 커밋은 `npm run format`, `npm run sync`, `npm run lint`, `npm test`를 통과했고 전체 테스트는 377개였습니다. Python AST 검사와 별도 임시 복사본의 결함/수동 수정 대조도 통과했습니다. 후속 실측 기록에서도 같은 검사와 전체 테스트 377개를 통과했습니다. 추가 계정의 프록시 두 개는 증거 수집 후 SIGTERM으로 정상 종료했고 각각 종료 코드 0을 확인했습니다. 종료 후에도 조회한 전역 파일과 키체인 메타데이터는 동일했습니다. 원래 18473 프록시는 후속 검증을 위해 유지합니다. 이 검사는 구독 청구서 확인이나 독립적인 Senior 의미 검토를 대신하지 않습니다.
