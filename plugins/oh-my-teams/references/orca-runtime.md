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

제한 편집 하네스는 `scripts/providers.mjs`가 프로필의 모델 ID를 인자 배열에 추가한다. 일반 감독 작업에서 Orca가 Agy를 아는 agent ID는 `agy`가 아니라 `antigravity`이며, `worker-start --model`은 Claude·Codex·Cursor에만 적용되고 권한 우회 플래그는 어느 실행기에도 전달하지 못한다. 그래서 Claude·Codex·Agy 역할은 모두 아래 「worker-start 래퍼」의 터미널 경로로 시작한다. `role-terminal`로 모델과 권한 우회 플래그를 명령줄에 담은 터미널을 먼저 열고, 화면에서 모델을 확인한 뒤 그 터미널에 작업을 넘긴다. 화면의 모델이 요청과 다르거나 확인할 수 없으면 작업을 넘기지 않는다. 계정·모델을 다른 실행기로 임의 대체하지 않는다.

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

`agent_unconfigured`는 `execution-unconfigured`로 옮겨 PM의 프로필 재바인딩으로 보낸다. 같은 프로필로 재시도하면 같은 거부가 재현되기 때문이다. `worker-start --terminal`이 호출 전 `tui-idle` 점검에서 받은 `timeout`도 같은 이유로 이 래퍼가 직접 `execution-unconfigured`로 옮긴다. 다른 명령의 `timeout`에는 이 경로를 적용하지 않으므로 번역표에는 넣지 않는다. `inject_rejected`, `runtime_error`, `failed`, `outcome_unknown`, `start_unknown`, `turn_start_unobserved`는 프로세스 상태를 미상으로 표시해 `process-unknown`으로 보낸다. 이 경로의 재시도는 실제 종료를 확인해야 열리므로, 잔여 자원을 점검한 뒤에 대체 실행을 시작하라는 Orca의 요구와 같은 규율이 된다.

표에 없는 코드는 중립 신호 없이 원문만 보존한다. 알지 못하는 거부에 임의로 경로를 부여하면 해결할 수 없는 담당자에게 작업이 전달된다.

실패 기록을 남길 때 **래퍼(`worker-start`, `terminal-idle-check` 등)가 거부 결과에 `signal`을 돌려주었으면 그 객체를 `signal` 필드에 그대로 옮긴다.** 래퍼는 이미 번역을 마쳤고, 사전 점검의 `timeout`처럼 번역표에 일부러 넣지 않은 코드도 있으므로 `runtime`·`code`로 다시 적으면 `unknown`으로 분류된다. 래퍼 없이 Orca 명령을 직접 실행해 받은 거부만 실행 기반이 반환한 코드를 그대로 적고 어느 실행 기반인지 함께 밝힌다. `failure-classify`가 번역까지 수행하므로 중립 어휘로 바꾸어 적으려 하지 않는다.

```json
{
  "message": "관측한 내용",
  "evidence": "receipt ...",
  "signal": { "kind": "execution-unconfigured", "code": "timeout", "message": "래퍼가 돌려준 문장" }
}
```

```json
{
  "message": "관측한 내용",
  "evidence": "run_...",
  "runtime": "orca",
  "code": "agent_unconfigured"
}
```

`runtime`은 `orca` 또는 `local`이며, `runtime`을 적었으면 `code`도 반드시 적는다. 둘 다 없는 기록은 이전과 똑같이 분류된다.

## worker-start 래퍼

감독 worker는 역할 이름과 조직 파일로만 시작한다. 원시 `orca orchestration worker-start`로 `--agent`와 `--model`을 손으로 적지 않는다. 손으로 적은 명령은 저장된 모델을 빠뜨려도 아무 오류 없이 계정 기본 모델로 실행되고, 보고서는 여전히 역할의 프로필을 적기 때문이다. kickoff 안에서는 항상 그 workflow를 함께 지정한다.

```text
node <runtime> worker-start --org <organization.json> --role <pl|senior|junior|intern> --repo <coordinator-worktree> --workflow-id <workflowId> --state <coordinator-state> --terminal <handle> --worktree <selector> --spec <작업> [--run <runId>]
```

`--terminal`에는 아래 「역할 터미널에서 시작」 절에 따라 `role-terminal`로 연 터미널을 넘긴다. 래퍼는 새 agent 터미널을 띄우지 않는다.

래퍼는 worker가 시작되면 receipt의 `effects`에 기록된 agent 터미널의 탭 제목을 역할 태그로 시작하게 바꾼다. 제목은 `[PL] <워크트리 이름>` 형식이며, `--title`을 주면 워크트리 이름 대신 그 문구가 태그 뒤에 온다. `--worktree current`처럼 워크트리 이름을 알 수 없고 `--title`도 없으면 제목을 바꾸지 않고 `role-terminal`이 붙인 제목을 유지한다. 같은 워크트리에서 같은 역할을 둘 이상 띄울 때에는 `--title`로 작업을 구분한다. 결과의 `title`과 `titlePinned`가 적용한 제목과 성공 여부를 나타내며, 제목 변경에 실패해도 이미 시작된 worker를 실패로 처리하지 않는다. 탭 제목을 붙이는 이유는 아래 「역할 탭 제목」 절에 있다.

`--workflow-id`와 `--state`를 주면 래퍼는 조직 파일 대신 그 workflow가 만들어질 때 고정한 조직 스냅샷을 읽고, workflow에 기록된 이번 실행의 역할 목록으로 역할을 접는다. 실행 도중 `adjust`로 바뀐 조직이나 삭제된 역할이 진행 중인 kickoff에 섞이지 않게 하기 위해서다. workflow를 주지 않으면 `--org`의 파일을 읽고 조직이 선언한 역할로 접는다.

