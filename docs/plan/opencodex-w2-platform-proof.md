# OpenCodex 런타임 설치·진단·수리 실측 (W2 플랫폼 검증)

이 문서의 수치, 해시, 파일 수는 모두 `experiments/opencodex-w2-platform/runtime-test-results.json`에서 옮겼고, 소스 줄 번호는 이 저장소의 파일에서 확인했습니다. JSON 필드 이름은 `tests.<단계>.<필드>` 형태로 적었으므로 `jq`로 직접 대조할 수 있습니다.

## 실측 조건

| 항목 | 값 | JSON 필드 |
|---|---|---|
| 운영체제 | macOS 15.7.4 (build 24G517), arm64 | `environment.sw_vers`, `environment.machine` |
| Node, npm | v26.7.0, 11.19.0 | `environment.node`, `environment.npm` |
| 실행 HEAD | `f6ba7876b0040500babd61d38ef75108cc7d4568` | `repository.head` |
| 작업 트리 상태 | 깨끗함 (`git status --porcelain` 결과가 빈 목록) | `repository.dirty` = false, `repository.status_porcelain` = [] |
| 구현 트리 | `d9ba65eaea0e9cbb4a9e14d1e48b2acb25613cab` (`git rev-parse HEAD:plugins/oh-my-teams`) | `repository.plugin_tree` |
| 조직 파일 | `plugins/oh-my-teams/examples/organization.json` (sha256 `3ce8c693d136aba4ccfde17825a8a30ac8d34b87166e84a1119bb75d27192727`) | `repository.organization_file`, `repository.organization_sha256` |
| 실행 시각 (UTC) | 2026-09-21T12:59:34Z 부터 2026-09-21T13:00:06Z 까지 | `started_utc`, `finished_utc` |

JSON은 스크립트를 실행한 커밋(`f6ba787`)의 바로 다음 커밋에 담겼으므로, 이 문서와 JSON을 담은 커밋의 HEAD는 위 값과 다릅니다. 두 커밋은 `plugins/oh-my-teams` 트리가 같으므로, 구현이 같은 상태에서 측정했는지는 `git rev-parse HEAD:plugins/oh-my-teams`가 `repository.plugin_tree`와 일치하는지로 확인합니다.

Node v26.7.0은 로컬 실행 환경이고, CI는 `node-version: "22"`를 사용합니다(`.github/workflows/ci.yml` 28~30줄의 `setup-node` 단계). 이 실측은 Node 22에서 실행한 결과가 아닙니다. 설치 단계는 npm 레지스트리에서 실제 패키지를 내려받으므로 네트워크에 의존합니다.

## 측정 방법

스크립트 `experiments/opencodex-w2-platform/run_platform_proof.py`는 다음과 같이 동작합니다.

