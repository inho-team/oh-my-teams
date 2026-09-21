# OpenCodex 런타임 설치 및 관리

## 개요

OpenCodex는 조직 프로필 하나에 계정 하나를 고정해 Codex 실행을 프록시로 보내는 런타임입니다. 이 문서는 설치, 진단, 수리, 고정 계정 설정 방법과 코드가 실제로 막는 조건을 설명합니다.

OpenCodex 실행은 프로필 단위의 선택 사항입니다. 조직 파일의 프로필에 `runner` 필드를 명시한 프로필만 OpenCodex를 거치며, `runner`가 없는 프로필은 기존 provider 실행 경로를 그대로 사용합니다. 설치기는 어떤 프로필이 `runner`를 쓰는지와 관계없이 OpenCodex 런타임을 준비합니다.

이 문서의 명령 출력과 오류 메시지는 코드에서 옮기거나 임시 HOME에서 실제로 실행해 얻은 것입니다. OpenCodex 로그인과 모델 호출은 실행하지 않았으므로, 로그인 이후 단계는 코드가 검사하는 조건만 적었습니다.

## 설치

### 진입점과 수행 내용

`install.sh`와 `install.ps1`은 모든 인자를 `scripts/install.mjs`로 전달하는 진입점입니다. 실제 설치 논리는 `scripts/install.mjs` 한 곳에 있습니다.

```sh
sh install.sh both   # claude | codex | both
```

```powershell
./install.ps1 both
```

`install.mjs`는 다음 순서로 동작합니다.

1. 선택한 호스트(`claude`, `codex`, `both`)의 플러그인 목록을 `plugin list --json`으로 읽습니다.
2. 목록을 바탕으로 설치 계획을 만들고, OpenCodex 런타임의 진단 결과(`runtime-doctor`와 같은 결과)를 계획에 넣습니다.
3. `--dry-run`이 아니면 호스트에 플러그인을 설치합니다. 새로 설치할 때는 Claude에서 `claude plugin marketplace add`와 `claude plugin install oh-my-teams@oh-my-teams`를, Codex에서 `codex plugin marketplace add`와 `codex plugin add oh-my-teams@oh-my-teams`를 실행합니다. 이미 설치되어 있고 버전이 다르면 Claude는 `claude plugin update`를, Codex는 `codex plugin add`를 실행합니다.
4. 레거시 플러그인 `orca@orca-skills`가 있으면 Claude에서는 비활성화하고, `--remove-legacy`를 주면 Claude와 Codex 모두에서 제거합니다. Codex에서 `--remove-legacy` 없이 레거시가 남아 있으면 그대로 두고 마이그레이션 선택지를 보고합니다.
5. 마지막으로 OpenCodex 런타임을 `~/.omt/runtime/opencodex/` 아래에 설치합니다.

`--dry-run`은 호스트 플러그인을 설치하거나 제거하지 않고 계획을 JSON으로 출력합니다. 계획을 만들려고 `plugin list`는 실행하며, `runtime` 항목에는 `runtime-doctor`와 같은 진단 결과가 들어 있습니다. `--remove-legacy`를 함께 주면 계획에 레거시 제거가 포함됩니다.

```sh
sh install.sh both --dry-run --remove-legacy
```

설치 중 실제로 바뀌는 것은 다음과 같습니다.

- 호스트가 저장하는 플러그인 상태: 로컬 마켓 등록, 플러그인 설치·갱신, 레거시 플러그인의 비활성화 또는 제거
- `~/.omt/runtime/opencodex/` 아래의 런타임 파일

설치기는 `.omt` 조직 파일을 읽거나 바꾸지 않는다고 코드 주석에 명시되어 있습니다. 다만 호스트가 플러그인 상태를 어디에 어떻게 저장하는지, 그 밖의 전역 파일이 바뀌는지는 이 문서에서 검증하지 않았으므로 전역 상태가 전혀 바뀌지 않는다고 단정하지 않습니다.

