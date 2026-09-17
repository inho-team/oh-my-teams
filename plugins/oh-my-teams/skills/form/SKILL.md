---
name: form
description: 최초 oh my teams 상설 조직을 다섯 역할의 모델만 물어 구성하고, 나머지는 비용이 늘지 않는 기본값으로 저장한다. 특정 개발 과제의 시작은 kickoff를 사용한다.
---

# 팀 결성

조직 결성은 특정 과제의 Goal이나 실행 팀을 만들지 않는다. 조직이 이미 있으면 저장된 구성을 보여 주며 다시 만들거나 구독 선택을 반복하지 않는다. 조직을 결성한 뒤 사용자가 개발 과제의 시작까지 요청했으면 `kickoff`로 이어 간다.

대상 프로젝트 `.omt/organization.json`을 먼저 확인한다. 있으면 `status`로 표시하고 저장된 구독을 그대로 사용한다. 다시 질문하거나 예제 설정으로 덮어쓰지 않는다.

## 묻는 것

조직이 없으면 **다섯 역할(PM·PL·Senior·Junior·Intern)이 각각 어떤 모델을 쓸지만** 묻는다. 몇 단계로 운영할지는 묻지 않는다. 조직은 항상 다섯 역할을 모두 두고, 실제로 몇 개의 역할을 쓸지는 kickoff마다 PM이 과제의 난이도를 보고 실행 깊이로 정하기 때문이다. 깊이의 기준과 변경 규칙은 [pm](../pm/SKILL.md)의 「실행 깊이」를 따른다.

묻는 방식은 [`../../references/user-choice.md`](../../references/user-choice.md)를 따르며, 질문은 두 번으로 끝난다. 구조화된 선택 도구는 한 번에 질문 네 개까지 담을 수 있으므로 첫 번째에 PM·PL·Senior·Junior의 모델을, 두 번째에 Intern의 모델을 묻는다. 번호를 매긴 선택지로 묻는 호스트에서는 다섯 개를 한 번에 제시한다.

구독이 부족해 특정 역할을 아예 둘 수 없는 조직은 결성 후 `adjust`에서 그 역할을 뺀다. 뺀 역할이 맡던 일은 서열을 따라 위로 올라가 남은 가장 가까운 역할이 이어받으며, 구조는 [`../../examples/organization.single-subscription.json`](../../examples/organization.single-subscription.json)에서 확인한다. 역할 이름은 바꿀 수 없다. 실패 라우팅, 검토 요구사항과 스킬이 이 이름으로 역할을 지목하기 때문이다.

모델 선택지는 역할의 성격에 따라 제시하고, 목록에 없는 모델은 자유 입력으로 받는다. 각 선택지는 괄호 안의 `provider:model` 값으로 저장된다.

| 역할 | 선택지 (표시 이름 → 저장 값) |
|---|---|
| PM | Claude Fable → `claude:fable`, Claude Opus → `claude:opus`, Codex Astra → `codex:gpt-6-astra`, Agy Gemini Pro → `agy:gemini-3.1-pro-high` |
| PL | Claude Opus → `claude:opus`, Codex Sol → `codex:gpt-5.6-sol`, Agy Gemini Pro → `agy:gemini-3.1-pro-high`, Claude Sonnet → `claude:sonnet`, Codex Terra → `codex:gpt-5.6-terra` |
| Senior | Claude Sonnet → `claude:sonnet`, Codex Terra → `codex:gpt-5.6-terra`, Agy Gemini Pro → `agy:gemini-3.1-pro-high`, Agy Claude Opus → `agy:claude-opus-4-6-thinking` |
| Junior | Claude Haiku → `claude:haiku`, Codex Luna → `codex:gpt-5.6-luna`, Agy Flash → `agy:gemini-3.8-flash-medium`, Agy Claude Sonnet → `agy:claude-sonnet-4-6` |
| Intern | Claude Haiku → `claude:haiku`, Codex Luna → `codex:gpt-5.6-luna`, Agy GPT-OSS-120B → `agy:gpt-oss-120b-medium` |

이 배열은 제안의 순서일 뿐 고정된 모델 능력 서열이나 구독 가격을 가정하지 않으며, 어떤 선택지도 사용자 답을 대신하지 않는다. 자유 입력으로 `provider:model` 형식의 값을 언제든 받는다.

PL은 선택지가 다섯 개다. 구조화된 선택 도구(예: Claude Code `AskUserQuestion`, 질문당 선택지 최대 4개)를 쓰는 호스트에서는 앞의 네 개(Claude Opus·Codex Sol·Agy Gemini Pro·Claude Sonnet)를 선택지로 두고, Codex Terra는 질문 본문에 "자유 입력으로 `codex:gpt-5.6-terra`"처럼 안내한다. 번호를 매긴 선택지로 묻는 호스트에서는 다섯 개를 모두 제시한다. "질문은 두 번으로 끝난다"는 규칙은 유지한다.

