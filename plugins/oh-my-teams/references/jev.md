# 실험 기능: Jev shadow 판단

조직이 켰을 때에만 런타임 명령 안에서 TypeSafe의 Jev 모델에게 좁은 판단을 묻고 기록하는 규칙이다. 이 문서가 정본이며, 역할 스킬과 `orca-runtime.md`는 여기를 참조한다.

## 왜 런타임 안에서 부르는가

Jev는 텍스트를 생성하지 않고, 자연어와 상태를 받아 Choice(보기 중 하나), Noul(조건이 참일 확률), Score(척도 위 위치) 같은 타입이 정해진 판단과 확률을 돌려준다. 입력 100만 토큰당 0.042달러이고 출력은 무료이며(2026-09-22 공식 문서 기준), 실제 호출은 0.2~0.7초 안에 끝났다.

역할이 Jev를 직접 부르면 그 답을 읽는 데 역할의 턴 하나가 든다. 호출 한 번이 약 17,600토큰이고 모델을 바꿔도 호출당 약 80토큰밖에 달라지지 않는다는 측정(`docs/plan/shared-quota-model-routing.md`)에 비추어 보면, 비용을 줄이는 방법은 역할의 턴 수를 줄이는 것이다. 그래서 Jev는 이미 입력을 가진 런타임 명령 안에서만 부르고, 역할에게는 아무것도 추가로 보여 주지 않는다.

## 켜는 방법

`policy.experimental.jev` 블록이 없으면 꺼져 있다. `form`은 이 값을 묻지 않으며, 사용자가 요청하면 `adjust`에서 켠다.

```json
"policy": {
  "experimental": {
    "jev": {
      "mode": "shadow",
      "model": "jev-1.13.0",
      "points": ["status-filter", "auto-observe", "model-check", "failure-fallback"],
      "budgetPerKickoff": 500,
      "timeoutMs": 2000
    }
  }
}
```

- 블록이 있으면 다섯 키를 모두 적어야 하며, 모르는 키가 있으면 런타임이 거부한다.
- `mode`는 `off`와 `shadow`만 받는다. `shadow`는 판단을 기록하기만 하고 명령의 결과를 바꾸지 않는다. 판단을 동작에 반영하는 모드는 shadow 기록으로 효과와 안전을 확인하기 전까지 받지 않는다.
- `model`은 `jev-1.13.0`처럼 버전을 고정한다. `jev-latest` 같은 별칭은 새 릴리스가 나오면 다른 모델을 가리키게 되어, 기록끼리 비교할 수 없게 되므로 거부한다.
- `budgetPerKickoff`는 kickoff 상태 디렉터리 하나에서 호출할 수 있는 횟수(1~5000)이고, `timeoutMs`는 호출 한 번의 제한 시간(200~10000)이다.
- API 키는 환경 변수 `TYPESAFE_API_KEY`에서만 읽는다. 조직 파일에는 키를 적지 않는다.

진행 중인 kickoff는 시작할 때의 조직 스냅샷을 따르므로, 켠 설정은 다음 kickoff부터 적용된다.

## 판단 지점

| 지점 | 실행되는 명령 | 판단 대상 | 질문 |
|---|---|---|---|
| `status-filter` | `supervision-wait --org --state` | `status` 메시지로만 이루어진 전달 | Noul: 감독자가 지금 행동해야 하는가, Choice: 진행·막힘·질문·완료·기타 |
| `auto-observe` | `supervision-next --dispatch --state` | 그 worker의 `worker-read` 출력 끝부분 | Choice: 작업 중·입력 대기·한도 걸림·비정상 종료·보고 없는 완료·판단 불가 |
| `model-check` | `role-terminal --state` | 역할 터미널의 마지막 화면 | Choice: 요청 모델과 일치·다른 모델·모델 표시 없음 |
| `failure-fallback` | `failure-classify --org --state` | 결정적 규칙이 `unknown`으로 둔 실패 | Choice: 실패 분류 10종과 판단 불가 |

`worker_done`, `question`, `escalation` 메시지는 구조로 판정할 수 있으므로 `status-filter`의 대상이 아니다. `supervision-next`, `failure-classify`, liveness처럼 이미 결정적으로 판정하는 결과는 어느 모드에서도 바뀌지 않는다.

## 실패와 기록

- 키가 없거나 예산이 바닥나면 Jev를 호출하지 않고 `status: "unavailable"`로 기록한다. 호출이 거부되거나 시간을 넘기면 `status: "failed"`로 기록한다. 어느 경우에도 명령은 판단이 없을 때와 똑같이 끝난다. 재시도는 하지 않는다.
- 기록은 `<state>/judgments/<point>-<uuid>.json`에 남는다. 보낸 상태는 저장하지 않고 해시(`stateHash`)만 남긴다. worker 출력과 화면에는 환경 변수 값이 섞일 수 있기 때문이다. 나중에 비교할 수 있도록 dispatch ID, 결정적 판정의 `action`·`reason`·`category`, 요청 모델 같은 작은 값만 `context`에 남긴다.
- 답(`answers`), 응답 모델(`effectiveModel`), `usage`, 계산한 `costUsd`, `requestId`, `elapsedMs`를 함께 기록한다. `usage-report`는 `answered`와 `failed` 기록을 provider `typesafe`의 호출로 집계하고, `unavailable` 기록은 호출하지 않았으므로 세지 않는다.
- **판단은 승인이 아니다.** `gate-check`, `review-record`, `accept`와 병합 경로는 이 기록을 읽지 않는다.

## 효과를 확인하는 방법

shadow 기록을 실제 행동과 대조한다. `status-filter`는 Noul 값이 낮았던 전달 뒤에 PM이 실제로 행동했는지, `auto-observe`는 판단 뒤에 이어진 `supervision-next`의 결과와 상위 보고 내용이 일치했는지, `model-check`는 PM이 화면에서 확인한 모델과 일치했는지, `failure-fallback`은 Senior가 최종으로 내린 분류와 일치했는지를 본다.

판단을 동작에 반영하는 모드를 도입하려면 기존 채택 기준을 따른다. 품질을 낮추지 않으면서 역할의 턴이나 토큰이 약 10% 이상 줄어야 하며, 놓친 메시지나 잘못 보낸 실패가 하나라도 있으면 토큰 절약만으로 채택하지 않는다. Jev는 영어가 주 학습 언어이므로 질문은 영어로 쓰고, 임계값은 한국어 보고로 따로 검증한다.
