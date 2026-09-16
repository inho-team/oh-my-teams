# 비대화형 감독 런타임 (Orca 없는 실행, 2단계)

- 작성: 2026-09-17
- 선행: [1단계 PoC 결과](../../experiments/HEADLESS_POC.md)
- 상태: 2단계 구현 중. 기본 실행 기반은 아직 Orca이며, 이 런타임은 명시적으로 선택할 때만 쓴다.

## 1. 목표

역할을 대화형 터미널이 아니라 **비대화형 프로세스**로 실행하고, Orca가 하던 감독 기능을 oh my teams 안에서 제공한다. 1단계 PoC는 Claude·Codex·Agy가 워크트리에서 편집·커밋하고, 종료 코드와 스트림으로 결과와 모델을 증명하며, 세션 재개로 후속 지시를 받을 수 있음을 확인했다. 2단계는 이를 감독 가능한 런타임으로 만든다.

| Orca 감독 기능 | 이 런타임의 대응 |
|---|---|
| `worker-start` (대기 감지 → 지시 주입) | 러너 프로세스가 제공자 CLI를 지시와 함께 실행 |
| `worker-list`의 liveness | 러너 PID 생존과 종료 기록(`exit.json`) |
| `worker_done` 메시지 | 마지막 응답의 종료 표식(`DONE:`/`FAILED:`) |
| `ask` / `reply` | `QUESTION:` 표식으로 턴 종료 → `headless-answer`가 같은 세션을 재개 |
| `worker-stop` | 중단 요청 파일 → 러너가 제공자 프로세스 종료 |
| 모델 증명 (`unproven`) | Claude·Agy는 스트림, Codex는 세션 기록 파일 |

## 2. 구조

```text
PM (teams-org.mjs headless-start)
  └─ 러너 (node headless-runner.mjs <turnDir>, 분리 실행)
       └─ 제공자 CLI (claude -p / codex exec / agy -p, 스트림 JSON)
```

- **러너를 둔 이유:** PM의 명령은 곧바로 돌아와야 하고, 제공자 프로세스의 종료 코드는 그 부모만 받을 수 있다. 분리 실행한 러너가 제공자 프로세스를 자식으로 두고, 출력을 파일로 흘리며, 종료를 기록한다.
- **중단은 파일로 요청한다:** Windows에서 다른 프로세스에 보낸 종료 신호는 처리기 없이 강제 종료되어 러너가 자식을 정리할 기회를 잃는다. 러너가 `stop.request` 파일을 주기적으로 확인하는 방식은 모든 플랫폼에서 같다.
- **쉘을 쓰지 않는다:** 지시문은 모델·사용자 텍스트이므로 인자로 직접 전달한다(`core.mjs`의 기존 원칙).

## 3. 기록 형식

`<state>/headless/<workerId>/` 아래에 둔다.

```text
worker.json          역할, 프로필, 제공자, 요청 모델·강도, 작업 경로, 시간 제한, 생성 시각
turns/<n>/turn.json  입력한 argv(지시문 제외), 지시문 파일, 러너·제공자 PID, 시작 시각, 재개한 세션
turns/<n>/prompt.txt 이번 턴의 지시문
turns/<n>/stream.jsonl  제공자 스트림 원문
turns/<n>/stderr.txt
turns/<n>/exit.json  종료 코드, 신호, timedOut, stopped, 종료 시각 (러너가 기록)
turns/<n>/stop.request  중단 요청 (있으면 러너가 종료 처리)
```

## 4. 상태 판정

| 상태 | 조건 |
|---|---|
| `live` | 마지막 턴에 `exit.json`이 없고 러너 PID가 살아 있다 |
| `exited` | 마지막 턴에 `exit.json`이 있다 |
| `unverifiable` | `exit.json`이 없는데 러너 PID가 없다(러너가 기록 전에 죽음). 종료로 간주하지 않는다 |

