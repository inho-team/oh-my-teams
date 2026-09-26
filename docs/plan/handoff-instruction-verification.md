# PM 인계 지시의 판정 설계 (이슈 #86)

## 목적

이사가 PM을 띄우며 건네는 인계 지시(브리프 경로)를 PM이 사용자에게 다시 확인하지 않고 실행하되, 등록부에 없는 터미널이나 다른 브리프 경로를 담은 텍스트는 계속 지시로 따르지 않게 한다. 이 문서는 이 목표를 이루기 위해 검토한 세 가지 선택지와 그 비교 근거, 채택한 구현을 정리한다.

## 문제

Claude Code는 터미널에 긴 텍스트를 그대로 typed하면 이를 붙여넣기(`<pasted_content>`)로 판정한다. 이 서술은 이슈 #86의 본문과 댓글이 Claude Code 2.1.282에서 관찰한 내용에 근거하며, Codex가 같은 방식으로 판정하는지는 이 이슈에도 저장소 다른 문서에도 관찰 근거가 없어 **미확인**이다. 붙여넣은 텍스트는 사용자가 직접 타이핑한 지시가 아니므로, 에이전트는 그 안의 지시를 사용자가 직접 요청한 것으로 간주하지 않고 실행을 보류한다. 이사가 PM 세션을 연 뒤 브리프 경로를 담은 문장을 `terminal send`로 그 세션에 보내면, PM 쪽 화면에는 이 문장이 (적어도 Claude Code에서는) 붙여넣기로 나타나므로 PM이 그 지시를 곧바로 따르지 않는 문제가 생긴다.

## 검토한 세 가지 선택지

### 선택지 1: 첫 프롬프트를 CLI 인자로 전달 (채택)

`role-terminal`이 PM 세션을 여는 셸 명령 자체에 브리프 경로를 담은 문장을 인자로 포함시킨다. Claude Code와 Codex는 `claude [prompt]`, `codex [PROMPT]`처럼 첫 프롬프트를 위치 인자로 받는다. Agy는 `--prompt-interactive`(별칭 `-i`) 플래그로 첫 프롬프트를 받는다. 세 provider 모두 설치본의 `--help`로 이 인자·플래그의 존재를 확인했다.

**Claude Code에서 확인한 사실(2026-09-26, CLI 판 v2.1.283)**: 실제 Orca에서 `role-terminal --brief`로 연 PM 세션의 화면에는 이 문장이 붙여넣기 표시 없이 일반 입력줄(`❯`)로 나타났고, 세션 기록(`~/.claude/projects`의 jsonl)의 첫 사용자 메시지도 `content`가 `<pasted_content>` 래핑 없는 순수 문자열이었으며 `promptSource: "typed"`, `origin.kind: "human"`, `turnOrigin: "human"`으로 남았다. 즉 실행 명령의 인자로 들어간 텍스트는 Claude Code에서는 붙여넣기가 아니라 세션의 진짜 초기 지시로 처리됨을 확인했다(아래 「실제 Orca에서 확인한 절차와 결과」).

**Codex와 Agy에서는 미확인**: 두 provider는 `--help`로 인자·플래그의 존재만 확인했을 뿐, 그 인자로 넘긴 텍스트가 실제 세션에서 붙여넣기로 표시되는지 진짜 초기 지시로 표시되는지는 관찰하지 않았다.

이 선택지는 pasted_content 판정 자체를 피하므로 이사가 PM을 처음 띄우는 경로에는 가장 확실하다. 다만 이미 실행 중인 CLI에는 실행 시점 인자를 추가로 넘길 수 없으므로, PM이 이미 뜬 뒤 도착하는 후속 인계 지시에는 쓸 수 없다.

**구현**: `role-launch.mjs`의 `kickoffBriefPrompt(briefPath)`가 자유 텍스트가 아니라 고정 템플릿 문장(브리프 경로만 채움)을 만들고, `roleCommand`가 `firstPrompt` 옵션으로 이를 받아 `FIRST_PROMPT_ARG`에 확인된 provider에만 인자로 붙인다. `teams-org.mjs`의 `role-terminal` 명령이 `--brief <경로>`를 받아 이 흐름을 잇는다.