플러그인 설치가 끝난 뒤 런타임 설치가 실패하면 설치기는 실패 정보를 담은 계획을 출력하고 0이 아닌 종료 코드로 끝납니다. 이때 계획의 `runtime.status`는 `install-failed`이고 `runtime.error`에 오류 메시지가 들어 있으며, `runtime.nextAction`은 플러그인이 이미 설치되었으니 원인을 고친 뒤 `runtime-repair`를 실행하라고 안내합니다.

## 진단: runtime-doctor

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org .omt/organization.json \
  --state .omt
```

- `--org`에는 실제 조직 파일이 필요합니다. 명령은 조직 파일을 먼저 검증하므로, 조직 파일이 유효하지 않으면 진단 전에 오류로 끝납니다.
- `--state`는 필수 인자이지만 세 런타임 명령(`runtime-doctor`, `runtime-install`, `runtime-repair`)은 이 값을 읽지 않습니다.
- `--format json`도 받지만 옵션이 없어도 출력은 JSON입니다.
- 진단은 읽기 전용이며 런타임 파일을 바꾸지 않습니다. 진단 결과가 `needs-install`이어도 종료 코드는 0입니다.

### 검사 내용

`runtime-doctor`는 아래 순서로 검사합니다. 1~3단계에서 실패하면 그 자리에서 결과를 돌려주고, 4단계가 실패해도 5단계는 계속 실행합니다.

1. `node`: Node.js가 22.13.0 이상인지 확인합니다. 아니면 `blocked`로 끝납니다.
2. `runtime-install`: 활성 런타임 포인터(`active.json`)가 있고 유효한지, 포인터의 지문과 버전이 잠금 파일에서 계산한 값과 같은지, 런타임 디렉터리가 있는지 확인합니다. 하나라도 어긋나면 `needs-install`로 끝납니다.
3. `runtime-integrity`: 런타임 디렉터리의 `manifest.json`, `package.json`, `package-lock.json`이 활성 식별자와 같은지 확인합니다. 다르면 `needs-install`로 끝납니다.
4. `runtime-install`(재확인): 설치된 `ocx --version` 출력에 고정된 버전이 들어 있는지 확인합니다.
5. 의존성 카탈로그 검사: `node`, `git`(저장소 여부와 worktree 목록 포함), `codex`(`--version`, `exec --help`, `features list`), Orca CLI, Orca Desktop 실행 여부, `gh`(`--version`, `repo view --help`, `pr --help`)를 확인합니다. Codex와 `gh`의 로그인 상태는 검사하지 않습니다.

### 결과 상태

`status` 필드는 다음 네 값 가운데 하나입니다.

| status | 의미 |
|---|---|
| `ready` | 런타임이 정상이고, 카탈로그에서 `opencodex-backend`를 요구하는 검사(현재는 Codex 항목)가 실패하지 않았습니다. 요구 대상이 아닌 검사(예: `gh`)가 실패해도 `ready`일 수 있으므로 모든 검사가 통과했다는 뜻은 아닙니다. |
| `needs-install` | 활성 런타임이 없거나, 포인터·지문·무결성이 어긋나거나, 설치된 `ocx`가 버전 확인에 실패했습니다. `nextAction`이 `runtime-install` 실행을 안내합니다. |
| `action-required` | 런타임은 정상이지만 `opencodex-backend`를 요구하는 검사가 실패했습니다. 설치된 런타임은 그대로 두고 실패한 검사를 해결해야 합니다. |
| `blocked` | Node.js가 22.13.0 미만이거나 실행되지 않았습니다. |

### 실제 출력 예시

OpenCodex를 설치하지 않은 임시 HOME에서 `runtime-doctor`를 실행한 결과입니다(`checkedAt`은 실행 시각이며, `evidence`의 Node 버전과 지문은 환경마다 다릅니다).

```json
{
  "schemaVersion": 1,
  "command": "runtime-doctor",
  "status": "needs-install",
  "runtimeHealthy": false,
  "checkedAt": "2026-09-21T12:38:31.381Z",
  "runtime": {
    "id": "opencodex",
    "version": "2.59.0",
    "prefixFingerprint": "sha256:fb0b1f1a6b0b01aa0589b35da8969c010a76c52c3e41d3c6ed6061155e35326f"
  },
  "checks": [
    {
      "id": "node",
      "status": "pass",
      "evidence": "v26.7.0"
    },
    {
      "id": "runtime-install",
      "status": "fail",
      "evidence": "No active runtime pointer"
    }
  ],
  "nextAction": "Run runtime-install; authentication is never automated."
}
```

`runtime.prefixFingerprint`는 아래 고정 계정 설정에서 `runner.runtimeFingerprint`에 넣는 값입니다.

## 설치와 수리: runtime-install, runtime-repair

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org .omt/organization.json \
  --state .omt
```

