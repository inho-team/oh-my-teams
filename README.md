# oh my teams

Claude Code·Codex용 **에이전트 조직 플러그인**. PM / PL / Senior / Junior의 역할과 모델·구독을 분리하고 Orca 위에서 작업을 실행한다. 내부 실행기는 **Claude, Codex, Agy, Ollama**이며, 독립 편집 작업과 통합에는 **Orca worktree**를 사용한다.

## 시작

| 스킬 | 동작 |
|---|---|
| `help` | 설치된 생애주기·역할·지원 스킬과 사용 시점을 표로 안내 |
| `form` | 네 역할의 모델만 골라 상설 조직을 결성하고, 나머지는 비용이 늘지 않는 기본값으로 저장 |
| `kickoff` | 하나의 개발 Goal을 시작하거나 재개하고, PM이 난이도에 맞춘 실행 깊이로 완료 조건까지 지속 감독 |
| `status` | 상설 조직과 현재 Goal·실행 팀·워크트리·검증 상태를 구분하여 표시 |
| `adjust` | 요청한 상설 조직 설정만 수정하고 이전 설정 보존. 추론 강도·대체 순서·인원·보조 도구·별도 계정은 여기서 정함 |
| `close` | 성공한 Goal의 PR/MR·병합·워크트리 정리와 완료 기록 처리 |
| `disband` | 실패·취소된 실행 팀을 해체하고 복구 가능한 결과와 기록 보존 |

Claude에서는 `/oh-my-teams:form`, `/oh-my-teams:kickoff` 등으로 호출한다. Codex에서는 플러그인의 해당 스킬을 호출하거나 같은 뜻으로 요청한다. `pm`은 kickoff 내부의 지휘 역할로 유지한다. 조직 구성 후 구독을 다시 묻지 않는다. 실행 중 작업은 시작 당시 조직 스냅샷을 유지한다.

구독·모델·승인처럼 사용자가 정해야 하는 항목은 [사용자 선택 질문 계약](plugins/oh-my-teams/references/user-choice.md)을 따른다. 호스트가 구조화된 선택 도구를 제공하면 그것으로 묻고(Claude Code에서는 `AskUserQuestion`), 제공하지 않으면 번호를 매긴 선택지를 한 번에 제시한다. Codex CLI 0.154.0에는 이 용도로 확인된 도구가 없으므로 후자를 쓴다.

**2.8.0 변경:** 감독과 검토에 드는 토큰을 줄였다. Claude 역할 터미널은 `--autocompact 250k`로 열리며, 값은 조직의 `policy.claudeAutoCompact`로 바꿀 수 있다. 이미 연 Claude 터미널에 다른 task나 검토를 넘기면 `worker-start`가 먼저 `/clear`로 대화를 비운다. 감독 역할은 heartbeat만 온 경우에는 깨어나지 않는 `supervision-wait`로 worker를 기다린다. Junior 구현은 첫 검토에서 반려되면 Senior에게 넘어가고, 검토자는 첫 검토에서 finding을 한 번에 모두 적으며 재검토에서는 수정 diff만 확인한다. 이사의 신호함에서는 `progress` 신호가 미처리 목록에 남지 않고, 새 `close-ready`가 이전 것을 대체하며, `kickoff-release`가 그 kickoff에 남은 신호를 정리한다.

**2.6.1 변경:** 구현 task의 담당을 추론 강도로 정한다. 설계와 구현이 한 번에 필요한 상위 등급 구현은 Senior가 직접 맡고, 닫힌 범위의 구현은 Junior가 맡는다. Senior가 구현한 task는 다른 Senior 실행이나 PL·PM이 검토한다. 기준은 [pm](plugins/oh-my-teams/skills/pm/SKILL.md)의 「구현 등급」에 있다.

**2.6.0 변경:** Intern 역할을 삭제했다. 좁은 편집·인용 수집·반복 실무는 Junior가 직접 맡으며, 실행 깊이는 1~4가 된다. `intern`을 선언한 조직 파일은 런타임이 거부하므로, Intern 프로필이 필요하면 Junior로 옮기고 `intern` 역할과 허용 목록 항목을 지운 뒤 `adjust`로 저장한다. 2.6.0 이전에 시작한 kickoff의 workflow 스냅샷과 기록은 `intern`을 `junior`로, 깊이 5를 깊이 4로 읽으므로 그대로 이어서 진행할 수 있다.

**2.0.0 비호환 변경:** 생애주기 스킬 이름에서 `team-` 접두어를 제거했다. `team-form`은 `form`, `team-kickoff`는 `kickoff`가 되었으며 `status`, `adjust`, `close`, `disband`, `help`도 같다. 이전 호환 별칭 `team-setup`, `team-show`, `team-edit`, `org-setup`, `org-show`, `org-edit`과 `director`는 모두 삭제했으므로 그 이름으로는 스킬을 찾을 수 없다. 조직 파일 형식과 런타임 명령은 바뀌지 않았으므로 기존 `.omt/` 설정은 그대로 쓴다.