그다음 역할 프로필에서 시작 경로와 Orca agent, 모델, 강도를 정한다.

| 실행기           | 시작 경로                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude·Codex·Agy | 아래 「역할 터미널에서 시작」 절에 따라 `role-terminal`로 모델·강도·권한 우회 플래그를 담은 명령의 터미널을 열고, 그 터미널을 `--terminal`로 넘긴다. `--terminal` 없이 호출하면 거부한다. |
| Agy(Windows, `gemini` 모델) | Windows의 Orca는 이 터미널의 대기를 보고하지 않으므로 감독 worker로 띄우지 않고 `headless-start`로 실행한다(아래 Agy 대기 판정 문단). |
| Ollama           | 대화형 Orca agent가 없으므로 감독 worker로 띄우지 않고 `work` 하네스로 실행한다.                                                                                           |

Claude·Codex 역할도 `worker-start --agent`로 띄우지 않는 이유는 권한 우회 플래그를 보장할 수 없기 때문이다. 자세한 근거는 아래 「역할 탭 제목」 절의 권한 우회 플래그 문단에 있다.

이 경로에서는 Orca가 Codex 작업 폴더를 미리 신뢰해 두지 않는다. Orca 1.4.203은 Codex를 직접 띄울 때(`worker-start --agent codex`, `worktree create --agent codex`) 시작 전에 그 워크트리를 `~/.codex/config.toml`에 신뢰한 프로젝트로 기록한다. `terminal create --command`는 명령이 agent 이름 하나뿐일 때에만 이 기록을 남기므로, `role-terminal`이 입력하는 `codex --dangerously-bypass-approvals-and-sandbox --model <model>`에는 적용되지 않는다. 그래서 한 번도 신뢰한 적 없는 저장소의 워크트리에서 Codex 역할을 열면 Codex의 폴더 신뢰 화면이 나올 수 있다. 권한 우회 플래그가 이 화면을 건너뛰는지는 확인하지 않았다. 화면이 나오면 `role-terminal`은 답하지 않고, `terminal-idle-check`와 `worker-start`가 `agent-trust-workspace`로 거부하므로 kickoff는 사람이 답할 때까지 멈춘다. 이때에는 사용자가 그 터미널에서 신뢰를 한 번 선택하거나, 해당 저장소에서 `codex`를 한 번 직접 실행해 신뢰해 둔 뒤 `terminal-idle-check`부터 다시 진행한다. OMT는 사용자의 Codex 설정 파일에 신뢰 항목을 직접 쓰지 않는다.

`--agent`, `--model`, `--effort`는 프로필과 같은 값이어도 받지 않고 Orca를 호출하기 전에 거부한다. 모든 역할은 `--terminal`로 시작하며, Orca는 `--terminal`과 이 옵션들을 함께 받지 않고 터미널은 처음 열 때의 모델을 유지하기 때문이다. `--terminal`과 `--worktree new-child`를 함께 주면 Orca가 넘겨받은 터미널에 워크트리를 만들지 않으므로 역시 호출 전에 거부한다. 다음 경우에도 호출 전에 거부한다.

- 역할이 PM이거나 PM으로 접힌다. 거부 문구는 조직에 선언되지 않은 역할(`is not declared`)과 이번 실행의 깊이에서 빠진 역할(`is not in this run's roles`)을 구분한다. PM은 coordinator이며 아래 「coordinator 실행」으로 띄운다.
- 프로필이 현재 계정이 아니거나, `env` 또는 추가 인자로 계정을 고른다. Orca agent ID는 실행 파일만 가리키므로 계정을 표현하지 못한다. 이런 프로필은 `role-command`도 거부하므로 감독 worker로 띄울 수 없고, 프로필의 명령과 환경변수 참조를 그대로 쓰는 `work` 하네스로 Ollama와 같이 실행한다.
- 프로필이 모델 없이 강도만 기록한다. Orca는 `--model` 없는 `--effort`를 거부한다.
- 받은 워크트리가 이번 workflow에서 다른 역할의 task가 작업하는 워크트리다. 아래 「역할과 워크트리」 절을 따른다.

`--spec` 앞에는 받는 역할의 머리글이 붙는다. 머리글에는 역할, 보고 대상, 이번 실행에 없어 이어받는 역할, 직접 배정할 수 있는 역할, 조직 파일 경로, workflow ID와 coordinator state 경로, 그리고 역할 스킬의 `권한·책임·한계` 절 전문이 들어간다. 중첩 worker로 실행되는 PL은 이 경로로 자기 하위 역할을 시작한다. `task-create`로 만든 Task를 `--task`로 시작할 때에는 래퍼가 머리글을 붙일 수 없으므로, Task 설명을 `node <runtime> role-spec --org <organization.json> --role <역할> --workflow-id <workflowId> --state <coordinator-state> --spec <작업>`의 출력으로 만든다.

시작 결과의 `binding`에는 `via`, `modelRequested`, `effortRequested`, `modelProof`, `screenCheck`가 남는다. `via`는 항상 `terminal`이며, `modelProof`는 다음 둘 중 하나다.

| 값            | 뜻                                                                                                       | 다음 행동                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `unproven`    | 프로필 모델로 연 터미널에 작업을 넘겼다. Orca는 `--terminal` 시작의 receipt에 모델을 기록하지 않는다. | 화면에서 모델을 확인하기 전에는 요청 모델로 실행 중이라고 보고하지 않는다.                                                                  |
| `unrequested` | 프로필 모델이 `null`이라 모델을 요청하지 않았다.                                                         | 보고서에 특정 모델명을 쓰지 않고 계정 기본값이라고 적는다. 현재 해석값이 필요하면 `host-defaults` 결과를 `현재 해석값`으로 구분해 덧붙인다. |

