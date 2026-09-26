# Codex 역할 터미널의 업데이트 알림 화면 처리 방법 확인

작성일: 2026-09-26
상태: 부분 확인 (t5-codex-update-prompt) — 설정 키의 존재와 수용은 확인했으나, 업데이트 알림 화면 자체를 없애는 효과는 로그인 화면에 막혀 여전히 미확인이다. 다음 단계는 PM의 판단을 기다린다(§1-4).
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

### 1-4. 검토 반려 후 재조사: 대화형 실행은 로그인 화면에 막혀 여전히 비교할 수 없다

PM 지시에 따라 두 갈래로 다시 조사했다.

**(a) CODEX_HOME 아래에 업데이트 확인 결과를 저장하는 파일이 있는가.** 임시 `CODEX_HOME`에서 플래그 없이 `codex exec "hi"`를 한 번 실행한 뒤 생긴 파일을 모두 나열했다(`sqlite3 <file> .tables`로 스키마도 확인). 생긴 것은 `goals_1.sqlite`·`memories_1.sqlite`·`queue_1.sqlite`·`state_5.sqlite`·`logs_2.sqlite`·`installation_id`·세션 롤아웃 로그뿐이며, 버전 번호나 마지막 확인 시각을 담은 파일·테이블은 하나도 없었다. 즉 이 설치본은(적어도 인증되지 않은 상태에서는) 업데이트 확인 결과를 `CODEX_HOME` 아래의 읽을 수 있는 파일에 캐시해 두지 않는다. 인증된 세션에서도 그런 파일이 없는지는 로그인을 하지 않고는 확인할 수 없어 미해결로 남는다.

**(b) 대화형 화면을 실제로 띄워 플래그 유무를 비교.** 이전 시도는 `codex`가 대체 화면(alt-screen) 진입 시 보내는 터미널 기능 질의에 일반 Bash 파이프가 응답하지 못해 멎었다. 이번에는 `tmux`(진짜 pty를 제공하고 그런 질의에 스스로 응답한다)로 세션을 띄워 그 문제를 넘었다. 다만 임시 `CODEX_HOME`을 이 워크트리의 스크래치패드 경로(중첩이 깊어 매우 긺) 아래 두면 `codex`가 app-server 데몬과 통신하는 유닉스 소켓 경로가 `SUN_LEN`을 넘어 `Error: ... path must be shorter than SUN_LEN`으로 즉시 실패했다. 이는 로그인이나 업데이트 확인과 무관한, 순전히 소켓 경로 길이 문제였으므로 `mktemp -d /tmp/cdx.XXXXXX`로 짧은 임시 `CODEX_HOME`을 새로 만들어 우회했다(여전히 OS 임시 디렉터리이고 워크트리 밖이다).

```
$ tmux new-session -d -s codex_t5 -x 220 -y 50 "env CODEX_HOME=/tmp/cdx.h2tNNY codex"
$ tmux new-session -d -s codex_t6 -x 220 -y 50 "env CODEX_HOME=/tmp/cdx.3EY5tb codex --config check_for_update_on_startup=false"
```

두 세션 모두 데몬 설치 스피너를 거친 뒤 화면 원문이 동일했다:

```
  Welcome to Codex, OpenAI's command-line coding agent

  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Provide your own API key
     Pay for what you use

  Press enter to continue
```

플래그가 있든 없든 로그인 화면이 가장 먼저, 그리고 동일하게 뜬다. 관측 근거(5절)의 "✨ Update available!" 화면은 이미 인증된 세션에서 나타난 것이므로, 인증되지 않은 임시 `CODEX_HOME`으로는 애초에 그 화면에 도달할 수 없다. 안전 규칙(로그인 정보 복사·작성 금지)을 지키는 한 이 경로로는 A/B 비교가 불가능하다는 뜻이며, 이는 t5의 이전 시도가 이미 부딪혔던 한계와 같은 결론이다. 두 세션 모두 아무 항목도 선택하지 않고 `tmux kill-session`으로 닫았다.

**결론:** 화면 소거 효과는 이번 재조사에서도 실측하지 못했다. 새로 확인한 것은 (i) 인증 전에는 업데이트 확인 결과를 담은 로컬 캐시 파일이 없다는 것과 (ii) 대화형 실행도 로그인 화면에 막혀 플래그 유무로 화면을 비교할 방법이 없다는 것이다. 더 새 Codex 판이 나오거나 안전하게 인증된 세션을 관찰할 방법이 생기기 전까지는 이 불확실성이 남는다.

## 2. 선택한 방법과 이유

명령줄 오버라이드로 화면을 사전에 억제하는 방법을 PM이 정한 순서 1번(화면을 아예 띄우지 않는 방법)에 따라 택했다. 다만 "실재를 확인했다"는 것은 `check_for_update_on_startup`이 `ConfigToml`의 유효한 최상위 필드로 존재하고 `-c` 오버라이드가 그 값을 오류 없이 받아들인다는 사실을 가리키며(§1-1, §1-2), 그 값이 "✨ Update available!" 화면을 실제로 없애는 효과까지 확인했다는 뜻은 아니다(§1-3, §1-4). 분류기(`prompt-answers.mjs`)에 이 화면을 새로 추가하는 2번 경로는, 관측 근거 5절이 이미 "unknown으로 두는 것이 의도된 동작"이라고 명시했고 1번 방법의 설정 키 자체는 확인됐으므로 쓰지 않았다.

## 3. 변경한 파일

- `plugins/oh-my-teams/scripts/role-launch.mjs`: `roleCommand`가 Codex 프로필에 `--config check_for_update_on_startup=false`를 추가.
- `plugins/oh-my-teams/references/orca-runtime.md`: Codex 명령 조립 서술에 새 플래그를 반영하고 이 문서를 근거로 링크.
- `tests/role-dispatch.test.mjs`: 기존 Codex argv 단정 두 곳을 갱신하고, effort 유무와 무관하게 플래그가 붙으며 다른 실행기에는 붙지 않는다는 회귀 테스트를 추가.

`plugins/oh-my-teams/scripts/headless.mjs`의 `PROVIDERS.codex.command()`가 만드는 `codex exec` argv에는 이 플래그를 붙이지 않았다. 그 경로는 `roleCommand`를 거치지 않는 별도의 헤드리스 실행(`docs/plan/headless-runtime.md`)이며, task 계약의 ac-1이 "역할 터미널"로 범위를 한정하므로 이번 변경의 대상이 아니다.

## 4. 검증에 쓴 임시 자원과 정리

모든 시험은 임시 `CODEX_HOME`(워크트리 밖의 OS 임시 디렉터리)에서 실행했고 사용자의 `~/.codex/config.toml`·`~/.codex/auth.json`은 읽거나 쓰지 않았다. §1-4의 대화형 재조사에서는 스크래치패드 하위 경로가 유닉스 소켓 경로 길이 제한에 걸려 `mktemp -d /tmp/cdx.XXXXXX`로 만든 더 짧은 임시 `CODEX_HOME`을 대신 썼다. `npm install -g`, `codex update`, 대화형 화면에서 "Update now"나 로그인 옵션 선택은 어떤 시점에도 실행하지 않았다. 시험용 임시 `CODEX_HOME` 디렉터리(`/private/tmp/.../scratchpad/codex-home-*`와 `/tmp/cdx.*` 모두), 로컬 프록시 실험용 스크립트, `tmux` 세션(`codex_noflag`·`codex_t2`~`codex_t6`), 백그라운드로 뜬 `codex`/`app-server-daemon` 프로세스는 확인 직후 모두 지우고 종료했다.