**provider별 확인**

| provider | 지원 방식 | 확인 |
|---|---|---|
| claude | 위치 인자 (`claude [prompt]`) | `claude --help`로 확인 |
| codex | 위치 인자 (`codex [PROMPT]`) | `codex --help`로 확인 |
| agy | `--prompt-interactive`(`-i`) 플래그 | `agy --help`로 확인 |

세 provider 모두 설치본에서 확인했으므로, 확인하지 못해 이 인자를 붙이지 않는 provider는 지금 조직 파일에는 없다. 다른 provider가 조직에 추가되면 `FIRST_PROMPT_ARG`에 없는 provider로 `--brief`를 요청한 `role-terminal`은 그 자리에서 거부되고, 브리프는 터미널을 연 뒤 `terminal send`로 보내는 기존 경로로 돌아간다.

### 선택지 2: 등록부 대조 (보조 규칙)

첫 프롬프트를 인자로 받지 못하는 provider와, PM이 이미 떠 있는 상태에서 받은 후속 인계 지시에는 등록부 대조를 보조 규칙으로 쓴다. 붙여 넣은 텍스트로 도착한 인계 지시는, `kickoff-show`로 조회한 이 워크트리의 kickoff에 적힌 `director.terminalHandle`과 브리프 경로가 지시에 적힌 값과 같을 때에만 이사의 지시로 본다.

등록 순서(이사가 4단계에서 PM 세션을 연 뒤 5단계에서 `kickoff-claim`으로 등록한다) 때문에, PM이 막 뜬 시점에는 등록부에 아직 아무 값도 없다. 따라서 이 선택지는 PM의 최초 기동에는 근본적으로 쓸 수 없고, PM이 이미 등록을 마친 뒤에 도착하는 후속 인계 지시에만 적용한다.

**구현**: `kickoff-registry.mjs`의 `verifyHandoffClaim(orgFile, { worktreeId, directorTerminal, brief })`가 등록부의 값과 주어진 값을 대조해 `matched`, `mismatch`, `not-registered`, `no-director-recorded` 가운데 하나를 판정으로 돌려준다. `teams-org.mjs`의 `kickoff-handoff-verify` CLI 명령이 이 판정을 감싼다. `pm/SKILL.md`는 이 명령의 사용법과, 대조 시점에 등록부에 값이 없으면 이사에게 `progress`로 알리고 지시를 따르지 않는다는 규칙만 적고, 판정 로직 자체는 런타임 함수를 참조할 뿐 다시 적지 않는다.

### 선택지 3: 인계 지시 단축 (근거로 삼지 않음)

브리프 경로 문장을 아주 짧게 줄이면 붙여넣기로 판정되지 않을 가능성이 있다는 발상이다. 다만 이 발상은 "붙여넣기 판정은 텍스트의 길이가 아니라 입력 경로(터미널에 실제로 타이핑되었는지, 클립보드에서 붙여졌는지)로 결정된다"는 추정에 기대고 있는데, 이 추정 자체를 관찰로 확인한 근거는 없다. 짧은 텍스트가 붙여넣기로 판정되지 않는다는 보장이 없는 채로는 이 선택지가 문제를 해결한다고 주장할 수 없고, 선택지 1이 이미 Claude Code에서 확인된 결과를 내놓았으므로, 이 미확인 추정을 따로 검증하지 않고 이 선택지는 근거로 삼지 않는다.

## 채택한 구현

