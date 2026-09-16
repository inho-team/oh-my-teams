---
name: form
description: 최초 oh my teams 상설 조직을 구성하고 역할별 구독·계정·모델과 보고 구조를 저장한다. 특정 개발 과제의 시작은 kickoff를 사용한다.
---

# 팀 결성

조직 결성은 특정 과제의 Goal이나 실행 팀을 만들지 않는다. 조직이 이미 있으면 저장된 구성을 보여 주며 다시 만들거나 구독 선택을 반복하지 않는다. 조직을 결성한 뒤 사용자가 개발 과제의 시작까지 요청했으면 `kickoff`로 이어 간다.

대상 프로젝트 `.omt/organization.json`을 먼저 확인한다. 있으면 `status`로 표시하고 저장된 구독을 그대로 사용한다. 다시 질문하거나 예제 설정으로 덮어쓰지 않는다.

없으면 한 번의 구성 대화에서 다음을 묻는다. 묻는 방식은 [`../../references/user-choice.md`](../../references/user-choice.md)를 따른다. 구조화된 선택 도구를 쓸 수 있으면 그것으로 묻고, 없으면 번호를 매긴 선택지를 한 번에 제시한다. 모델은 선택의 추천값일 뿐, 사용자 답을 대신하지 않는다.

- 팀 이름, 역할별 상위 역할과 동시 인원. PM이 유일한 루트이며 순환이 없어야 한다.
- **각 직급마다** 사용할 구독/계정 프로필과 모델. 기존 직급의 구독 공유도 명시적으로 선택할 수 있다.
- 사용할 대체 프로필과 순서, 할당량 소진 시 대체 또는 중단, 전체 호출 한도.
- 역할별로 GPT-OSS 보조 도구 호출을 허용할지 여부. 허용한 역할만 `assistants`에 기록되며, 비워 두면 그 역할의 `assist` 호출은 전부 거부된다.

실행기는 Claude·Codex·Agy, 설치 호스트는 Claude·Codex다. 먼저 설치된 `agy models`와 각 CLI 도움말에서 실제 모델 ID를 확인한다. 이 배포에서 확인한 Agy 선택지는 Gemini Flash 3.8·3.7·3.6(각 high/medium/low), Gemini Pro 3.1(high/low), Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS-120B다. Codex 카탈로그에서 확인한 선택지는 `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`다. Agy의 GPT-OSS·Sonnet·Opus는 모두 프로필의 정확한 모델 ID를 `--model` 인자로 전달한다. Claude·Codex의 미지정 모델은 `null`로 저장해 호스트 기본값을 사용한다. 고정된 모델 능력 서열이나 구독 가격을 가정하지 않는다.

프로필의 선택적 `effort` 필드가 추론 강도를 정한다. 사용자가 강도를 요청하지 않았으면 이 필드를 생략해 각 CLI의 기본값을 쓴다. Agy는 `--effort`로 `low|medium|high`를 받고, Codex는 전용 플래그가 없어 `--config model_reasoning_effort=<값>`으로 `low|medium|high|xhigh|max|ultra`를 받으며, Claude CLI에는 강도 선택 수단이 없으므로 `effort`를 지정하면 런타임이 저장을 거부한다. 강도별 지원 범위는 모델마다 다르므로(예: `gpt-5.6-luna`에는 `ultra`가 없고, Agy는 모델에 따라 `--effort` 자체를 거부한다) 확인되지 않은 조합을 사용자에게 권하지 않는다. 생략했을 때 적용되는 깊이는 CLI와 계정 설정이 정하므로, 특정 기본 강도를 사용자에게 단정해 알리지 않는다. Agy 모델 ID가 이미 `-high`처럼 강도를 담고 있으면 `effort`는 같은 값이어야 하고, 어긋나면 런타임이 거부한다.

최초 구성에서는 `opus-first`와 `balanced` 프리셋을 제안한다. `opus-first`는 Agy 역할의 기준선을 Opus로 통일하고, `balanced`는 Senior=Opus, Junior=Sonnet, Intern=GPT-OSS로 배정한다. PM·PL의 기존 Claude·Codex 선택은 두 프리셋 모두 바꾸지 않는다. 프리셋을 고른 뒤에도 직급별 구독·계정과 실제 모델 ID를 확인하며 사용자는 모두 변경할 수 있다. 프리셋은 보고 구조를 바꾸지 않으므로 예제의 상위 역할 배치는 참고일 뿐이다. 구독별 청구/할당량은 토큰 수와 다른 값이다.

[`../../examples/organization.json`](../../examples/organization.json)을 구조 참고로 사용하되 실제 답으로 채운다. 프리셋이 적용한 결과를 담은 예제도 있으나, 배정 내용은 위 문단에 이미 있고 정본은 `scripts/presets.mjs`이므로 구조를 볼 때는 한 파일이면 충분하다. `subscription`은 사용자가 알아볼 이름, `account`는 실행 계정 참조다. 이름만 붙여 계정이 전환됐다고 보고하지 않는다. 현재 CLI 인증을 쓸 때 `account: current`; 별도 계정은 CLI가 지원하는 프로필 인수 또는 `env`의 환경변수 **이름 참조**로 연결한다. 비밀값을 JSON에 넣지 않는다. Agy가 계정 선택 옵션을 제공하지 않으면 검증된 별도 실행 프로필이 필요하다.

현재 SKILL.md 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석해 다음을 실행한다. 예제 조직 자체를 사용자 조직으로 자동 설치하지 않는다.

```text
node <runtime> init --org <project>/.omt/organization.json --from <user-approved-config.json>
node <runtime> show --org <project>/.omt/organization.json
```

`init`은 조직 파일이 이미 있으면 아무것도 바꾸지 않고 `created: false`로 정상 종료한다. 출력의 `created`가 `true`인 경우에만 신규 결성으로 보고하고, `false`이면 기존 조직을 그대로 쓴다고 알린다. 인증 준비가 끝나지 않은 프로필은 실행 전에 정확한 오류를 알리고 멈춘다. 구독 선택 질문을 다시 시작하지 않는다. `.omt/`는 Git에서 제외한다. 별도 저장소 작업에는 `orca-cli`를 읽어 Orca worktree를 사용한다.
