# W2 OpenCodex 설치·실행 구현 계약

## 판정과 범위

부분 완료: W1은 macOS에서 OpenCodex 2.59.0의 격리 설치, 단일 계정 실행 및 제한된 한 건의 풀 회복 전환을 관측했지만, 요청별 완전한 전환 기록·상위 요청 진행 중 취소·Windows 실측은 확인하지 못했습니다. 따라서 W2-04는 고정 계정의 제한된 공통 runner만 구현할 수 있고, raw OpenCodex 다계정 풀과 미실측 경로를 기본 경로나 지원 완료로 활성화하면 안 됩니다.

이 문서는 W2-01의 구현 계약입니다. 구현 소유자는 W2-04 Junior이며, 이 문서는 `docs/plan/opencodex-w2-contract.md`만 변경합니다. Claude 또는 Agy의 새 추론, 전역 설정·로그인·키체인 복구는 이 계약과 구현의 범위가 아닙니다.

### W1 근거의 판정

| 항목 | 판정 | 구현에 사용할 수 있는 근거 | 활성화 제한 |
| --- | --- | --- | --- |
| OpenCodex 설치 | 제한적으로 확인됨 | 임시 prefix의 `@bitkyc08/opencodex@2.59.0` 설치와 `ocx --version`, foreground `/healthz`를 macOS에서 확인했습니다. | plugin host의 lifecycle 실행 여부와 영속 prefix는 아직 W2-02에서 확인해야 합니다. |
| 단일 계정 고정 실행 | 제한적으로 확인됨 | 계정 하나만 든 `OPENCODEX_HOME`에서 reactive failover가 false였고, 요청 모델·계정 표식·완료를 관측했습니다. | 사람의 독립 로그인과 한 개의 소유 프로세스가 필요합니다. 계정 홈 복사나 기존 자격 증명 import는 자동화하지 않습니다. |
| 선언된 풀의 전환 | 미수용 | 한 429 회복에서 provider·model 유지와 전후 current 계정 변화는 관측했습니다. | request-history에는 이전 계정·각 시도·정확한 전환 시각이 없으므로 동시 요청과 raw 풀은 fail closed입니다. |
| 취소 | 미수용 | local turn 시작 직후 SIGINT와 최종 프로세스 소멸을 한 번 관측했습니다. | 상위 streaming 요청이 시작된 뒤의 취소, 자손 종료, 재개는 미검증입니다. 불명확한 종료 뒤 대체 실행을 만들지 않습니다. |
| 폴더 신뢰와 제출 | 미수용 | 권한 우회 인수에도 Codex의 trust 화면이 남는 것을 관측했습니다. | trust 화면의 Enter를 일반 프롬프트 제출로 처리하지 않으며, 명시적 사용자 승인이 없는 자동 응답을 금지합니다. |
| 전역 상태와 키체인 | 미수용 | 초기 제한 비교는 통과했지만, 실행 기간 중 `Claude Code-credentials` 메타데이터가 변경됐고 원인을 특정하지 못했습니다. | 변경 전후 상태 검사를 필수화하되, 무변경을 주장하거나 항목을 복구하지 않습니다. |
| Windows | 미실행 | W1은 macOS에서만 실행되었습니다. | Windows 지원·기본 활성화·실측 완료로 표시하지 않습니다. 결정적 단위 검사는 추가하되 W2-06의 실제 증거가 필요합니다. |

## 공개 CLI와 결과 계약

공개 진입점은 `node plugins/oh-my-teams/scripts/teams-org.mjs` 아래의 다음 세 명령으로 고정합니다. `install.sh`와 `install.ps1`는 기존처럼 Node 설치기만 호출하며, runtime 준비 로직을 별도로 복제하지 않습니다.

```text
runtime-doctor --org <organization.json> --state <pm-state> [--format json]
runtime-install --org <organization.json> --state <pm-state> [--dry-run]
runtime-repair --org <organization.json> --state <pm-state> [--dry-run]
```