묻기 전에 `claude`, `codex`, `agy`가 설치되어 있는지 확인하고, 확인되지 않은 선택지는 빼고 제시한다. 공급자별 확인 방법은 다음과 같다.

- **Agy**: `agy models` 출력에 해당 ID가 있는지 확인한다. 이 배포에서 확인한 ID는 `gemini-3.1-pro-high`, `gemini-3.8-flash-medium`, `claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`이다.
- **Codex**: `host-defaults` 출력의 `codex.listed`에 해당 ID가 있는지 확인한다. 카탈로그는 계정과 CLI 버전에 따라 달라지므로 ID 목록은 이 문서에 적어 두지 않는다.
- **Claude 별칭**: 설치된 `claude --help`의 `--model` 설명에서 예시로 드는 별칭(예: `fable`, `opus`, `sonnet`)으로 확인한다. `--model` 설명에 예시로 없는 별칭(예: `haiku`)은 `claude -p --model <별칭> --output-format json`으로 짧은 요청을 한 번 보내 응답의 `modelUsage`에 실제 모델이 기록되는지 확인한다. 어느 방법으로도 확인하지 못한 별칭은 선택지에서 뺀다.

### 호스트 기본값과 자유 입력 안내

자유 입력으로 `provider:default`를 받으면 모델을 `null`로 저장하므로, 실제로 어떤 모델이 실행되는지는 호스트 기본값을 확인해야 알 수 있다. 자유 입력에서 `default`를 받았거나 Codex 모델 목록을 질문 본문에 안내할 때는 첫 질문을 만들기 전에 다음을 실행한다. `<runtime>`은 아래 「저장」 절과 같이 해석한다.

```text
node <runtime> host-defaults --project <project>
```

- Codex는 `$CODEX_HOME/config.toml`(기본 `~/.codex/config.toml`)의 최상위 `model`을 쓰고, 없으면 `codex debug models`에서 `visibility`가 `list`인 항목 가운데 `priority`가 가장 작은 모델을 쓴다. 출력의 `codex.model`과 `codex.source`가 이 결과이고, `codex.listed`는 지금 선택할 수 있는 Codex 모델 ID 목록이다. Orca처럼 실행기가 자기 `CODEX_HOME`으로 Codex를 띄우는 환경이면 그 경로를 `--codex-home`으로 넘기고, 경로를 확인하지 못했으면 출력의 `codex.configFile`이 실제 실행과 다를 수 있다고 함께 적는다.
- Claude는 `ANTHROPIC_MODEL`, 프로젝트와 사용자 settings의 `model` 순서로 확인한다. `claude.model`이 `null`이면 Claude Code가 정하는 모델이며, 특정 모델이라고 단정하지 않는다.

자유 입력으로 `codex:default`를 받으면 현재 해석값을 확인해 결과를 알린다. 예를 들어 "지금은 gpt-6-astra가 실행됩니다. 계정 기본값이 바뀌면 함께 바뀝니다."처럼 저장값과 현재 해석값을 구분하고, `codex debug models`가 실패했으면 확인하지 못했다고 적고 모델명을 추측하지 않는다.

표의 Codex 선택지는 `codex.listed`에 해당 ID가 있을 때만 제시한다. 표에 없는 Codex 모델을 쓰려면 질문 본문에 `codex.listed`의 ID를 나열하고, 그 가운데 하나를 쓰려면 자유 입력으로 `codex:<id>`를 적으면 된다고 안내한다. 이 안내는 질문 본문에 넣으므로 질문 수와 선택지 수는 늘지 않고, 목록은 카탈로그 순서 그대로 적어 서열을 매기지 않는다.

Gemini는 다른 모델과 달리 강도를 비워 둘 수 없다. Agy에는 강도 없는 Gemini ID가 없고, 강도를 빼고 `--model gemini-3.8-flash`로 부르면 1.2.4가 "requires --effort (available: low, medium, high)"라며 호출 전에 거부하므로, 따로 조정하지 않았을 때 쓰일 기본 강도가 없다. 그래서 결성 단계에서는 Flash 3.8을 `medium`으로, `medium`이 없는 Pro 3.1을 `high`로 정한다. 사용자가 고르지 않은 강도이므로 결성 보고에 반드시 적고, 다른 강도는 `adjust`에서 바꾼다. 자유 입력으로 받은 모델은 `provider:model` 형식으로 옮겨 적고, 초안 명령이 거부하면 그 역할만 다시 묻는다.

## 묻지 않고 정하는 것