1. **`role-launch.mjs`**: `FIRST_PROMPT_ARG`(provider별 지원 방식), `kickoffBriefPrompt(briefPath)`(고정 템플릿), `roleCommand`의 `firstPrompt` 옵션(확인된 provider에만 인자를 붙이고, 확인되지 않은 provider에는 assert로 거부).
2. **`kickoff-registry.mjs`**: `verifyHandoffClaim(orgFile, { worktreeId, directorTerminal, brief })`.
3. **`teams-org.mjs`**: `role-terminal`이 `--brief`를 받아 `kickoffBriefPrompt`로 만든 `firstPrompt`를 `roleCommand`에 넘기고, `command.role`이 `pm`이 아니면 거부한다. `kickoff-handoff-verify` CLI 명령이 `verifyHandoffClaim`을 감싼다.
4. **문서**: `references/orca-runtime.md`의 `PM 실행` 절, `references/kickoff-registry.md`의 인계 절차 4단계, `skills/director/SKILL.md`의 4단계 문구가 `--brief` 방식을 반영하도록 갱신했다. `skills/pm/SKILL.md`에 「인계 지시 확인」 절을 새로 추가해, 최초 기동 시 `--brief`로 받은 첫 프롬프트는 사용자 추가 확인 없이 따르고, 후속 붙여넣기 인계 지시는 `kickoff-handoff-verify`의 `match` 결과로만 판정한다는 규칙을 적었다.

## 사용자 설정 파일에 기대지 않음 (ac-3)

이 구현은 `~/.claude`, `~/.codex`, Agy 설정 파일을 읽거나 쓰지 않는다. 첫 프롬프트는 실행 명령 자체의 인자이고, 등록부 대조는 프로젝트 워크트리 안의 `.omt/organization.json`만 읽는다. 사용자 전역 `CLAUDE.md`의 역할 worker 예외는 이 worker 세션이 작업을 진행할 권한의 근거일 뿐, PM이 인계 지시를 신뢰하는 근거로 코드나 문서 어디에도 참조하지 않는다.

## 실제 Orca에서 확인한 절차와 결과

아래 절차는 실제 Orca와 Claude PM으로 `--brief` 경로를 2026-09-26에 한 번 실행해 확인했다. 실제 조직 파일과 그 파일이 가리키는 등록부에는 아무것도 쓰지 않도록, OS 임시 디렉터리에 조직 파일 사본과 확인용 브리프를 따로 준비했다.

**어느 워크트리에서 확인했는지**: 이 rework의 spec은 이 확인을 t6 작업 워크트리(`id:955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/tdj-t6-handoff`)에서 실행하라고 지시했다. 그러나 실제로 3단계에서 실행한 명령은 같은 uuid의 다른 경로, PM 워크트리(`id:955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/terminal-delivery-judgment`)를 `--worktree`로 받았다. `role-launch.mjs`의 `selectedWorktreePath`·`worktreePath`는 `id:` 선택자의 uuid가 아니라 마지막 `::` 뒤 경로 문자열만 resolve해 실제 대상 디렉터리로 쓰므로, 새로 연 PM 세션은 지시받은 t6 워크트리가 아니라 PM 워크트리에서 열렸다. 그 워크트리는 확인 시점에 커밋 `a05fd92`(t6 구현 커밋 `0f8bb8c` 이전)에 있었고, `git show a05fd92:plugins/oh-my-teams/skills/pm/SKILL.md`에는 「인계 지시 확인」 절 자체가 없다(`0f8bb8c`가 처음 추가한 절이므로). 즉 이번 확인은 이 rework가 pm/SKILL.md에 적은 신뢰 조건 문구가 전혀 존재하지 않는 스킬 파일 아래에서 이뤄졌다.