세 명령은 하나의 `dependencies.mjs` 서비스와 하나의 OpenCodex binding 서비스만 호출합니다. `runtime-install`은 doctor가 찾은 결함을 설치 가능한 범위에서 복구하고, `runtime-repair`는 손상·중단·불일치를 staging에서 다시 준비합니다. 어느 명령도 OAuth 로그인, provider 추론, `ocx init`, `ocx service`, 전역 plugin 목록 변경, 소유하지 않은 프로세스 종료를 수행하지 않습니다. `--dry-run`은 파일·프로세스·서비스·로그인 상태를 변경하지 않습니다.

의존성 진단은 W2-03의 `runtime-dependencies.json` schemaVersion 2를 소비합니다. doctor는 `requiredFor`에 따라 Node, Git, Codex, OpenCodex, Orca CLI, Orca desktop, `gh`를 분류하고, `detect.command` 또는 `detect.commands`와 `featureChecks`를 argv 배열로 실행합니다. `command -v`와 PowerShell `Get-Command`는 사람이 따를 PATH 안내에만 쓰며, 실행기는 catalog의 명령 문자열을 셸로 평가하지 않습니다. Orca는 기존 `orca-adapter.mjs`의 선택 실행 파일·status·capability discovery를 사용하고, 선택한 실행 파일이 실패했을 때 다른 Orca 또는 GNOME Orca로 fallback하지 않습니다. 패치 버전 차이만으로 차단하지 않고 필요한 capability가 없을 때만 `capability-unavailable`으로 차단합니다.

성공 JSON은 최소한 아래 필드를 반환합니다. human action이 필요하면 종료 코드는 0이 아니어야 하며 `status: "action-required"`와 `nextAction`을 반환합니다. 실행 경로가 지원되지 않으면 `status: "blocked"`와 안정된 `code`를 반환하고, 다른 provider·계정·모델·API 키 경로로 재시도하지 않습니다.

```json
{
  "schemaVersion": 1,
  "command": "runtime-doctor",
  "status": "ready",
  "checkedAt": "2026-09-21T00:00:00.000Z",
  "runtime": {
    "id": "opencodex",
    "version": "2.59.0",
    "prefixFingerprint": "sha256:<manifest-and-lock>"
  },
  "checks": [
    { "id": "runtime-install", "status": "pass", "evidence": "..." }
  ],
  "nextAction": null
}
```

`status`는 `ready`, `needs-install`, `action-required`, `blocked`, `failed`만 사용합니다. `checks[].status`는 `pass`, `fail`, `unknown`, `not-applicable`만 사용합니다. 진단 결과와 실행 receipt에는 access token, refresh token, 이메일, 원시 계정 ID, 프롬프트 원문을 넣지 않습니다. 계정 관측값은 기존 evidence 방식과 동일하게 비밀값 없는 `accountLogLabel` 또는 hash만 기록합니다.

사람의 인증 조작은 `nextAction`에만 안내합니다. fixed account의 새 인증이 필요하면 W1에서 import를 건너뛴 account-login 경로를 사람이 별도 격리 home에서 수행하고, 이후 doctor가 한 계정과 label만 검사합니다. 일반 OpenCodex login 또는 Claude local credential fallback, `CLAUDE_CONFIG_DIR` 변경만으로 격리가 확보되었다고 판단해서는 안 되며, 기존 `Claude Code-credentials`나 `~/.claude/.credentials.json`을 읽거나 복사하지 않습니다.

## 영속 설치와 복구

OpenCodex의 설치 정본은 plugin `package.json`의 정확한 `@bitkyc08/opencodex` 버전과 같은 디렉터리의 lockfile입니다. W1의 2.59.0은 구현 시작 시 이 두 정본에 고정하며, 버전 문자열을 다른 소스 파일에 복제하지 않습니다. plugin cache나 host global npm prefix는 runtime prefix가 아닙니다.

OMT 소유 영속 prefix의 논리 구조는 다음과 같이 고정합니다. 실제 기본 루트는 운영체제별 catalog가 제공하며, 루트가 없거나 권한 검증에 실패하면 설치를 멈추고 `runtime-prefix-unavailable`을 반환합니다.

