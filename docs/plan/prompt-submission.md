# 프롬프트·명령 제출 확인: 재현 기록과 설계

작성일: 2026-09-22
상태: 구현 완료. 인시던트 경로 전체는 재현하지 못했고, 확인된 범위만 고쳤다.
환경: macOS(Darwin 24.6.0), Orca 1.4.206, zsh, Claude Code 2.1.278
워크트리: `oh-my-teams/spa-submission`(기준 커밋 71f8573)

## 1. 배경

2026-09-22에 PM 터미널을 열 때 `role-terminal`이 `ready: true`를 돌려주었지만, `claude ...` 명령은 셸 입력줄에 남아 있었고 이사가 Enter를 한 번 보내서 실행되었다. 같은 날 `director-signal`은 신호를 inbox에 기록하고도 `notified: false, notifyError: "exit 1"`을 돌려주었다(stderr 없음). 두 관측 모두 입력이 수락되었다는 사실과 실제로 제출되었다는 사실을 구분하지 못한 데서 나온 문제로 보였다. 원시 화면 캡처는 남아 있지 않다.

## 2. 실험

이 워크트리에서 실험용 터미널을 새로 만들어 진행했고, 끝난 뒤 모두 닫았다. 다른 역할의 터미널에는 아무것도 보내지 않았다.

| # | 실험 | 관측 |
|---|---|---|
| 1 | `terminal create --command "echo OMT_EXP_1"` | 명령이 셸 입력줄에 입력만 되었고 실행되지 않았다. 11초 뒤에도 같았다. Orca는 `create --command`의 명령을 제출하지 않는다. |
| 2 | 위 터미널에 Enter만 전송(`--text "" --enter`) | 명령이 실행되었다. 영수증은 `accepted: true, bytesWritten: 1`이고 `prompt` 블록이 없다. |
| 3 | 셸에 `--text "echo ..." --enter --json` | `prompt.stages: ["input_accepted"]`, `provider: "unsupported"`, `observation: "unsupported"`. 경고: "input was accepted, but this provider cannot report delivery. Inspect the terminal before retrying." |
| 4 | 셸에 `--wait-submit 3` 추가 | 3번과 같은 영수증. 셸에서는 `turn_started`가 오지 않는다. |
| 5 | 3번의 실제 `requestId`로 `--retry-request` | `mutation.replayed: true`이고 화면에 그 명령이 한 번만 남았다. 텍스트를 다시 입력하지 않는다. |
| 6 | 임의 문자열로 `--retry-request` | 종료 코드 1, `invalid_argument`. 입력은 셸에 들어가지 않았다. |
| 7 | Claude 터미널(haiku)에 기본 전송 | `stages: ["input_accepted"]`, `provider: "claude"`, `observation: "supported"`, 경고: "no turn start was observed, so the Enter may have been swallowed. ... reissuing the exact command with --retry-request ... --wait-submit". 화면에서는 턴이 이미 진행 중이었다. |
| 8 | 7번의 `requestId`로 `--retry-request ... --wait-submit 5` | `stages: ["input_accepted", "turn_started"]`, 경고 없음, 프롬프트는 화면에 한 번만 남았다. |
| 9 | Claude에 새 프롬프트를 `--wait-submit 10`으로 전송 | 한 번의 호출에서 `turn_started`까지 관측되었다. 이어서 보낸 두 번째 프롬프트도 `turn_started`로 관측되었지만, 그 시점에 앞선 턴이 진행 중이었는지는 확인하지 못했고 대기열 등록을 뜻하는 별도 단계 이름도 보지 못했다. |
| 10 | Claude에 Enter 없이 텍스트만 전송 | `bytesWritten`은 정상이지만 `terminal read --screen`과 일반 `terminal read` 모두 입력 상자를 빈 상태(`❯`)로 보여 주었다. 이어서 Enter를 보내자 그 텍스트가 제출되었다. |
| 11 | 빈 셸에 명령을 한 글자씩 입력하며 매번 `commandPending`, `agentStarted` 판정 | 73글자 중 72개의 화면(명령이 일부만 에코된 모든 시점)이 `agentStarted: true`, `commandPending: false`였다. 명령 전체가 보이는 화면만 `pending`으로 판정되었다. |
| 12 | 수정된 `notifyDirector`를 실제 Claude 터미널(`claude --model haiku`)과 존재하지 않는 핸들에 실행 | 실제 터미널에서는 `outcome: submitted`, `stages: ["input_accepted", "turn_started"]`, Enter 없음, 재전송 없음으로 1.7초 만에 끝났고 화면에 프롬프트가 한 번만 나타나 응답이 이어졌다. 없는 핸들에서는 `notified: false`, `outcome: failed`이며 `notifyError`에 Orca의 `terminal_handle_stale` 원문이 그대로 남았다. |

## 3. 원인 판단

확인한 것:

