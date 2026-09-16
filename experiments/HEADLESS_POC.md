# Orca 없는 비대화형 역할 실행 PoC (1단계)

- 실행일: 2026-09-17
- 스크립트: [`headless-worker-poc.mjs`](headless-worker-poc.mjs)
- 원본 기록: `experiments/results/headless-poc-2026-09-16T23-27-21-607Z/` (Git 제외)
- 환경: macOS 15.7.4, Claude Code 2.1.273, Codex CLI 0.154.0, Antigravity CLI 1.2.4

## 질문

역할을 Orca 터미널 대신 비대화형 프로세스로 실행하면, Orca 없이도 다음을 관측할 수 있는가?

1. 격리된 워크트리에서 파일을 편집하고 커밋하는가
2. 프로세스 종료로 완료와 실패를 판정할 수 있는가
3. 실제 실행 모델을 증명할 수 있는가
4. 작업 중 대화(`ask`/`reply`)를 세션 재개로 대신할 수 있는가

## 방법

임시 Git 저장소를 만들고, 제공자마다 `local-adapter.mjs`의 `createWorkspace`로 일반 Git 워크트리를 만들었다. 각 워크트리에서 같은 구현 과제를 비대화형으로 실행했다. 과제는 `poc/<provider>.md` 파일 하나를 정해진 내용으로 만들어 정해진 메시지로 커밋하고, 다른 파일은 남기지 않으며, `DONE <sha>` 한 줄로 끝내는 것이다.

| 제공자 | 실행 명령 |
|---|---|
| Claude | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model sonnet` (지시는 stdin) |
| Codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox "<지시>"` (모델 인자 없음, 계정 기본값) |
| Agy | `agy --output-format stream-json --dangerously-skip-permissions --model gemini-3.8-flash-high --print-timeout 5m -p "<지시>"` |

그다음 세 세션을 **동시에** 비대화형으로 재개해, 파일 경로를 다시 알려 주지 않고 "이전 턴에 만든 파일에 둘째 줄을 추가해 `poc: resumed`로 커밋하라"고 지시했다.

## 결과

### 첫 작업

| 항목 | Claude | Codex | Agy |
|---|---|---|---|
| 종료 코드 / 시간 | 0 / 16.6초 | 0 / 9.9초 | 0 / 52.2초 |
| 커밋과 파일 내용 | 일치 | 일치 | 일치 |
| 변경 파일 | `poc/claude.md`만 | `poc/codex.md`만 | `poc/agy.md`만 |
| 워크트리에 남은 파일 | 없음 | 없음 | 없음 |
| 보고한 `DONE` SHA | 실제 커밋과 일치 | 일치 | 일치 |
| 스트림의 모델 | `claude-sonnet-5` (`system/init`) | **없음** | `gemini-3.8-flash-high` (`init`) |
| 세션 ID 위치 | `system/init.session_id` | `thread.started.thread_id` | `init.conversation_id` |

Codex의 JSONL 스트림에는 모델이 없다. 대신 Codex가 남기는 세션 기록 `~/.codex/sessions/**/rollout-*-<thread_id>.jsonl`의 `turn_context`에 `model: gpt-5.6-sol`, `effort: low`, 작업 경로가 기록되어 있어, `thread_id`로 찾으면 모델을 증명할 수 있다.

Agy는 처음 여는 폴더였지만 비대화형 모드에서는 폴더 신뢰 질문으로 멈추지 않았다. 대화형 터미널에서 겪은 `tui-idle` 문제(stablyai/orca#21110)도 생기지 않는다.

### 세션 재개

| 항목 | Claude | Codex | Agy |
|---|---|---|---|
| 재개 명령 | `claude -p --resume <session_id> …` | `codex exec resume <thread_id> --json …` | `agy --conversation <id> … -p` |
| 종료 코드 | 0 | 0 | 0 |
| 이전 맥락 유지 | 경로를 알려 주지 않았는데 같은 파일에 둘째 줄 추가 | 같음 | 같음 |
| 새 커밋 `poc: resumed` | 생성, `DONE` SHA 일치 | 생성, 일치 | 생성, 일치 |
| 재개 후 세션 ID·모델 | 같은 세션, `claude-sonnet-5` | 같은 thread | 같은 conversation, `gemini-3.8-flash-high` |

세 재개를 동시에 실행해도 서로 간섭하지 않았다.

## 결론

네 질문 모두 세 제공자에서 **예**다. 역할을 비대화형 프로세스로 실행하면 Orca 터미널이 하던 일 가운데 다음이 더 단순하고 확실해진다.

| 기능 | Orca 대화형 터미널 | 비대화형 프로세스 |
|---|---|---|
| 지시 전달 | 대기 감지 후 화면 주입 | 실행 인자나 stdin |
| 완료·실패 | 화면·훅으로 추정, `worker_done` 메시지 | 종료 코드와 마지막 스트림 이벤트 |
| 모델 증명 | 화면에서 읽어 `unproven` | Claude·Agy는 스트림, Codex는 세션 기록 |
| 작업 중 대화 | 메일함 `ask`/`reply` | 한 턴을 끝내고 같은 세션을 재개 |
| Agy 대기 감지 | 우회 필요 | 문제 없음 |

## 아직 확인하지 않은 것 (2단계 이후)

- **긴 작업과 중단:** 시간 제한 초과, 강제 종료, 부분 커밋 처리. 이번 과제는 모두 1분 안에 끝났다.
- **작업 중 질문:** 에이전트가 스스로 질문해야 할 때 턴을 끝내고 질문을 남기게 하는 지시 형식. Agy는 도구 목록에 `ask_question`, `ask_permission`이 있어, 비대화형에서 이 도구를 부르면 `--print-timeout`까지 기다릴 수 있다.
- **할당량·속도 제한:** Claude 스트림의 `rate_limit_event`와 각 제공자의 소진 신호를 실패 분류에 연결하는 일.
- **Windows:** 이번 PoC는 macOS에서만 실행했다.
- **Ollama:** 이번 비교에 넣지 않았다. 기존 `work` 하네스 경로가 이미 비대화형이다.
- **보이는 것:** 실행 스트림과 상태를 폰에서 볼 대시보드는 3단계 범위다.