```text
<omt-runtime-root>/opencodex/
  active.json
  locks/<fingerprint>.lock
  runtimes/<fingerprint>/manifest.json
  runtimes/<fingerprint>/package-lock.json
  runtimes/<fingerprint>/node_modules/
  staging/<random-fingerprint>/
```

`fingerprint`는 준비에 사용한 manifest와 lockfile 바이트의 SHA-256입니다. `active.json`은 성공적으로 검증한 fingerprint와 `ocx --version` 관측값만 가리키며, credential이나 계정 home을 포함하지 않습니다. runtime 계정 home은 prefix 밖의 workflow·account 소유 위치이며, 기존 전역 home이나 plugin cache 아래에 두지 않습니다.

구현 순서는 다음과 같습니다.

1. doctor는 Node·npm·필요한 lockfile·active runtime·`ocx --version`·실행 가능성을 읽기 전용으로 검사합니다.
2. install 또는 repair는 fingerprint lock을 획득하고 기존 active runtime을 계속 읽을 수 있게 둔 채 새 staging에서 lockfile 기반 설치를 수행합니다.
3. staging의 `ocx --version`이 package 정본과 일치하고 Bun 실행 가능성을 실제로 확인한 경우에만 manifest와 lockfile을 함께 보존하고 active pointer를 원자적으로 교체합니다.
4. npm 실패, lifecycle 미실행, 부분 `node_modules`, 버전 불일치, 권한 거부, 검증 시간 초과는 staging을 failed 상태로 남기고 기존 active pointer를 유지합니다. 실패 후 repair는 같은 검사부터 다시 시작하며, 정상 active runtime을 삭제하지 않습니다.

`ocx --version`만으로 Bun이 준비됐다고 판단하지 않습니다. lockfile로 설치한 runtime에서 Bun을 필요로 하는 OpenCodex 실행 경로를 실제로 한 번 기동하고, loopback의 준비 상태와 종료를 확인해야 합니다. 이 검증은 OAuth·provider 요청·`ocx init`·`ocx service`를 호출하지 않는 무인 준비 검사여야 합니다. W2-02가 host plugin lifecycle을 실측하기 전에는 plugin 설치가 npm lifecycle과 Bun postinstall을 수행한다고 추정하지 않습니다.

## 프로필, runner, account의 분리

기존 organization profile의 `provider`, `account`, `subscription`, `model`, `effort`, `pool`은 논리·정책 값이며 runner가 아닙니다. schema에 선택적 `runner` 객체를 추가하되, 기존 profile은 이 필드가 없어도 현재 provider adapter로 계속 해석해야 합니다. 기존 organization과 진행 중 workflow snapshot은 자동 migration하거나 자동 선택하지 않습니다.

```json
{
  "runner": {
    "kind": "opencodex",
    "mode": "fixed-account",
    "accountHomeRef": "opencodex-codex-current",
    "runtimeFingerprint": "sha256:<manifest-and-lock>"
  }
}
```

`runner.kind`는 초기에는 `opencodex`만 허용하고, 필드가 없으면 `legacy`입니다. `runner.mode`는 초기에는 `fixed-account`만 허용합니다. `accountHomeRef`는 profile의 named `account`와 일치하는 OMT 관리 reference이며 경로·자격 증명 자체가 아닙니다. `runtimeFingerprint`는 선택된 active runtime과 정확히 일치해야 합니다. `provider`, `account`, `model`, `effort`, `pool`, `subscription`을 `runner`로 옮기거나 추론 결과로 덮어쓰지 않습니다.

OpenCodex 2.59.0 runner의 허용 조건은 다음과 같습니다.

