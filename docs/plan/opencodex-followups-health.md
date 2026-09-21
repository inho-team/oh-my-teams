# 상태 확인 환경 격리와 정리

## 개요

설치와 수리의 상태 확인이 활성 런타임 트리에 health 디렉터리를 남기지 않도록 고쳤습니다. 상태 확인 환경은 `HOME`과 Windows 사용자 디렉터리 변수까지 임시 경로로 격리하며, 수리와 중단된 설치가 남기는 잔여물은 `runtime-prune` 명령으로 정리합니다(F-13, F-4).

## 구현 내용

### 격리된 상태 확인 환경

`isolatedHealthEnvironment(home, codexHome)`는 부모 환경에서 API 키류 변수와 `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `OPENCODEX_HOME`, `CODEX_HOME`을 먼저 제거한 뒤 다음 값을 설정합니다.

| 변수 | 값 | 적용 플랫폼 |
|---|---|---|
| `HOME`, `USERPROFILE`, `OPENCODEX_HOME` | `home` | 모든 플랫폼 |
| `CODEX_HOME` | `codexHome` | 모든 플랫폼 |
| `HOMEDRIVE`, `HOMEPATH` | `home`의 드라이브와 나머지 경로 | Windows에서만 설정하고, 그 밖의 플랫폼에서는 부모 값을 물려받지 않도록 제거만 합니다 |

Windows는 `HOMEDRIVE`와 `HOMEPATH`로 홈 디렉터리를 도출하므로 두 변수도 함께 격리합니다. 이 Windows 분기는 Windows에서 실행해 보지 못했으므로 **미검증**입니다.

### health 디렉터리 위치

`healthCheck`는 임시 홈을 staging 안이 아니라 소유 접두사 바로 아래인 `~/.omt/runtime/opencodex/health-<임의 ID>/`(`home`, `codex`)에 만듭니다. staging 전체가 `runtimes/<지문>`으로 옮겨져도 health 디렉터리는 활성 트리에 들어가지 않으며, 성공과 실패 모두 `finally`에서 지웁니다.

### runtime-prune

```
runtime-prune --org FILE --state DIR [--dry-run]
```

별도 명령으로 만든 이유는 `runtime-repair`가 정상 런타임을 그대로 재사용하기 때문입니다(`reused: true`). 정상 런타임에서는 수리 경로가 실행되지 않으므로, 잔여물 정리를 수리의 옵션으로 두면 가장 필요한 때에 실행되지 않습니다.

삭제 후보는 두 종류입니다.

- `runtimes/<지문>.failed-<숫자>` 디렉터리
- `staging/` 아래의 디렉터리

두 위치는 서로의 존재 여부와 상관없이 각각 처리합니다. 첫 설치가 중단되면 `runtimes/` 없이 `staging/`만 남는데, 이 경우에도 staging을 정리합니다.

다음은 어떤 경우에도 지우지 않고 결과의 `skipped`에 사유를 남깁니다.

- `active.json`이 가리키는 런타임
- 설치 잠금(`locks/<지문>.lock`)의 소유자가 살아 있거나 확인할 수 없는 staging. staging 이름의 지문 접두사로 잠금 파일을 찾고, 이름에서 지문을 읽을 수 없으면 살아 있는 잠금이 하나라도 있는 동안 건드리지 않습니다. 소유자가 종료했음이 확인된 잠금(`ownerHasExited`)은 보호하지 않습니다.
- 심볼릭 링크인 항목
- 소유 접두사 밖을 가리키는 경로

접두사 보호는 문자열 비교가 아니라 실제 경로(`realpath`)로 합니다. 소유 접두사 자체, `runtimes`, `staging`의 실제 경로가 각각 접두사 안의 실제 디렉터리여야 하고, 삭제 후보의 실제 경로는 그 디렉터리의 직접 자식이어야 합니다. 이 확인은 후보를 나열할 때와 삭제 직전에 한 번씩 하므로, 그 사이에 링크로 바뀐 경로는 지워지지 않습니다.

`--dry-run`은 같은 검사를 거쳐 지울 목록만 `deleted`에 담아 돌려주고 아무것도 지우지 않습니다.

## 가짜 HOME 실측

계약이 요구한 대로, 작업 디렉터리 밖 임시 HOME에서 실제 npm 설치와 새 격리의 `ocx start` 상태 확인을 실행했습니다. 로그인과 모델 호출은 하지 않았고, 자격 증명과 계정 정보는 읽거나 기록하지 않았습니다. 사용자의 실제 `~/.omt/runtime/opencodex`는 읽기만 했습니다(실행 전 `ls`).

### 실행한 명령

측정 스크립트는 작업 트리 밖의 임시 디렉터리에 두었습니다. 내용은 `installRuntime`을 임시 HOME 아래 `.omt/runtime`에 실행하고 결과의 일부만 출력하는 것입니다.

```js
import fs from "node:fs";
import path from "node:path";
import { installRuntime, runtimePaths } from "<작업 트리>/plugins/oh-my-teams/scripts/dependencies.mjs";