1. OS 임시 디렉터리에 확인용 폴더를 만들고, 실제 조직 파일 `/Users/jinsungkim/orca/oh-my-teams/.omt/organization.json`을 읽기만 해서 그 폴더 안 `.omt/organization.json`으로 복사했다(실제 조직 파일 자체는 건드리지 않았다). 이 사본이 아래 명령의 `<org>`다.
2. 같은 폴더에 확인용 브리프(`brief.md`)를 썼다. 내용은 "이 문서는 #86 확인용 브리프입니다. 어떤 명령도 실행하지 말고, Goal·Run·kickoff-bind도 만들지 말고, '브리프 확인 완료' 한 줄로만 답한 뒤 멈추십시오."로, PM이 실제로 Goal이나 Run을 만들지 않도록 범위를 좁혔다.
3. `node <runtime> role-terminal --org <위 1단계의 임시 org 파일> --role pm --worktree id:955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/terminal-delivery-judgment --brief <위 2단계의 확인용 브리프 경로> --title "86 확인"`을 한 번 실행했다. 위에서 밝혔듯 이 `--worktree` 값은 지시받은 t6 워크트리가 아니라 PM 워크트리였다.
4. **관찰한 결과**: 명령 결과의 `command`·`launched`에 확인용 브리프 경로를 담은 문장이 실행 명령 자체의 마지막 인자로 들어 있었고, `ready: true`, `submission: "enter-sent"`였다. 이 `enter-sent`는 PM 세션 안에서 브리프 내용에 대해 role-terminal이 별도로 보낸 Enter가 아니다. `role-terminal.mjs`의 `launchOnce`(717~723행 `commandPending` 분기)는 셸이 방금 그 launch 명령(브리프 문장을 인자로 실은 실행 명령 자체)을 아직 실행하지 않고 화면 끝에 그대로 echo한 상태를 스스로 판정했을 때에만 빈 텍스트와 Enter를 보내며, 이번 확인에서도 그 판정 뒤 한 번만 나갔다. 즉 이 Enter가 향한 대상은 PM 세션을 여는 launch 명령이며, 브리프의 내용 자체가 아니다. `orca terminal read`로 남긴 화면 원문에서 첫 프롬프트는 붙여넣기 표시 없이 `❯ 인수 브리프 ...를 읽고, ...` 형태의 일반 입력줄로 나타났다. PM은 사용자 확인을 구하지 않고 AGENTS.md를 읽은 뒤 브리프가 지시한 대로 "브리프 확인 완료"라고만 답하고 멈췄다. 세션 jsonl의 첫 사용자 메시지는 `content`가 `<pasted_content>` 래핑 없는 순수 문자열이었고 `promptSource: "typed"`, `origin.kind: "human"`, `turnOrigin: "human"`이었으며, 이는 이 세션의 실제 첫 턴으로 기록됐다는 뜻이다.
5. **판정과 그 범위**: 붙여넣기 판정·Enter 대상·세션의 첫 턴 여부라는 관찰 사실 자체는 `role-launch.mjs`가 실행 명령의 위치 인자로 첫 프롬프트를 넘기는 방식과 Claude Code 자신의 판정 동작에서 나오므로, 세션이 어느 워크트리에서 열렸는지와 무관하다. 그러나 PM이 사용자 확인 없이 브리프를 따른 것이 이 rework가 pm/SKILL.md에 새로 적은 턴 순서 신뢰 조건 덕분인지, 그 절 자체가 없는 상태에서 도착한 첫 지시를 그대로 따른 것뿐인지는 이 확인만으로 가려낼 수 없다. 그 세션의 작업 폴더에는 새 pm 스킬 「인계 지시 확인」 절이 없었으므로, PM이 따른 근거는 이 새 규칙이 아니라 첫 사용자 메시지로 도착한 지시 자체였다고 봐야 하며, 새 규칙이 적용된 환경에서의 PM 동작은 이번에 관찰하지 못했다. 그 세션이 실제로 어느 경로의 플러그인·스킬 파일을 읽었는지는, 이 확인이 남긴 기록(명령 결과와 화면 원문, jsonl 메타데이터)의 확인 범위 안에서는 확정할 수 없다. 확인이 끝난 뒤 그 PM 터미널을 `orca terminal close`로 닫고 임시 폴더를 지웠다. 이 CLI 판(Claude Code v2.1.283)의 이 worktree 신뢰 상태에서는 폴더 신뢰 질문이 뜨지 않아(`trust: "not-asked"`), 신뢰 질문이 있는 경로는 이번에 관찰하지 못했다.
6. 이 확인은 Claude Code 한 판에서, 지시받은 t6 워크트리가 아닌 PM 워크트리에서, 한 번 실행한 결과다. Codex와 Agy는 여전히 `--help`로 인자·플래그의 존재만 확인했을 뿐, 세션에서의 표시는 관찰하지 않았다(위 「검토한 세 가지 선택지」).