- `account`는 `current`가 아닌 명시된 단일 계정이어야 합니다.
- account home의 인증 목록은 정확히 한 계정이어야 하며, 현재 계정의 비밀값 없는 표식이 binding과 일치해야 합니다.
- `OPENCODEX_HOME`은 그 account home만, `CODEX_HOME`은 그 turn 또는 session 소유 home만 가리켜야 합니다. 두 home과 runtime prefix는 서로 달라야 합니다.
- API key 환경변수와 API-key provider 경로가 감지되면 `api-key-fallback-blocked`로 실패합니다.
- 요청 모델·transport 모델·관측 모델은 각각 기록합니다. 요청한 모델의 관측값이 없으면 `unproven`, 다르면 `mismatched`이며 `matched`가 아닙니다. `model: null`은 host-default 관측을 통한 별도 확인 전에는 common runner에 연결하지 않습니다.
- effort는 현재 provider adapter가 검증한 값만 전달하며, null 또는 누락은 provider default라는 관측값으로 대체하지 않습니다.

raw 다계정 OpenCodex home, `pool`이 지정된 profile, `account: current`, 관측하지 못한 provider/model/effort 조합은 `opencodex-pool-unverified` 또는 `opencodex-binding-unverified`로 fail closed합니다. 해당 profile은 기존 runner가 있으면 그 경로를 유지하고, 새 runner만 명시한 profile은 시작하지 않습니다. 이 제한은 같은 Claude 모델의 Claude와 Agy 구독 경로를 하나의 Codex provider로 합치지 않도록 보장합니다.

## 호출, 상태, 계측 계약

새 `opencodex.mjs`는 기존 provider registry와 `providers.mjs`의 request 생성·`modelBinding`·오류 정규화를 재사용합니다. `headless.mjs`의 Codex JSONL decoder와 세션 재개 형식, `headless-runner.mjs`의 `stop.request`·POSIX process group·Windows `taskkill` 기록, `role-launch.mjs`와 `role-terminal.mjs`의 권한 및 trust 경계도 유지합니다. OpenCodex 화면·OAuth·서비스 관리자와 Orca terminal·Dispatch·입력 receipt는 재구현하지 않습니다.

각 attempt receipt는 다음 최소 상관관계를 유지합니다.

```json
{
  "attemptId": "caller-owned-id",
  "taskId": "task-id",
  "dispatchId": "dispatch-id-or-null",
  "logicalProfile": "profile-id",
  "logicalBinding": {
    "provider": "agy",
    "accountRef": "named-account",
    "modelRequested": "google-antigravity/claude-sonnet-4-6",
    "effortRequested": "medium",
    "pool": "declared-pool-or-null"
  },
  "runner": { "kind": "opencodex", "runtimeFingerprint": "sha256:..." },
  "observed": {
    "provider": "google-antigravity",
    "accountLogLabel": "hash-or-label",
    "model": "claude-sonnet-4-6",
    "modelBinding": "matched"
  },
  "lifecycle": {
    "inputAccepted": false,
    "turnStarted": false,
    "upstreamRequestStarted": false,
    "completed": false,
    "exitObserved": false,
    "cancelRequested": false,
    "termination": "unverifiable"
  }
}
```

`inputAccepted`, `turnStarted`, `upstreamRequestStarted`, `completed`, `exitObserved`는 독립적인 boolean입니다. 하나가 true여도 다음 상태를 유추하지 않습니다. 완료는 `completed`, 정상 종료 관측, 해당 task의 검증 결과가 모두 있을 때만 기록합니다. 종료 코드 0 또는 완료 표식만으로 완료를 선언하지 않습니다. usage는 CLI 또는 proxy 중 하나의 source와 deduplication key로 한 번만 ledger에 넣으며, 누락 usage는 0이 아니라 `unknown`입니다.

취소 요청은 `cancelRequested`와 시각을 먼저 기록하고 기존 headless stop 경로를 사용합니다. owner가 아닌 프로세스를 종료하지 않으며, `exitObserved`와 자손 종료가 모두 확인되지 않으면 `termination: "unverifiable"`로 남깁니다. 이 경우 자동 재시도·대체 계정·대체 provider 실행을 금지합니다. 상위 요청 진행 중 취소와 Windows 실제 종료 증거가 생기기 전에는 이를 지원 완료로 표시하지 않습니다.

신뢰 또는 권한 화면이 감지되면 `action-required`를 반환하고, 화면의 Enter를 prompt receipt로 기록하지 않습니다. 사람의 명시적 승인 이후에만 기존 Orca/Codex 경계에서 재개할 수 있습니다.