`work` 하네스가 쓰는 `matched`와 `mismatched`는 이 래퍼에서 나오지 않는다. 모델의 증거는 receipt가 아니라 화면이므로, `screenCheck`가 `required`이면 `role-terminal` 결과의 `screen`을 확인한 데 이어 시작 직후 `worker-read --dispatch <id> --source terminal`이나 `terminal read --screen`으로 대화형 화면에 표시된 현재 모델을 다시 확인하고, `modelRequested`와 다르면 추가 지시를 보내지 않고 상위에 보고한다.

### 역할과 워크트리

역할은 다른 역할의 task가 작업하는 워크트리에서 시작하지 않는다. literacy-test kickoff에서 PM은 Agy가 이미 신뢰를 받아 둔 Junior의 워크트리에 Agy Senior 검토자를 띄웠고, 검토 뒤 그 워크트리에는 URL 확인용 Playwright 파일(`package.json`, `node_modules/`, 테스트 스크립트)이 커밋되지 않은 채 Junior의 보고서 옆에 남았다. 같은 워크트리를 쓰면 한 역할의 부산물이 다른 역할의 산출물에 섞이고, 누가 남긴 변경인지도 가릴 수 없다.

- 검토 역할은 검토 대상을 **경로와 커밋으로 읽고**, 자기 워크트리에서 실행한다. PL이나 PM이 띄운 Senior는 `--worktree current`로 띄운 역할의 워크트리를 쓰고, 파일을 만들어야 하는 검토는 새 워크트리를 만든다.
- Agy의 폴더 신뢰 질문은 `role-terminal`이 답하고 터미널을 다시 열어 처리하므로, 신뢰를 피하려고 이미 신뢰된 다른 역할의 워크트리를 빌리지 않는다.
- `role-terminal`과 `worker-start`는 `--workflow-id`와 `--state`를 받으면, workflow의 각 시도에 기록된 `worktreeId`와 역할을 대조해 이 규칙을 강제한다. 워크트리가 다른 역할의 것이면 터미널을 만들기 전에 `is where <역할> works on task <task>`로 거부한다. 워크트리를 기록한 역할 자신과, 그 역할이 배정할 수 있는 하위 역할은 허용한다. 예를 들어 PL의 워크트리에서 Senior는 실행할 수 있지만, Junior의 워크트리에서 Senior는 실행할 수 없다. `new-child`는 아직 아무도 쓰지 않는 워크트리라 대조하지 않으며, `current`와 `active`는 `worker-start`에서는 `--repo`, `role-terminal`에서는 명령을 실행한 디렉터리로 해석한다. 이 거부를 우회하려고 워크트리 선택자를 바꾸지 않는다.

### 역할 터미널에서 시작

모든 감독 역할은 모델·강도·권한 우회 플래그를 명령줄에 담아 터미널을 먼저 열고, 화면에서 모델을 확인한 뒤 그 터미널에 작업을 넘긴다. Claude·Codex·Agy 모두 같은 순서를 따르며, 예외는 Windows에서 모델이 `gemini`로 시작하는 Agy 역할뿐이다. 이 역할은 아래 Agy 대기 판정 문단에 따라 `headless-start`로 실행한다. Orca는 `--terminal`과 새 워크트리 생성을 함께 받지 않으므로, 별도 워크트리가 필요하면 먼저 만든다. PL의 워크트리에서 실행하는 Senior처럼 기존 워크트리를 쓰면 첫 줄을 건너뛰고 두 명령에 같은 워크트리 선택자를 넘긴다.

```text
<orca> worktree create --name <name> --parent-worktree active --json
node <runtime> role-terminal --org <organization.json> --role <역할> --worktree id:<worktreeId> --workflow-id <workflowId> --state <coordinator-state>
node <runtime> terminal-idle-check --terminal <handle>
node <runtime> workflow-reserve --id <workflowId> --state <coordinator-state> --revision <n> --execution <reserve.json>
node <runtime> worker-start --org <organization.json> --role <역할> --repo <coordinator-worktree> --workflow-id <workflowId> --state <coordinator-state> --terminal <handle> --worktree id:<worktreeId> --spec <작업>
```

`role-terminal`과 `worker-start`에는 같은 `--workflow-id`와 `--state`를 넘긴다. 그래야 두 명령이 같은 조직 스냅샷과 이번 실행의 역할을 읽는다. 터미널은 한 역할의 프로필로 미리 만들어지므로, 두 명령 모두 요청한 역할이 이번 실행에 실제로 있을 때에만 받아들인다. 이번 실행에 없어 다른 역할로 접히는 역할을 요청하면 어느 역할로 접히는지 알리며 거부하고, 그때에는 접힌 역할의 터미널을 연다. `role-terminal`이 여는 명령은 `role-command`와 같으며, 아래 「역할 터미널 열기」 절을 따른다. 결과의 `ready`가 `true`이고 `screen`에 표시된 모델이 프로필의 모델과 같을 때에만 결과의 `terminal`을 `worker-start --terminal`에 넘긴다. 신뢰 질문 때문에 터미널을 다시 열었다면 넘기는 값은 `reopened.closedTerminal`이 아니라 결과의 `terminal`이다. 이 경로의 `modelProof`는 항상 `unproven`이므로 작업을 넘긴 뒤에도 보고서에 모델을 적을 때에는 화면에서 확인한 사실로 적는다.

