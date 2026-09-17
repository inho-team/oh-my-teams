---
name: adjust
description: 저장된 oh my teams 상설 조직의 역할, 인원, 구독·모델, 추론 강도와 보고 구조를 조정한다. 진행 중인 kickoff에는 기존 스냅샷을 유지한다.
---

# 팀 조정

이 스킬은 상설 조직을 조정하며, 진행 중인 kickoff의 목표나 수용 기준은 변경하지 않는다.

프로젝트 `.omt/organization.json`을 읽는다. 없으면 `form`으로 이동한다. 사용자 요청으로 바뀌는 항목에 대해서만 필요한 선택을 [`../../references/user-choice.md`](../../references/user-choice.md)의 방식으로 받는다. 기존 구독 배정을 전부 다시 묻지 않는다.

1. 현재 revision과 역할·프로필을 읽고 변경 전후를 정리한다. 이름 변경, 직급별 부모와 인원, 구독/모델, 추론 강도, 대체 순서, 보조 도구 허용, `opus-first`·`balanced`·`single-subscription` 프리셋을 지원한다. 역할 ID는 pm/pl/senior/junior/intern이며 이 이름은 바꿀 수 없다.
2. 새 구독이나 과금 경로를 임의로 선택하지 않는다. 계정 연결은 아래 「계정과 실행기」를 따른다.
3. 수정안을 별도 JSON에 쓰고 현재 스킬 기준 `../../scripts/teams-org.mjs`를 호출한다.

## 결성 때 묻지 않은 값

`form`은 단계 수와 단계별 모델만 묻고, 나머지는 사용자가 고른 모델보다 더 쓰지 않는 값으로 저장한다. 다음 항목은 이 스킬에서 처음 정하게 되므로, 사용자가 요청하면 현재 값이 결성 기본값이라는 사실을 함께 알린다.

- 추론 강도: 기록되지 않아 각 CLI 기본값을 쓰고 있다. Gemini는 강도가 필수라서 결성 때 Flash 3.8은 `medium`, Pro 3.1은 `high` ID로 저장되었다. 이전에 결성한 조직은 둘 다 `-high`일 수 있다.
- 동시 인원·시도 횟수 1, 대체 프로필 없음, 소진 시 중단, 전체 호출 한도 3.
- 보조 도구: `assistants`가 비어 있어 모든 역할의 `assist` 호출이 거부된다.
- 계정: 모든 프로필이 현재 로그인 계정을 쓰며, 같은 실행기의 프로필은 하나의 `pool`로 묶여 있다.
- 무응답 감독: `policy.supervision`이 `progressCheckMs: 900000`(15분), `unansweredLimit: 2`다. 이 값이 없는 이전 조직도 같은 기본값으로 읽힌다.

무응답 감독 값을 바꿀 때에는 `policy.supervision`의 두 값을 함께 적는다. `progressCheckMs`는 60000부터 86400000까지, `unansweredLimit`는 1부터 10까지 받으며, 한쪽만 적은 블록은 런타임이 거부한다. 간격을 줄이면 진행 요청 메시지가 늘어나고, 한도를 높이면 상위 보고가 늦어진다는 점을 함께 알린다. 이 정책은 재시도나 종료를 결정하지 않는다.

## 역할과 프리셋

과제가 쉬워서 역할을 덜 쓰고 싶다는 요청은 조직을 바꾸지 않는다. 그런 조정은 kickoff마다 PM이 정하는 실행 깊이가 맡으므로 [pm](../pm/SKILL.md)의 「실행 깊이」를 안내한다. 조직에서 역할을 빼는 것은 구독이 없는 것처럼 어떤 실행에서도 그 역할을 쓸 수 없을 때에만 한다.

역할을 추가하거나 제거할 때에는 PM을 반드시 남기고, 남은 역할의 상위 역할이 모두 조직에 선언되어 있는지 확인한다. 선언되지 않은 역할을 상위로 지정하면 런타임이 거부한다. 역할을 제거하면 그 역할이 맡던 일은 서열을 따라 위로 올라가 선언된 가장 가까운 역할이 이어받으므로, 사용자에게 어느 역할이 무엇을 더 맡게 되는지 알린 뒤 적용한다. 이미 진행 중인 kickoff는 생성 시의 스냅샷을 유지하므로 배정이 즉시 바뀌지 않는다.

`single-subscription` 프리셋은 모델을 하나도 바꾸지 않는다. 선언된 모든 역할의 동시 인원을 1로 낮추고, 주 프로필과 같은 할당량을 쓰는 대체 프로필만 대체 순서에서 제거한다. 계정이 다른 대체는 그대로 남는다. 구독 하나를 여러 역할이 나눠 쓰는 조직에 적용한다.