`kickoff`는 호스트의 네이티브 Goal을 유일한 지속 실행 권한으로 사용한다. 같은 세션에서 Ralph, autopilot 또는 다른 Goal 루프를 함께 실행하지 않는다. 매 실행 주기에는 확인 가능한 진전을 남기며, 완료 조건과 최신 검증이 모두 충족된 뒤 `close`로 전달과 자원 정리를 마쳐야 Goal을 완료한다.

```text
PM       분석·중장기 계획·최종 결과
└─ PL    분석·중단기 계획·분할·통합
   └─ Senior  구체적인 구현 방법·상위 등급 구현·중요 변경 검토
      └─ Junior  기능 구현·제한된 편집·반복 실무
```

작은 작업에 네 세션을 모두 만들지 않는다. 실제 감독에는 Orca `orchestration`, 워크트리·터미널·회수에는 `orca-cli`, 웹 검증에는 `orca-browser-use`, 외부 앱에는 `computer-use` 스킬을 필요할 때 사용한다.

## 설치

### 필수 의존성

플러그인을 설치하기 전에 다음 소프트웨어를 설치하고 로그인해야 합니다.

| 소프트웨어 | 버전 | 용도 | 설치 방법 |
|---|---|---|---|
| Node.js | 22.13 이상 | 런타임 및 설치 스크립트 실행 | https://nodejs.org/en/download/ |
| Git | 최신 | 저장소 관리 및 작업 추적 | https://git-scm.com/downloads |
| Claude Code | 최신 | 호스트 및 에이전트 실행 | 이 저장소의 의존성 카탈로그에 설치 출처가 없으므로 이미 설치한 Claude Code를 사용합니다. |
| Codex CLI | 최신 | 호스트 및 에이전트 실행 | macOS는 https://chatgpt.com/codex/install.sh, Windows는 https://chatgpt.com/codex/install.ps1, 또는 `npm install -g @openai/codex` |
| Orca CLI | 최신 | workflow 감독 및 orchestration | https://onorca.dev/download |
| gh (GitHub CLI) | 최신 | pull request 작업(선택) | https://cli.github.com/ |

새 oh my teams 런타임은 Python이나 macOS `sandbox-exec`에 의존하지 않습니다.

### 플러그인 설치

설치기를 실행하면 호스트에 플러그인을 설치하고, `plugins/oh-my-teams/package.json`에 정확한 버전으로 고정된 OpenCodex 런타임을 준비합니다.

```powershell
./install.ps1 both
```

```sh
sh install.sh both   # claude | codex | both
```

설치기는 다음을 수행합니다.

- 현재 저장소를 호스트(Claude 또는 Codex)의 로컬 마켓으로 등록하고 플러그인을 설치하거나 갱신합니다. 이 과정에서 호스트가 저장하는 플러그인 상태가 바뀝니다.
- 기존 설치 상태를 확인하고 레거시 플러그인 `orca@orca-skills`의 처리 계획을 만듭니다. Claude에서는 레거시를 비활성화하고, `--remove-legacy`를 주면 제거합니다.
- 마지막으로 OpenCodex 런타임을 `~/.omt/runtime/opencodex/` 아래에 설치합니다. 이 단계가 실패하면 플러그인은 이미 설치된 상태에서 계획의 `runtime.status`가 `install-failed`로 표시되고 종료 코드가 0이 아니며, 원인을 고친 뒤 `runtime-repair`를 실행합니다.

`--dry-run`을 추가하면 호스트 플러그인과 런타임을 바꾸지 않고 계획을 JSON으로 출력합니다. 이때도 호스트의 플러그인 목록은 읽습니다. `--remove-legacy`를 함께 사용하면 계획에 레거시 제거가 포함됩니다.

```sh
sh install.sh both --dry-run --remove-legacy
```

설치 후 **새 대화**에서 스킬을 사용합니다. Claude 세션 전용 시험은 `claude --plugin-dir ./plugins/oh-my-teams`로 가능합니다. 개발 변경 자체는 전역 설치나 사용자의 조직 설정을 자동 변경하지 않습니다.

새 설치 식별자는 `oh-my-teams@oh-my-teams`입니다. 기존 `/orca:director` 호출에 대응하던 `director` 별칭은 2.0.0에서 삭제했으므로 지휘 역할은 `pm`으로 직접 부릅니다. 조직 설정과 실행 기록은 `.omt/`에 저장됩니다. `~/.orca-skills` 고정 링크는 사용하지 않습니다. 이전 구현·실측은 [legacy/0.6.1](legacy/0.6.1/README.md)에 보존했고 자동 스킬 발견에서 제외했습니다.

### 첫 실행 점검

설치 후에는 다음 명령으로 OpenCodex 런타임이 준비되었는지 확인합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org .omt/organization.json \
  --state .omt
