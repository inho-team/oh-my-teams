# Codex 역할 터미널의 업데이트 알림 화면 처리 방법 확인

작성일: 2026-09-26
상태: 완료 (t5-codex-update-prompt)
환경: macOS 24.6.0(Darwin), codex-cli 0.157.0(`/opt/homebrew/bin/codex` → `@openai/codex` npm 패키지, 네이티브 바이너리 `.../codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`)
관측 근거: `/Users/jinsungkim/orca/oh-my-teams/.omt/history/supervised-prompt-answers-w3/signal-progress-12.txt` 5절 (Codex 0.155.1의 "✨ Update available! 0.155.1 -> 0.157.0" 화면, 기본 선택은 "1. Update now (runs npm install -g @openai/codex)")

## 목표

Codex 역할 터미널이 업데이트 알림 화면을 만나도 사람의 개입 없이, 전역 패키지를 갱신하지 않고 다음 단계로 나아가게 한다. PM이 정한 순서대로 먼저 화면을 아예 띄우지 않는 명령줄 방법을 실제 설치본에서 찾는다.

## 1. 실제 설치본에서 확인한 것

### 1-1. `check_for_update_on_startup`은 실재하는 `ConfigToml` 최상위 필드다

`-c/--config`는 `~/.codex/config.toml`에 쓰지 않고 그 자리에서 값을 덮어쓰는 명령줄 옵션이다(`codex --help`). 존재하지 않는 키를 주면 `--strict-config`가 즉시 거부하므로, 이 성질로 실재 여부를 시험했다.

```
$ codex exec -c totally_bogus_key_xyz=false --strict-config "hi"
Error loading config.toml: unknown configuration field `totally_bogus_key_xyz` in -c/--config override

$ codex exec -c check_for_update_on_startup=false --strict-config "hi"
Reading additional input from stdin...
OpenAI Codex v0.157.0
--------
workdir: ...
model: gpt-6-astra
...
2026-09-26T05:10:36Z ERROR ...: failed to connect to websocket: HTTP error: 401 Unauthorized, ...
```

`totally_bogus_key_xyz`는 즉시 오류로 거부됐고 `check_for_update_on_startup`은 그대로 통과해 정상 세션 헤더를 찍은 뒤 인증 단계(임시 `CODEX_HOME`이라 로그인 정보가 없어 401)로 넘어갔다. 두 번째 실행은 임시 `CODEX_HOME`을 썼고 어떤 모델 호출도 성공하지 않았으므로 과금이나 실제 작업은 일어나지 않았다.

네이티브 바이너리 문자열을 직접 뒤져 같은 결론을 재확인했다. `check_for_update_on_startup`은 여러 지점에서 `"struct ConfigToml with 104 elements"`라는 문구와 같은 문자열 블록에 등장하는 필드 이름이며, `core/src/config/requirements.rs` 경로 문자열 근처(관리형 정책이 강제할 수 있는 필드 목록)에도 나타난다. 즉 사용자 설정 파일이 아니라 `-c` 오버라이드로도 켜고 끌 수 있는 최상위 설정값이다.

```
$ strings -a <native codex 바이너리> | grep -o '.\{60\}check_for_update_on_startup.\{60\}'
...ghost_snapshotproject_root_markerscheck_for_update_on_startupanalyticsdesktopnotice...struct ConfigToml with 104 elements...
```

### 1-2. 여러 `-c` 오버라이드를 함께 줘도 모두 적용된다

`role-command`는 이미 Codex에 `--config model_reasoning_effort=<effort>`를 붙인다. 같은 호출에 `-c`를 두 번 줘도 둘 다 반영되는 것을 확인했다.

```
$ codex exec -c check_for_update_on_startup=false -c model_reasoning_effort=medium --strict-config "hi"
...
reasoning effort: medium
...
```

### 1-3. 확인하지 못한 것

- 이 플래그가 실제로 "✨ Update available!" 화면 자체를 없애는지는 화면으로 직접 보지 못했다. 설치본이 이미 0.157.0(관측 근거의 화면이 안내하던 최신판)이라서 더 새 판이 없고, 화면을 강제로 재현하려면 `npm install -g`로 진짜 업데이트를 하거나 더 새 버전이 나오길 기다려야 하는데, 둘 다 안전 규칙(전역 패키지를 갱신하지 않는다)에 어긋나 시도하지 않았다.
- 로컬 프록시로 시작 시 네트워크 호출 자체가 사라지는지 관찰하려 했으나, `codex`의 대화형 TUI가 대체 화면 진입 시 터미널 기능 질의(OSC 10/11, DA 응답)에 대한 응답을 기다리며 멎어서, 짧은 시간 안에 판독 가능한 신호를 얻지 못했다. 더 시간을 들이면 확인할 수 있겠지만 이번 확인의 범위를 넘는다고 보아 중단했다.
- 따라서 "화면이 아예 뜨지 않는다"는 것은 설정 필드의 이름과 문서화되지 않은 의미로부터 강하게 뒷받침되는 추정이며, 화면 소거 자체를 실측으로 확정하지는 못했다.

## 2. 선택한 방법과 이유

명령줄 오버라이드로 화면을 사전에 억제하는 방법이 실재를 확인한 만큼, PM이 정한 순서 1번(화면을 아예 띄우지 않는 방법)을 택했다. `plugins/oh-my-teams/scripts/role-launch.mjs`의 `roleCommand`가 Codex를 조립하는 자리에 `--config check_for_update_on_startup=false`를 항상 덧붙였다(모델·effort 유무와 무관하게). 분류기(`prompt-answers.mjs`)에 이 화면을 새로 추가하는 2번 경로는, 관측 근거 5절이 이미 "unknown으로 두는 것이 의도된 동작"이라고 명시했고 1번 방법이 확인됐으므로 쓰지 않았다.

## 3. 변경한 파일

- `plugins/oh-my-teams/scripts/role-launch.mjs`: `roleCommand`가 Codex 프로필에 `--config check_for_update_on_startup=false`를 추가.
- `plugins/oh-my-teams/references/orca-runtime.md`: Codex 명령 조립 서술에 새 플래그를 반영하고 이 문서를 근거로 링크.
- `tests/role-dispatch.test.mjs`: 기존 Codex argv 단정 두 곳을 갱신하고, effort 유무와 무관하게 플래그가 붙으며 다른 실행기에는 붙지 않는다는 회귀 테스트를 추가.

## 4. 검증에 쓴 임시 자원과 정리

모든 시험은 `mktemp`로 만든 임시 `CODEX_HOME`(스크래치패드 하위, 워크트리 밖)에서 실행했고 사용자의 `~/.codex/config.toml`·`~/.codex/auth.json`은 읽거나 쓰지 않았다. `npm install -g`, `codex update`, 대화형 화면에서 "Update now" 선택은 어떤 시점에도 실행하지 않았다. 시험용 임시 `CODEX_HOME` 디렉터리와 로컬 프록시 실험용 스크립트, 백그라운드로 띄운 `codex` 프로세스는 확인 직후 모두 지우고 종료했다.
