# OpenCodex 2.59.0 격리 검증

부분 완료: 버전을 고정한 로컬 설치와 로그인 없는 프록시 실행은 확인했지만, 세 구독의 실제 작업 수행과 계정 귀속은 아직 확인하지 못했습니다. 현재 증거로는 OMT의 공통 실행 경로 전환을 승인할 수 없습니다.

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
| OAuth 저장소 | `src/oauth/store.ts`는 격리 홈의 `auth.json`에 저장합니다. ChatGPT pool은 `src/codex/account-store.ts`의 `codex-accounts.json`을 사용합니다. 저장 위치를 확인했으며 토큰을 생성하거나 복사하지 않았습니다. |
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

[snapshot.py](../../experiments/opencodex/snapshot.py)는 비교 방법을 재현합니다. 메타데이터 해시에는 조회된 항목의 수정 날짜 정보가 포함되지만 키체인 전체나 모든 동명 계정을 열거하지 않습니다. 비밀값의 해시는 계산하지 않았습니다. 다른 세션이 동시에 동작하므로 미래의 변화가 발견되더라도 이 프록시의 변화로 바로 단정할 수 없습니다. 현재 비교는 로그인 이전의 결과이며 로그인 후 무변경을 대신 입증하지 않습니다.

## 세 구독의 동일 작업 비교

[픽스처와 실행 도구](../../experiments/opencodex/README.md)는 `sum.js`를 읽고 뺄셈을 덧셈으로 수정한 뒤 같은 Node 테스트를 실행하도록 구성했습니다. 세 번의 사전 점검 모두 같은 파일 해시와 baseline 테스트 종료 코드 1을 기록했습니다. 자격 증명 파일이 없어서 모델 프로세스를 시작하지 않았으며, JSON의 `requestedModel`은 예정된 요청값일 뿐 실제 요청의 증거가 아닙니다.

| 구독 | 상태와 근거 | 요청/관측 모델 | 계정 및 사용량 귀속 |
|---|---|---|---|
| 현재 ChatGPT 구독 | 미실행입니다. 격리 `codex-accounts.json`이 없습니다. | 조직의 모델이 null이므로 미정입니다. 관측값은 없습니다. | 확인하지 못했습니다. |
| 현재 Claude Max 구독 | 미실행입니다. 격리 `auth.json`이 없습니다. | 비교 후보는 `anthropic/claude-sonnet-4-6`입니다. 관측값은 없습니다. | 확인하지 못했습니다. |
| 현재 shared Antigravity 구독 | 미실행입니다. 격리 로그인이 없고 2026-09-21T06:04Z까지 호출하지 말라는 지시가 적용됩니다. | 비교 후보는 `google-antigravity/claude-sonnet-4-6`입니다. 관측값은 없습니다. | `agy-shared` pool을 유지해야 합니다. 실제 귀속은 확인하지 못했습니다. |

같은 Claude 모델은 제공자 이름으로 서로 다른 경로를 표현할 수 있습니다. 다만 모델 목록에서 실제 지원 이름, 응답의 모델, 계정별 요청 기록과 구독 사용량을 확인하기 전에는 두 구독을 실제로 구분했다고 판정할 수 없습니다. 모델 접두사나 OAuth 파일 존재만으로 귀속을 증명하지 않습니다.

사람에게 요청한 명령은 다음과 같습니다. 현재 ChatGPT 구독 계정, 현재 Claude Max 계정으로 각각 직접 로그인하며 계정 이메일이나 토큰은 보고하지 않습니다. 세 번째 명령은 시간 제한이 해제된 뒤 shared Agy 계정으로 수행해야 합니다. PM에게 `msg_1696e4ef1214`로 전달했고, PM은 이사에게 사람 조작을 요청했다고 회신했습니다.

```sh
env OPENCODEX_HOME=/tmp/omt-opencodex-probe.dAKX3U/ocx \
  CODEX_HOME=/tmp/omt-opencodex-probe.dAKX3U/codex \
  sandbox-exec -f /tmp/omt-opencodex-probe.dAKX3U/readonly-home.sb \
  /tmp/omt-opencodex-probe.dAKX3U/install/node_modules/.bin/ocx account login openai
```

같은 환경과 실행 파일을 사용하여 마지막 인수를 `account login anthropic` 또는 `account login google-antigravity`로 바꿉니다. 일반 `ocx login anthropic`, `account import`, `account main register`는 사용하지 않습니다. 로그인을 마치면 키체인 전후 비교를 다시 수행하고, 단일 계정과 자동 전환 비활성화를 확인한 뒤 `probe.py --execute --routing-reviewed`를 사용합니다. 프록시에 제공자가 아직 없으므로 로그인 후 생성된 제공자 설정도 검토해야 합니다.