```

이 명령은 Node.js, OpenCodex 런타임, Git, Codex, Orca, GitHub CLI를 확인하고 결과를 JSON으로 출력합니다. `status`가 `ready`이면 OpenCodex 런타임이 정상이고 `opencodex-backend`에 필요한 검사가 실패하지 않은 것입니다. `gh`처럼 그 검사에 필요하지 않은 항목이 실패해도 `ready`일 수 있으므로, 모든 검사가 `pass`라는 뜻은 아닙니다.

`status`가 `needs-install`이면 활성 런타임이 없거나 어긋난 것입니다. 다음 명령은 잠금 파일로 고정된 OpenCodex 런타임만 설치하며, Node.js, Git, Codex, Orca, `gh`는 설치하지 않습니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org .omt/organization.json \
  --state .omt
```

문제가 해결되지 않으면 [OpenCodex 런타임 설치 안내](docs/OPENCODEX_RUNTIME.md)를 참고하십시오.

### 의존성

| 항목 | 필수 | 기능 |
|---|---|---|
| Node.js | ✓ | 런타임 실행, npm 패키지 관리 |
| npm | ✓ | 의존성 설치 |
| Git | ✓ | 저장소 관리, worktree 생성 |
| Codex CLI 또는 Claude Code | ✓ | 구독별 에이전트 실행(Codex) 또는 기본 실행기(Claude) |
| Orca CLI | ✓ | workflow 감독, orchestration, 상태 관리 |
| Orca Desktop | 선택 | GUI 기반 작업 모니터링 |
| OpenCodex 런타임 | 선택(설치기가 준비) | 고정 계정 실행: 조직 파일에서 `runner` 필드를 설정한 프로필만 사용 |
| gh (GitHub CLI) | 선택 | pull request 생성 및 관리 |

각 항목의 설치 및 문제 해결 방법은 [OpenCodex 런타임 설치 안내](docs/OPENCODEX_RUNTIME.md)를 참고하십시오.

## 모델과 구독

