---
name: form
description: 최초 oh my teams 상설 조직을 구성하고 역할별 구독·계정·모델과 보고 구조를 저장한다. 특정 개발 과제의 시작은 kickoff를 사용한다.
---

# 팀 결성

조직 결성은 특정 과제의 Goal이나 실행 팀을 만들지 않는다. 조직이 이미 있으면 저장된 구성을 보여 주며 다시 만들거나 구독 선택을 반복하지 않는다. 조직을 결성한 뒤 사용자가 개발 과제의 시작까지 요청했으면 `kickoff`로 이어 간다.

대상 프로젝트 `.omt/organization.json`을 먼저 확인한다. 있으면 `status`로 표시하고 저장된 구독을 그대로 사용한다. 다시 질문하거나 예제 설정으로 덮어쓰지 않는다.

없으면 한 번의 구성 대화에서 다음을 묻는다. 묻는 방식은 [`../../references/user-choice.md`](../../references/user-choice.md)를 따른다. 구조화된 선택 도구를 쓸 수 있으면 그것으로 묻고, 없으면 번호를 매긴 선택지를 한 번에 제시한다. 모델은 선택의 추천값일 뿐, 사용자 답을 대신하지 않는다.

- 팀 이름, 실제로 운영할 역할과 역할별 상위 역할, 동시 인원. PM이 유일한 루트이며 순환이 없어야 한다.
- **각 직급마다** 사용할 구독/계정 프로필과 모델. 기존 직급의 구독 공유도 명시적으로 선택할 수 있다.
- 사용할 대체 프로필과 순서, 할당량 소진 시 대체 또는 중단, 전체 호출 한도.
- 역할별로 GPT-OSS 보조 도구 호출을 허용할지 여부. 허용한 역할만 `assistants`에 기록되며, 비워 두면 그 역할의 `assist` 호출은 전부 거부된다.

실행기는 Claude·Codex·Agy·Ollama, 설치 호스트는 Claude·Codex다. 먼저 설치된 `agy models`와 각 CLI 도움말에서 실제 모델 ID를 확인한다. 이 배포에서 확인한 Agy 선택지는 Gemini Flash 3.8·3.7·3.6(각 high/medium/low), Gemini Pro 3.1(high/low), Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS-120B다. Codex 카탈로그에서 확인한 선택지는 `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`다. Agy의 GPT-OSS·Sonnet·Opus는 모두 프로필의 정확한 모델 ID를 `--model` 인자로 전달한다. Claude·Codex의 미지정 모델은 `null`로 저장해 호스트 기본값을 사용한다. 고정된 모델 능력 서열이나 구독 가격을 가정하지 않는다.

로컬 모델을 쓰겠다는 요청을 받으면 Ollama 프로필을 만든다. 프로필에는 `command`(CLI 실행)와 `endpoint`(HTTP API) 중 정확히 하나만 적고, HTTP 쪽을 권한다. 토큰 사용량과 실제 응답 모델이 함께 돌아와 증거가 남기 때문이다. 모델 ID와 `contextTokens`는 반드시 적는다. Ollama는 컨텍스트 창을 넘는 프롬프트를 오류 없이 잘라내므로, 이 값이 없으면 잘린 계약을 읽고 답한 결과를 정상 응답과 구분할 수 없다. 설치된 모델과 창 크기는 `ollama list`와 `ollama show <모델>`로 확인하고 추측하지 않는다. 로컬 추론은 공유 할당량을 쓰지 않으므로 `pool`을 붙이지 않으며, 저장소 파일을 직접 열지 못하므로 계약 파일 내용을 읽어야 하는 역할에는 배정하지 않는다. 로컬 서버는 요청을 사실상 직렬로 처리하므로 해당 역할의 `concurrency`는 1로 제안한다.

프로필의 선택적 `effort` 필드가 추론 강도를 정한다. 사용자가 강도를 요청하지 않았으면 이 필드를 생략해 각 CLI의 기본값을 쓴다. Agy는 `--effort`로 `low|medium|high`를 받고, Codex는 전용 플래그가 없어 `--config model_reasoning_effort=<값>`으로 `low|medium|high|xhigh|max|ultra`를 받으며, Claude CLI에는 강도 선택 수단이 없으므로 `effort`를 지정하면 런타임이 저장을 거부하고, Ollama는 thinking 모델에 한해 `low|medium|high`를 받는다. 강도별 지원 범위는 모델마다 다르므로(예: `gpt-5.6-luna`에는 `ultra`가 없고, Agy는 모델에 따라 `--effort` 자체를 거부한다) 확인되지 않은 조합을 사용자에게 권하지 않는다. 생략했을 때 적용되는 깊이는 CLI와 계정 설정이 정하므로, 특정 기본 강도를 사용자에게 단정해 알리지 않는다. Agy 모델 ID가 이미 `-high`처럼 강도를 담고 있으면 `effort`는 같은 값이어야 하고, 어긋나면 런타임이 거부한다.

