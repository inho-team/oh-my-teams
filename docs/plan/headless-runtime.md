# 비대화형 감독 런타임 (Orca 없는 실행, 2단계)

- 작성: 2026-09-17
- 선행: [1단계 PoC 결과](../../experiments/HEADLESS_POC.md)
- 상태: 2단계(감독 런타임)와 3단계(대시보드) 구현. 기본 실행 기반은 아직 Orca이며, 이 런타임은 명시적으로 선택할 때만 쓴다.

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

`<pm-state>/headless/<workerId>/` 아래에 둔다.

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
| 실패한 turn의 오류가 사용 한도나 용량 부족 | `rate-limited` | `limitKind`(`usage-limit`, `capacity`)와 함께 `rate-limited` 신호로 실패 분류에 넘긴다 |

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
| Agy | `agy --output-format stream-json --dangerously-skip-permissions [--print-timeout <dur>] [--model] -p <지시>` | `--conversation <id>` 추가 | `init.conversation_id` | `init.model` | `result.response` |

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

## 8. 실제 CLI 검증 (2026-09-17, macOS)

임시 Git 저장소에서 역할마다 워크트리를 만들고, 임시 조직(PL=Codex `gpt-5.6-sol`, Senior=Agy `gemini-3.8-flash-high`, Junior=Claude `sonnet`)으로 세 worker를 **동시에** `headless-start`했다. 과제는 "파일을 만들기 전에 파일 이름을 질문하고, 답을 받으면 만들어 커밋하라"였다.

| 단계 | Codex (PL) | Agy (Senior) | Claude (Junior) |
|---|---|---|---|
| 1턴 결과 | `question`, 12.8초 | `question`, 8.8초 | `question`, 4.8초 |
| 1턴 뒤 워크트리 | 변경 없음 | 변경 없음 | 변경 없음 |
| 모델 판정 | `matched` (세션 기록에서 `gpt-5.6-sol`) | `matched` | `alias` (`sonnet` → `claude-sonnet-5`) |
| `headless-answer` 뒤 2턴 | `done`, 22.7초, 같은 세션 | `done`, 26.4초, 같은 세션 | `done`, 12.0초, 같은 세션 |
| 커밋과 파일 | `step2: pl`, 내용 일치 | `step2: senior`, 일치 | `step2: junior`, 일치 |
| 남은 파일 | 없음 | 없음 | 없음 |

시간 제한은 Agy worker에 `sleep 120`을 시키고 `--timeout-ms 25000`으로 확인했다. 25.9초에 `timed-out`(`exit.code: 1`, `timedOut: true`)으로 기록되었고, `sleep` 프로세스는 남지 않았다.

검증 중에 `headless-answer --text`의 답변 문장이 별도 인자로 거부되는 문제를 찾았다. `role-spec --text` 플래그가 모든 명령에 적용된 탓이며, `role-spec`에만 적용하도록 고쳤다.

### Windows 검증 (2026-09-17)