- 입력 수락과 제출은 다른 사실이다(실험 1, 3, 7). `accepted: true`와 `input_accepted`는 제출을 증명하지 않고, 기본 전송은 관측을 0초만 한다.
- 이전 `agentStarted`는 명령의 일부만 에코된 화면을 시작된 agent로 판정했다(실험 11). 이 판정은 `commandPending`도 거짓으로 만들어서, 그 순간에는 Enter도 보내지 않고 다음 관측에서 `ready`를 낼 수 있었다. 이것은 PM 터미널에서 관측한 증상, 즉 `ready: true`인데 명령이 입력줄에 남은 상태를 만들 수 있는 실제 결함이다.
- `terminal create --command`가 명령을 제출하지 않는 동작은 이 환경에서도 재현되었다(실험 1). 그래서 `role-terminal`의 Enter 한 번은 여전히 필요하다.

확인하지 못한 것:

- PM 터미널에서 `ready: true`가 나온 정확한 화면. 이 환경에서는 Orca가 명령을 한 번에 써서 두 종류의 화면(프롬프트만, 명령 전체)만 관측되었고, 부분 에코 화면을 자연 상태로 얻지 못했다. 따라서 위의 결함이 그 인시던트의 실제 경로였다고 단정하지 않는다. 이 결함으로 설명되지 않는 경로가 남아 있을 수 있다.
- `director-signal`이 `exit 1`을 낸 이유. 이전 구현은 stderr가 비어 있으면 종료 코드만 남겼으므로 원인을 알 수 없다. 이번 변경은 Orca의 응답 원문(stderr 또는 stdout)을 그대로 보존한다.
- 같은 관측이 Codex와 Agy 터미널에서 어떻게 보이는지.

## 4. 변경

- `plugins/oh-my-teams/scripts/prompt-submission.mjs`(신규): `readSendReceipt`, `inputLine`, `judgeDelivery`(순수 함수), `deliverPrompt`.
  - `judgeDelivery`는 영수증 단계와 화면으로 `submitted`, `already-started`, `unsubmitted`, `foreign-input`, `unclear`를 구분하고, `unsubmitted`일 때에만 `enter: true`를 돌려준다.
  - `deliverPrompt`는 텍스트를 한 번만 `--wait-submit`으로 보내고, 불명확하면 같은 `requestId`로 `--retry-request`를 한 번 실행하며, Enter는 승인한 텍스트가 입력 상자에 홀로 남은 것이 확인될 때에만 한 번 보낸다. 실패는 `failed`와 Orca의 오류 원문으로 남긴다.
- `role-terminal.mjs`: `commandTyping`을 추가해서 부분 에코를 시작으로도, 미제출 명령으로도 보지 않는다. 에코가 끝나기를 기다린 뒤 Enter를 한 번만 보낸다. 에코가 끝나지 않으면 Enter 없이 차단으로 보고한다.
- `director.mjs`: `notifyDirector`와 `replySignal`의 PM 알림이 `deliverPrompt`를 쓴다. `notified`는 제출되었거나 이미 처리 중일 때에만 `true`이고, `delivery`에 분류와 단계, 요청 ID를 남기며, 실패 원문은 `notifyError`에 그대로 둔다. 재전송하지 않으므로 알림이 중복되지 않는다.
- `references/orca-runtime.md`: 「역할 터미널 열기」의 2번과 3번, PM 브리프 전송, 새 절 「프롬프트 전달과 제출 확인」.

## 5. 남은 위험

- 화면으로 입력 상자를 볼 수 없는 agent 터미널에서는 `unsubmitted`를 판정할 수 없다(실험 10). 그 경우는 `unclear`가 되어 `--retry-request`로만 확인하고 Enter를 보내지 않는다. Enter가 실제로 삼켜졌다면 사람이 확인해야 한다.
- 입력이 입력 상자에서 사라졌고 같은 문장이 기록에 이미 있으면, 이전에 보낸 같은 문장과 구별하지 못하고 `already-started`로 판정할 수 있다.
- Enter를 보낸 뒤 `--retry-request` 재관측이 그 Enter로 시작된 턴을 `turn_started`로 잡는지는 관측하지 못했다. 화면 판정이 함께 쓰이므로 입력이 사라지면 `already-started`로 결정된다.
- `terminal read --screen`이 `source: "screen-unavailable"`로 누적 출력을 돌려주는 경우는 이 환경에서 재현하지 못했다. `--help`의 설명(반복해 그린 줄이 조각으로 쌓인다)을 근거로, `source`가 `screen`이 아니거나 응답에 없으면 화면을 비어 있는 것으로 취급하고 `unclear`로 판정해 Enter를 보내지 않는다. `role-terminal`의 화면 읽기는 이 확인을 아직 하지 않는다.
- `clearRoleTerminal`의 `/clear` 전송은 이번에 바꾸지 않았다.