const root = path.join(process.env.HOME, ".omt", "runtime");
const started = Date.now();
const receipt = await installRuntime(root);
const paths = runtimePaths(root);
console.log(JSON.stringify({
  elapsedMs: Date.now() - started,
  installed: receipt.installed,
  status: receipt.status,
  runtimeHealthy: receipt.runtimeHealthy,
  baseEntries: fs.readdirSync(paths.base),
}));
```

```sh
FAKE=$(mktemp -d /tmp/omt-fakehome.XXXXXX)
cd /tmp && HOME=$FAKE USERPROFILE=$FAKE node measure.mjs
```

### 실제 HOME 무쓰기를 확인한 방법

실행하는 동안 실제 HOME에서 다른 Codex와 Claude 프로세스가 계속 동작하므로 두 가지 방법을 함께 사용했습니다.

1. **실행 전후 스냅샷 비교(1차 실행)**: 실제 `~/.omt`, `~/.codex`, `~/.claude`의 모든 항목을 `경로|크기|mtime`으로 기록했습니다. 파일 내용은 읽지 않았습니다.

   ```sh
   find "$HOME/.omt" "$HOME/.codex" "$HOME/.claude" -print0 | xargs -0 stat -f '%N|%z|%m' | sort > before.txt
   # 측정 실행 뒤 같은 명령으로 after.txt 생성
   diff before.txt after.txt
   ```

2. **읽기와 쓰기 차단(2차 실행)**: macOS `sandbox-exec`로 실제 `~/.omt`, `~/.codex`, `~/.claude`에 대한 파일 읽기와 쓰기를 모두 거부한 채로 같은 측정을 실행했습니다. 프로필은 `(version 1)(allow default)(deny file* (subpath "<실제 HOME>/.omt") (subpath "<실제 HOME>/.codex") (subpath "<실제 HOME>/.claude"))`입니다. 차단이 실제로 작동하는지는 같은 프로필에서 `ls ~/.omt`가 거부되고 `touch ~/.codex/x`가 `Operation not permitted`로 실패하는 것으로 먼저 확인했습니다.

### 결과

| 항목 | 1차(스냅샷 비교) | 2차(실제 HOME 차단) |
|---|---|---|
| `installed` | true | true |
| `status` | `ready` | `ready` |
| `runtimeHealthy` | true | true |
| 걸린 시간 | 5.6초 | 5.2초 |
| 임시 HOME 안 `health-*` 디렉터리 | 없음 | 없음 |
| 임시 HOME 안 `opencodex/` 항목 | `active.json`, `locks`, `runtimes`, `staging` | 같음 |

걸린 시간에는 비어 있는 npm 캐시에서 내려받는 `npm ci`가 포함됩니다. 임시 HOME은 각각 약 165MB였고 실행 뒤 삭제했습니다. 격리 때문에 상태 확인이 실패하지 않았으므로 격리를 되돌리거나 실패 원인을 따로 측정할 필요가 없었습니다.

실제 HOME 비교 결과는 다음과 같습니다.

- `~/.omt`: 1차와 2차 모두 변경 0건.
- `~/.codex`: 1차 비교에서 `logs_2.sqlite`와 `logs_2.sqlite-wal`의 mtime만 바뀌었습니다. 실행 중인 다른 Codex 프로세스의 로그이며, 이 측정이 쓴 것이 아님은 2차 실행으로 확인합니다.
- `~/.claude`: 1차 비교에서 21건이 바뀌었고 모두 `history.jsonl`, `projects/*/*.jsonl`, `sessions/*.json` 같은 동시에 실행 중인 Claude 세션의 기록과 `~/.claude` 디렉터리 자체의 mtime입니다. 마찬가지로 2차 실행이 판정 근거입니다.
- 2차 실행은 세 디렉터리에 대한 읽기와 쓰기가 모두 차단된 상태에서 `ready`가 되었으므로, 설치와 상태 확인 경로가 실제 HOME 아래를 읽거나 쓰지 않는다는 결론입니다.

### 미검증 항목

- Windows에서의 `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` 동작. 이 저장소의 테스트는 Windows 분기의 기대값을 단언하지만 Windows에서는 실행하지 않았습니다.
- 로그인, 모델 호출과 실제 요청 처리. 계약에 따라 실행하지 않았습니다.
- `sandbox-exec` 차단 실험은 macOS 전용이므로 다른 플랫폼의 결과는 확인하지 않았습니다.

## 결정적 테스트

`tests/dependencies.test.mjs`에 계약의 다섯 항목을 각각 독립된 테스트로 두었습니다. 설치 경로 테스트는 가짜 `npm ci`와 가짜 `ocx`를 임시 PATH에 두고 임시 루트에서 `installRuntime`을 실제로 실행합니다.

| 계약 항목 | 테스트 |
|---|---|
| 활성 트리에 health 디렉터리 없음(성공) | a successful install leaves no health directory in the active tree or the owned base |
| 활성 트리에 health 디렉터리 없음(실패) | a failed status check also leaves no health directory behind |
| 격리 환경의 HOME·USERPROFILE·HOMEDRIVE·HOMEPATH | the isolated health environment maps each variable to its own temporary path |
| 가짜 HOME에서 실제 HOME 무쓰기 | the status check under a fake HOME never writes to the real HOME |
| 정리 명령의 보호 대상 | prune keeps the runtime the active pointer names, and installed runtimes / prune keeps staging whose lock a live process holds, and removes it once the owner is gone / prune never removes anything outside the ownership prefix through a link |
| dry-run 무삭제 | prune --dry-run lists what it would remove and removes nothing |

보조 테스트는 다음과 같습니다.

- prune removes failed runtimes and stale staging directories
- prune removes stale staging even when runtimes does not exist
- withEnv leaves process.env exactly as it found it

환경 변수를 바꾸는 테스트는 `withEnv`로 원래 값을 복원합니다. 원래 없던 변수는 `delete`로 되돌리며, 문자열 `"undefined"`를 남기지 않는 것을 마지막 테스트가 확인합니다.

접두사 밖 링크 테스트는 `staging`이 링크인 경우, `runtimes`가 링크인 경우, 소유 접두사 자체가 링크인 경우, 실패 런타임 항목이 링크인 경우, staging 항목이 링크인 경우를 각각 만들고 밖의 파일이 남는지 확인합니다. 반려 전 구현(4c89336)에 같은 테스트를 실행하면 prune 관련 네 개가 실패하고, 변이(HOME 격리 제거, health 디렉터리 정리 제거, 활성 보호 제거)마다 해당 테스트가 실패함을 확인했습니다.

실패한 상태 확인 테스트는 상태 확인의 제한 시간(15초)을 그대로 기다리므로 약 16초가 걸립니다.

## 관련 파일

- `plugins/oh-my-teams/scripts/dependencies.mjs`: `isolatedHealthEnvironment`, `healthCheck`, `pruneRuntimes`
- `plugins/oh-my-teams/scripts/teams-org.mjs`: `runtime-prune` 명령 등록
- `tests/dependencies.test.mjs`: 위 테스트
- `docs/OPENCODEX_RUNTIME.md`: 사용자용 설명