[#46](https://github.com/inho-team/oh-my-teams/issues/46)에서 Windows의 Orca 터미널 경로로는 Gemini Agy 역할을 시작할 수 없다는 것이 확인되어, 같은 역할을 헤드리스로 실행했다.

- 환경: Windows 11 Pro 10.0.26200, Antigravity CLI 1.2.4, oh-my-teams 2.2.3(`main`의 `7d24fed` 이후).
- 조직: `org-draft`로 Junior만 Agy `gemini-3.8-flash-medium`으로 둔 임시 조직. 임시 Git 저장소에서 `headless-start --role junior`로 "`hello.txt`에 `ok`를 쓰고 끝내라"는 과제를 주었다.

| 항목 | 결과 |
|---|---|
| 판정 | `liveness: exited`, `outcome: done`, `DONE` 표시에 커밋 SHA 포함 |
| 모델 | 요청·보고 모두 `gemini-3.8-flash-medium`, `modelProof: matched` |
| 결과물 | `hello.txt`에 `ok`, 커밋 `Create hello.txt containing ok` |
| 종료 | `exit.code: 0`, `timedOut: false`. 마지막 스트림 이벤트 1.7초 뒤 프로세스가 스스로 종료 |
| 소요 | 240.0초. 역할 지시에 따라 작업 디렉터리·Git 상태 확인, 파일 작성, 커밋, SHA 확인까지 도구 호출 약 30단계 |

이 검증에는 `--timeout-ms 240000`을 주었고 실행이 그 직전에 끝났다. 기본 제한 시간은 30분이므로 평소 실행에는 여유가 있지만, 제한 시간을 줄여 쓸 때에는 Windows의 Agy 역할이 이 정도 시간을 쓸 수 있다는 점을 고려한다. 질문과 답변으로 이어지는 두 번째 턴과 시간 초과 경로는 Windows에서 아직 확인하지 않았다.

## 9. 대시보드 (3단계)

Orca 탭이 보여 주던 것을 oh my teams가 직접 보여 준다. 의존성 없는 Node HTTP 서버가 worker 기록 파일을 읽어 폰 화면용 페이지로 제공한다.

```text
node <runtime> dashboard --state DIR [--port 4812] [--host 0.0.0.0] [--token TEXT]
```

| 화면 | 내용 |
|---|---|
| 목록 | worker마다 역할, 제공자·보고 모델·모델 판정, 상태(실행 중, 질문 대기, 완료, 실패 등), 질문이나 완료 요약, 턴 수, 워크트리 이름. 질문 대기 → 실행 중 → 확인 불가 → 종료 순서로 정렬한다 |
| 상세 | 세션, 작업 경로, 제공자 오류·속도 제한 표시, 턴별 지시문과 실행 기록(응답·도구·출력·오류), 표준 오류 |
| 질문 답변 | 질문 대기 worker에 답을 입력하면 같은 세션을 재개한다. 끝난 worker에는 같은 세션으로 이어서 지시할 수 있다 |
| 중단 | 실행 중인 턴을 두 번 눌러 중단한다(브라우저 확인 창을 쓰지 않는다) |

- **인증:** 서버는 폰이 테일넷으로 접근할 수 있게 기본적으로 모든 인터페이스에 바인딩하므로, 페이지와 API 모두 시작할 때 출력한 토큰을 요구한다. 토큰은 16자 이상이며, 비교는 시간 차가 드러나지 않는 방식으로 한다. 요청 본문은 64KB로 제한한다.
- **실행 기록:** 제공자 스트림을 읽기 쉬운 항목으로 바꾼다. Claude는 메시지의 텍스트·도구 호출·도구 결과, Codex는 에이전트 메시지와 명령 실행(출력·종료 코드), Agy는 조각으로 오는 응답 텍스트와 도구 호출을 쓴다. Agy 스트림에는 도구 출력이 없다.
- **갱신:** 목록은 4초, 실행 중인 상세는 2.5초, 끝난 상세는 6초마다 다시 읽는다. 답변을 입력하는 동안에는 화면을 갈아 끼우지 않는다.
- **확인:** Playwright로 390×844 화면에서 목록, 상세, 답변 전송 → 재개 → 완료 반영까지 확인했고, `devshare port`로 테일넷 접근을 확인했다.

## 10. 확인한 위험

- **워크트리 밖 접근:** 1단계 PoC에서 Agy worker가 자기 워크트리 밖의 상위 저장소에서 `git status`를 실행하고 파일을 열어 봤다. 변경은 없었지만, 비대화형 실행은 파일 접근을 워크트리로 가두지 않는다. 격리가 필요하면 제공자별 샌드박스 설정이나 운영체제 수준의 제한을 따로 검토해야 한다.

## 11. 이번 단계 범위 밖

- PM·PL 스킬의 기본 실행 경로 전환과 kickoff 전체를 이 런타임으로 끝까지 실행하는 일(4단계 전환 전 별도 확인).
- 할당량 소진 신호의 실패 분류 연결. 스트림 원문은 보존하므로 이후 연결한다.
- Ollama. 기존 `work` 하네스가 이미 비대화형이다.