`runtime-install`은 잠금 파일로 고정된 OpenCodex만 설치합니다. Node.js, Git, Codex, Orca, `gh`는 설치하지 않습니다. 동작은 다음과 같습니다.

1. 먼저 `runtime-doctor`와 같은 진단을 합니다. 런타임이 이미 정상(`runtimeHealthy`)이면 아무것도 바꾸지 않고 결과에 `reused: true`를 담아 돌려줍니다. 카탈로그의 다른 검사가 실패했더라도 정상 런타임은 다시 설치하지 않습니다.
2. 정상이 아니면 `~/.omt/runtime/opencodex/locks/<지문>.lock`을 잡고 `staging/<지문>-<임의 ID>` 디렉터리에 `package.json`과 `package-lock.json`을 복사한 뒤 `npm ci`를 실행합니다(제한 시간 180초).
3. 설치된 `ocx --version` 출력에 고정된 버전이 들어 있는지, 동봉된 Bun이 실행되는지 확인하고, 격리된 임시 홈에서 `ocx start`를 띄워 `/healthz`가 15초 안에 응답하는지 확인합니다. 임시 홈은 `~/.omt/runtime/opencodex/health-<uuid>/` 아래에 만들어지며, 성공과 실패 모두에서 정리됩니다. `HOME`, `USERPROFILE`, `OPENCODEX_HOME`, `CODEX_HOME`은 모든 플랫폼에서 임시 경로로 격리하고, Windows에서는 `HOMEDRIVE`와 `HOMEPATH`도 임시 경로로 바꿉니다. 그 밖의 플랫폼에서는 두 변수를 물려받지 않도록 제거합니다. 그래서 상태 확인이 실제 사용자 홈 디렉터리를 읽거나 쓰지 않습니다.
4. 모두 통과하면 `staging`을 `runtimes/<지문>`으로 옮기고, 활성 포인터 `active.json`을 임시 파일 교체 방식으로 갱신한 뒤 다시 진단한 결과에 `installed: true`를 담아 돌려줍니다.
5. 성공과 실패에 관계없이 이번 실행의 `staging` 디렉터리는 마지막에 삭제합니다.

같은 지문의 런타임을 다른 프로세스가 설치하는 중이면 `runtime-install-locked`로 끝납니다.

### --dry-run

`--dry-run`은 설치하지 않고 진단 결과에 `"dryRun": true`를 덧붙여 돌려줍니다. 실행할 단계의 목록은 출력하지 않습니다. 아래는 OpenCodex가 설치되지 않은 임시 HOME에서 `runtime-install --dry-run`을 실행한 결과에서 `checkedAt`을 뺀 것입니다.

```json
{
  "schemaVersion": 1,
  "command": "runtime-install",
  "status": "needs-install",
  "runtimeHealthy": false,
  "runtime": {
    "id": "opencodex",
    "version": "2.59.0",
    "prefixFingerprint": "sha256:fb0b1f1a6b0b01aa0589b35da8969c010a76c52c3e41d3c6ed6061155e35326f"
  },
  "checks": [
    {
      "id": "node",
      "status": "pass",
      "evidence": "v26.7.0"
    },
    {
      "id": "runtime-install",
      "status": "fail",
      "evidence": "No active runtime pointer"
    }
  ],
  "nextAction": "Run runtime-install; authentication is never automated.",
  "dryRun": true
}
```

### 설치 실패 오류

