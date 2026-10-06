---
name: form
description: 최초 oh my teams 상설 조직에 검증된 구독 자원과 고정 역할 권한을 기록한다. 특정 개발 과제의 시작은 kickoff를 사용한다.
---

# 팀 결성

조직 결성은 특정 과제의 Goal이나 실행 팀을 만들지 않는다. 조직이 이미 있으면 저장된 구성을 보여 주며 다시 만들거나 구독 선택을 반복하지 않는다. 조직을 결성한 뒤 사용자가 개발 과제의 시작까지 요청했으면 `kickoff`로 이어 간다.

대상 프로젝트 `.omt/organization.json`을 먼저 확인한다. 있으면 `status`로 표시하고 저장된 구독을 그대로 사용한다. 다시 질문하거나 예제 설정으로 덮어쓰지 않는다.

## 묻는 것

조직이 없으면 **사용할 구독 자원만** 묻는다. PM과 Worker의 모델, 추론 강도와 역할별 profile은 결성 단계에서 묻거나 기록하지 않는다. 새 조직은 PM과 Worker의 고정 권한·보고 관계와 자원별 account·subscription·pool·동시 실행·호출 한도를 기록하며, 실제 모델 선택은 검증된 자원 범위 안에서 이후의 staffing 결정이 맡는다.

묻는 방식은 [`../../references/user-choice.md`](../../references/user-choice.md)를 따르며, 질문은 한 번으로 끝난다. 사용자는 현재 로그인한 Codex·Claude·Agy 가운데 이 조직이 사용할 구독 자원을 선택한다. 사용자가 선택하지 않은 실행기·계정·구독은 조직에 추가하지 않는다.

기존 역할별 profile 조직은 명시적인 호환 입력으로 계속 읽는다. 축소 구조는 [`../../examples/organization.single-subscription.json`](../../examples/organization.single-subscription.json)에서 확인한다. 기존 조직이나 진행 중인 kickoff snapshot의 모델, pool, fallback, 호출 한도와 역할 권한을 새 자원 계약으로 추측하여 바꾸지 않는다. 새 조직의 역할 ID는 `pm`과 `worker`이며, 기존 역할이 있는 kickoff에는 저장된 스냅샷을 적용한다.

모델 선택지는 미리 박아 둔 표에서 고르지 않고, 묻기 직전에 실행한 조회 결과에서만 만든다. 다음을 실행한다.

```text
node <runtime> model-catalog --codex-home <codex-home>
```

세 실행기(`claude`, `codex`, `agy`) 각각의 항목을 이렇게 읽는다.

- `status`가 `"ok"`이면 그 실행기의 현재 카탈로그를 확인했으므로, 해당 실행기의 현재 account 구독을 자원 선택지로 제시한다. 모델 목록은 역할별 질문이나 우선순위로 바꾸지 않는다.
- `status`가 `"unavailable"`이고 `reasonCode`가 `"no-catalog-interface"`가 아니면, 설치 또는 카탈로그 조회를 확인하지 못한 것이다. 그 실행기는 자원 선택지에서 제외하고, 다른 실행기의 기본값으로 대체하지 않는다.
- `status`가 `"unavailable"`이고 `reasonCode`가 `"no-catalog-interface"`이면, 실행기 설치 여부만 확인된 것이다. 이 경우에는 현재 account 구독을 자원으로 선택할 수 있지만, 모델을 선택하거나 모델 접근 권한을 단정하지 않는다.

사용자는 catalog가 확인한 실행기만 선택할 수 있다. 목록 밖의 provider나 임의 account·구독 이름을 자유 입력으로 추가하지 않는다.

## 묻지 않고 정하는 것

아래 값은 사용자가 고른 모델보다 더 많은 호출, 계정이나 권한을 쓰지 않는 쪽으로 고정되어 있으며, `scripts/org-draft.mjs`가 기록한다. 모두 `adjust`에서 바꿀 수 있다.