`exited`의 결과(`outcome`)는 마지막 응답의 마지막 표식 줄로 정한다.

| 표식 | `outcome` | 다음 행동 |
|---|---|---|
| `DONE: <요약>` | `done` | 검증과 검토로 넘긴다 |
| `QUESTION: <질문>` | `question` | 상위 역할이 답을 정해 `headless-answer`로 재개한다 |
| `FAILED: <이유>` | `failed` | 실패 분류로 넘긴다 |
| 표식 없음, 0이 아닌 종료, 시간 초과, 중단 | `no-marker`, `exit-error`, `timed-out`, `stopped` | 실패 분류로 넘긴다. `timed-out`은 부분 변경이 남았을 수 있다 |

## 5. 지시 규약

러너에 넘기는 지시문은 `role-spec` 머리글 뒤에 다음 규약을 붙인다.

- 사람이 지켜보지 않는다. 대화형 질문·권한 요청 도구를 쓰지 않는다. Agy의 `ask_question`처럼 응답을 기다리는 도구는 제한 시간까지 멈추게 한다.
- 진행할 수 없는 질문이 생기면 작업을 멈추고 마지막 줄을 `QUESTION: <질문>`으로 끝낸다. 답은 같은 세션의 다음 턴으로 온다.
- 끝나면 마지막 줄을 `DONE: <요약>`, 실패하면 `FAILED: <이유>`로 끝낸다.
- 임시 스크립트·의존성·내려받은 파일은 워크트리 밖에 만든다.

## 6. 제공자별 명령과 스트림 해석

| 제공자 | 첫 턴 | 재개 | 세션 ID | 모델 증명 | 마지막 응답 |
|---|---|---|---|---|---|
| Claude | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions [--model] [--effort]` (지시 stdin) | `--resume <id>` 추가 | `system/init.session_id` | `system/init.model` | `result.result` |
| Codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox [-m] [-c model_reasoning_effort=] <지시>` | `codex exec resume <id> …` | `thread.started.thread_id` | `$CODEX_HOME/sessions/**/rollout-*-<id>.jsonl`의 `turn_context.model` | 마지막 `agent_message.text` |
| Agy | `agy --output-format stream-json --dangerously-skip-permissions [--model] -p <지시>` | `--conversation <id>` 추가 | `init.conversation_id` | `init.model` | `result.response` |

모델 판정은 요청과 보고가 같으면 `matched`, 다르면 `mismatched`, 요청이 없으면 `unrequested`, 보고를 찾지 못하면 `unproven`이다. Claude의 `sonnet` 같은 별칭은 보고 모델(`claude-sonnet-5`)과 문자열이 다르므로, 요청이 별칭이면 `alias`로 구분해 보고 모델을 함께 적는다.

## 7. 명령

```text
node <runtime> headless-start  --org FILE --role ROLE --cwd DIR --spec TEXT --state DIR [--workflow-id ID] [--timeout-ms N] [--worker ID]
node <runtime> headless-status --state DIR --worker ID [--wait-ms N]
node <runtime> headless-answer --state DIR --worker ID --text TEXT [--timeout-ms N]
node <runtime> headless-stop   --state DIR --worker ID
node <runtime> headless-list   --state DIR
```

`headless-start`는 `role-terminal`·`worker-start`와 같은 역할 검사를 한다. 주인 체크아웃 거부, 다른 역할의 워크트리 거부, 이번 실행에 없는 역할 거부, 프로필의 실행 파일 검사가 여기에 해당한다.

## 8. 이번 단계 범위 밖

- PM·PL 스킬의 기본 실행 경로 전환과 kickoff 전체를 이 런타임으로 끝까지 실행하는 일(4단계 전환 전 별도 확인).
- 폰에서 보는 대시보드(3단계).
- 할당량 소진 신호의 실패 분류 연결. 스트림 원문은 보존하므로 이후 연결한다.
- Ollama. 기존 `work` 하네스가 이미 비대화형이다.
