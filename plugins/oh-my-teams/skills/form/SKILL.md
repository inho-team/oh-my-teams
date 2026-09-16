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

모델 선택지는 역할의 성격에 따라 네 개씩 제시하고, 목록에 없는 모델은 자유 입력으로 받는다. 각 선택지는 괄호 안의 `provider:model` 값으로 저장된다.

| 역할 | 선택지 |
|---|---|
| PM·PL·Senior | Claude Code 기본(`claude:default`), Opus 4.6·Agy(`agy:claude-opus-4-6-thinking`), Gemini 3.1 Pro·Agy(`agy:gemini-3.1-pro-high`), Codex 기본(`codex:default`) |
| Junior | Sonnet 4.6·Agy(`agy:claude-sonnet-4-6`), Gemini 3.8 Flash·Agy(`agy:gemini-3.8-flash-high`), Opus 4.6·Agy(`agy:claude-opus-4-6-thinking`), Codex 기본(`codex:default`) |
| Intern | GPT-OSS 120B·Agy(`agy:gpt-oss-120b-medium`), Gemini 3.8 Flash·Agy(`agy:gemini-3.8-flash-high`), Sonnet 4.6·Agy(`agy:claude-sonnet-4-6`), Codex 기본(`codex:default`) |

이 배열은 제안의 순서일 뿐 고정된 모델 능력 서열이나 구독 가격을 가정하지 않으며, 어떤 선택지도 사용자 답을 대신하지 않는다. 묻기 전에 `claude`, `codex`, `agy`가 설치되어 있는지와 `agy models`에 해당 ID가 있는지 확인하고, 확인되지 않은 선택지는 빼고 제시한다. 이 배포에서 확인한 Agy 선택지는 Gemini Flash 3.8·3.7·3.6(각 high/medium/low), Gemini Pro 3.1(high/low), Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS-120B이고, Codex 카탈로그에서 확인한 선택지는 `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`다. Codex의 개별 모델은 능력 서열을 가정하지 않기 위해 선택지에 넣지 않고 자유 입력으로 받는다.

Gemini 모델 ID는 추론 강도를 이름에 담고 있어서 강도를 비워 둘 수 없다. 결성 단계에서는 Pro 3.1과 Flash 3.8이 공통으로 제공하는 `-high`를 사용하고, 다른 강도는 `adjust`에서 바꾼다. 자유 입력으로 받은 모델은 `provider:model` 형식으로 옮겨 적고, 초안 명령이 거부하면 그 역할만 다시 묻는다.

## 묻지 않고 정하는 것

아래 값은 사용자가 고른 모델보다 더 많은 호출, 계정이나 권한을 쓰지 않는 쪽으로 고정되어 있으며, `scripts/org-draft.mjs`가 기록한다. 모두 `adjust`에서 바꿀 수 있다.

- 팀 이름은 프로젝트 디렉터리 이름을 쓴다.
- 각 역할의 상위 역할은 서열상 바로 위 역할이고, 모든 프로필은 각 실행기의 현재 로그인 계정(`account: current`)을 쓴다. 같은 실행기의 프로필은 하나의 `pool`로 묶어, 소진이 확인된 계정을 런타임이 건너뛸 수 있게 한다.
- 역할별 동시 인원과 시도 횟수는 1이고, 대체 프로필은 두지 않으며, 할당량이 소진되면 중단하고, 전체 호출 한도는 3이다.
- 추론 강도(`effort`)는 기록하지 않아 각 CLI의 기본값을 쓴다. 생략했을 때의 실제 강도는 CLI와 계정 설정이 정하므로 특정 값으로 단정해 알리지 않는다.
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

결성을 보고할 때에는 역할별로 배정된 모델과 함께, 위 목록에서 묻지 않고 정한 값을 짧게 알리고 `adjust`에서 바꿀 수 있다고 덧붙인다. 저장된 파일의 전체 구조는 [`../../examples/organization.json`](../../examples/organization.json)에서 확인할 수 있다.

`.omt/`는 Git에서 제외한다. 별도 저장소 작업에는 `orca-cli`를 읽어 Orca worktree를 사용한다. 조직 파일을 둔 이 프로젝트의 `.omt/`가 이후 kickoff 등록부가 놓이는 자리가 된다. 한 프로젝트에서 kickoff를 여러 개 동시에 진행할 수 있으며, form 자체는 kickoff를 등록하지 않는다. 자세한 계약은 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)에 있다.