`agy models`가 반환한 ID(agy 1.2.3, 2026-09-15): `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`, `gemini-3.6-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

Codex 계정의 모델 카탈로그는 계정과 CLI 버전에 따라 달라진다. codex-cli 0.154.0(2026-09-16)의 `codex debug models`에는 `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`가 선택 가능한 모델로 들어 있었고, `config.toml`에 `model`이 없으면 이 가운데 첫 항목이 실행된다. 설치 때 `agy models`와 Codex 카탈로그로 다시 확인한다. Claude·Codex의 미지정 모델은 `null`로 저장해 호스트 기본값을 쓴다.

기본 예제는 PM=Claude 호스트 기본 모델, PL=`gpt-5.6-sol`, Senior=`gemini-3.8-flash-high`, Junior=`claude-opus-4-6-thinking`으로 배정한다. 여기에 더해 `gpt-5.6-luna`와 `gpt-5.6-terra` 프로필을 미리 정의해 두므로, 역할의 `profile`만 바꾸면 다른 Codex 모델로 옮길 수 있다. 역할이 실제로 참조하는 프로필에는 강도를 적지 않았다. 강도 표기 예시는 어떤 역할도 참조하지 않는 `codex-terra`에만 두었으므로, 이 예제로 실행하는 호출의 추론 깊이는 이전과 같다. 공유 풀 소진 이후 모든 역할의 동시 실행 슬롯은 1로 고정했다. 조직의 `assistants`에 허용된 역할은 저장된 GPT-OSS 프로필을 보조 도구로 호출할 수 있다. 기본 예제에서는 모든 역할이 허용되어 있으며, 호출한 역할이 결과를 검증하고 최종 판단을 책임진다.

Agy 프로필의 GPT-OSS·Sonnet·Opus는 모두 정확한 모델 ID를 `--model` 인자로 전달한다. 요청 모델이 적용됐다는 증거가 없으면 기본 모델로 조용히 전환하지 않는다.

### 결성 질문과 기본값

`form`은 네 역할(PM·PL·Senior·Junior)이 각각 어떤 모델을 쓸지만 묻고, 질문은 한 번으로 끝난다. 몇 단계로 운영할지는 묻지 않는다. 조직은 항상 네 역할을 두고, 몇 개를 쓸지는 kickoff마다 PM이 실행 깊이로 정한다. 역할별 선택지는 PM에 Claude Fable·Opus·Codex Astra·Agy Gemini Pro, PL에 Claude Opus·Codex Sol·Agy Gemini Pro·Claude Sonnet·Codex Terra(5개), Senior에 Claude Sonnet·Codex Terra·Agy Gemini Pro·Agy Claude Opus, Junior에 Claude Haiku·Codex Luna·Agy Flash·Agy Claude Sonnet이 있으며, 그 밖의 모델은 자유 입력으로 받는다. Codex의 개별 모델 ID는 설치된 CLI의 `codex debug models`에서 읽어 질문 본문에 안내하며, 자유 입력 `codex:<id>`로 고른다.

묻지 않은 값은 사용자가 고른 모델보다 더 쓰지 않는 쪽으로 저장된다. 모든 프로필은 현재 로그인 계정을 쓰고 같은 실행기끼리 하나의 pool로 묶이며, 역할별 동시 인원과 시도는 1, 대체 프로필은 없음, 소진 시 중단, 호출 한도(`policy.maxCalls`)는 3이다. 이 한도는 `work` 한 번이 쓰는 provider 호출 수와 workflow attempt 하나에 배정되는 호출 수의 상한이며, 대화형 역할 터미널의 턴은 세지 않는다. 감독 역할은 15분 동안 활동이 없는 worker에게 진행 상황을 묻고, 답이 없는 요청이 2회에 이르면 상위에 보고한다. 추론 강도는 기록하지 않아 각 CLI 기본값을 쓴다. 다만 Agy는 Gemini 모델에 기본 강도를 두지 않고 강도 없이 부르면 거부하므로, Gemini는 결성 때 Flash 3.8을 `medium`, Pro 3.1을 `high`로 정하고 결성 보고에 적는다. 보조 도구 호출은 허용하지 않는다. 이 값들은 `org-draft` 명령이 기록하며 모두 `adjust`에서 바꾼다. 로컬 Ollama 모델은 컨텍스트 창을 확인해 기록해야 하므로 결성 후 `adjust`에서 추가한다.

### 실행 깊이

한 번의 kickoff가 쓰는 역할 수는 PM이 과제의 난이도를 보고 정한다. 깊이 1은 PM만, 2는 PM·Junior, 3은 여기에 Senior, 4는 PL까지 네 역할을 모두 쓴다. 역할은 구현, 독립 검토, 병렬 분할·통합의 순서로 더해진다. 이번 실행에서 쓰지 않는 역할 앞으로 온 일은 서열을 따라 위로 올라가 포함된 가장 가까운 역할이 맡는다. 역할은 작업을 배정받을 때만 모델을 호출하므로, 쓰지 않는 역할은 비용이 들지 않는다.

깊이는 사용자에게 묻지 않고 PM이 정해 사유와 함께 알리며, 사용자가 다른 깊이를 말하면 따른다. 처음 깊이는 workflow 요청의 `depth`에 기록되고, 실행 중에는 `workflow-depth` 명령으로 바꾼다. 올리기는 언제든 가능하다. 내리기는 빠지는 역할에 예약되었거나 실행 중인 작업이 없을 때만 런타임이 허용하며, 종료를 확인하지 못한 워커도 정산 전까지는 실행 중으로 본다. 대기 중인 작업은 원래 요청된 역할을 기준으로 다시 배정되고, 이미 실행을 마친 작업은 실행한 역할을 유지한다. 모든 변경은 사유·근거와 함께 `depthHistory`에 남는다.

깊이는 조직이 선언한 역할 안에서만 고른다. 구독이 없어 어떤 실행에서도 쓸 수 없는 역할은 `adjust`로 조직에서 빼고, 난이도에 따른 조정은 깊이로 한다. 조직 파일이 아니라 workflow에 기록된 역할 목록이 작업 배정, 실패 담당자 결정, workflow에 연결된 `work` 실행과 `status`의 다음 담당자 표시의 기준이다.

### 여러 kickoff 동시 진행

한 프로젝트에서 kickoff를 몇 개든 동시에 진행할 수 있다. kickoff마다 선언 세션이 PM 워크트리를 따로 만들어 넘기고, 그 워크트리 ID로 `.omt/kickoffs/`에 등록한다. `status`는 등록된 kickoff를 모두 보여 주고, `close`와 `disband`는 지목한 kickoff만 종료한다. 한 워크트리에는 kickoff를 하나만 등록할 수 있다. PM 세션 하나가 Goal 하나를 소유하고 Run 하나를 바인딩하기 때문이다.

워크트리가 나뉘어 파일 충돌은 없지만 구독 할당량은 나뉘지 않는다. 역할별 동시 인원과 호출 예산은 kickoff마다 따로 계산되므로, 같은 구독을 쓰는 kickoff가 둘이면 조직 파일에 적은 동시 인원의 두 배까지 워커가 함께 돌 수 있다. 필요하면 각 kickoff의 실행 깊이를 낮추거나 `adjust`로 동시 인원을 줄인다.

### 추론 강도

프로필의 선택적 `effort` 필드가 추론 강도를 지정한다. `form`은 이 필드를 기록하지 않으며, 강도는 `adjust`에서 정한다. 생략하면 어떤 강도 인자도 전달하지 않으므로 해당 CLI의 기본값을 그대로 쓴다. 실행기마다 전달 방식과 허용값이 다르며, 각 값은 설치된 CLI에서 확인한 것이다.

| 실행기 | 허용값 | 전달 방식 | 근거 |
|---|---|---|---|
| Agy | `low`, `medium`, `high` | `--effort <값>` | `agy --help`가 이 세 값을 명시한다. |
| Codex | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `--config model_reasoning_effort=<값>` | `codex exec`에 전용 플래그가 없고, 값 목록은 계정의 모델 카탈로그에서 가져왔다. |
| Claude | `low`, `medium`, `high`, `xhigh`, `max` | `--effort <값>` | `claude --help`(2.1.273)가 이 다섯 값을 명시한다. |
| Ollama | `low`, `medium`, `high` | HTTP 본문의 `think`, CLI의 `--think <값>` | Ollama 문서가 gpt-oss 같은 thinking 모델에 이 값을 명시한다. thinking 모드가 없는 모델은 요청을 거부하므로 일반적인 실행기 실패로 드러난다. |

`effort`를 생략했을 때 실제로 적용되는 깊이는 런타임이 정하지 않고 각 CLI와 계정 설정이 정한다. Codex는 `~/.codex/config.toml`의 `model_reasoning_effort`가 있으면 그것을, 없으면 모델 카탈로그의 `default_reasoning_level`을 쓴다(확인 시점 기준 `gpt-5.6-sol`은 `low`, `gpt-5.6-luna`와 `gpt-5.6-terra`는 `medium`). Agy는 서버가 모델별로 내려주는 선택지에서 결정한다. 따라서 보고서의 `requestedEffort`가 `null`이라는 것은 기본 깊이를 뜻하지 않고 **런타임이 깊이를 지정하지 않았다**는 사실만 뜻한다. 실제 적용된 깊이는 측정하지 않았다.

지원 범위는 모델마다 다르다. Codex 카탈로그에서 `gpt-5.6-luna`는 `ultra`를 제공하지 않으며, Codex CLI는 알 수 없는 값을 거부하지 않고 그대로 전달하므로 런타임이 저장 시점과 호출 시점에 값을 검증한다. Agy는 `--effort is not supported for model`이라는 오류를 가지고 있어 모델에 따라 이 플래그를 거부한다. `agy models`의 표시 이름을 보면 Gemini 계열만 High/Medium/Low로 나뉘고 `claude-sonnet-4-6`과 `claude-opus-4-6-thinking`은 Thinking, `gpt-oss-120b-medium`은 Medium으로 고정되어 있는데, 이 세 모델이 `--effort`를 받아들이는지는 확인하지 않았다. 런타임은 모델별 지원 표를 내장하지 않으므로, 모델이 거부한 강도는 일반적인 실행기 실패로 드러난다.

Agy는 `gemini-3.8-flash-high`처럼 모델 ID 자체에 강도를 담는다. 이때 `effort`를 함께 적으면 같은 값이어야 하며, 서로 어긋나면 저장을 거부한다. 어느 쪽이 실제 호출에 적용되는지 확인하지 않은 채 보고서에 쓰이지 않은 강도를 기록하지 않기 위해서다. `claude-sonnet-4-6`과 `claude-opus-4-6-thinking`은 ID에 강도 접미사가 없으므로 이 제약을 받지 않는다.

[조직 예제](plugins/oh-my-teams/examples/organization.json)는 구조 참고이며 실제 구독 선택을 대신하지 않는다. 프로필에는 실행기·명령 argv·계정 참조·구독 표시 이름·모델과 선택적 추론 강도를 저장한다. 구독 공유가 가능하다. 별도 계정은 실제 CLI 프로필 인수 또는 환경변수 이름 참조로 연결한다. 계정 이름만 붙여 전환됐다고 처리하지 않으며, 비밀값을 JSON에 넣지 않는다.

### 구독 하나로 쓰는 축소 조직

역할마다 계정을 나눌 필요는 없다. 같은 구독으로 만든 프로필을 모델만 다르게 여러 개 두고 역할별로 배정하면, 구독 하나로 역할별 모델 티어를 구분할 수 있다. 이때 그 프로필들을 하나의 `pool`로 묶어야 한다. 런타임은 소진이 확인된 pool에 속한 프로필을 남은 대체 순서에서 건너뛰므로, pool이 없으면 이미 소진된 같은 계정으로 계속 시도하다가 호출 예산만 소모한다. `single-subscription` 프리셋은 모델을 바꾸지 않고, 선언된 모든 역할의 동시 인원을 1로 낮추며 같은 할당량을 쓰는 대체만 제거한다.

`advisor-codex` 프리셋은 PM을 `gpt-5.6-sol`, PL·Senior를 `gpt-5.6-terra`, Junior를 `gpt-5.6-luna`로 옮기고 `gpt-6-astra`를 PM·PL·Senior의 자문자로 둔다. `advisor-claude` 프리셋은 같은 구조로 PM을 `opus`, PL·Senior를 `sonnet`, Junior를 `haiku`로 옮기고 `fable`을 자문자로 둔다. 두 프리셋 모두 이미 그 실행기에서 돌던 역할만 옮기고, 다른 실행기에 배정된 역할은 다른 할당량을 쓰므로 그대로 둔다. 조직에 없는 모델은 같은 실행기의 기존 프로필을 복사해 추가하므로 새 계정을 만들지 않는다.

역할도 네 개를 모두 둘 필요가 없다. PM만 필수이고 나머지 세 역할은 생략할 수 있으며, 남긴 역할의 상위 역할은 반드시 조직이 선언한 역할이어야 한다. 생략한 역할이 맡던 일은 `pm > pl > senior > junior` 서열을 따라 위로 올라가 선언된 가장 가까운 역할이 이어받는다. PM과 Junior만 둔 조직에서는 Senior가 맡던 검토와 PL이 맡던 실패 처리를 PM이 수행한다. 검토 요구사항은 요구된 역할보다 같거나 상위인 역할이 수행하면 충족되며, 구현과 다른 실행 주체여야 한다는 독립성 조건은 그대로 적용된다. 역할 이름 자체는 바꿀 수 없다. 구조는 [축소 조직 예제](plugins/oh-my-teams/examples/organization.single-subscription.json)에서 확인한다.

`opus-first`는 Agy 역할을 Opus로 시작하는 평가 기준선이고, `balanced`는 Senior=Opus, Junior=Sonnet으로 나눈다. [6유형 실측](experiments/ROUTING_REPORT.md)에서는 balanced(당시에는 Intern=GPT-OSS를 포함한 구성)가 6/6을 통과하며 Opus-first보다 토큰 9.7%, 모델 시간 16.0%를 줄여 잠정 권고가 됐다. 1회 배치이므로 기존 조직에는 자동 적용하지 않으며 `preset` 명령은 변경되는 역할만 먼저 보여준다. 같은 공유 풀의 소진이 구조적으로 확인되면 그 풀의 다른 모델을 연쇄 호출하지 않는다. 구독의 실제 할당량 차감·가격은 토큰 수와 구분한다.

### 실행기 어댑터와 로컬 Ollama

실행기별 동작은 `plugins/oh-my-teams/scripts/providers/`의 어댑터 모듈 한 개에 모여 있다. 어댑터는 자신이 지원하는 전송 방식, 허용하는 추론 강도, 요청 구성, 출력 해석, 실패 분류를 스스로 선언하고, 레지스트리가 이를 모아 공개한다. 런타임이 인정하는 실행기 목록과 강도 표는 모두 이 레지스트리에서 파생되므로, 실행기를 추가하는 작업은 어댑터 파일 하나와 레지스트리 한 줄, 그리고 스키마의 열거값 추가로 끝난다. 라우팅·증거·사용량 보고는 실행기 이름을 보지 않는다.

프로필은 전송 방식을 정확히 하나만 선언한다. `command`를 적으면 자식 프로세스로 CLI를 실행하고, `endpoint`를 적으면 HTTP API를 호출한다. 둘을 함께 적거나 하나도 적지 않으면 저장을 거부한다. Claude·Codex·Agy는 프로세스 전송만 지원하고, Ollama는 두 방식을 모두 지원한다.

Ollama 프로필에는 다음 제약이 적용된다.

| 항목 | 규칙 | 이유 |
|---|---|---|
| `model` | 필수 | 호스트 기본 모델이라는 개념이 없어서 생략하면 어떤 모델이 답했는지 증명할 수 없다. |
| `contextTokens` | 필수(2048 이상) | Ollama는 컨텍스트 창을 넘는 프롬프트를 오류 없이 잘라낸다. 이 값을 `num_ctx`로 전달하고, 응답의 `prompt_eval_count`가 창에 도달하면 절단으로 판정해 실패시킨다. |
| `pool` | 금지 | 로컬 추론은 공유 할당량을 쓰지 않는다. 서버가 응답하지 않는 상황은 풀 소진이 아니라 `provider-unavailable`로 분류되어 다음 프로필로 넘어간다. |
| 비용 | 항상 `0` | API 지출이 실제로 없다. `null`로 두면 로컬 프로필이 한 번이라도 참여한 실행의 총비용이 영구히 미상으로 남는다. |

HTTP 전송을 권장한다. 토큰 수와 실제 응답 모델을 함께 받으므로 사용량과 모델 확인 증거가 남고, `format`으로 JSON 응답을 서버 측에서 강제할 수 있으며, thinking 모델의 추론 흔적이 답변과 분리되어 도착한다. CLI 전송은 이 세 가지를 제공하지 못하므로 절단 여부를 사후에 확인할 수 없다.

Ollama는 저장소 파일을 직접 열지 못한다. 작업 계약의 `contextRefs`는 내용이 프롬프트에 포함되지만 `contractRefs`는 경로와 해시만 전달되므로, 그 내용을 읽어야 하는 작업은 Ollama 프로필에 배정하지 않는다. 또한 로컬 서버는 요청을 사실상 직렬로 처리하므로 해당 역할의 `concurrency`는 1로 두는 편이 낫다. [로컬 우선 조직 예제](plugins/oh-my-teams/examples/organization.local-ollama.json)가 두 전송 방식과 클라우드 fallback을 함께 보여준다.

## 실행과 검증

역할별 사용량은 `usage-report`가 각 CLI가 이미 남긴 세션 기록에서 읽는다. 역할을 띄우는 `role-terminal`, `worker-start`, `headless-start`가 `<project>/.omt/usage/launches.jsonl`에 어느 역할을 어디서 띄웠는지 적고, 보고서는 그 기록으로 세션을 역할에 연결한다. 메시지 본문은 읽지 않는다. Agy 대화형 세션은 토큰 사용량이 기록되지 않아 `unmeasured`로 표시되므로, 사용량이 중요한 kickoff에서는 Agy 역할을 `headless-start`로 실행한다. 자세한 기준은 [`orca-runtime.md`](plugins/oh-my-teams/references/orca-runtime.md)의 「사용량 측정」 절에 있다.

```text
node plugins/oh-my-teams/scripts/teams-org.mjs --help
node plugins/oh-my-teams/scripts/teams-org.mjs validate --org plugins/oh-my-teams/examples/organization.json
node plugins/oh-my-teams/scripts/teams-org.mjs show --org plugins/oh-my-teams/examples/organization.json
node plugins/oh-my-teams/scripts/teams-org.mjs assist --org .omt/organization.json --task <task.json> --repo <worktree> --state .omt --role junior --kind research
node plugins/oh-my-teams/scripts/teams-org.mjs advise --org .omt/organization.json --brief <brief.json> --repo <worktree> --state .omt --role pm --kind plan
node plugins/oh-my-teams/scripts/teams-org.mjs preset --org <project>/.omt/organization.json --name balanced --revision <revision>
node plugins/oh-my-teams/scripts/teams-org.mjs gate-check --task <task-v2.json> --report <report.json> --repo <worktree> --state <pm-state>
node plugins/oh-my-teams/scripts/teams-org.mjs workflow-status --id <workflow-id> --state <pm-state>
node plugins/oh-my-teams/scripts/teams-org.mjs incident-status --state <pm-state>
node plugins/oh-my-teams/scripts/teams-org.mjs usage-report --org <project>/.omt/organization.json --worktree <pm-worktree-id>
node --test tests/runtime.test.mjs
npm run eval:organization
node experiments/run-routing.mjs --mode e1 --max-calls 18 --dry-run
npm ci
npm run sync
npm run lint
```

버전과 감사 수치처럼 여러 파일이 되풀이하는 값은 `scripts/metadata.mjs`가 정본에서 파생한다. 파일마다 직접 고치지 않고 정본만 바꾼 뒤 `npm run sync`를 실행하며, `npm run sync:check`는 고치지 않고 어긋난 곳만 보고한다. 정본과 따라가는 파일의 대응은 [AGENTS.md](AGENTS.md)에 표로 정리했다.

제한된 편집은 기존 [task v1 예제](plugins/oh-my-teams/examples/task.json) 또는 목표·수용 기준·검토 요구를 고정하는 [task v2 예제](plugins/oh-my-teams/examples/task.v2.json)를 채워 `prepare` → `work`로 수행한다. `prepare`가 반환한 worktree·조직 스냅샷·작업 파일·공유 state를 그대로 전달한다. 여러 워커는 같은 PM state를 써야 동시 인원 제한이 적용된다. 복잡한 작업의 감독 실행은 PL 스킬을 따른다.

감독 worker는 `worker-start --org <organization.json> --role <역할>`로만 시작한다. Claude·Codex·Agy 역할은 모두 `role-terminal`로 프로필의 모델·강도와 권한 우회 플래그를 담은 명령의 터미널을 먼저 열고, 그 터미널을 `--terminal`로 넘긴다. `worker-start --agent`는 인자를 더할 수 없어 권한 우회 플래그를 Orca 설정에 맡겨야 하므로, 래퍼는 `--terminal` 없는 시작과 손으로 적은 `--agent`·`--model`·`--effort`를 거부한다. 결과의 `binding.modelProof`는 화면에서 모델을 확인해야 한다는 뜻의 `unproven`이나, 모델을 요청하지 않은 `unrequested`다. kickoff 안에서는 `--workflow-id`와 `--state`를 함께 넘겨 workflow에 고정된 조직 스냅샷과 실행 깊이의 역할로 시작한다. Windows에서 모델이 `gemini`로 시작하는 Agy 역할은 Orca가 그 터미널의 대기를 보고하지 않으므로 `headless-start`로 실행하고, Ollama 역할은 `work` 하네스로 실행한다. 작업 지시문 앞에는 받는 역할 스킬의 `권한·책임·한계` 절이 붙으므로, 각 역할은 자신이 쓸 수 있는 명령과 보고 대상, 하지 말아야 할 일을 지시문에서 바로 읽는다. PM은 `role-command`가 만든 명령으로 띄우고, 무응답 worker는 `supervision-next`의 판정에 따라 진행 요청과 상향 보고로 처리한다. 자세한 절차는 [Orca 런타임 참조](plugins/oh-my-teams/references/orca-runtime.md)에 있다.

`assist`는 조직의 `assistants.<role>` 허용 목록에서 GPT-OSS-120B 프로필을 선택한다. `research`와 `checklist`는 파일을 수정하지 않고 검증된 인용과 감사 기록을 남긴다. `edit`는 호출자의 기본 모델을 바꾸지 않은 채 GPT-OSS를 한 번 호출하고, 기존 `work`와 동일한 파일 해시·허용 범위·검사·보고 관문을 적용한다. 비서 결과의 판단과 통합 책임은 호출한 역할에 남는다.

`advise`는 방향이 반대인 호출이다. 조직의 `advisors.<role>` 허용 목록에 있는 비싼 모델에게 결정할 질문 하나와 12000바이트 이하의 요약, 최대 8개의 파일만 보내고 `proceed`·`revise`·`stop`·`escalate` 중 하나의 권고를 받는다. 대화 전문을 보내지 않으므로 프론티어 모델을 긴 감독 세션에 두지 않고 결정 관문에서만 쓸 수 있다. 호출은 kickoff 상태 하나당 `policy.adviceBudget`(기본값 6)회로 제한되고, 실패한 호출도 한 번으로 센다. 권고는 승인이 아니며 결정은 호출한 역할이 내린다. 계약은 [자문 호출 참조](plugins/oh-my-teams/references/advise.md)에 있다.

- 파일과 직전 실패만 모델에 전달하고, JSON 편집을 경로·원본 해시 대조 후 하네스가 적용한다.
- 검사 명령은 argv 배열이다. 호출과 재시도에 한도가 있고 실패를 통과로 바꾸지 않는다. 실패 편집은 보존한다.
- `.omt/runs/`에 조직 스냅샷·보고·사용량, `.omt/evidence/`에 검사 증거를 저장한다. `.omt/`는 Git에서 제외한다.
- `aggregate`는 누락·중복·실패를 확인하고 짧은 결과를 만든다. 모델 호출은 없다. `ready-for-verification`은 머지 승인이 아니다.
- task v2는 검사 통과 후 `submitted`가 되며, 다른 실행 ID의 필수 `review-record`와 PM의 `accept`가 같은 task/source에 고정되어야 최종 수용된다.
- workflow는 dependency revision, 역할별 동시 실행, review 대기, 전체 attempt/call 예산을 고정한다. 실행 receipt와 event를 append-only로 보존하며 상태가 불명확한 running attempt는 재배정하지 않는다.
- 실패는 requirement/scope/implementation/environment/contract/review/quota/process-unknown으로 분류해 담당자에게 돌리고, 재작업은 이전 attempt와 전체 예산을 보존한다. 해결 경험은 검증 전까지 lesson 후보일 뿐 skill을 자동 수정하지 않는다.
- 이슈·알림 입력은 기본 kill switch, dedupe key, 제안 한도, 관찰 기간과 무진전 중단을 적용한다. 생성 범위는 진단·수정 제안이며 배포 권한은 포함하지 않는다.
- `verify`는 HEAD·base·파일 내용·검사 argv·환경 지문·원본 로그가 모두 일치하는 성공만 재사용한다. 실패·소스 변경은 재검증한다. 외부 DB·도구 변화는 environment 지문에 반영해야 한다.
- 최종 통합 후 `merge-check`, 실제 PR HEAD·최신 remote base 대조, 프로젝트 필수 CI와 필요한 Senior 검토를 거친다. 해시는 무결성 검사이며 로컬 보고 작성자의 서명 인증은 아니다.
- 하네스는 push·PR·머지·배포를 자동 수행하지 않는다. PM/PL이 사용자 요청 범위에 따라 처리한다. 감독된 워커의 회수는 Orca accepted settlement와 실제 프로세스 종료 근거를 따른다.

테스트는 조직 저장·변경, 순환, 계정 연결, 편집 범위, 검증 캐시, 보고 누락, 승격·할당량·동시 실행을 확인한다. `experiments/`의 실험은 실제 Orca worktree와 구독을 사용하므로 명시적으로 실행한다.

활성 코드의 JSDoc·모듈 설명·장문 실행문 기준과 전수조사 결과는 [코드 품질 문서](docs/CODE_QUALITY.md)에 정리했다.

세 구현 계획의 완료 범위, 검증 근거와 의도적으로 남긴 후속 운영 검증은 [계획 완료 상태](docs/PLAN_STATUS.md)에 정리했다. 계획 문서의 초기 기준선과 미래형 문장은 당시 설계를 설명하며, 현재 지원 여부는 구현 기록과 계획 완료 상태를 우선한다.

확대 모델 실험은 `--dry-run`으로 6개 fixture와 호출 수를 먼저 확인한다. 실제 실행은 `--confirm-subscription-use`가 있어야 하며 E1은 18회, `opus-first`와 `balanced`는 각각 6회의 초기 호출을 사용한다. 실행 중 manifest를 계속 저장하고, 결과는 `summarize-routing.mjs`, 정확한 worktree 정리는 `finish-routing.mjs --confirm-close`로 처리한다.

## 라이선스

이 저장소는 [MIT 라이선스](LICENSE)로 배포한다. 출처 표시를 유지하면 사용, 수정, 재배포, 상업적 이용을 모두 허용한다.