## 최소 검증과 활성화 게이트

W2-04는 다음의 결정적 검사와 기존 회귀 검사를 추가해야 합니다.

| 영역 | 반드시 증명할 검사 |
| --- | --- |
| 설치 | 미설치, 정상 재사용, manifest/lock 불일치, partial install, npm/Bun 실패, 권한 거부, 중단 후 repair, concurrent lock을 주입합니다. 정상 재실행은 다운로드와 파일 변경이 없어야 하며 실패는 이전 active runtime을 보존해야 합니다. |
| 실행 | fixed-account runner의 home 분리, 한 계정 검증, API key 차단, provider/account/model/effort 보존, observed model 누락, model 불일치, null model 차단을 검사합니다. |
| 상태 | input accepted, turn started, upstream request, complete, exit, trust 질문, 취소와 자손 잔존을 각각 입력하여 상호 추론하지 않음을 검사합니다. |
| 호환성 | runner 없는 기존 organization과 진행 중 workflow snapshot을 변경 없이 읽고 실행하며, 기존 provider adapter·usage·quota·failure 분류를 보존함을 검사합니다. |
| 이식성 | macOS·Windows 경로와 npm shim을 결정적으로 검사합니다. 실제 Windows 설치·첫 실행·repair는 W2-06의 host 증거가 생길 때까지 `not-applicable`로 남깁니다. |

기본 활성화는 다음 조건을 모두 만족할 때만 PM이 별도로 결정할 수 있습니다: W2-02의 두 host lifecycle 증거, W2-03의 공식 설치 catalog, exact implementation HEAD의 설치·실행·복구 검사, W2-06의 실제 macOS와 Windows 증거, 별도 Senior의 독립 review, 그리고 raw pool의 완전한 attempt 기록 또는 명시적 계속 차단입니다. 이 계약 자체는 기본 활성화나 W1 수용을 승인하지 않습니다.

## 구현 순서와 소유 경계

1. W2-02와 W2-03 결과를 먼저 contract의 `unknown` 항목과 대조합니다. 결과가 제한을 해소하지 못하면 runtime-install의 해당 capability를 `blocked`로 남깁니다.
2. Junior는 `dependencies.mjs`와 `opencodex.mjs`를 추가하고 `teams-org.mjs`의 세 CLI를 연결합니다. 이 단계에서 package 정본과 lockfile을 추가하되 제품 버전·기존 manifest 버전은 올리지 않습니다.
3. Junior는 schema의 optional runner와 기존 decoding 경계만 추가합니다. 기존 문서·snapshot을 변환하거나 provider registry를 OpenCodex 이름으로 바꾸지 않습니다.
4. Junior는 위의 단위·통합 검사를 추가하고, `npm ci`, `npm run format`, `npm run sync`, `npm run lint`, `npm test`, 관련 `node --test`를 실행합니다. 최종 단계에서 `npm run eval:organization`과 CI의 OS 증거를 W2-06에 연결합니다.
5. W2-07의 별도 Senior는 구현자가 아닌 Dispatch와 정확한 source/task hash에서 이 계약과 실제 증거를 검토합니다. PM은 열린 `opencodex-pool-unverified`, 상위 취소, Windows finding을 acceptance로 우회하지 않습니다.

## W1 독립 검토 결론

W1은 OpenCodex 2.59.0과 세 구독 계열의 제한된 가능성을 뒷받침하지만, 전면 공통 경로나 pool 지원을 뒷받침하지 않습니다. 특히 2.59.0의 reactive failover는 auto-switch 표시와 독립적으로 동작했고 request-history가 attempt별 전환 기록을 제공하지 않았으므로, raw pool을 허용하는 구현은 사용자 정책과 W2 수용 조건을 위반합니다. 또한 Claude 키체인 메타데이터 변경의 원인이 확인되지 않았으므로, W2는 최소 권한의 격리와 전후 비교를 수행하되 전역 무변경이나 원상 복구를 주장해서는 안 됩니다.