프리셋은 먼저 `preset`으로 변경되는 역할의 프로필, 대체 순서와 **동시 인원**을 미리 본다. 프리셋은 동시 인원을 1로 고정하므로 인원을 늘려 둔 조직은 줄어든다. 미리보기의 `concurrency` 변화를 사용자에게 그대로 알린다. 기존 구독·계정 프로필을 재사용하며, 없는 모델 프로필은 사용자가 `adjust`로 연결하기 전까지 적용하지 않는다. 명시적으로 적용할 때만 `--apply`를 붙인다.

```text
node <runtime> preset --org <project>/.omt/organization.json --name balanced --revision <read-revision>
node <runtime> preset --org <project>/.omt/organization.json --name balanced --revision <read-revision> --apply
```

```text
node <runtime> edit --org <project>/.omt/organization.json --from <edited.json> --revision <read-revision>
node <runtime> show --org <project>/.omt/organization.json
```

## 추론 강도

추론 강도는 해당 프로필의 선택적 `effort` 필드로 정한다. Agy는 `--effort`로 `low|medium|high`를 받고, Codex는 전용 플래그가 없어 `--config model_reasoning_effort=<값>`으로 `low|medium|high|xhigh|max|ultra`를 받으며, Claude CLI는 `--effort`로 `low|medium|high|xhigh|max`를 받고, Ollama는 thinking 모델에 한해 `low|medium|high`를 받는다. 강도별 지원 범위는 모델마다 다르므로(예: `gpt-5.6-luna`에는 `ultra`가 없고, Agy는 모델에 따라 `--effort` 자체를 거부한다) 확인되지 않은 조합을 사용자에게 권하지 않는다.

Agy 모델 ID가 이미 `-high`처럼 강도를 담고 있으면 `effort`는 같은 값이어야 하고, 어긋나면 런타임이 거부한다. 그런 모델의 강도를 바꿀 때에는 `effort`만 고치지 말고 `agy models`에서 확인한 다른 강도의 ID로 프로필의 `model`을 바꾼다. 강도를 CLI 기본값으로 되돌릴 때는 `effort`를 지운다. 빈 문자열이나 `null`로 두지 않는다. 프리셋은 역할이 참조하는 프로필 자체를 교체하므로, 적용 뒤의 강도는 새 프로필에 저장된 값을 따른다. 미리보기에서 바뀐 프로필의 `effort`를 함께 확인해 사용자에게 알린다.

## 계정과 실행기

모델 ID와 카탈로그는 `form`의 확인된 선택지를 기준으로 하되, 적용 전에 설치된 `agy models`와 각 CLI 도움말에서 다시 확인한다. `subscription`은 사용자가 알아볼 이름, `account`는 실행 계정 참조다. 이름만 붙여 계정이 전환됐다고 보고하지 않는다. 현재 CLI 인증을 쓸 때는 `account: current`이고, 별도 계정은 CLI가 지원하는 프로필 인수 또는 `env`의 환경변수 **이름 참조**로 연결한다. 비밀값을 JSON에 넣지 않는다. Agy가 계정 선택 옵션을 제공하지 않으면 검증된 별도 실행 프로필이 필요하다. 구독 하나로 여러 모델 프로필을 만들었다면 그 프로필들을 하나의 `pool`로 묶는다. 런타임은 소진이 확인된 pool에 속한 프로필을 대체 순서에서 건너뛰므로, 묶지 않으면 이미 소진된 계정으로 계속 시도하며 호출 예산만 소모한다.

로컬 모델을 쓰겠다는 요청을 받으면 Ollama 프로필을 만든다. 프로필에는 `command`(CLI 실행)와 `endpoint`(HTTP API) 중 정확히 하나만 적고, HTTP 쪽을 권한다. 토큰 사용량과 실제 응답 모델이 함께 돌아와 증거가 남기 때문이다. 모델 ID와 `contextTokens`는 반드시 적는다. Ollama는 컨텍스트 창을 넘는 프롬프트를 오류 없이 잘라내므로, 이 값이 없으면 잘린 계약을 읽고 답한 결과를 정상 응답과 구분할 수 없다. 설치된 모델과 창 크기는 `ollama list`와 `ollama show <모델>`로 확인하고 추측하지 않는다. 로컬 추론은 공유 할당량을 쓰지 않으므로 `pool`을 붙이지 않으며, 저장소 파일을 직접 열지 못하므로 계약 파일 내용을 읽어야 하는 역할에는 배정하지 않는다. 로컬 서버는 요청을 사실상 직렬로 처리하므로 해당 역할의 `concurrency`는 1로 제안한다.

런타임은 순환·누락·없는 프로필·오래된 revision을 거부하고 이전 설정을 `.omt/history/`에 남긴다. 진행 중 작업은 생성 시의 스냅샷을 유지한다. 새 배정부터 변경을 적용한다. 이미 실행 중인 세션의 계정·모델을 바꾸거나 같은 편집 작업을 중복 실행하지 않는다.