| 오류 | 발생 조건 |
|---|---|
| `runtime-npm-install-failed: <npm stderr>` | `npm ci`가 실패했거나 제한 시간을 넘겼습니다. |
| `runtime-version-mismatch` | 설치된 `ocx --version` 출력에 `plugins/oh-my-teams/package.json`에 고정된 버전이 들어 있지 않습니다. |
| `runtime-bun-unavailable` | 동봉된 Bun 실행 파일이 종료 코드 0으로 끝나지 않았습니다. |
| `runtime-health-check-failed` | 격리된 임시 홈에서 띄운 `ocx start`가 15초 안에 `/healthz`에 정상 응답하지 않았습니다. |
| `runtime-install-locked` | 같은 지문의 설치 잠금을 다른 프로세스가 잡고 있습니다. |

### runtime-repair

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-repair \
  --org .omt/organization.json \
  --state .omt
```

`runtime-repair`는 `runtime-install`과 같은 함수를 `command` 이름만 바꿔 호출합니다. 따라서 정상 런타임은 그대로 재사용하고(`reused: true`), 정상이 아닐 때만 위 설치 절차를 다시 실행합니다. 수리 과정에서 보관하는 대상은 하나뿐입니다. 같은 지문의 `runtimes/<지문>` 디렉터리가 이미 있으면 새 설치가 검증을 통과한 뒤 그 디렉터리를 `runtimes/<지문>.failed-<밀리초 타임스탬프>`로 이름을 바꿔 남깁니다. 중단되거나 부분적인 설치는 보관하지 않으며, 이번 실행의 `staging` 디렉터리는 항상 삭제합니다.

`--dry-run`은 `runtime-install`과 같이 진단 결과에 `"dryRun": true`를 덧붙일 뿐이며, `command`는 `runtime-repair`로 표시됩니다.

### runtime-prune

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-prune \
  --org .omt/organization.json \
  --state .omt
```

`runtime-prune`은 이전 설치와 수리 과정에서 남긴 잔여물을 정리합니다. 정리 대상은 다음과 같습니다:

- `runtimes/<지문>.failed-<밀리초 타임스탬프>` 형태의 실패한 런타임 디렉터리
- `staging/` 아래에 남은 이전 설치의 디렉터리(첫 설치가 중단되어 `runtimes/`가 없는 경우도 포함합니다)

다음 항목은 보호되어 정리 대상에서 제외됩니다:

- 활성 포인터가 가리키는 현재 런타임
- 살아 있는 프로세스가 설치 잠금(`locks/<지문>.lock`)을 보유한 staging 디렉터리. 소유자가 종료했음이 확인된 잠금은 보호하지 않습니다.
- 소유 접두사(`~/.omt/runtime/opencodex/`) 밖의 경로
- 심볼릭 링크인 항목과, 링크 때문에 실제 경로가 접두사 밖이 되는 `runtimes`, `staging` 디렉터리

접두사 보호는 삭제 직전에 실제 경로(`realpath`)를 다시 확인하는 방식이라 링크를 따라가 밖을 지우는 일이 없습니다. 지우지 않은 항목은 결과의 `skipped`에 사유와 함께 남습니다.

`--dry-run`은 같은 검사를 거쳐 지울 대상을 `deleted`에 담아 출력하기만 하고 실제로 삭제하지 않습니다.

## 고정 계정 runner 설정

### 조직 파일의 runner 필드

`profiles`는 프로필 ID를 키로 하는 객체입니다. 각 프로필은 `command`(argv 배열)와 `endpoint` 중 정확히 하나를 가져야 합니다. 아래 항목을 예제 조직(`plugins/oh-my-teams/examples/organization.json`)의 `profiles`에 추가한 조직 파일이 `teams-org.mjs validate --org <파일>`을 통과하는 것을 확인했습니다. 지문 자리에는 실제 값이 필요하므로 `runtime-doctor` 출력의 `runtime.prefixFingerprint`를 복사해 넣습니다.