아래 값은 사용자가 고른 모델보다 더 많은 호출, 계정이나 권한을 쓰지 않는 쪽으로 고정되어 있으며, `scripts/org-draft.mjs`가 기록한다. 모두 `adjust`에서 바꿀 수 있다.

- 팀 이름은 프로젝트 디렉터리 이름을 쓴다.
- 각 역할의 상위 역할은 서열상 바로 위 역할이고, 모든 프로필은 각 실행기의 현재 로그인 계정(`account: current`)을 쓴다. 같은 실행기의 프로필은 하나의 `pool`로 묶어, 소진이 확인된 계정을 런타임이 건너뛸 수 있게 한다.
- 역할별 동시 인원과 시도 횟수는 1이고, 대체 프로필은 두지 않으며, 할당량이 소진되면 중단하고, 호출 한도(`policy.maxCalls`)는 3이다. 이 한도는 `work` 한 번과 workflow attempt 하나가 쓰는 provider 호출 수의 상한이며, 대화형 역할 터미널의 턴은 세지 않는다.
- 추론 강도(`effort`)는 기록하지 않아 각 CLI의 기본값을 쓴다. 생략했을 때의 실제 강도는 CLI와 계정 설정이 정하므로 특정 값으로 단정해 알리지 않는다.
- 감독 역할은 `worker_done`을 보내지 않은 worker가 15분(`policy.supervision.progressCheckMs: 900000`) 동안 활동이 없으면 진행 상황을 묻고, 답이 없는 요청이 2회(`unansweredLimit: 2`)에 이르면 상위에 보고한다. 이 정책은 메시지 한 통 외에 호출을 쓰지 않으며, 재시도나 종료를 스스로 하지 않는다.
- GPT-OSS 보조 도구 호출을 허용할지는 묻지 않고 `assistants`를 비워 둔다. 이 상태에서는 모든 역할의 `assist` 호출이 거부되므로, 필요해지면 `adjust`에서 역할별로 허용한다.

로컬 Ollama 모델은 결성 단계에서 받지 않는다. 컨텍스트 창을 `ollama show`로 확인해 기록해야 하는데, 추측한 값으로 저장하면 잘린 프롬프트에 대한 답이 정상 응답처럼 보이기 때문이다. 결성 후 `adjust`에서 추가한다.

## 저장

현재 SKILL.md 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석해 다음을 실행한다. 초안 파일은 새 경로에 쓰며, 이미 있는 파일에는 쓰지 않는다. 예제 조직 자체를 사용자 조직으로 자동 설치하지 않는다.

```text
node <runtime> org-draft --name <project-dir-name> --models <pm>,<pl>,<senior>,<junior>,<intern> --output <draft.json>
node <runtime> init --org <project>/.omt/organization.json --from <draft.json>
node <runtime> show --org <project>/.omt/organization.json
```

`init`은 조직 파일이 이미 있으면 아무것도 바꾸지 않고 `created: false`로 정상 종료한다. 출력의 `created`가 `true`인 경우에만 신규 결성으로 보고하고, `false`이면 기존 조직을 그대로 쓴다고 알린다. 인증 준비가 끝나지 않은 프로필은 실행 전에 정확한 오류를 알리고 멈춘다. 질문을 처음부터 다시 시작하지 않는다.

결성을 보고할 때에는 역할별로 배정된 모델을 적는다. 자유 입력으로 `provider:default`를 받아 모델이 `null`인 프로필이 있으면 `host-defaults`를 다시 실행해 얻은 현재 해석값을 함께 적는다. 예를 들어 "PL: Codex 기본(지금은 gpt-6-astra, 계정 기본값을 따름)"처럼 저장값과 현재 해석값을 구분하고, Claude의 해석값이 `null`이면 확인하지 못했다고 적는다. Gemini를 고른 역할이 있으면 "Junior: Gemini 3.8 Flash, 강도 medium(Gemini는 강도가 필수라 결성 때 정함)"처럼 정한 강도를 함께 적는다. 이어서 위 목록에서 묻지 않고 정한 값을 짧게 알리고 `adjust`에서 바꿀 수 있다고 덧붙인다. 저장된 파일의 전체 구조는 [`../../examples/organization.json`](../../examples/organization.json)에서 확인할 수 있다.

`.omt/`는 Git에서 제외한다. 별도 저장소 작업에는 `orca-cli`를 읽어 Orca worktree를 사용한다. 조직 파일을 둔 이 프로젝트의 `.omt/`가 이후 kickoff 등록부가 놓이는 자리가 된다. 한 프로젝트에서 kickoff를 여러 개 동시에 진행할 수 있으며, form 자체는 kickoff를 등록하지 않는다. 자세한 계약은 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)에 있다.