Orca의 `worker-start --terminal`은 넘겨받은 터미널이 인식한 agent를 실행 중일 때에만 받아들이고, 아니면 `agent_unconfigured`로 거부한다. Orca 1.4.203은 명령으로 실행한 터미널에서 전경 프로세스를 보고 agent를 인식한다. `claude`와 `codex`는 각각 `claude`, `codex` agent로, `agy`는 `antigravity` agent로 인식한다. 인식하지 못해 `agent_unconfigured`나 `inject_rejected`로 거부하면 같은 명령을 반복하지 않고 거부 원문과 함께 상위에 보고한다.

Orca의 `worker-start`는 Dispatch를 먼저 만든 뒤, 넘겨받은 터미널이 `tui-idle`에 이를 때까지 기다리고 이르지 않으면 작업을 주입하지 못한 채 실패한다. 이렇게 실패하면 회수할 Dispatch가 남고 시도 예산도 줄어든다. 그래서 `worker-start --terminal`은 Orca를 호출하기 전에 같은 터미널에 `terminal wait --for tui-idle`을 20초 동안 실행하고, `timeout`이 돌아오면 Orca를 호출하지 않고 거부한다. 이때 Dispatch는 만들어지지 않는다. `workflow-reserve`로 시도를 예약한 뒤 이 거부를 받으면, `workflow-release`로 예약을 반납해도 시도는 소진된 채 남는다. 그래서 같은 점검을 `terminal-idle-check`로 **예약보다 먼저** 실행하고, 통과한 터미널에만 시도를 예약한다. 이 명령은 아무것도 만들지 않으며, 거부할 때 `worker-start`와 같은 신호를 돌려준다.

화면에 폴더 신뢰, 업데이트, 명령 승인 같은 질문이 남아 있으면 Orca는 기다리지 않고 `satisfied: false`와 `blockedReason`(예: `agent-trust-workspace`, `agent-approval-prompt`)을 돌려준다. 응답 봉투 자체는 `ok: true`이므로, `terminal-idle-check`와 `worker-start --terminal`의 사전 점검은 이 경우도 대기 상태가 아닌 것으로 보고 `blockedReason`을 신호의 `code`로 삼아 Dispatch 없이 거부한다. 질문에는 터미널 앞의 사람만 답할 수 있으므로 이 신호에는 경로를 정하지 않으며, 화면을 증거로 붙여 상위에 보고한다.

Orca 1.4.203은 Claude 터미널의 대기 상태를 agent가 보내는 터미널 제목(`✳`로 시작하는 제목)과 상태 훅으로, Codex 터미널은 같은 신호와 화면의 `OpenAI Codex` 배너(`model:`과 `directory:` 줄)로 판정한다. 대기 중인 Claude 터미널에 `terminal wait --for tui-idle`을 실행하면 곧바로 `satisfied: true`가 돌아오는 것을 확인했다. Codex 터미널은 소스에서 판정 규칙만 확인했고 실제 터미널로는 확인하지 않았다. Claude·Codex 터미널이 `timeout`으로 거부되면 agent가 아직 화면을 그리는 중이거나 다른 입력을 처리하는 중이므로, 화면을 읽어 확인한 뒤 보고한다. Claude의 폴더 신뢰 질문이나 권한 우회 모드를 처음 켤 때 나오는 확인 질문은 `role-terminal`이 답하지 않는다. 이런 질문이 새 워크트리에서 나오면 위 사전 점검이 `blockedReason`과 함께 거부하므로, 사람이 그 터미널에서 답한 뒤 다시 점검한다. 실제 Claude·Codex 역할 터미널에서 이 질문이 나오는지는 아직 확인하지 않았다.

