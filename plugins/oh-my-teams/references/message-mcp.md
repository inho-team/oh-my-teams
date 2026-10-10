# OMT Message MCP

OMT의 역할 간 질문, 진행 보고, 지시와 결정을 PM 워크트리의 `.omt/messages/`에 보관합니다. 이 경로는 Orca의 터미널 입력이나 Run 메시지와 별개입니다. 메시지를 보냈다는 결과는 파일에 기록되었다는 뜻이며, 수신자가 읽거나 처리했다는 뜻은 아닙니다. 수신자가 처리한 뒤 확인 응답을 보내면 상태가 `acknowledged`로 바뀝니다. Orca의 Task·Dispatch 실행과 `worker_done` 정산은 계속 Orca가 담당합니다.

## 주소와 범위

각 kickoff는 등록부의 `kickoffHash`로 분리됩니다. 발신자와 수신자는 `director`, `pm`, `task:<workflow task ID>` 가운데 하나입니다. PM이 배정한 Worker와 PL이 배정한 하위 역할은 자신에게 배정된 workflow task ID를 주소에 사용합니다. 하위 역할이 PL에게 보고할 때에는 PL의 workflow task ID를 수신 주소에 사용합니다. 다른 kickoff에 보내려면 해당 kickoff의 PM 상태 디렉터리를 명시해야 합니다.

Claude와 Codex 역할 터미널과 새 이사 터미널에는 시작 명령의 세션 인자로 Message MCP가 연결됩니다. 사용자 설정 파일은 수정하지 않습니다. Agy는 현재 세션별 MCP 구성 인자를 제공하지 않으므로 같은 저장소에 접근하는 아래 CLI 명령을 사용합니다. 이사의 MCP는 조직에 등록된 모든 kickoff를 함께 조회합니다. `message-watch` CLI도 같은 메시지를 보여 줍니다.

## 보내기와 받기

실행 중인 역할은 MCP의 `send_message`, `receive_messages`, `ack_message`, `get_message` 도구를 사용합니다. MCP 도구가 없는 세션에서는 같은 동작을 하는 다음 명령을 사용합니다. `<runtime>`은 설치된 OMT의 `teams-org.mjs`입니다.

```text
node <runtime> message-send --state <pm-state> --actor <내 주소> --to <수신 주소> --key <고유 재시도 키> --type question|status|decision|blocked|close-ready|progress|instruction|escalation --subject <제목> --body <본문>
node <runtime> message-inbox --state <pm-state> --actor <내 주소> [--wait-ms 30000]
node <runtime> message-show --state <pm-state> --actor <내 주소> --id <messageId>
node <runtime> message-ack --state <pm-state> --actor <내 주소> --id <messageId>
node <runtime> message-watch --org <organization.json> [--wait-ms 30000]
```

이사가 MCP에서 `send_message`, `ack_message`, `get_message`를 호출할 때에는 대상의 `worktreeId`를 함께 줍니다. `receive_messages`는 각 메시지에 `worktreeId`를 붙여 돌려줍니다.

발신자는 같은 요청을 다시 확인하거나 재시도할 때 동일한 `key`와 본문을 사용합니다. 서버는 기존 메시지를 돌려주고 `replayed: true`로 표시합니다. 같은 키에 다른 내용을 넣으면 거부합니다. 수신자가 `message-inbox`나 `receive_messages`로 읽어도 메시지는 사라지지 않습니다. 내용을 처리한 뒤 `message-ack` 또는 `ack_message`를 호출합니다. 재시작 후에도 확인되지 않은 메시지는 다시 나타나므로, 수신자는 메시지 ID로 이미 처리한 동작인지 확인해야 합니다.

PM은 worker를 감독할 때 `supervision-wait --state <pm-state> --mailbox pm`을 사용합니다. 이 명령은 Orca의 `worker_done`과 Message MCP의 PM 메시지를 함께 기다립니다. 응답의 `source`가 `message-mcp`이면 각 메시지를 처리하고 `message-ack`으로 확인합니다. Orca의 `deliveryId`가 함께 있으면 다음 `supervision-wait` 호출에 `--ack`으로 전달합니다. PL도 자신의 `task:<workflow task ID>` 주소를 `--mailbox`에 줄 수 있습니다.

이사는 `director-signal`로 만들어진 신호를 기존 `director-inbox`에서 확인하고 `message-watch`로 새 메시지를 기다립니다. `director-reply`는 답을 신호 기록과 PM 메시지함에 함께 남깁니다. 이사는 신호를 처리한 뒤 `director-ack`으로 신호와 연결된 Message MCP 메시지를 확인합니다. PM은 답장을 처리한 뒤 `message-ack`으로 확인합니다. 신호 기록과 workflow 문서는 권한과 결정의 정본이며, 메시지 본문만으로 gate를 통과시키지 않습니다.

## 실행 경계

Message MCP는 이미 실행 중인 역할이 도구를 호출하거나 대기 중인 명령이 결과를 받게 합니다. 실행 명령이 셸 입력줄에 남아 아직 역할 세션이 시작되지 않았다면 MCP가 세션을 시작시킬 수 없습니다. 이 경우에는 `role-terminal`의 시작 확인이 필요합니다. 역할이 메시지 수신 명령을 호출하지 않은 동안에도 메시지는 보관되며, 다음 조회에서 전달됩니다.