- 저장소 루트를 자기 위치에서 `git rev-parse --show-toplevel`로 찾고, 결과 JSON을 스크립트 옆에 씁니다. 절대 경로를 포함하지 않으며, 조직 파일은 `--org`로 바꿀 수 있고 기본값은 저장소의 예시 파일입니다.
- 런타임 명령(`runtime-doctor`, `runtime-install`, `runtime-repair`)은 `os.homedir()`가 가리키는 `~/.omt/runtime`에 씁니다(`plugins/oh-my-teams/scripts/dependencies.mjs` 459줄, `teams-org.mjs` 1117~1129줄). `--state` 인자는 이 명령들이 사용하지 않으므로, 실제 사용자 홈에 쓰지 않게 하는 수단은 HOME 격리입니다.
- 모든 명령은 임시 디렉터리 하나 안에서 `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `CODEX_HOME`, `OPENCODEX_HOME`을 지정해 실행합니다(`isolation.env_overrides`). 실행이 끝났을 때 격리 홈의 최상위 항목은 `.codex`, `.npm`, `.omt`, `.opencodex`였습니다(`isolation.isolated_home_top_level`).
- macOS의 `sandbox-exec`로 실제 홈 디렉터리와 저장소 아래의 파일 쓰기를 거부하는 프로필을 씌웠습니다. 이 가드가 실제로 동작하는지는 통제 프로브로 확인했습니다. 실제 홈 아래에 파일을 만들려는 `touch`를 서로 다른 이름으로 3회 시도했고 모두 거부되었습니다(`isolation.guard_control.probe_attempts` = 3, `isolation.guard_control.write_below_real_home_denied` = true). 다만 이번 실행에서 커널 통합 로그는 이 프로브의 거부를 한 건도 기록하지 않았습니다(`isolation.guard_control.denials_logged` = 0, `denial_logged` = false). 그래서 로그 조회 결과인 `isolation.sandbox_denials_excluding_control.denials` = []는 증거로 쓰지 않고, 스크립트가 `reliable` = false와 사유를 함께 기록했습니다. 이 머신에서 같은 조회가 앞선 실행에서는 프로브 거부를 기록했으므로 로그 기록은 실행마다 일정하지 않습니다.
- npm은 PATH 앞에 둔 shim으로 대체했습니다. shim은 호출마다 작업 디렉터리와 인자를 기록한 뒤 실제 npm으로 넘기거나(정상 단계), 곧바로 실패합니다(`failed-staging` 단계). 단계별 호출은 `tests.<단계>.npm_calls`, 그중 `npm ci` 호출 수는 `tests.<단계>.npm_ci_calls`입니다.
- 트리 비교는 파일 이름, 크기, 내용의 sha256, 심볼릭 링크 대상을 모두 합친 해시입니다(`tree.sha256`). 링크는 따라가지 않습니다. `manifest.json`의 `verifiedAt`은 설치마다 달라지므로, 재설치가 일어났다면 이 해시가 달라집니다.
- 각 단계의 기대 결과는 스크립트가 판정해 `expectations`에 기록했고, 12개 항목이 모두 true입니다. 로그 기반 "다른 거부 없음" 항목은 위 이유로 이번 12개에 들어 있지 않습니다.
- 진단 결과의 `git:rev-parse---show-toplevel`과 `git:worktree-list` 항목은 `fail`입니다(`tests.doctor-after.result.checks`). 명령을 저장소가 아닌 임시 작업 디렉터리에서 실행했기 때문입니다. 두 항목의 `requiredFor`는 `worktrees`, `repository-evidence`, `pull-requests`이고 `opencodex-backend`를 포함하지 않으므로, 진단은 이 실패를 상태에 반영하지 않고 `ready`로 유지했습니다(`tests/dependencies.test.mjs` 140줄의 주석이 설명하는 설계와 같습니다).

## 단계별 결과

### 1. 진단 (runtime-doctor)

| 단계 | 결과 | JSON 필드 |
|---|---|---|
| 설치 전 | `needs-install`, 근거 "No active runtime pointer" | `tests.doctor-before.result.status`, `.checks` |
| 설치 후 | `ready`, `runtimeHealthy` true | `tests.doctor-after.result.status`, `.runtimeHealthy` |
| manifest.json을 "CORRUPTED"로 덮은 뒤 | `needs-install`, `runtime-integrity` 항목이 fail, 근거 "Runtime manifest or lockfile does not match the active identity" | `tests.doctor-damaged.result.checks` |

소스는 `plugins/oh-my-teams/scripts/dependencies.mjs`의 `doctor()`(165~264줄)입니다. 결정적 테스트는 `tests/dependencies.test.mjs` 45줄의 "missing and dry-run runtime checks do not write an active pointer"가 설치 전 `needs-install`을 확인합니다. 이 테스트는 `posixOnly`가 아니므로 Windows CI에서도 실행됩니다. 설치 전 doctor가 격리 디렉터리에 아무것도 쓰지 않았다는 파일 목록 비교는 아래 2번 항목의 마지막 목록에 적었습니다(`tests.doctor-before.listing_diff.identical` = true).

### 2. 설치 (runtime-install)

- 첫 설치는 종료 코드 0, `installed` true, 상태 `ready`입니다(`tests.install-actual.code`, `.result.installed`, `.result.status`).
- 이 단계에서 shim이 기록한 `npm ci`는 1회입니다. 작업 디렉터리는 런타임 staging 아래였습니다(`tests.install-actual.npm_ci_calls` = 1, `npm_calls[0].in_runtime_staging` = true).
- 설치된 런타임 트리는 파일 5294개, 심볼릭 링크 5개, 디렉터리 685개이고 해시는 `9817cc13b291b7fc9996f5aedb76727218fe5dfff6d56dbb409535c7168c6a53`입니다(`tests.install-actual.tree`).
- `active.json`의 내용은 `fingerprint` `sha256:fb0b1f1a6b0b01aa0589b35da8969c010a76c52c3e41d3c6ed6061155e35326f`, `version` 2.59.0, `ocxVersion` "opencodex 2.59.0"입니다(`tests.install-actual.active_json`).
- `--dry-run`은 종료 코드 0, `dryRun` true, 상태 `needs-install`을 반환했고 `npm ci`는 0회였습니다(`tests.install-dryrun.result.dryRun`, `.result.status`, `.npm_ci_calls`). 격리 홈에 `.omt` 디렉터리가 생기지 않았습니다(`tests.install-dryrun.omt_directory_created` = false).
- 설치 전 doctor와 `--dry-run`은 각 실행의 전후에 격리 홈(`home`)과 `state`, `cache`, `config`, `data`, `work` 디렉터리 전체를 상대 경로, 종류, 크기, sha256으로 나열해 비교했습니다(`tests.<단계>.watched_directories`, `.listing_before`, `.listing_after`, `.listing_diff`). 두 단계 모두 `listing_diff`가 `added` = [], `removed` = [], `changed` = [], `identical` = true입니다. 나열된 항목은 디렉터리 8개(`home`, `home/.codex`, `home/.opencodex`, `state`, `cache`, `config`, `data`, `work`)이고 파일은 하나도 없었습니다. `home/.codex`와 `home/.opencodex`는 OpenCodex가 존재하는 디렉터리를 요구하므로 스크립트가 미리 만든 빈 디렉터리입니다.

소스는 `installRuntime()`(368~455줄)입니다. staging에서 `npm ci`(396줄), 버전 검증, health check(`/healthz`, 345줄)를 거친 뒤 `renameSync`로 staging을 런타임 위치로 옮기고(435줄) 마지막에 `active.json`을 교체합니다(442줄). `tests/dependencies.test.mjs`의 135줄, 159줄, 178줄, 194줄 테스트는 npm을 항상 실패시키는 가짜로 대체하므로, 설치가 끝까지 성공하는 경로는 결정적 테스트에 없고 이 실측만 확인합니다.

### 3. 재실행 멱등성

- 두 번째 `runtime-install`은 종료 코드 0, `reused` true를 반환했습니다(`tests.install-second.result.reused`).
- 이 단계에서 shim이 기록한 npm 호출은 0건입니다(`tests.install-second.npm_calls` = [], `npm_ci_calls` = 0).
- 런타임 트리는 파일 5294개, 심볼릭 링크 5개, 디렉터리 685개이고 해시가 첫 설치 뒤와 같습니다(`tests.install-second.tree`, `tests.install-second.tree_hash_equal` = true).

소스는 `dependencies.mjs` 376줄의 `if (before.runtimeHealthy) return { ...before, command, reused: true };`입니다. 결정적 테스트는 `tests/dependencies.test.mjs` 135줄의 "a healthy runtime is reused when only unrelated catalog checks fail"(`posixOnly`)이며, 이 테스트가 npm 호출 기록이 없음과 파일 스냅샷이 같음을 검사합니다.

### 4. 손상 뒤 복구 (runtime-repair)

- 손상 방법은 활성 런타임의 `manifest.json`을 문자열 "CORRUPTED"로 덮는 것입니다. 진단은 `needs-install`이었습니다(위 1번 표).
- `runtime-repair`(실제 npm)는 종료 코드 0, `installed` true, 상태 `ready`이고, `npm ci`는 1회였습니다(`tests.repair-real-npm.code`, `.result.installed`, `.npm_ci_calls`).
- 복구 뒤 진단은 `ready`입니다(`tests.doctor-repaired.result.status`). 이때 `runtimes/` 아래에는 현재 런타임 디렉터리와 `<fingerprint>.failed-<epoch-ms>` 디렉터리가 함께 있었습니다(`tests.doctor-repaired.runtimes_entries`). 이전 런타임이 삭제되지 않고 이름만 바뀌어 남은 것을 확인한 결과입니다.

소스는 `teams-org.mjs` 1125~1129줄의 `repair: true` 전달과 `dependencies.mjs` 433줄의 `.failed-` 이름 변경입니다. `tests/dependencies.test.mjs`에서 `repair: true`를 쓰는 곳은 152줄의 재사용 확인 하나뿐이므로, 손상된 런타임을 수리해 복구하는 경로는 결정적 테스트에 없고 이 실측만 확인합니다.

### 5. npm이 실패하는 수리에서 기존 상태 보존

이 단계는 `manifest.json`을 "CORRUPTED-FOR-FAILED-TEST"로 다시 덮고, 실패하는 npm shim을 PATH 앞에 둔 채 `runtime-repair`를 실행했습니다.

- 종료 코드는 1이고 오류 메시지는 `runtime-npm-install-failed:`로 시작했습니다(`tests.failed-staging.code`, `.stderr_head`). shim이 기록한 `npm ci`는 1회입니다(`.npm_ci_calls`).
- 실행 전후를 비교한 결과는 다음과 같습니다. `active.json` 파일의 sha256이 같고(`cfbd8630c95b096b5fc8ab5a2a2728fad9682dc355ed21e7e747418b0736472c`, `.active_json_equal` = true), 런타임 트리 해시가 같으며(`86b2f3b256cc8faaebc858348b7c882ea955db76a01ca9734e9fc3f03a60bfe0`, `.runtime_tree_equal` = true), `runtimes/` 항목 목록이 같고(`.runtimes_entries_equal` = true), 실행 뒤 `staging/`에 남은 항목이 없습니다(`.after.staging_entries` = []).
- 이어서 실제 npm으로 `runtime-repair`를 다시 실행하자 종료 코드 0, `installed` true였고, 진단은 `ready`였습니다(`tests.repair-after-failure`, `tests.doctor-recovered.result.status`).

이 결과가 보여 주는 범위는 "수리가 실패해도 손상된 기존 런타임과 `active.json`을 건드리지 않고 staging을 정리한다"입니다. 정상 런타임이 npm 실패로 손실되지 않는다는 뜻은 아닙니다. 정상 런타임은 3번 항목처럼 재사용되어 npm이 호출되지 않습니다. 결정적 테스트로는 `tests/dependencies.test.mjs` 178줄의 "an unhealthy runtime is still reinstalled"가 npm 실패 시 `runtime-npm-install-failed`로 거부되고 `npm ci`가 기록됨을 확인하지만, `active.json`의 보존은 검사하지 않습니다.

## 전역 상태 측정

### 방법과 귀속 범위

`~/.codex`와 `~/.claude` 전체 트리를 비교하지 않습니다. 이 두 디렉터리에는 실행 중인 Codex와 Claude Code 세션이 로그와 데이터베이스를 계속 쓰므로, 전후 차이가 있어도 이 실험이 만든 것인지 알 수 없기 때문입니다. 대신 두 가지를 측정했습니다.

1. **누출 검출 (귀속 가능)**: 실험 프로세스의 쓰기를 홈 디렉터리와 저장소 아래에서 커널 수준으로 거부했고, 가드가 실제 홈 아래 쓰기를 거부함은 통제 프로브 3회로 확인했습니다. 그러나 이번 실행에서는 커널 로그가 통제 프로브의 거부도 기록하지 못해, 실험 프로세스가 거부된 쓰기를 시도했는지를 로그로는 판단할 수 없습니다(위 측정 방법 참조). 거부된 쓰기는 EPERM으로 실패하므로 해당 단계의 기대 결과가 깨질 수 있으며, `expectations` 12개가 모두 true인 점이 간접 근거일 뿐입니다.
2. **대상 파일 전후 비교 (`real_user_state`)**: OpenCodex 실행이 바꿀 수 있는 파일만 전후로 mtime, 크기, 내용 해시 앞 12자리를 비교했습니다. 비교한 16개 항목은 `~/.codex/config.toml`, `~/.codex/auth.json`(크기와 mtime만, 내용과 해시는 읽지 않음), `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/plugins/installed_plugins.json`, 셸 rc 파일 8종(`~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.zlogin`, `~/.bash_profile`, `~/.bash_login`, `~/.bashrc`, `~/.profile`), `~/.omt` 트리, `~/.opencodex` 트리, `launchctl getenv ANTHROPIC_BASE_URL`입니다.

### 결과

`real_user_state.diff`의 16개 항목이 모두 `"unchanged"`입니다. 실제 사용자 `~/.omt`에는 실험 이전부터 파일 5300개가 있었고(`real_user_state.before.trees["~/.omt"].files`), 실험 뒤에도 같은 개수와 해시였습니다. `~/.opencodex`는 실험 전후 모두 존재하지 않았고(`exists` false), `launchctl`의 `ANTHROPIC_BASE_URL`은 전후 모두 설정되어 있지 않았습니다(`set` false). `~/.zlogin`과 `~/.bash_login`은 이 머신에 없는 파일이며 전후 모두 없음으로 같습니다.

### 이 측정이 말하지 못하는 것

- `~/.codex`와 `~/.claude`의 위 대상 파일 이외 부분은 비교하지 않았습니다. 그 부분의 변화에 대해서는 귀속 불가입니다. 이 경로에 대한 이 실험의 쓰기 시도가 없었다는 점도 이번 실행의 로그로는 확인하지 못했습니다.
- 쓰기 가드는 파일 쓰기만 거부하며, 실제 홈과 저장소 밖의 경로(예: 시스템 디렉터리, Homebrew 경로)와 `launchctl setenv` 같은 프로세스 간 통신은 막지도 비교하지도 않았습니다. `launchctl` 값은 위 비교 항목으로만 확인했습니다.
- 거부 로그는 macOS 통합 로그를 시간 창으로 조회한 결과입니다. 같은 시간에 다른 샌드박스 프로세스의 거부가 섞일 수 있고, 이번 실행처럼 기록 자체가 누락될 수도 있습니다. 이 때문에 스크립트는 통제 프로브의 거부가 기록되었을 때에만 "다른 거부 없음"을 기대 항목으로 판정하며, 이번 실행에서는 그 항목이 판정되지 않았습니다.
- 이전 판은 `~/.codex`, `~/.claude` 전체의 파일 수, 최대 mtime, 총 크기를 비교했고, 그 결과가 "무변경"이라는 문서 서술과 어긋났습니다. 그 방식은 폐기했습니다.

## dry-run

`runtime-install --dry-run`은 종료 코드 0, `dryRun` true를 반환했고 `npm ci`를 호출하지 않았습니다. 실행 전후 파일 목록은 `tests.install-dryrun.listing_before`와 `listing_after`가 같고 `listing_diff.identical` = true이며, 추가, 삭제, 변경된 경로가 없습니다. 자세한 내용은 위 2번 항목을 참조하십시오.

## 결정적 테스트와 CI 범위

`.github/workflows/ci.yml`은 40줄이며 다음 내용이 있습니다.

- 22줄: `os: [ubuntu-latest, macos-latest, windows-latest]` 매트릭스.
- 32줄 `npm ci`, 34줄 `npm run quality`, 37줄 `npm run format:check`, 40줄 `npm test`.
- `tests/dependencies.test.mjs` 76~78줄의 `posixOnly`는 `process.platform === "win32"`일 때 테스트를 건너뜁니다. 이 옵션을 쓰는 테스트는 135줄, 159줄, 178줄, 194줄의 테스트입니다. 23줄, 38줄, 45줄, 54줄의 테스트는 옵션이 없어 모든 플랫폼에서 실행됩니다.
- 어느 테스트도 `teams-org.mjs`의 `runtime-doctor`, `runtime-install`, `runtime-repair` 명령을 호출하지 않으며, `dependencies.mjs`의 함수를 직접 호출합니다.

## Windows

이 문서의 실측은 Windows에서 하지 않았습니다. Windows 호스트가 없었으므로 Windows에서의 설치, `ocx.cmd` 실행, health check, 손상과 복구 동작은 실측이 없습니다. 확인된 사실은 CI 매트릭스에 `windows-latest`가 있어 `npm run quality`, `npm run format:check`, `npm test`가 실행된다는 점과, 위 `posixOnly` 테스트 4개가 Windows에서 건너뛰어진다는 점뿐입니다.

## 발견한 구현 결함

없음. 이 실측 범위에서 구현과 계약 요구가 어긋나는 동작은 관측되지 않았습니다.

## 재실행

```bash
python3 experiments/opencodex-w2-platform/run_platform_proof.py
```

- 작업 트리가 깨끗한 커밋에서 실행하면 `repository.dirty`가 false로 기록됩니다. 수정 중인 트리에서 실행하면 `repository.status_porcelain`에 변경 파일이 남습니다.
- 종료 코드는 `expectations`가 모두 true일 때만 0입니다. 콘솔에는 전역 상태 비교 16개 항목이 하나도 생략되지 않고 출력됩니다.
- 실행하면 `runtime-test-results.json`을 덮어쓰므로, 결과를 보존하려면 `--output`으로 다른 경로를 지정합니다.