Orca는 `antigravity` 터미널의 대기 상태를 화면으로 판정한다. `Antigravity CLI` 배너 뒤에 `gemini`로 시작하는 줄과 `>`만 있는 줄이 모두 있어야 대기로 본다. Orca가 여는 폭에서 Agy 1.2.4는 로고를 배너 **왼쪽에** 그리므로 모델 줄이 로고 문자로 시작하고, 이 판정이 끝내 실패한다. Agy가 보내는 `Stop` 훅은 이 판정을 대신하지 않는다. 그래서 `role-terminal`은 모델이 `gemini`로 시작하는 Agy 역할을 POSIX 셸에서는 `stty cols 44;`를, Windows의 PowerShell에서는 `mode con: cols=44;`를 앞에 붙여 띄운다. 이 폭에서는 로고가 배너 위로 올라가므로 Orca가 대기를 보고하고, `worker-start --terminal`이 감독 worker로 시작한다. 결과의 `launched`와 `columns`에 실제로 입력한 명령과 폭이 남는다. 이 폭은 그 터미널의 작업 화면에도 적용된다. macOS의 실제 Orca에서는 이 방법으로 감독 worker가 시작되고 `worker_done`까지 도착하는 것을 확인했다. Windows에서는 이 방법이 통하지 않는다는 것이 실제 Orca에서 확인되었다([#46](https://github.com/inho-team/oh-my-teams/issues/46)). `mode con: cols=44`로 폭은 바뀌고 화면 배치도 macOS와 같아졌지만 Orca는 대기를 보고하지 않았다. 또 `mode con: …; agy …`로 연 터미널의 제목이 `powershell.exe`로 남아 Orca가 agy로 인식하지 못했고, 아래 예외 경로의 주입도 `no_agent_detected`로 거부되었다. 따라서 Windows에서 모델이 `gemini`로 시작하는 Agy 역할은 Orca 터미널로 시작하지 말고 `headless-start`로 실행한다. 이 경로는 Orca의 터미널과 에이전트 인식을 거치지 않으며, Windows 11에서 `gemini-3.8-flash-medium` 역할이 파일을 만들고 커밋한 뒤 `done`, `modelProof: matched`로 끝나는 것을 확인했다(`docs/plan/headless-runtime.md`의 Windows 검증). 모델 이름이 `gemini`로 시작하지 않는 Agy 프로필(예: Agy에서 실행하는 Claude, GPT-OSS)은 폭과 무관하게 이 판정을 통과하지 못하므로 아래 예외 경로의 대상이다. 원인과 재현 방법은 Orca에 보고했다([stablyai/orca#21110](https://github.com/stablyai/orca/issues/21110)). Orca가 고치면 이 폭 조정과 예외 경로는 필요 없어진다.

이 거부의 신호는 `code: "timeout"`, `kind: "execution-unconfigured"`이며 `failure-classify`는 PM의 `rebind-profile-agent`로 보낸다. 신호는 실행기를 구분하지 않지만, 같은 프로필의 터미널로 다시 시작해도 같은 거부가 재현된다는 판단은 Agy 터미널에만 해당한다. Claude·Codex 터미널은 위 문단대로 화면을 확인해 보고하며, 어느 경우에도 같은 명령을 반복하지 않는다. `adjust`는 진행 중인 kickoff의 조직 스냅샷을 바꾸지 않고 실행 중 프로필을 다시 묶는 절차도 없으므로, PM은 그 역할에 작업을 넘기지 않고 멈춘 뒤 거부 원문과 함께 사용자에게 보고한다. 원시 `orchestration dispatch --inject`로 직접 주입해 우회하지 않는다.

**주입 예외 경로.** 사용자가 이 한계를 알고 주입을 승인한 경우에만, 같은 `worker-start` 명령에 `--inject-fallback "<누가 무엇을 승인했는지>"`를 붙여 다시 실행한다. 래퍼는 사전 점검이 `timeout`으로 거부한 Agy 터미널에 한해 `task-create`와 `dispatch --inject`로 작업을 넘기고, 다음을 결과에 남긴다. Claude·Codex 역할에 이 옵션을 붙이면 Orca를 호출하기 전에 거부한다. 이 예외는 Orca가 Agy 터미널의 대기를 보고하지 못하는 한계 때문에 있으며, 대기에 이르지 못한 Claude·Codex 터미널은 작업 중이거나 질문에 멈춘 상태라 주입하면 안 되기 때문이다.

- `via: "dispatch-inject"`, `supervised: false`, `approval`(받은 승인 문장), `refusal`(사전 점검의 거부 신호), `taskId`, `dispatchId`, `injected`.
- `liveness: "unverifiable"`, `binding.modelProof: "unproven"`.
- `limitations`: `worker-list`가 liveness를 보고하지 않고, `worker-release`가 터미널을 회수하지 않으며, 모델이 증명되지 않는다는 세 가지.

workflow에 연결할 때에는 `dispatchId`를 실행 ID로 쓰고, receipt에 `via`와 화면에서 확인한 모델을 함께 적는다. 진행은 `check --wait`와 터미널 화면으로 따라가고, 작업이 끝나면 터미널을 직접 닫는다. `injected`가 `false`이면 결과에 `status: "blocked"`가 붙으므로 작업이 넘어간 것으로 보고하지 않는다. Orca가 `inject_rejected`나 `no_agent_detected`로 주입을 거부하면 래퍼는 예외를 던지지 않고 이 결과를 돌려준다. 결과에는 거부 원문(`orcaResponse`), 중립 신호 `injectRefusal`(`kind: "not-started"`), 그 신호의 분류 `route`(`start-refused` → PM의 `change-launch-path`), 이번 호출이 만든 Task를 `failed`로 닫았는지 알리는 `taskClosed`가 담긴다. `taskClosed`가 `false`이고 `taskCreated`가 `true`이면 그 Task를 `orchestration task-update --status failed`로 직접 닫는다. 이 거부는 작업을 하나도 넘기지 않았다는 확정된 사실이므로, 같은 코드를 `failure-classify`에 `runtime`·`code`로 넣지 말고 결과의 `injectRefusal`을 그대로 쓴다. `worker-start` 경로의 같은 코드는 이미 띄운 에이전트가 남아 있을 수 있어 여전히 프로세스 상태 미상으로 분류되기 때문이다. 미리 예약한 시도는 `workflow-release`의 해제 파일에 `refusal`로 `injectRefusal`을 함께 넣으면 돌려받는다. 다른 해제는 지금처럼 시도를 소진한 채로 둔다. 다음 kickoff부터는 Gemini 모델 프로필이나 Claude·Codex 프로필로 바꾸도록 안내한다.

### 역할 터미널 열기

`<orca> terminal create --command`를 직접 호출해 역할 터미널을 열지 않는다. Orca는 명령을 새 셸의 프롬프트에 입력만 하고 실행하지 않는 경우가 잦으며, 이 상태에서 보낸 브리프나 작업은 agent가 아니라 셸에 입력된다. `role-terminal`은 다음을 한 번에 수행한다.

1. `role-command`와 같은 명령으로 터미널을 만든다. 모델이 `gemini`로 시작하는 Agy 역할은 POSIX 셸에서 `stty cols 44;`, PowerShell에서 `mode con: cols=44;`를 앞에 붙인다(위 「역할 터미널에서 시작」 절의 Agy 대기 판정 문단).
2. 짧게 `tui-idle`을 기다린 뒤 화면을 읽고, 마지막 줄에 명령이 프롬프트에 입력된 채 남아 있으면 Enter를 한 번 보낸다. 결과의 `submission`은 Orca가 스스로 실행했으면 `orca`, Enter를 보냈으면 `enter-sent`다. 시작된 agent에 입력이 들어가지 않도록 Enter는 두 번 보내지 않는다.
3. agent가 명령 아래에 자기 화면을 그릴 때까지 화면을 다시 읽는다. Orca의 `tui-idle`은 명령을 붙든 채 멈춘 셸에서도 충족되므로 준비 여부를 판단하는 근거로 쓰지 않는다. 화면 너비 때문에 명령이 여러 줄로 나뉘어도 같은 명령으로 인식한다.
4. Agy는 처음 여는 폴더마다 폴더 신뢰 질문("Do you trust the contents of this project?")을 띄우며, 권한 우회 플래그로도 건너뛰지 않는다. 역할의 워크트리는 사용자 저장소에서 이 실행을 위해 만든 것이고 역할은 이미 승인 없이 도구를 실행하므로, "Yes, I trust this folder"가 선택된 경우에만 Enter를 한 번 보내 신뢰한다. 결과의 `trust`는 질문이 없었으면 `not-asked`, 답했으면 `accepted`다. 신뢰한 폴더는 Agy 설정의 `trustedWorkspaces`에 남는다.
5. 신뢰 질문에 답한 터미널은 버퍼에 질문 문구가 남는다. Orca의 시작 판정기는 이 문구를 찾아 `worker-start --terminal`을 `agent-trust-workspace`로 차단하므로, 답한 뒤 질문이 화면에서 사라졌으면 그 터미널을 `terminal close`로 닫고 같은 워크트리에서 같은 명령으로 한 번만 다시 연다. 이때 신뢰는 이미 기록되어 있으므로 새 터미널에는 질문이 나오지 않는다. 결과의 `terminal`은 다시 연 터미널이고, `trust`는 `accepted`를 유지하며, `reopened`에 닫은 터미널(`closedTerminal`)과 이유가 남는다. 다시 열지 않았으면 `reopened`는 `null`이다. 다시 연 터미널에서도 질문이 나오면 신뢰가 기록되지 않은 것이므로 답하지도, 또 닫지도 않고 차단으로 돌려준다. 첫 터미널을 닫지 못했으면 새 터미널을 열지 않고 `closeError`에 오류 원문을 담아 차단으로 돌려준다.
6. 준비가 확인되면 탭 제목을 `terminal rename`으로 다시 지정한다. 그리고 같은 워크트리에서 agent가 없고, 이름이 없거나 Orca 기본 이름(`Terminal <n>`)이며, 화면에 프롬프트 한 줄만 있는 셸 탭을 `terminal close`로 닫는다. `worktree create`가 함께 여는 빈 셸이 역할 탭 옆에 남아 다른 역할의 탭처럼 보였기 때문이다. 처음에는 이 셸의 이름을 `[shell]`로 바꿨지만, Orca가 아직 화면에 띄우지 않은 탭은 이름이 `Terminal <n>`으로 되돌아가서 효과가 없었다. 사람이 이름을 붙였거나 명령을 입력한 셸, 다른 agent의 탭은 닫지 않는다. 결과의 `title`, `titlePinned`, `shellsClosed`에 적용 내용이 담긴다. 이유는 아래 「역할 탭 제목」 절에 있다.
7. 마지막 화면을 `screen`에 담는다. agent가 끝내 화면을 그리지 않았거나, 명령이 여전히 프롬프트에 남아 있거나, 신뢰 질문이 남아 있거나, 신뢰에 답한 터미널을 닫지 못했으면 `ready: false`, `status: "blocked"`로 종료 코드 1을 돌려준다. 이때는 브리프나 작업을 보내지 않고 화면을 증거로 붙여 보고한다.

### 역할 탭 제목

역할 터미널의 탭 제목은 `[PM]`, `[PL]`, `[Senior]`, `[Junior]`, `[Intern]` 태그로 시작한다. 태그가 없으면 Orca 탭에는 agent가 스스로 보내는 세션 요약 제목(예: `✳ Oh my teams kickoff coordinator`)만 보여서 어느 탭이 PM이고 어느 탭이 PL인지 구분할 수 없다. `role-terminal`의 `--title`은 태그를 대신하지 않고 태그 뒤에 붙으며, 생략하면 워크트리 이름이 붙는다.

제목은 터미널을 만들 때 한 번 주는 것으로 끝내지 않고, agent가 뜬 뒤 `terminal rename`으로 다시 지정한다. literacy-test kickoff에서 `terminal create --title`로 연 PM 탭이 나중에 사용자 지정 제목을 잃고 agent의 세션 제목으로 표시되었다. Orca는 탭 기록이 없는 터미널을 넘겨받을 때 사용자 지정 제목 없이 탭을 다시 만들기 때문이다. Orca 탭은 사용자 지정 제목을 agent가 보내는 제목보다 먼저 표시하므로, 다시 지정한 제목은 agent가 작업하는 동안에도 유지된다. 반면 `terminal show`와 `terminal list`의 `title`은 agent가 보낸 실시간 제목이므로, 이 값이 태그로 시작하지 않는다고 해서 탭 제목이 사라진 것은 아니다. agent의 제목 기능 자체는 끄지 않는다. Orca가 그 제목으로 agent의 작업 상태를 판단하기 때문이다.

역할 명령에는 실행기별 권한 우회 플래그가 붙는다. Claude와 Agy에는 `--dangerously-skip-permissions`, Codex에는 `--dangerously-bypass-approvals-and-sandbox`다. 역할 터미널에는 도구 승인 창에 답할 사람이 없고 상위 역할이 대신 승인하는 절차도 없으므로, 플래그 없이 뜬 역할은 첫 도구 호출에서 멈춘다. `worker-start --agent codex --model`로 띄운 Codex PL은 Windows 샌드박스가 `orca.cmd`를 막자 "Would you like to run the following command?"에서 멈췄다. Orca가 agent를 직접 띄울 때에는 설정의 agent별 기본 인자(`agentDefaultArgs`)를 명령에 붙인다. Orca 1.4.203 소스에서는 `--model`을 함께 줘도 기본 인자 가운데 모델 인자만 빼고 나머지를 유지한다. 그러나 이 값은 사용자가 바꿀 수 있는 설정이라 비어 있을 수 있고(이 사례의 호스트에서는 `claude`와 `codex`가 빈 문자열이었다), `worker-start`에는 인자를 더하는 옵션이 없다. `terminal create --command`로 입력한 명령에는 기본 인자가 전혀 붙지 않는다. 그래서 OMT는 Orca 설정에 기대지 않고, 모든 감독 역할을 플래그와 모델을 담은 `role-command`의 명령으로 열어 `--terminal`로 넘긴다. 래퍼는 `--terminal` 없는 시작을 거부하므로 플래그 없이 뜨는 경로가 없다. 역할 프로필의 `command`는 실행 파일 이름 하나만 허용되므로 플래그가 두 번 붙지 않는다. Codex는 같은 플래그가 두 번 오면 실행을 거부한다.

이 래퍼는 argv를 배열로 전달하고, receipt에서 Dispatch 신원을 확인한 뒤, 시작이 `ready`에 이르지 못하면 3값 liveness와 번역된 실패 신호가 담긴 receipt를 돌려준다. 거부되어 Dispatch가 만들어지지 않은 경우에만 오류를 던지며, 그 오류에도 신호와 원본 receipt가 함께 실린다.

**`worker-start`는 해당 Run에 바인딩된 coordinator 터미널에서만 호출할 수 있다.** 바인딩된 Run이 없는 상태에서 호출하면 Task의 존재 여부와 무관하게 `consumer_fenced`로 거부되므로, 먼저 같은 터미널에서 `orchestration run-create`로 Run을 만들어 바인딩한다. 이 코드는 호출한 자리가 잘못되었다는 뜻이므로 재시도로 해소되지 않으며, 번역표에 넣지 않고 증거와 함께 에스컬레이션한다.

Run을 바인딩한 뒤에는 `--spec`으로 Task와 첫 시도를 한 번에 만들 수 있고, 성공한 시작은 `state: "ready"`와 함께 `runId`, `taskId`, `dispatchId`를 돌려준다. `--agent`로 시작한 receipt의 `launch.requested`와 `launch.effective`에는 요청한 agent·모델·강도와 적용된 값이 나란히 들어 있지만, 래퍼가 쓰는 `--terminal` 시작에서는 두 값 모두 모델을 담지 않는다.

`worker-start`는 `ready`에서만 0으로 종료하고, `failed`와 `outcome_unknown`에서는 1로 종료하면서도 `dispatchId`, `failedStage`, `residualResources`를 담은 receipt를 반환한다. 따라서 종료 코드만으로 실패를 단정하지 않고 receipt를 읽는다. receipt 자체가 오지 않은 경우에만 미관측으로 처리하며, 이때에도 같은 명령을 다시 실행하지 않는다.

## coordinator 실행

PM coordinator는 감독 worker가 아니므로 `worker-start`로 띄우지 않는다. `orca worktree create --agent`에는 모델 옵션이 없어 PM 프로필의 모델을 전달할 수 없으므로, 워크트리를 agent 없이 만든 뒤 `role-terminal`로 프로필의 명령을 실행한 터미널을 연다.

```text
<orca> worktree create --name <name> --parent-worktree active --json
node <runtime> role-terminal --org <project>/.omt/organization.json --role pm --worktree id:<worktreeId> [--title <kickoff 요약>]
<orca> terminal send --terminal <handle> --text "<브리프 경로와 시작 지시>" --enter --json
```

`role-command`는 Claude에는 `claude --dangerously-skip-permissions --model <model>`, Codex에는 `codex --dangerously-bypass-approvals-and-sandbox --model <model> --config model_reasoning_effort=<effort>`, Agy에는 `agy --dangerously-skip-permissions --model <model>`을 만들고, 모델이 `null`이면 모델 인자 없이 만든다. `role-terminal`은 이 명령으로 터미널을 열며 동작은 위 「역할 터미널 열기」 절과 같다. `opus[1m]`의 대괄호처럼 셸이 해석하는 문자가 든 인자는 POSIX 셸과 PowerShell에서 모두 글자 그대로 읽히는 작은따옴표로 감싼다. 실행 파일은 PATH에 있는 이름만 받는다. PowerShell은 따옴표로 감싼 경로를 명령이 아니라 문자열로 읽기 때문이다. 브리프를 보내기 전에 결과가 `ready: true`인지, `screen`에 표시된 모델이 `modelRequested`와 같은지 확인한다. `modelRequested`가 `null`이면 화면의 모델을 `host-defaults`의 현재 해석값과 대조한다. `role-terminal`이 프로필을 거부하거나, `ready: false`이거나, 화면의 모델이 다르면 브리프를 보내지 않고 사용자에게 보고한다. 이 경우 다른 실행기나 기본 모델로 대신 띄우지 않으며, 선언 세션이 coordinator를 대신 맡지도 않는다.

## 무응답 worker 감독

`check --wait`의 제한 시간은 완료나 실패의 근거가 아니지만, 아무것도 하지 않고 다시 기다리는 근거도 아니다. 감독 역할(PM, PL)은 제한 시간을 조직의 `policy.supervision.progressCheckMs`로 두고, 제한 시간이 지날 때마다 `worker_done`을 보내지 않은 worker 각각에 대해 다음을 수행한다. 값이 없는 조직은 기본값 15분(`900000`)과 `unansweredLimit` 2를 쓴다.

1. `worker-list`로 liveness를, `worker-show --dispatch <id>`로 `observation.agentWait`를 조회한다.
2. 관측 파일에 다음을 적어 `node <runtime> supervision-next --org <organization.json> --observation <observation.json>`을 실행한다. 마지막 heartbeat, 메시지, 출력 변화 가운데 가장 최근 시각은 `lastActivityAt`, 그 뒤로 답을 받지 못한 진행 요청 수는 `unansweredRequests`, 그 뒤로 수행한 확인 횟수는 `inspections`, 이 정체를 이미 상위에 보고했으면 그 시각은 `escalatedAt`, 그때 보고한 `reason`은 `escalatedReason`이다. 새 활동이 관측되면 세 값을 비운다. 진행 요청과 확인을 합한 횟수가 `unansweredLimit`에 이르면 보고로 넘어가므로, 상태를 확인할 수 없는 worker도 무한히 확인만 반복하지 않는다.
3. 결과의 `action`대로 행동한다.

| action         | 행동                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait`         | 다시 `check --wait`로 기다린다. `reason`이 `already-escalated`이면 같은 정체를 다시 보고하지 않고, 사용자 보고에는 `display`를 그대로 적는다.                                                                                                                                                                                                                                                                                             |
| `ask-progress` | `<orca> orchestration send --to dispatch:<id> --type question --subject "진행 상황 요청" --body "현재 단계, 끝낸 항목과 남은 항목, 장애물을 알려 주세요." --json`으로 묻고, 요청 수를 하나 늘린다.                                                                                                                                                                                                                                        |
| `inspect`      | `worker-show`와 `worker-read --dispatch <id> --source auto --limit <n>`으로 상태와 최근 출력을 확인하고 `inspections`를 하나 늘린다. 확인에서 새 활동을 찾았으면 관측값을 고쳐 다시 판정한다.                                                                                                                                                                                                                                             |
| `escalate`     | `worker-read`의 제한된 출력, liveness, 무응답 시간과 보낸 요청을 증거로 붙여 상위에 보고한다. PL은 `orchestration send --type escalation`으로 PM에게, PM은 사용자에게 보고한다. `failureClassify`가 `true`이면 그 증거로 `failure-classify`를 실행한다. 보고한 시각을 `escalatedAt`으로, 판정의 `reason`을 `escalatedReason`으로 기록한다. 같은 종료나 같은 입력 대기는 다시 보고하지 않고, 보고한 뒤 사실이 바뀌었을 때만 다시 보고한다. |

이 판정은 재시도나 종료를 결정하지 않는다. 종료와 재시도는 위 「worker-start 실패 복구」와 `failure-classify` 결과를 따른다. `unverifiable` worker는 살아 있다고 간주하지 않고 확인이나 보고로 보낸다. 사용자에게 상태를 알릴 때 무응답 worker는 `진행 중`이 아니라 결과의 `display`대로 `무응답 N분`으로 적는다.

하위 worker는 진행 요청을 받으면 `orchestration reply --id <msg_id> --body <진행 상황>`으로 현재 단계, 끝낸 항목과 남은 항목, 장애물을 곧바로 답하고, injected preamble이 정한 주기로 heartbeat를 보낸다.

## worker-list와 liveness

감독 작업의 실시간 상태는 해당 Run의 `worker-list`에서 확인한다. 이 조회 없이 계획의 존재나 최근 커밋만으로 실행 중이라고 판단하지 않는다.

각 worker의 liveness는 `live`, `unverifiable`, `exited` 중 하나이며 세 값을 서로 대체하지 않는다. `live`는 프로세스가 확인된 상태, `exited`는 종료가 확인된 상태, `unverifiable`은 조회가 실패하여 **어느 쪽인지 알 수 없는 상태**다. `unverifiable`을 실행 중으로 추정하거나 종료로 단정하지 않고 그대로 보존해 보고한다.

`live` worker가 0명이고 `unverifiable` worker도 없으면, 계획이나 다음 단계나 기존 커밋이 있더라도 `in-progress`가 아니라 `stopped`다. `unverifiable` worker는 실행 중인 worker 수에 포함하지 않는다. `scripts/status.mjs`의 `supervisedProgressStatus`가 같은 판정을 결정적으로 계산하므로, 서술이 그 함수와 어긋나면 함수가 정본이다.

Goal이 `blocked`이면 표현을 완화하지 않고 그대로 전달한다. 다만 `workflow-status`의 `blocked`는 실패한 task가 하나 있다는 뜻이며 `workflow-retry`로 되돌릴 수 있는 일시 상태이므로, Goal의 `blocked`와 서로 옮겨 적지 않는다.

사용자에게 보고할 때에는 Goal 상태, `live` worker 수, 확인된 최근 코드 변경을 **서로 구분된 항목**으로 제시한다. 계획의 존재, 대기 중인 다음 단계, 완료된 변경, 현재 실행 중인 구현은 각각 다른 사실이다.