- 팀 이름은 프로젝트 디렉터리 이름을 쓴다.
- 각 역할의 상위 역할은 서열상 바로 위 역할이다. 선택한 실행기는 현재 로그인 계정(`account: current`)으로 기록하고, 실행기별로 하나의 `pool`을 만들어 같은 구독의 소진을 우회하지 않게 한다.
- 자원별 동시 실행 한도는 기본 1이고, 자원별 호출 한도와 `policy.maxCalls`는 기본 3이다. 역할의 시도 횟수는 1이며, 대체 profile은 두지 않고, 할당량이 소진되면 중단한다. 추가 자원이나 대체 profile은 `adjust`에서 사용자가 고르게 하며, 이 값도 `adjust`에서 명시적으로 바꿀 수 있다.
- 모델과 추론 강도는 결성 조직에 기록하지 않는다. 카탈로그가 실패했을 때 host default나 고정 모델을 추측하여 넣지 않는다.
- 감독 역할은 `worker_done`을 보내지 않은 worker가 15분(`policy.supervision.progressCheckMs: 900000`) 동안 활동이 없으면 진행 상황을 묻고, 답이 없는 요청이 2회(`unansweredLimit: 2`)에 이르면 상위에 보고한다. 이 정책은 메시지 한 통 외에 호출을 쓰지 않으며, 재시도나 종료를 스스로 하지 않는다.
- advisor profile은 해당 기능이 필요할 때 `adjust`에서 검증된 자원 범위와 별도로 명시한다.
- 감사(`org.auditor`)는 결성 단계에서 만들지 않는다. 이사 또는 독립 정책이 필요할 때 배정하며, PM이 감사 신원과 판정 권한을 선택하지 않는다.

로컬 Ollama 모델은 결성 단계에서 받지 않는다. 컨텍스트 창을 `ollama show`로 확인해 기록해야 하는데, 추측한 값으로 저장하면 잘린 프롬프트에 대한 답이 정상 응답처럼 보이기 때문이다. 결성 후 `adjust`에서 추가한다.

## 저장

현재 SKILL.md 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석해 다음을 실행한다. 초안 파일은 새 경로에 쓰며, 이미 있는 파일에는 쓰지 않는다. 예제 조직 자체를 사용자 조직으로 자동 설치하지 않는다.

```text
node <runtime> org-draft --name <project-dir-name> --resources <codex,claude,agy> --output <draft.json>
node <runtime> init --org <project>/.omt/organization.json --from <draft.json>
node <runtime> show --org <project>/.omt/organization.json
```

`init`은 조직 파일이 이미 있으면 아무것도 바꾸지 않고 `created: false`로 정상 종료한다. 출력의 `created`가 `true`인 경우에만 신규 결성으로 보고하고, `false`이면 기존 조직을 그대로 쓴다고 알린다. 인증 준비가 끝나지 않은 프로필은 실행 전에 정확한 오류를 알리고 멈춘다. 질문을 처음부터 다시 시작하지 않는다.

결성을 보고할 때에는 선택한 자원마다 provider, 현재 account, subscription, pool, 동시 실행 한도와 호출 한도를 적는다. 모델과 추론 강도를 아직 선택하지 않았으며, 조회 실패한 실행기는 저장하지 않았다는 사실도 함께 적는다. 기존 역할별 profile 조직은 호환 입력으로만 유지하며, 새 조직으로 자동 변경하지 않는다.

`.omt/`는 Git에서 제외한다. 별도 저장소 작업에는 `orca-cli`를 읽어 Orca worktree를 사용한다. 조직 파일을 둔 이 프로젝트의 `.omt/`가 이후 kickoff 등록부가 놓이는 자리가 된다. 한 프로젝트에서 kickoff를 여러 개 동시에 진행할 수 있으며, form 자체는 kickoff를 등록하지 않는다. 자세한 계약은 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)에 있다.