```json
"codex-fixed": {
  "provider": "codex",
  "command": ["codex"],
  "account": "codex-chatgpt",
  "subscription": "User-selected ChatGPT subscription",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "runner": {
    "kind": "opencodex",
    "mode": "fixed-account",
    "accountHomeRef": "codex-chatgpt",
    "runtimeFingerprint": "sha256:<runtime-doctor의 runtime.prefixFingerprint>"
  }
}
```

`validate`가 확인하는 조건과 위반할 때의 오류는 다음과 같습니다. 아래 조건 하나라도 어기면 오류 메시지는 모두 `Invalid OpenCodex runner binding: <프로필 ID>`입니다.

- `runner.kind`가 `opencodex`이고 `runner.mode`가 `fixed-account`여야 합니다.
- `runner.accountHomeRef`가 프로필의 `account`와 같아야 합니다.
- `account`는 `current`가 될 수 없습니다.
- `model`은 `null`이 될 수 없습니다.
- `runner.runtimeFingerprint`는 `sha256:` 다음에 소문자 16진수 64자리가 이어지는 형식이어야 합니다.

`command`와 `endpoint`를 둘 다 빼거나 둘 다 쓰면 `Profile must declare exactly one of command or endpoint: <provider>`로 실패합니다. 콜론 뒤에는 프로필의 provider 이름(예: `codex`)이 나옵니다.

`effort`는 `validate`가 요구하지 않지만, 실제 실행 단계에서 없으면 `opencodex-binding-unverified`로 실패합니다. Codex에서 쓸 수 있는 값은 `low`, `medium`, `high`, `xhigh`, `max`, `ultra`입니다.

실행할 때는 조직 파일의 `runtimeFingerprint`가 활성 런타임의 지문과 같아야 합니다. 다르면 `opencodex-binding-unverified`로 실패하므로, 고정된 OpenCodex 버전이 바뀌어 지문이 달라지면 조직 파일의 값도 갱신해야 합니다.

### 계정 홈과 세션 홈

고정 계정은 격리된 두 디렉터리로 표현합니다.

- 계정 홈: OpenCodex가 `OPENCODEX_HOME`으로 사용하는 디렉터리입니다. 로그인한 계정 한 개의 정보가 들어갑니다.
- 세션 홈: 프록시와 Codex 자식 프로세스에 `CODEX_HOME`으로 전달되는 디렉터리입니다. 계정 홈과 달라야 합니다. 실행 전에 이미 있는 디렉터리여야 하며, 없으면 2.59.0의 `ocx`가 `CODEX_HOME points to ... could not be read` 오류로 시작하지 못하는 것을 임시 디렉터리에서 확인했습니다.

계정 홈은 런타임 설치 위치(`runtimes/<지문>`)와도 달라야 합니다. 계정 홈이 세션 홈이나 런타임 위치와 같으면 `opencodex-binding-unverified`로 실패합니다.

### 환경변수

runner 프로필을 쓰는 프로세스(workflow를 실행하는 프로세스)의 환경에 다음 변수가 있어야 합니다. `<REF>`는 프로필의 `runner.accountHomeRef`를 대문자로 바꾸고 영문 대문자와 숫자가 아닌 문자를 모두 `_`로 바꾼 값입니다. 예를 들어 `codex-chatgpt`는 `CODEX_CHATGPT`가 됩니다.

| 변수 | 의미 |
|---|---|
| `OMT_OPENCODEX_<REF>_HOME` | 계정 홈 디렉터리 경로입니다. |
| `OMT_OPENCODEX_<REF>_LABEL` | 계정 홈의 `config.json`에 있는 `codexAccounts[0].logLabel` 값과 같아야 하는 비밀이 아닌 표식입니다. |
| `OMT_OPENCODEX_SESSION_HOME` | 세션 홈 디렉터리 경로입니다. |

셋 중 하나라도 없으면 `opencodex-action-required: configure named account home, label and session home`로 실패합니다.