구독을 하나만 쓰는 사용자에게는 역할마다 계정을 나누지 말고, 그 구독으로 만든 프로필 여러 개를 모델만 다르게 두어 역할별로 배정한다. 이때 **그 프로필들을 하나의 `pool`로 묶어야 한다.** 런타임은 소진이 확인된 pool에 속한 프로필을 남은 대체 순서에서 건너뛰므로, pool을 붙이지 않으면 이미 소진된 같은 계정으로 계속 시도하다가 호출 예산만 소모한다. 같은 이유로 같은 pool 안에서의 대체 지정은 의미가 없고, 역할별 동시 인원은 1을 권한다. 하나의 구독을 여러 역할이 동시에 끌어 쓰면 모델 선택보다 슬롯 수가 소진 속도를 더 크게 좌우한다. 이 조합은 `single-subscription` 프리셋이 한 번에 적용한다.

역할은 다섯 개를 모두 둘 필요가 없다. PM만 필수이며 PL·Senior·Junior·Intern은 생략할 수 있고, 남긴 역할의 상위 역할도 반드시 조직이 선언한 역할이어야 한다. 생략한 역할이 맡던 일은 서열을 따라 위로 올라가 조직이 선언한 가장 가까운 역할이 이어받는다. 예를 들어 PM과 Junior만 두면 Intern에게 배정된 작업은 Junior가, Senior가 맡던 검토는 PM이 수행한다. 역할 이름 자체는 바꿀 수 없다. 실패 라우팅, 검토 요구사항과 스킬이 이 이름으로 역할을 지목하기 때문이다. 구조는 [`../../examples/organization.single-subscription.json`](../../examples/organization.single-subscription.json)에서 확인한다.

최초 구성에서는 `opus-first`와 `balanced` 프리셋을 제안한다. `opus-first`는 Agy 역할의 기준선을 Opus로 통일하고, `balanced`는 Senior=Opus, Junior=Sonnet, Intern=GPT-OSS로 배정한다. PM·PL의 기존 Claude·Codex 선택은 두 프리셋 모두 바꾸지 않는다. 프리셋을 고른 뒤에도 직급별 구독·계정과 실제 모델 ID를 확인하며 사용자는 모두 변경할 수 있다. 프리셋은 보고 구조를 바꾸지 않으므로 예제의 상위 역할 배치는 참고일 뿐이다. 구독별 청구/할당량은 토큰 수와 다른 값이다.

[`../../examples/organization.json`](../../examples/organization.json)을 구조 참고로 사용하되 실제 답으로 채운다. 프리셋이 적용한 결과를 담은 예제도 있으나, 배정 내용은 위 문단에 이미 있고 정본은 `scripts/presets.mjs`이므로 구조를 볼 때는 한 파일이면 충분하다. `subscription`은 사용자가 알아볼 이름, `account`는 실행 계정 참조다. 이름만 붙여 계정이 전환됐다고 보고하지 않는다. 현재 CLI 인증을 쓸 때 `account: current`; 별도 계정은 CLI가 지원하는 프로필 인수 또는 `env`의 환경변수 **이름 참조**로 연결한다. 비밀값을 JSON에 넣지 않는다. Agy가 계정 선택 옵션을 제공하지 않으면 검증된 별도 실행 프로필이 필요하다.

현재 SKILL.md 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석해 다음을 실행한다. 예제 조직 자체를 사용자 조직으로 자동 설치하지 않는다.

```text
node <runtime> init --org <project>/.omt/organization.json --from <user-approved-config.json>
node <runtime> show --org <project>/.omt/organization.json
```

`init`은 조직 파일이 이미 있으면 아무것도 바꾸지 않고 `created: false`로 정상 종료한다. 출력의 `created`가 `true`인 경우에만 신규 결성으로 보고하고, `false`이면 기존 조직을 그대로 쓴다고 알린다. 인증 준비가 끝나지 않은 프로필은 실행 전에 정확한 오류를 알리고 멈춘다. 구독 선택 질문을 다시 시작하지 않는다. `.omt/`는 Git에서 제외한다. 별도 저장소 작업에는 `orca-cli`를 읽어 Orca worktree를 사용한다.
