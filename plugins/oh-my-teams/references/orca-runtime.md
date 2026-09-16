# Orca runtime discovery

oh my teams는 역할·작업 계약·검증 gate를 소유하고, worktree·터미널·Task/Dispatch·settlement는 Orca에 맡긴다. 저장소에 복사된 명령 옵션을 최신 사양으로 간주하지 않는다.

감독 실행을 시작할 때 한 번 다음 절차를 따른다.

1. 현재 세션의 공식 `orca-cli` skill이 정한 discovery 규칙으로 실행 파일을 하나 선택한다. 조용히 다른 실행 파일로 전환하지 않는다.
2. 선택한 실행 파일에서 `skills get orca-cli`를 읽는다.
3. Task/Dispatch 감독이 필요할 때 같은 실행 파일에서 `skills get orchestration`을 읽는다.
4. 필요한 참조만 추가로 읽고, 그 가이드가 실제로 제공한 명령·인자·응답 필드를 사용한다.
5. run 기록에 실행 파일 경로, 확인 가능한 버전, 조회한 skill ID와 내용 hash를 남긴다. 조회 성공은 바이너리가 전 세계 최신 버전이라는 증거가 아니다.

가이드 조회 실패, 실행 파일 불일치, 필수 기능 부재, 응답 필드 변경은 서로 다른 오류로 보존한다. 쓰기 작업은 기억한 명령으로 계속하지 않는다. 타임아웃 뒤 생성 여부가 불명확하면 현재 상태를 조회해 receipt를 복구하고 생성부터 반복하지 않는다. 실행 중 바이너리가 바뀌면 살아 있는 작업은 유지하고 다음 실행 경계에서 discovery를 다시 수행한다.

같은 세션과 실행 파일에서 동일 가이드를 매 호출마다 다시 읽지 않는다. 자식에게는 전체 가이드가 아니라 실행 파일 식별자와 필요한 참조를 전달한다. oh my teams는 Orca polling, lifecycle, 프로세스 회수 또는 업데이트 관리자를 재구현하지 않는다.

## Agy 모델 선택

Agy 프로필의 `model`은 프롬프트 설명이 아니라 실제 CLI 인자로 전달한다. GPT-OSS, Sonnet, Opus는 같은 `--model <model-id>` 형식을 사용한다.

```text
agy --model gpt-oss-120b-medium ...
agy --model claude-sonnet-4-6 ...
agy --model claude-opus-4-6-thinking ...
```

모델 ID는 실행 직전에 `agy models`에서 확인한다. `gpt-oss-120b-medium`처럼 모델 ID 자체에 추론 수준이 포함되거나 Agy가 별도 effort를 지원하지 않는 모델에는 `--effort`를 추가하지 않는다. 모델 선택 오류가 호출 전에 반환되면 사용량 0인 구성 오류로 기록하고, 기본 모델로 조용히 다시 실행하지 않는다.

제한 편집 하네스는 `scripts/providers.mjs`가 프로필의 모델 ID를 인자 배열에 추가한다. 일반 감독 작업에서 Orca의 등록된 agent launcher가 Agy를 지원하면 requested/effective 모델을 대조한다. 지원하지 않으면 현재 orchestration 가이드의 custom argv 경로를 사용하되, 모델을 감지할 수 없거나 대화형 화면의 현재 모델이 요청과 다르면 Dispatch를 시작하지 않는다. 계정·모델을 다른 실행기로 임의 대체하지 않는다.

제한 편집 하네스는 응답이 보고한 모델을 요청 모델과 대조하고, 불일치가 확인되면 결과를 채택하지 않는다(`scripts/providers.mjs`의 `modelBinding`). 보고서의 `modelProof`에는 `matched`, `mismatched`, `unproven`, `unrequested` 중 하나가 남는다. `unproven`은 실행기가 모델 메타데이터를 반환하지 않아 증명하지 못한 상태이며, 일치를 확인했다는 뜻이 아니다.

## 읽기 전용 결과의 근거 요구

감독 호출이 반환한 조사 결과는 그 자체로 증거가 아니다. 응답이 인용한 파일과 줄은 실제 workspace에서 대조하며, 인용이 하나도 없거나 대조에 실패한 인용이 하나라도 있으면 결과를 저장하지 않고 거부한다. 보고서에는 결과를 만들어 낸 workspace의 절대 경로와 Git HEAD를 함께 남겨, 나중에 다른 저장소의 구조를 보고한 응답을 판별할 수 있게 한다.

## worker-start 실패 복구

`worker-start`가 제한 시간 안에 receipt를 반환하지 않으면 같은 명령을 다시 실행하지 않는다. 중복 실행은 회수할 자원을 늘릴 뿐이다. 다음 순서로 상태를 확인하고 정리한다.

1. `worker-show`와 `worker-read`로 터미널이 살아 있는지, agent 프로세스가 실제로 시작됐는지 구분한다. 셸 프롬프트만 있고 구문 오류만 출력됐다면 터미널은 live이지만 agent는 시작되지 않은 상태다.
2. agent가 시작되지 않았음을 확인했으면 `worker-stop`으로 해당 Dispatch의 터미널만 종료한다. 다른 Dispatch를 함께 종료하지 않는다. **실제 종료를 확인하지 못했으면 `worker-stop` 대신 `worker-abandon`으로 봉인한다.** `worker-abandon`은 프로세스가 멈췄다고 주장하지 않고 살아 있을 수 있는 자원을 유지하며, `worker-release`는 정산이 끝난 worker 전용이므로 상태 불명 worker에 사용하지 않는다.
3. `worker-release`로 작업 자원을 반납한다.
4. 변경이 없는 자식 worktree는 제거한다. 변경이 남아 있으면 제거하지 않고 보존한 뒤 보고한다.