프로필의 `env` 키 가운데 `API_KEY`나 `API-KEY` 형태의 이름이 있으면 `api-key-fallback-blocked`로 실패합니다. 자식 프로세스의 환경에서는 이름에 `OPENAI`, `ANTHROPIC`, `GOOGLE`, `GEMINI`, `API` 중 하나가 있고 그 뒤에 `KEY` 또는 `TOKEN`이 이어지는 변수와 기존 `OPENCODEX_HOME`, `CODEX_HOME`이 먼저 제거되며, 그 다음에 계정 홈과 세션 홈이 지정됩니다.

### 계정 홈 검증

계정 홈은 다음 파일과 값을 모두 만족해야 합니다. 검사는 위에서 아래 순서로 진행되며, 처음 어긋난 그룹의 오류가 나옵니다. 아래 오류는 조건을 하나씩 어긴 임시 계정 홈으로 실제 재현한 결과입니다.

| 조건 | 오류 |
|---|---|
| `config.json`과 `codex-accounts.json`이 모두 존재합니다. | `opencodex-binding-unverified` |
| `config.codexAccounts`가 계정 정확히 1개를 담고, `codex-accounts.json`의 항목도 1개이며, 그 계정의 `id`가 `activeCodexAccountId`와 같고, 항목 키에 `id`가 있으며, `logLabel`이 환경변수 `_LABEL` 값과 같습니다. | `opencodex-binding-unverified` |
| `activeCodexAccountPinned`가 그 계정의 `id`이고, `providers.openai.codexAccountMode`가 `"pool"`이며, `clientIntegrations.codex`가 `false`입니다. | `opencodex-pool-unverified` |
| `runtimeRole`이 `"hub"`이고, `claudeCode.enabled`가 `false`이거나 `claudeCode.systemEnv`와 `claudeCode.injectAgents`가 모두 `false`입니다. | `opencodex-global-change-blocked: account home lacks <실패한 조건 이름>` |

마지막 오류의 조건 이름은 `runtimeRole`, `claudeCode.integration`이며, 둘 다 실패하면 `opencodex-global-change-blocked: account home lacks runtimeRole, claudeCode.integration`처럼 쉼표로 이어집니다.

검증기가 읽는 키만 발췌한 `config.json` 예시입니다. 실제 파일은 OpenCodex가 기록하며 더 많은 키를 가집니다. 이 발췌본과 `codex-accounts.json`(키가 계정 `id`인 객체)으로 구성한 임시 홈이 검증을 통과하는 것을 확인했습니다.

```json
{
  "codexAccounts": [{ "id": "acct1", "logLabel": "lbl1" }],
  "activeCodexAccountId": "acct1",
  "activeCodexAccountPinned": "acct1",
  "providers": { "openai": { "codexAccountMode": "pool" } },
  "clientIntegrations": { "codex": false },
  "runtimeRole": "hub",
  "claudeCode": { "enabled": false }
}
```

이 키들은 OMT가 검사만 하고 쓰지 않습니다. `runtime-install`의 상태 점검용 임시 홈은 `runtimeRole: "hub"`, `clientIntegrations.codex: false`, `claudeCode`의 세 항목을 `false`로 두어 만듭니다. 검증기 주석은 `ocx start`가 이 값들 없이 시작하면 macOS 전역 환경변수 설정, 셸 hook 설치, Claude 에이전트 목록 수정을 할 수 있어서 계정 홈에도 이 값을 요구한다고 설명합니다.

### ocx 실행 방법

OMT는 `ocx`를 PATH에 등록하지 않습니다. 고정된 런타임의 실행 파일은 다음 위치에 있습니다. `<지문>`은 `runtime.prefixFingerprint`에서 `sha256:`을 뺀 값입니다.

```text
~/.omt/runtime/opencodex/runtimes/<지문>/node_modules/.bin/ocx
```

`ocx account` 계열 명령은 실행 중인 OpenCodex 프록시가 필요합니다. 프록시 없이 `ocx account list openai --json`을 실행하면 `Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.`가 출력되고 종료 코드 1로 끝나는 것을 확인했습니다.