## 관측한 실행 단계와 관측하지 못한 단계

Codex CLI의 설치된 `exec --help`에서 `--config/-c`, `--json`, `--ephemeral`, `--ignore-user-config`와 sandbox 인수를 확인했습니다. 별도 인증 없는 로컬 연결 음성 대조에서는 빈 제공자 설정을 유지하고 존재하지 않는 모델을 요청했습니다. `model_provider=probe`, `model_providers.probe.base_url=http://127.0.0.1:18473/v1`, `wire_api=responses`, `requires_openai_auth=false`를 CLI 인수로만 지정했습니다. 별도 로컬 HTTP 음성 대조의 오류 원문은 `OpenAI account pool has no usable account credential`이었고, 오류 유형은 `authentication_error`, 코드는 `invalid_api_key`였습니다. 존재하지 않는 모델도 계정 pool 인증 오류로 처리되었으므로 이 대조는 특정 제공자 라우팅의 정확성을 입증하지 않습니다. 결과는 다음과 같습니다.

| 단계 | 관측 범위 |
|---|---|
| 입력 수락과 turn 시작 | `thread.started`, `turn.started`를 관측했습니다. |
| 프록시 경유 연결 | 위 로컬 URL 설정으로 실행했고 인증 오류 401을 관측했습니다. 성공한 추론이나 상위 제공자 도달은 입증하지 않습니다. |
| 실패 종료 | `error`, `turn.failed`, 프로세스 종료 코드 1을 관측했습니다. |
| 파일 읽기·수정·테스트 | 로그인 전이라 모델 도구 실행을 관측하지 못했습니다. 픽스처의 baseline 실패만 로컬에서 확인했습니다. |
| 성공 완료 | `turn.completed`는 아직 관측하지 못했습니다. 재현 도구는 종료 코드 0과 해당 이벤트, 파일 변경 및 테스트 성공을 함께 요구합니다. |
| 권한 질문과 폴더 신뢰 | 확인하지 못했습니다. 비대화 exec 경로의 준비만으로 기존 감독 터미널의 Enter/신뢰 문제를 해결했다고 볼 수 없습니다. |
| 취소 | 활성 모델 turn의 취소와 자손 프로세스 정리는 확인하지 못했습니다. |

## 판정과 후속 조건

공통 경로 전환은 보류합니다. 설치와 제한된 무변경 기동은 가능했지만 세 구독의 작업 성공, 실제 모델, 사용량 귀속을 입증하지 못했기 때문입니다. 현재 단계에서는 필수 런타임 의존성으로 승격하거나 기존 실행기를 제거할 근거가 없습니다.

전환 검토를 재개하려면 사람의 격리 로그인, 계정 전환 및 API 과금 fallback 없는 단일 경로 확인, 세 구독의 동일 작업 실행, 모델과 계정 귀속 관측, 로그인과 종료 이후 전역 상태 비교가 필요합니다. Antigravity는 시간 제한 후 한 번만 시도하고 할당량 오류이면 반복하지 않습니다. 권한 질문과 취소는 별도의 감독 세션 검증이 필요하며 Windows 실측과 Senior 독립 검토도 남아 있습니다.

대안은 기존 Codex·Claude·Agy 실행 경로를 유지하고 OpenCodex를 이 격리 실험으로 한정하는 것입니다. 상위 제품의 명시적인 무주입 서버 모드나 키체인 저장 정책이 검증되면 플랫폼별 sandbox 의존성을 줄일 수 있습니다.

## 저장소 검사와 증거 한계

`npm ci`, `npm run format`, `npm run sync`, `npm run lint`, `npm test`를 실행했습니다. 동기화 결과는 변경과 누락이 없었고, lint 및 전체 테스트 377개가 통과했습니다. Python 스크립트 두 개는 AST 구문 검사를 통과했습니다. 별도 임시 복사본에서 결함 픽스처의 테스트 종료 코드 1과 수동 대조 수정 후 종료 코드 0을 확인했습니다. 수동 대조 결과는 구독 모델의 작업 성공으로 계산하지 않습니다.

이 검사는 실험 도구와 저장소 상태를 확인한 것이며 OAuth 이후의 실제 실행, 모델별 호환성, 구독 과금 귀속을 대신하지 않습니다. 독립적인 Senior 의미 검토와 PM 수용은 이 보고서 작성자가 수행하지 않았습니다.