`start_unknown` 또는 `turn_start_unobserved`는 시작 성공의 증거가 아니며, 실패의 증거도 아니다. 두 상태는 미관측으로 보존하고 위 절차로 실제 상태를 확인한 뒤에 판단한다.

## 실패 어휘 번역

실행 기반이 반환하는 실패 코드는 그 실행 기반의 어휘이며 실패 분류기의 어휘가 아니다. `scripts/orca-adapter.mjs`의 `translateOrcaFailure`가 Orca의 코드를 중립 신호로 옮기고, `scripts/failures.mjs`의 `classifyFailure`는 중립 신호만 읽는다. Orca 고유 문자열을 `failures.mjs`에 넣지 않으며, `tests/execution-port.test.mjs`가 이 경계를 검사한다.

`agent_unconfigured`는 `execution-unconfigured`로 옮겨 PM의 프로필 재바인딩으로 보낸다. 같은 프로필로 재시도하면 같은 거부가 재현되기 때문이다. `inject_rejected`, `runtime_error`, `failed`, `outcome_unknown`, `start_unknown`, `turn_start_unobserved`는 프로세스 상태를 미상으로 표시해 `process-unknown`으로 보낸다. 이 경로의 재시도는 실제 종료를 확인해야 열리므로, 잔여 자원을 점검한 뒤에 대체 실행을 시작하라는 Orca의 요구와 같은 규율이 된다.

표에 없는 코드는 중립 신호 없이 원문만 보존한다. 알지 못하는 거부에 임의로 경로를 부여하면 해결할 수 없는 담당자에게 작업이 전달된다.

실패 기록을 남길 때에는 실행 기반이 반환한 코드를 그대로 적고 어느 실행 기반인지 함께 밝힌다. `failure-classify`가 번역까지 수행하므로 중립 어휘로 바꾸어 적으려 하지 않는다.

```json
{ "message": "관측한 내용", "evidence": "run_...", "runtime": "orca", "code": "agent_unconfigured" }
```

`runtime`은 `orca` 또는 `local`이며, `runtime`을 적었으면 `code`도 반드시 적는다. 둘 다 없는 기록은 이전과 똑같이 분류된다.

## worker-start 래퍼

감독 실행을 시작할 때에는 `npm run org -- worker-start --repo <경로> --task <id> --agent <agent>`를 사용한다. 이 래퍼는 argv를 배열로 전달하고, receipt에서 Dispatch 신원을 확인한 뒤, 시작이 `ready`에 이르지 못하면 3값 liveness와 번역된 실패 신호가 담긴 receipt를 돌려준다. 거부되어 Dispatch가 만들어지지 않은 경우에만 오류를 던지며, 그 오류에도 신호와 원본 receipt가 함께 실린다.

`--model`은 `--effort`보다 먼저 있어야 하고, `--terminal`로 기존 터미널을 재사용할 때에는 `--model`과 `--effort`를 함께 쓸 수 없다. 래퍼가 호출 전에 이를 거부하므로 잘못된 조합이 실행 기반에 도달하지 않는다.

**`worker-start`는 해당 Run에 바인딩된 coordinator 터미널에서만 호출할 수 있다.** 일반 셸에서 호출하면 Task의 존재 여부와 무관하게 `consumer_fenced`로 거부된다. 이 코드는 호출한 자리가 잘못되었다는 뜻이므로 재시도로 해소되지 않으며, 번역표에 넣지 않고 증거와 함께 에스컬레이션한다.

`worker-start`는 `ready`에서만 0으로 종료하고, `failed`와 `outcome_unknown`에서는 1로 종료하면서도 `dispatchId`, `failedStage`, `residualResources`를 담은 receipt를 반환한다. 따라서 종료 코드만으로 실패를 단정하지 않고 receipt를 읽는다. receipt 자체가 오지 않은 경우에만 미관측으로 처리하며, 이때에도 같은 명령을 다시 실행하지 않는다.

## worker-list와 liveness

감독 작업의 실시간 상태는 해당 Run의 `worker-list`에서 확인한다. 이 조회 없이 계획의 존재나 최근 커밋만으로 실행 중이라고 판단하지 않는다.

각 worker의 liveness는 `live`, `unverifiable`, `exited` 중 하나이며 세 값을 서로 대체하지 않는다. `live`는 프로세스가 확인된 상태, `exited`는 종료가 확인된 상태, `unverifiable`은 조회가 실패하여 **어느 쪽인지 알 수 없는 상태**다. `unverifiable`을 실행 중으로 추정하거나 종료로 단정하지 않고 그대로 보존해 보고한다.

`live` worker가 0명이고 `unverifiable` worker도 없으면, 계획이나 다음 단계나 기존 커밋이 있더라도 `in-progress`가 아니라 `stopped`다. `unverifiable` worker는 실행 중인 worker 수에 포함하지 않는다. `scripts/status.mjs`의 `supervisedProgressStatus`가 같은 판정을 결정적으로 계산하므로, 서술이 그 함수와 어긋나면 함수가 정본이다.

Goal이 `blocked`이면 표현을 완화하지 않고 그대로 전달한다. 다만 `workflow-status`의 `blocked`는 실패한 task가 하나 있다는 뜻이며 `workflow-retry`로 되돌릴 수 있는 일시 상태이므로, Goal의 `blocked`와 서로 옮겨 적지 않는다.

사용자에게 보고할 때에는 Goal 상태, `live` worker 수, 확인된 최근 코드 변경을 **서로 구분된 항목**으로 제시한다. 계획의 존재, 대기 중인 다음 단계, 완료된 변경, 현재 실행 중인 구현은 각각 다른 사실이다.