로그인은 사람이 브라우저에서 직접 해야 하며 OMT가 자동화하지 않습니다. 의존성 카탈로그(`plugins/oh-my-teams/resources/runtime-dependencies.json`)는 격리된 빈 디렉터리를 `OPENCODEX_HOME`으로 지정해 `ocx account login <provider>`를 실행하고, 정확히 한 계정만 로그인하라고 정의합니다. OpenAI(ChatGPT·Codex) 계정의 provider 인자는 `openai`입니다.

계정을 고정(pin)하는 값 `activeCodexAccountPinned`는 OpenCodex가 기록합니다. OpenCodex 2.59.0 소스에서 확인한 방법은 `ocx account use openai <계정 ID>`이며, 이 명령이 활성 계정을 지정하면서 고정 값을 기록합니다. 실행 중인 프록시가 필요하고 로그인이 선행되어야 하므로, 이 문서는 이 절차를 실행해 검증하지 않았습니다.

### 실행 조건

runner 프로필로 실행하기 직전에 `runtime-doctor`와 같은 진단을 하며, 결과 `status`가 `ready`가 아니면 `opencodex-action-required: run runtime-install first`로 실패합니다. 이 메시지는 `needs-install`뿐 아니라 `action-required`와 `blocked`에도 같으므로, 실제 원인은 `runtime-doctor`의 `checks`에서 확인해야 합니다.

## 지원 범위와 한계

- 계정: 계정 홈 검증이 OpenAI(ChatGPT·Codex) 계정 저장소(`codexAccounts`, `codex-accounts.json`)만 읽으므로 고정 계정 실행은 이 계정만 받습니다. Claude와 Agy 계정 홈은 `opencodex-binding-unverified`로 거부됩니다.
- Windows: 프록시를 시작하는 코드가 Windows에서 `opencodex-proxy-ownership-unverifiable`로 실패하므로 고정 계정 runner는 Windows에서 막힙니다. 설치기의 런타임 설치 단계를 Windows에서 실행해 검증하지는 않았습니다.
- 그 밖의 플랫폼: 의존성 카탈로그에 선언된 플랫폼은 `macos`와 `windows`뿐이고, 이 문서는 macOS 밖에서 OpenCodex 런타임이나 runner를 실행해 검증하지 않았습니다. 따라서 다른 플랫폼을 지원한다고 선언하지 않습니다.

### 다계정 풀 모드

다계정 풀 모드는 지원하지 않습니다. 코드에서 다음과 같이 막힙니다.

- `runner.mode`가 `fixed-account`가 아니면 조직 파일 검증이 `Invalid OpenCodex runner binding: <프로필 ID>`로 실패합니다. 실행 단계에도 같은 조건이 있어서, `fixed-account`가 아닌 runner는 `opencodex-pool-unverified`로 거부됩니다.
- 계정 홈에 계정이 둘 이상이면 `opencodex-binding-unverified`로 실패합니다.
- 계정 홈에서 계정 고정 값, `providers.openai.codexAccountMode`, `clientIntegrations.codex`가 위 표의 조건과 다르면 `opencodex-pool-unverified`로 실패합니다.
- 요청 하나의 모든 시도(attempt)는 첫 전송에 성공한 고정 계정의 시도여야 하며, 복구·재전송·실패한 시도가 있으면 `opencodex-binding-unverified`로 거부합니다. 코드 주석은 이런 시도가 계정이나 provider의 전환을 가릴 수 있고 어댑터가 그것을 증명할 수 없기 때문이라고 설명합니다.

풀 모드를 열지 않은 이유는 요청 기록에서 시도별 계정 전환을 증명하지 못하고, 상위 streaming 요청이 시작된 뒤의 취소 동작이 검증되지 않았기 때문입니다.

### 전역 상태에 대해 확인한 것과 확인하지 못한 것

코드가 실제로 하는 보호는 다음과 같습니다.

- 계정 홈 검증이 위 표의 전역 통합 설정을 끈 홈만 받습니다.
- 프록시 자식 프로세스는 계정 홈 아래의 `.omt-proxy-home`을 `HOME`으로 사용합니다.
- 자식 프로세스의 환경에서 API 키·토큰 변수를 제거합니다.

이 보호가 사용자의 전역 파일(`~/.opencodex`, `~/.codex`, `~/.claude`, 셸 설정, 키체인 등)을 바꾸지 않는다는 것을 이 문서에서 검증하지는 않았습니다. 설치기가 호스트의 플러그인 상태를 바꾼다는 점은 위 설치 절에 적었습니다.

## 기존 조직과 진행 중 workflow

- `runner`가 없는 프로필은 기존 provider adapter를 계속 사용합니다.
- 진행 중인 workflow는 시작 시점의 조직 스냅샷을 유지하므로, 조직 파일을 바꿔도 이미 시작된 workflow의 실행 경로는 그대로입니다.
- 새로 시작하는 workflow는 그 시점의 조직 파일을 사용합니다.

## 오류 진단

| 증상 또는 오류 | 원인 | 대응 |
|---|---|---|
| `runtime-doctor`가 `needs-install`이고 `runtime-install` 검사가 `No active runtime pointer` | 활성 런타임이 없습니다. | `runtime-install`을 실행합니다. `--dry-run`으로 현재 진단만 볼 수 있습니다. |
| `runtime-doctor`가 `needs-install`이고 `runtime-integrity` 검사가 실패 | 런타임 디렉터리의 파일이 활성 식별자와 다릅니다. | `runtime-repair`를 실행합니다. |
| `runtime-doctor`가 `blocked` | Node.js가 22.13.0 미만입니다. | Node.js를 갱신합니다. |
| `runtime-doctor`가 `action-required` | 런타임은 정상이지만 `opencodex-backend`를 요구하는 검사(Codex CLI)가 실패했습니다. | `checks`에서 실패한 항목의 `evidence`를 따라 해결합니다. 런타임은 다시 설치하지 않습니다. |
| `runtime-npm-install-failed: ...` | `npm ci`가 실패했습니다. | 메시지의 npm stderr를 확인하고 원인을 고친 뒤 `runtime-repair`를 실행합니다. |
| `runtime-version-mismatch`, `runtime-bun-unavailable`, `runtime-health-check-failed` | 설치 검증 단계가 실패했습니다. | 위 설치 실패 오류 표를 보고 원인을 확인한 뒤 `runtime-repair`를 실행합니다. |
| 설치기의 `install-failed` | 플러그인은 설치되었지만 런타임 설치가 실패했습니다. | 원인을 고친 뒤 `runtime-repair`를 실행합니다. |
| `opencodex-action-required: configure named account home, label and session home` | 세 환경변수 중 하나가 없습니다. | 환경변수 표에 따라 설정합니다. |
| `opencodex-action-required: run runtime-install first` | 실행 직전 진단이 `ready`가 아닙니다. | `runtime-doctor`의 `checks`를 확인합니다. |
| `opencodex-binding-unverified` | 계정 홈 파일·계정 수·라벨 조건, 지문 불일치, 홈 경로 겹침, `effort` 누락 중 하나입니다. | 각각 위 절의 조건을 확인합니다. |
| `opencodex-pool-unverified` | 계정이 고정되지 않았거나 풀 모드·클라이언트 통합 설정이 다릅니다. | 계정 홈 검증 표의 세 번째 행을 확인합니다. |
| `opencodex-global-change-blocked: account home lacks ...` | `runtimeRole` 또는 `claudeCode` 설정이 조건을 만족하지 않습니다. | 오류 메시지에 나온 이름의 조건을 확인합니다. |
| `api-key-fallback-blocked` | 프로필 `env`에 API 키 이름이 있습니다. | 해당 키를 `env`에서 제거합니다. |
| `opencodex-proxy-ownership-unverifiable` | Windows에서 프록시를 시작하려 했습니다. | Windows에서는 고정 계정 runner를 쓸 수 없습니다. |

## 더 알아보기

- 공식 설치 가이드: https://opencodex.me/getting-started/for-agents/
- 공식 Providers 문서: https://opencodex.me/guides/providers/
- 조직 파일 스키마: `plugins/oh-my-teams/schemas/organization.schema.json`
- 의존성 카탈로그: `plugins/oh-my-teams/resources/runtime-dependencies.json`
