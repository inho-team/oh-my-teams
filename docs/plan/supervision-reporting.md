# OMT 감시·보고 실패 경로 조사와 보완 설계

## 목적과 조사 기준

이 문서는 OMT가 Orca의 실행 소유권, 프로세스 종료, 재시도와 회수를 다시 구현하지 않는다는 전제에서 감시·보고의 실패 경로를 기록한다. 대상 HEAD는 `e8f9df0640472ce884c9a7b7fb62e0232b5a04ba`이고, 관측 시점은 2026-10-11 04:09:43 UTC이다. 이 문서에서 `요청 모델`은 역할 명령 또는 선택 파일이 요청한 값이고, `확인 모델`은 실행 원장 또는 화면에서 확인된 값이며, 어느 값도 없는 상태는 정상·실행 중·완료로 추정하지 않는다.

실제 Orca에는 읽기 전용 명령만 사용했다. 원시 출력은 작업 트리 밖의 다음 경로에 보관했다.

- `/tmp/omt-supervision-director-watch-20261011.json`: `director-watch`의 전체 관측이다.
- `/tmp/omt-supervision-kickoff-show-20261011.json`: 등록부 관측이다.
- `/tmp/omt-supervision-orca-status-20261011.json`: Orca 세션 상태 관측이다.
- `/tmp/omt-supervision-worker-list-20261011.json`: Orca 전역 워커 목록 관측이다.
- `/Users/jinsungkim/orca/oh-my-teams/.omt/usage/launches.jsonl:1024-1027`: PM과 이 Worker의 역할 실행 원장이다.

다른 kickoff의 실제 Message MCP 메시지는 수신·확인 처리하지 않았다. 이 문서의 메시지 격리 평가는 코드·테스트·등록부의 읽기 전용 집계와 OS 임시 fixture에서 실제 `handleMessageTool`을 직접 호출한 단위 재현으로 수행했다. fixture는 synthetic context만 사용하므로 실제 Orca transport나 업무 메시지 소비의 증명에는 사용하지 않는다.

## 재개 검토 기준과 증거 경계

이 문서는 최초 실패 재현의 기준 HEAD `e8f9df0640472ce884c9a7b7fb62e0232b5a04ba`를 유지한다. 2026-10-11 재개에서는 정식 검토 기록 `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-supervision-reporting/.omt/reviews/supervision-investigation-review-a2.json`의 다섯 finding을 반영하고, PM 워크트리의 post-merge HEAD `c2e50e9302edb954378581c453839e6884cf400c`는 읽기 전용으로 대조했다. 이번 수정 execution은 Dispatch `ctx_8dc61e8d1300`, Orca task `task_20858749da3d`, 전체 Run `run_d4227d769b5f`이며, frozen 조사 계약은 task ID `supervision-investigation`, revision 1, hash `aac104f2b02c359a87fda24c531c481d9c420fb0268d5d15fca8319e41a5a0a6`이다. 따라서 이 절의 post-merge 인용은 병합 뒤에도 남은 결함의 소스 증거이고, 최초 A2 fixture·현재 워크트리 검사는 과거 `3699fcde6ef31d43fbd693684a07ab2afab55264`의 환경·시각 증거이며, 새 구현 Worker의 결과나 독립 재검토 결과는 아니다.

`node /tmp/omt-supervision-handle-message-tool-repro.mjs`의 원시 결과 `/tmp/omt-supervision-handle-message-tool-repro-20261011.json`은 실제 `handleMessageTool` 함수를 두 이사 등록 fixture에 직접 호출했다. `contextKeys`는 `orgFile`, `actor`뿐이고, director A를 뜻하는 terminal·Orca Run·session provenance가 없어서 `receive_messages`가 기대 한 건 대신 두 director inbox를 반환했다. 이는 handler가 현재 호출자 소유권을 판정할 입력을 받지 않는다는 단위 재현이며, 실제 Orca가 다른 이사의 terminal에 메시지를 전송했다는 transport 증명은 아니다. 실제 transport의 수신·제출·화면 확인은 별도 Orca receipt 없이는 `unverifiable`로 남긴다.

같은 fixture에서 director actor가 `ack_message`를 호출하면 결과는 해당 message ID, `actor: "director"`, `status: "acknowledged"`이고, 뒤의 `receive_messages`에는 그 worktree가 사라지고 다른 worktree의 pending 메시지만 남았다. 이는 고정 actor·kickoff hash를 쓰는 Message MCP 저장소가 그 수신자의 acknowledgement와 `acknowledgedAt`을 기록했다는 긍정 근거이다. 다만 ack는 수신자가 처리 뒤에 보내는 자기 보고이므로 사람의 읽음, 내용의 의미 판단, 외부 행동 또는 `handled`를 증명하지 않으며, `progress`의 `autoAcknowledged`와도 분리한다.

실제 실행 관측도 같은 경계를 뒷받침한다. PM이 04:51경 자신의 구현 Worker로 보낸 `msg_76d6717320e1d76005c3857a08a435969778dda7b84e7ebd76a3b54482620b86`은 04:44:22 저장 뒤 pending이었고, `msg_9a48776484b8559bd2c8bb19a79ed40bd50b62d3195f2a40c052e915f2a84992`도 04:48:51 저장 뒤 pending이었다. 같은 Dispatch `ctx_e3a7289dfe38`은 live/working이고 화면은 검사 단계를 보였다. 이 source receipt와 관측 시각은 저장 및 처리 ack 부재를 증명하지만, Worker가 읽지 않았거나 의미 처리하지 않았다는 결론은 증명하지 않는다. PM의 다음 행동은 완료 전 동일 task의 pending을 다시 확인하고 필요한 후속 지시를 그 task에 보낼 일이다.

SDK 설치 실패와 복구도 시각별 receipt 단계로 구분한다. 과거 실패에서는 PM이 설치된 2.17.0 cache의 `message-mcp.mjs --help`를 실행해 `@modelcontextprotocol/sdk`의 `ERR_MODULE_NOT_FOUND`와 exit 1을 재현했고, 실제 `role-terminal` receipt는 그 cache 경로를 MCP server로 가리켰다. 이는 당시 MCP server가 초기화되지 않아 tool 호출을 받을 수 없던 원인이지, pending 메시지가 수신자에게 전달되었거나 수신자가 읽고 처리하지 않았다는 증거는 아니다.

그 뒤 Director는 2026-10-11 04:59:44 UTC에 실제 Codex 2.17.0+codex.20261011040835와 Claude 2.17.0 cache의 bundled lockfile 기준으로 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`를 실행해 누락 dependency를 복구했다. 복구 증거 `/Users/jinsungkim/orca/oh-my-teams/.omt/history/plugin-updates/20261011-mcp-dependency-repair.json`은 두 cache와 임시 MCP Client의 initialize·tools/list roundtrip, `send_message`·`receive_messages`·`ack_message`·`get_message` 네 tool 확인, 업무 메시지를 보내지 않은 사실을 기록한다. 이 복구는 과거 실패를 없애거나 그 실패 session의 자동 재연결을 증명하지 않는다. 실패한 session은 자신의 actor에 한정한 CLI `message-inbox --state`와 처리 뒤 `message-ack` fallback을 유지하고, 새 working session에서 같은 roundtrip을 검증한 뒤에만 MCP 복구를 주장할 수 있다. 최종 2.18 actual install은 Director 소유이며, PRODUCT role launch 전 SDK startup preflight는 구현 Worker의 미래 범위일 뿐 이 조사에서 구현됐다고 주장하지 않는다.

## 관측 결과 요약

`node plugins/oh-my-teams/scripts/teams-org.mjs director-watch --org /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json`은 `feat-supervision-reporting` PM에 `pmLiveness: "unverifiable"`, `providerOverload: "unknown"`, `pmModelDisplay: "Unknown host-default"`를 반환했다. 같은 PM의 실행 원장에는 2026-10-11 04:03:34 UTC에 `provider: "codex"`, `modelRequested: "gpt-6.1-sol"`, `modelResolved: "gpt-6.1-sol"`, PM 워크트리와 터미널이 기록되어 있다. 반면 등록부 항목은 PM의 `worktreeId`, `path`, `stateDir`만 보유하여 모델·provider·터미널·관측 시각을 보존하지 않는다.

이는 화면의 실제 선택 모델을 증명하는 관측은 아니다. 역할 실행 경로의 바인딩은 모델 화면 증명을 `unproven`으로 구분할 수 있으므로, 보완 후에도 실행 원장의 요청·해결 값과 화면 확인 값을 별도 필드로 기록해야 한다.

### 관측 계층의 경계

터미널 목록의 connected 사실은 PTY 연결 또는 terminal 존재의 증거일 뿐이며, agent 생존·유휴·실제 진전의 증거가 아니다. agent 생존은 Orca가 제공하는 `projection.liveness`와 그 `source`·`observedAt`으로, 유휴는 별도의 worker observation으로, 활동은 heartbeat·terminal output·output fingerprint 변화로 각각 기록해야 한다. 의미 있는 진전은 검증된 산출물, 통과한 검사, 수용 이벤트 또는 근거가 있는 작업 단계 보고로만 별도 기록하며, Orca가 특정 계층의 상태를 제공하지 않으면 해당 계층은 `unverifiable`로 남기고 다음 읽기 전용 관측 경로만 제시해야 한다.

### OS 임시 격리 재현 보완

`node /tmp/omt-supervision-a2-repro.mjs`를 실행한 원시 결과는 `/tmp/omt-supervision-a2-repro-20261011.json`에 기록했다. 이 fixture는 서로 다른 `director.terminalHandle`을 가진 두 등록 kickoff와 별도 PM state를 OS 임시 디렉터리에 만들었으며, 실제 사용 중인 다른 kickoff를 읽거나 확인 처리하지 않았다.

두 이사 격리에서 이사 A가 받아야 할 메시지는 하나였지만 `message-watch`의 실제 결과는 두 개였고, 두 worktree ID가 함께 반환되었다. 기대값은 호출 이사의 등록부 소유 kickoff로 제한된 한 개이고, 실제값은 모든 등록 kickoff의 director inbox를 평탄화한 두 개이므로, 이사가 다른 이사의 메시지를 처리 대상으로 오인할 수 있다.

같은 fixture에서 `director-signal --kind progress`의 signal 레코드는 전송 직후 `status: "acknowledged"`, `autoAcknowledged: true`였고 pending signal 수는 0이었다. 그러나 Message MCP director inbox에는 같은 signal의 pending 메시지가 한 개 남았고, 그 메시지를 ack한 뒤에도 별도 `handledAt` 영수증은 없었다. 따라서 auto acknowledgment는 저장·목록 정책일 뿐 읽음·판단·처리의 영수증이 아니며, 구현은 이 상태들을 분리해 표시해야 한다.

출력만 변하는 장기 정체에서도 현재 `nextSupervisionAction`은 `lastActivityAt` 하나만 판정한다. fixture에서 출력 fingerprint가 1분 전에 갱신됐다고 기록하면 기대한 semantic-progress 기준의 `escalate` 대신 실제값은 `wait`, `recent-activity`, `진행 중`이었고, 의미 있는 진전 시각을 60분 전으로 유지한 비교 입력은 `escalate`, `silent-after-progress-requests`였다. 이 영향은 출력이 계속 바뀌는 worker가 근거 있는 진전 없이 무진전 escalation을 계속 피할 수 있다는 점이다.

## 수용 기준 1: 실제 실패 경로와 영향

### 재현된 경로

1. 자원형 PM bootstrap이 역할 터미널을 열고 실행 원장에는 모델을 기록한다. 실행 원장 1024줄이 이 경로의 실제 증거이다.
2. `registerKickoff`는 claim의 PM 객체에서 `worktreeId`, `path`, `stateDir`만 새 등록부 항목으로 복사한다([`kickoff-registry.mjs:1042`](../../plugins/oh-my-teams/scripts/kickoff-registry.mjs#L1042)부터 [`1049`](../../plugins/oh-my-teams/scripts/kickoff-registry.mjs#L1049)). 현재 validator도 PM의 이 세 값만 요구한다([`kickoff-registry.mjs:293`](../../plugins/oh-my-teams/scripts/kickoff-registry.mjs#L293)부터 [`298`](../../plugins/oh-my-teams/scripts/kickoff-registry.mjs#L298)).
3. `kickoff-show`와 `director-watch`는 없는 `entry.pm.provider`와 `entry.pm.model`을 `displayModel`에 전달한다([`teams-org.mjs:3741`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L3741)부터 [`3746`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L3746), [`5064`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L5064)부터 [`5080`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L5080)). 그 결과 관측처럼 `Unknown host-default`가 표시된다.
4. `queryPmLiveness`는 실행 원장의 PM terminal·worker identity를 사용하지 않고, 인자 없는 `orca orchestration worker-list --json`의 항목을 PM 워크트리 문자열로만 매칭한다([`resources.mjs:273`](../../plugins/oh-my-teams/scripts/resources.mjs#L273)~[`302`](../../plugins/oh-my-teams/scripts/resources.mjs#L302)). 매칭되는 항목이 없거나 응답을 읽지 못하면 `unverifiable`이다.

영향은 감독자가 실행 중인 PM의 요청 모델, 확인 모델, Run·Dispatch·terminal identity, 마지막 관측 출처를 한 화면에서 대조할 수 없다는 점이다. `unverifiable` 자체는 안전한 값이지만, 왜 확인할 수 없는지와 마지막 양성 관측이 없어 다음 행동을 정확히 정하기 어렵다.

### 보완 설계와 회귀 검증

등록부의 PM 실행 메타데이터를 역할 launch receipt와 실행 원장에서 조립하되, 정적 kickoff claim과 실행 관측을 분리한다. 정적 필드에는 PM worktree, kickoff Run, 요청 provider·model, bootstrap 선택의 지문과 생성 시각을 보관한다. 동적 관측에는 terminal handle, Orca worker·dispatch identity, liveness verdict, `observedAt`, `source`, 확인 모델과 `modelProof`를 보관하며, 관측 실패는 이전 값을 정상으로 승격하지 않고 `unverifiable`과 원인을 남긴다.

모델 정책이 main에 반영된 뒤에도 잔여 결함은 남아 있다. post-merge `role-launch.mjs:542`부터 `565`는 `modelRequested`, `modelProof: "unproven"`과 화면 확인 필요성을 launch binding에 기록하고, `teams-org.mjs:4491`부터 `4505`는 launch ledger에 요청·해결 모델을 기록한다. 반면 `kickoff-registry.mjs:1042`부터 `1049`는 여전히 PM의 `worktreeId`, `path`, `stateDir`만 등록하고, `teams-org.mjs:5074`부터 `5089`의 `director-watch`는 없는 `entry.pm.provider`, `entry.pm.model`을 display에 준다. 따라서 `Unknown host-default` 가시성 결함은 `c2e50e9302edb954378581c453839e6884cf400c`에서도 남아 있으며, 호환 구현은 모델 정책의 launch receipt 형식을 바꾸지 않고 그 receipt를 additive PM execution metadata와 watch projection으로 조립하는 범위여야 한다.

구현 테스트는 자원형 bootstrap claim에서 `gpt-6.1-sol`의 요청·해결 값이 등록부와 watch projection에 남는지, 화면 증명이 없으면 `modelProof: "unproven"`으로 남는지, 그리고 `worker-list` 누락·파싱 실패·알 수 없는 verdict가 `live`나 `exited`로 바뀌지 않는지를 검증해야 한다. 기존 `queryPmLiveness`의 보수적 판정 검증은 [`tests/director-signal.test.mjs:750`](../../tests/director-signal.test.mjs#L750)~[`835`](../../tests/director-signal.test.mjs#L835)에 있으나, PM 실행 identity와 요청/확인 모델의 end-to-end 결합 검증은 없다.

## 수용 기준 2: 실행 신원과 상태 분리

### 실패 경로와 영향

현재 `directorWatch` 요약은 worktree, 목표, 신호, 슬롯, PM liveness와 provider overload만 반환한다([`resources.mjs:361`](../../plugins/oh-my-teams/scripts/resources.mjs#L361)부터 [`399`](../../plugins/oh-my-teams/scripts/resources.mjs#L399)). PM launch를 찾는 함수는 실행 원장을 PM 역할·worktree·terminal 기준으로 조회하며([`director.mjs:724`](../../plugins/oh-my-teams/scripts/director.mjs#L724)부터 [`778`](../../plugins/oh-my-teams/scripts/director.mjs#L778)), 그 결과는 provider-overload 판정에만 쓰인다([`resources.mjs:319`](../../plugins/oh-my-teams/scripts/resources.mjs#L319)부터 [`338`](../../plugins/oh-my-teams/scripts/resources.mjs#L338)). 따라서 PM과 Worker의 Run, Orca Task·Dispatch, terminal, provider·model, 모델 증명, 상태 관측 시각과 출처가 하나의 식별 가능한 관측 레코드가 되지 않는다.

특히 상태를 `진행`, `유휴`, `종료`, `조회 실패`로 구분하려면 각 상태에 양성 근거가 필요하다. 현재 `queryPmLiveness`는 이 원칙을 지켜 조회 실패를 `unverifiable`로 반환하지만, watch projection에 조회 대상의 Run/Dispatch와 `observedAt`·`source`가 없어서 운영자가 사실과 추론을 분리하기 어렵다.

### 보완 설계와 회귀 검증

감시 projection은 역할별로 다음을 함께 보여야 한다: 논리 소유자(PM 또는 Worker), worktree, workflow task, Run, Orca task·dispatch, terminal, 요청 provider·model, 확인 provider·model과 증명 수준, liveness verdict, 마지막 활동 시각, 관측 시각, 관측 출처, 조회 오류이다. stale 관측은 마지막 관측의 사실로만 표시하고 현재 생존 또는 완료의 근거로 사용하지 않는다. 동일 worktree의 여러 Orca 항목이 있을 때에는 PM launch의 dispatch/terminal identity를 우선 사용하고, 식별자가 없으면 worktree 매칭 결과를 보조 증거로 표시해야 한다.

회귀 검증은 하나의 PM worktree에 live·exited·unverifiable 항목이 공존하는 경우, terminal 재실행으로 launch가 교체되는 경우, worker-list 응답이 다른 Run에 한정되는 경우와 원격 조회 실패를 포함해야 한다. 각 경우 `live`와 `exited`는 긍정 Orca verdict에서만, 나머지는 `unverifiable`에서만 표시되어야 한다.

## 수용 기준 3: 이사·PM 전달, 격리와 처리 상태

### 실패 경로와 영향

Message MCP 저장소는 kickoff hash와 수신 actor를 함께 검사하고, `receiveMessages`는 대상 actor와 `pending` 상태만 반환한다([`message-store.mjs:160`](../../plugins/oh-my-teams/scripts/message-store.mjs#L160)부터 [`190`](../../plugins/oh-my-teams/scripts/message-store.mjs#L190)). `acknowledgeMessage`도 수신자만 확인할 수 있다([`message-store.mjs:214`](../../plugins/oh-my-teams/scripts/message-store.mjs#L214)부터 [`239`](../../plugins/oh-my-teams/scripts/message-store.mjs#L239)). 이 자체는 한 PM state를 통해 actor별 메시지를 분리한다.

그러나 `message-watch`는 등록된 모든 kickoff의 director 수신함을 평탄화해 반환한다([`teams-org.mjs:3339`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L3339)~[`3365`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L3365)). 현재 이사와 해당 kickoff의 `director.terminalHandle`을 비교하거나, 호출자의 소유권을 필터하지 않는다. 브리프에서 지적한 다른 이사 소유의 오래된 메시지가 먼저 반환되는 경로가 이 코드로 재현된다. 다른 kickoff 메시지를 읽는 것만으로 확인 처리되지는 않지만, 이사가 잘못된 inbox를 자기 업무처럼 처리할 위험이 있다.

post-merge `message-mcp.mjs:96`부터 `176`의 organization-scoped handler도 `context.actor === "director"`만 검사한 뒤 모든 registered kickoff를 평탄화해 `receiveMessages`를 호출한다. 이 경로는 `args.worktreeId`로 scope를 고르는 send·ack·get과 달리 receive에는 caller terminal이나 session binding이 전혀 없다. 위의 handler fixture는 이 경로의 결함을 직접 재현하지만, synthetic context 호출이므로 실제 Orca terminal delivery가 발생했다는 증명은 아니다.

`director-signal`은 signal 레코드를 기록한 뒤 PM state의 Message MCP에 같은 메시지를 큐잉하고 `queued: true`를 반환한다([`teams-org.mjs:4966`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L4966)부터 [`5004`](../../plugins/oh-my-teams/scripts/teams-org.mjs#L5004)). 이는 저장 성공만 뜻하며 terminal 전달, 읽음, 처리 또는 응답을 증명하지 않는다. reply도 동일하게 `queued: true`일 뿐이다([`director.mjs:640`](../../plugins/oh-my-teams/scripts/director.mjs#L640)부터 [`657`](../../plugins/oh-my-teams/scripts/director.mjs#L657)).

### 보완 설계와 회귀 검증

공식 process-lineage authentication API는 확인되지 않았으므로, 이 설계는 같은 OS 사용자 또는 환경 변수 위조에 대한 인증 시스템이라고 주장하지 않는다. 범위는 여러 정상 이사의 우발적 inbox 혼입 방지이며, fixed launch receipt와 server-start binding, Orca pane·terminal 관측을 함께 보관해 scope를 `launch-bound`, `observed`, `ownership-unverifiable` proof 수준으로 표시한다. no-override `run-current`가 PM coordinator를 찾았다는 관측도 scope authentication으로 승격하지 않는다.

organization MCP는 server 시작 때 고정된 launch receipt의 director terminal·worktree·Run과 등록부 `director.terminalHandle`·kickoff Run을 대조해 그 결과로 scope를 고정한다. state MCP도 시작 binding의 role·worktree·Run/Dispatch와 resolved kickoff hash·PM state를 대조해 scope를 고정한다. 이후 tool request의 임의 worktreeId·terminal·actor 문자열은 scope를 넓히거나 바꾸지 못하게 거부하고, 해석 시각·source·proof 수준을 response에 남긴다. 환경 변수와 launch binding이 모두 없거나 관측이 불일치·모호하면 양쪽 MCP의 ownership은 `ownership-unverifiable`이며, 정상 준비 상태로 표시하지 않고 recovery와 next owner를 반환한다. 익명·legacy 등록은 별도 읽기 전용 `unowned` 진단 목록에만 보존하며 자동 ack·reply·notification 대상이 될 수 없다.

신호와 메시지는 `stored`, `notification-attempted`, `terminal-submitted`, `received`, `acknowledged`, `replied`, `handled`를 별도 이벤트로 기록한다. `acknowledged`는 fixed receiver가 작성한 `acknowledgedAt` 자기 보고 receipt로 표시하고, `handled`는 그와 다른 근거 있는 작업 결과 또는 명시적 처리 attestation이 있을 때만 기록한다. `autoAcknowledged`는 정보성 signal의 목록 상태일 뿐 수신자 ack 또는 handled receipt가 아니다. 중복은 stable key와 동일 payload의 replay로만 인정하고, 동일 key·다른 payload는 거부한다. 재시작 뒤에는 저장된 pending 이벤트를 다시 조회하되, 입력 제출이 불명확한 경우에는 재전송하지 않고 사람의 확인 대상으로 올린다.

회귀 검증은 두 이사의 두 kickoff, 하나의 legacy/anonymous entry, 메시지 재시작 전후, 중복 key, 잘못된 수신자의 ack, 화면 제출 실패를 포함해야 한다. 추가로 org/state MCP 각각에서 정상 launch binding, 잘못된 binding, 모호한 pane·terminal 관측, launch/environment 모두 없는 경우를 분리해 검사하고, 요청의 임의 worktree·terminal·Run·Dispatch 문자열이 고정 scope를 바꾸지 못하게 거부해야 한다. `message-watch`가 다른 이사의 메시지를 반환하지 않고, `queued`가 읽음·처리됨으로 표현되지 않으며, 수신자만 ack할 수 있어야 한다. 기존 actor 격리 시험은 [`tests/message-mcp.test.mjs:299`](../../tests/message-mcp.test.mjs#L299)~[`340`](../../tests/message-mcp.test.mjs#L340)에 있으나, 이사 소유권 필터 시험은 추가가 필요하다.

## 수용 기준 4: 장시간 무진전, provider 장애와 감독자 부재

### 실패 경로와 영향

`nextSupervisionAction`은 `unverifiable`을 진행으로 가정하지 않고 inspect 후 escalation하며, `exited`, human prompt, provider overload는 즉시 escalation한다([`status.mjs:52`](../../plugins/oh-my-teams/scripts/status.mjs#L52)부터 [`153`](../../plugins/oh-my-teams/scripts/status.mjs#L153)). 무진전 검사와 진행 요청 횟수를 합산하는 기존 회귀 시험도 있다([`tests/supervision.test.mjs:88`](../../tests/supervision.test.mjs#L88)부터 [`122`](../../tests/supervision.test.mjs#L122)). Claude 529 overload도 별도의 escalation reason으로 검사한다([`tests/supervision.test.mjs:230`](../../tests/supervision.test.mjs#L230)부터 [`253`](../../tests/supervision.test.mjs#L253)).

하지만 PM 감독 projection은 Worker 판정의 입력인 마지막 활동, unanswered requests, inspections, last escalation을 내보내지 않는다. `directorWatch`의 provider overload는 PM launch provider가 `claude`일 때에만 화면을 읽고, terminal 또는 화면을 찾을 수 없으면 `unknown`으로 반환한다([`resources.mjs:305`](../../plugins/oh-my-teams/scripts/resources.mjs#L305)~[`351`](../../plugins/oh-my-teams/scripts/resources.mjs#L351)). 이는 보수적이지만 감독자 부재, notification 대상 terminal 손실, PM Run 조회 실패의 다음 담당자와 행동을 구조화하지 않는다.

### 보완 설계와 회귀 검증

감시기는 활동 화면 출력 자체를 진전으로 판단하지 말고, heartbeat와 terminal output fingerprint는 `activityAt`으로, 검증된 산출물·검사·수용 이벤트·근거 있는 단계 보고는 `semanticProgressAt`으로 출처와 proof 수준을 붙여 기록해야 한다. 무진전 타이머와 escalation 억제는 `semanticProgressAt`만으로 계산하며, 활동 변화는 화면 재조회 또는 보조 진단을 요청할 근거일 뿐 타이머와 escalation을 초기화하지 않는다. 정해진 무진전 구간마다 `wait`, `ask-progress`, `inspect`, `escalate` 중 하나만 결정하고, 자동 retry·stop·소유권 탈취는 결정 결과에 포함하지 않는다. provider 장애와 감독자 부재는 같은 failure envelope에 관측값, 오류, 마지막 양성 관측, 다음 담당자, 필요한 행동을 남기고 이사에게 한 번 상승 보고한다.

`semanticProgressAt`의 compatibility 경계는 명시적이어야 한다. 필드가 전혀 없는 legacy observation만 versioned migration의 문서화된 시작 시각(`startedAt` 또는 최초 verified observation)을 사용하며, 그 시작 시각도 없으면 즉시 정상으로 가정하지 않고 `unverifiable` inspection을 낸다. 필드가 명시적 `null`, `unknown`, 잘못된 시각이면 의미 있는 진전이 증명되지 않은 상태이므로 `lastActivityAt`, heartbeat, output fingerprint로 대체하지 않고 시작 시각부터 무진전 경과를 계산하거나 시작 시각도 없으면 escalation 전에 inspect한다. proof가 있는 유효한 `semanticProgressAt`만 타이머의 기준을 갱신하고 recovery 또는 같은 failure reason의 새 cycle을 열 수 있다. 따라서 현재 post-merge `status.mjs:92`부터 `154`처럼 `lastActivityAt` 하나를 parse하는 계약은 이 네 상태를 표현하지 못하며 변경이 필요하다.

같은 failure reason은 의미 있는 진전 또는 새 실패 원인이 확인되기 전까지 반복 알림하지 않는다. 활동 변화만으로는 이미 보고한 failure reason을 해제하거나 새 escalation cycle을 시작하지 않는다. escalation은 `escalatedAt`과 reason을 갱신하고, terminal 입력이 이미 제출되었는지 불명확하면 재전송을 금지한다. 이사 terminal이 없거나 소유자를 증명하지 못하면 signal은 durable inbox에 남고 `supervisor-unavailable`로 표시해야 한다.

회귀 검증은 활동 없는 live worker, 출력만 변하는 worker, 반복 `unverifiable`, worker_done 없는 exited worker, 529 overload, human prompt, 조회 시간 초과, PM terminal 상실, director terminal 재배정과 process restart를 포함한다. 특히 `semanticProgressAt`이 없는 legacy record, 명시적 `null`, `unknown`/invalid proof, 유효하고 proven인 시각을 분리해 검사하고, null·unknown이 activity 시각으로 fallback되지 않으며 proven 시각만 recovery를 만드는지 확인해야 한다. 모든 경우에 근거 없는 자동 종료·retry·release가 없고, 반복 tick이 동일 alert를 증식시키지 않으며, semantic progress가 증명될 때에만 새 escalation cycle이 시작되어야 한다.

## 수용 기준 5: 여러 kickoff를 보는 이사의 요약과 중복 억제

### 실패 경로와 영향

`director-watch`는 모든 kickoff의 pending signal 수, 슬롯, liveness와 overload를 병렬로 집계한다([`resources.mjs:361`](../../plugins/oh-my-teams/scripts/resources.mjs#L361)~[`399`](../../plugins/oh-my-teams/scripts/resources.mjs#L399)). 관측 당시 전체 결과는 pending signal 6개, active slot 5개였지만, 이 kickoff는 worker slot 1개와 pending signal 0개만 보였다. 해당 한 화면에서 마지막 확인 가능한 진전, 미해결 결정, 다음 행동, PM 실행 identity와 관측 시각이 함께 보이지 않으므로 긴급성의 근거를 비교할 수 없다.

`progress` 신호는 전송 때 `status: "acknowledged"`와 `autoAcknowledged: true`로 저장되어 pending 목록에서 제외된다([`director.mjs:86`](../../plugins/oh-my-teams/scripts/director.mjs#L86)부터 [`179`](../../plugins/oh-my-teams/scripts/director.mjs#L179)). 다만 아직 terminal 통지가 확인되지 않은 progress는 재통지 후보로 남는다([`director.mjs:352`](../../plugins/oh-my-teams/scripts/director.mjs#L352)부터 [`373`](../../plugins/oh-my-teams/scripts/director.mjs#L373)). 따라서 `autoAcknowledged`는 이사가 읽거나 처리했다는 뜻이 아니며, 단지 action-required pending 목록을 줄이기 위한 정보성 신호의 상태이다.

### 보완 설계와 회귀 검증

이사 summary는 kickoff별로 우선순위가 있는 `attention` 항목을 제공해야 한다. 각 항목은 상태 변화, source와 observedAt, 마지막 확인 진전, 미해결 decision/blocked/close-ready, slot, liveness, failure reason, next owner·action을 보존한다. `progress`는 최근 진전 타임라인에는 남기되 decision queue와 완료 준비 gate를 통과한 것으로 해석하지 않는다. 기존 CLI JSON의 기존 필드는 호환을 유지하고 새 필드는 additive projection으로만 추가한다.

회귀 검증은 progress만 있는 kickoff, pending decision, superseded close-ready, unconfirmed terminal delivery, 동일 escalation 반복, 출력만 변하는 정체, semantic progress 뒤의 새 escalation, 독립 delivery receipt를 한 watch 결과에서 함께 검증해야 한다. 기존 progress 자동 확인 시험은 [`tests/director-signal.test.mjs:158`](../../tests/director-signal.test.mjs#L158)부터 [`177`](../../tests/director-signal.test.mjs#L177)에 있고, 독립 delivery의 watch 표시 시험은 [`tests/director-signal.test.mjs:2443`](../../tests/director-signal.test.mjs#L2443)부터 [`2463`](../../tests/director-signal.test.mjs#L2463)에 있다.

## 수용 기준 6: 구현·복구 회귀 검증과 인도 준비

### 권고하는 구현 task 범위

구현 task는 기존 감시 어댑터와 projection 경계 안에서 다음을 수행한다.

1. 먼저 `message-mcp.mjs`, `message-store.mjs`, `director.mjs`와 `tests/message-mcp.test.mjs`, `tests/director-signal.test.mjs`에서 fixed launch receipt·server-start binding·pane/terminal observation을 org/state scope에 결속한다. process-lineage authentication API를 가정하지 않고 정상·invalid·ambiguous·binding 부재를 proof 수준으로 나누며, arbitrary 문자열이 고정 scope를 바꾸는 요청을 거부하고 stored·submitted·received·acknowledged·handled 상태를 분리한다. PRODUCT role launch 전 SDK startup preflight는 별도 구현 Worker 범위로 남긴다.
2. 다음으로 `status.mjs`, `resources.mjs`와 `tests/supervision.test.mjs`, `tests/director-signal.test.mjs`에서 `activityAt`과 `semanticProgressAt`을 구분한다. legacy field 부재, explicit null, unknown/invalid proof, proven value와 시작 시각을 각각 시험해 출력만 변하는 정체·provider·감독자 부재의 escalation deduplication을 검증한다.
3. 마지막으로 이미 main에 반영된 `role-launch.mjs`의 launch binding과 launch ledger를 읽어 `kickoff-registry.mjs`의 PM execution metadata 및 `teams-org.mjs` watch projection에 연결한다. 요청·구성 해석·화면 확인 모델과 proof를 구분하되, 모델 정책의 기존 launch receipt 형식은 바꾸지 않고 `tests/director-signal.test.mjs`와 watch 관련 회귀 테스트를 추가한다.

구현은 `orca-adapter.mjs`와 기존 `teams-org.mjs`의 공식 어댑터 경로를 사용해야 하며, Orca process·Run·Dispatch의 소유권을 복제하거나 내부 저장소를 직접 수정해서는 안 된다. 기존 CLI·snapshot의 필드와 동작은 유지하고 새 관측값은 호환 가능한 선택 필드로 추가해야 한다.

모델 정책의 PR #167은 `c2e50e9302edb954378581c453839e6884cf400c`으로 main에 반영되었으므로, 이전 조사 시점의 "통합 뒤 조율"은 완료된 선행 조건으로 정정한다. 감시·보고 구현은 그 HEAD의 `role-launch.mjs`, `teams-org.mjs`, `kickoff-registry.mjs` 호출 형식을 읽기 전용으로 대조하고, additive metadata projection만 추가한다. 조사에서 우선 진행할 범위는 `orca-adapter.mjs`, `resources.mjs`, `director.mjs`, `message-store.mjs`, `message-mcp.mjs`, `status.mjs`와 회귀 테스트이며, launch receipt·workflow·schema의 공통 계약을 바꿔야 하면 모델 정책 PM과 다시 조율한다.

### 권고하는 독립 검토 범위

별도 실행과 별도 worktree의 검토자는 다음을 확인해야 한다.

1. 실제 resource-PM bootstrap fixture가 `director-watch`의 model identity와 liveness identity를 채우며, 화면 증명이 없을 때 이를 확인 모델로 과장하지 않는지 확인한다.
2. 두 이사와 여러 kickoff fixture에서 inbox 결과가 director ownership 밖으로 새지 않고, 다른 kickoff의 ack·reply가 거부되는지 확인한다.
3. restart, duplicate signal, terminal submission 불명확, `autoAcknowledged` progress, close-ready supersede, provider overload, long silence, supervisor absence의 상태 전이를 독립적으로 재현한다.
4. `git diff --check`, `npm run format`, `npm run sync`, `npm run lint`, `npm test` 및 최신 HEAD의 CI 결과가 실제 변경과 일치하는지 확인한다.

### 남은 제약

Orca가 제공하지 않는 화면 모델 증명, 원격 worker 상태 또는 terminal 출력은 확인 불가일 수 있다. 이 경우 모델과 상태는 `unknown` 또는 `unverifiable`로 남겨야 하며, 상태 표시를 좋게 보이게 하기 위해 정상·완료·전달됨으로 변환해서는 안 된다. 이 문서는 조사 결과이므로 실제 구현, 사용자 전역 설정 변경, plugin 갱신 예약, push·PR 생성·병합을 수행하지 않았다.

## 구현 결과와 현재 제약

2026-10-11 구현 결과는 이 문서의 조사 기준과 구분해 기록한다. 구현 브랜치는 accepted 조사 통합 HEAD `0484b11e1c4860b1b540d3f767423bad972d2d61`을 병합하고, 선행 모델 정책 PR #167의 main `c2e50e9302edb954378581c453839e6884cf400c` 및 worktree reuse·resource 수정 PR #166의 main `b1f71ef3e873a899fd4081e3e6902a2784e5a13c`을 포함한 뒤 Message MCP, 감독 상태 저장소, watch projection과 역할 시작 preflight를 보완했다.

1. `message-mcp.mjs`는 Orca pane 관측이 있으면 그 terminal과 launch ledger를, pane 환경 변수가 없으면 role process의 고정 시작 worktree와 단일 launch receipt를 state scope에 결속한다. PM은 PM role launch, task actor는 같은 `workflowTaskId` launch를 추가로 요구하며, 다른 kickoff·다른 task·모호한 시작 worktree는 `ownership-unverifiable`과 재시작 담당자 안내로 거부한다. organization scope도 terminal 또는 단일 director checkout binding을 요구하므로, 임의 `worktreeId`나 terminal 요청이 scope를 바꾸지 못한다. 이는 여러 정상 이사의 우발적 혼입을 막는 binding이며, Orca 1.4.220에 없는 process-lineage authentication이나 동일 OS 사용자의 환경 변수 위조 방어를 주장하지 않는다.
2. `resources.mjs`의 PM watch는 launch receipt의 요청 provider·model, 등록부의 구성 provider·model, 확인 모델의 부재와 proof, terminal·Run·Dispatch·liveness의 source와 observedAt을 분리한다. role-terminal PM은 exact Dispatch가 없으므로 같은 worktree의 다른 live Worker가 있어도 PM live로 승격하지 않으며 `unverifiable`과 다음 관측 행동을 유지한다. exact PM launch binding이 없으면 terminal 목록을 양성 부재 증거로 읽지 않고 `launch-binding-missing`으로 남기며, binding이 있을 때의 정상 목록 부재와 목록 조회 실패도 각각 confirmed-absent와 query-failed로 분리해 Director가 재확인·복구 판단을 맡는다.

3. `supervision-reporting.mjs`와 `supervision-next`는 dispatch별 durable record에 마지막 proven semantic progress, actual action receipt로 확인된 inspect/ask count, escalation, pending decision과 local durable report proof를 저장한다. 단순 화면 출력, heartbeat, activity, 추천 action은 progress 또는 count 증가 근거가 아니며, valid evidence object와 과거 시각을 가진 semantic event만 새 cycle을 연다. 21개가 지난 뒤에도 이전 receipt ID를 다시 사용하면 새 수행으로 세지 않고, 재시작도 같은 reason을 다시 보고하지 않으며, 현재 cycle 또는 reason·escalatedAt에 결속된 resolution evidence 전까지 pending decision을 보존한다. provider overload·보고 지연·감독자 부재는 next owner와 action을 분리한다.
4. `message-mcp-config.mjs`와 `role-launch.mjs`는 Claude·Codex의 SDK dependency probe가 실패하면 source, checkedAt, recovery owner와 다음 행동을 포함한 startup block을 반환해 역할을 정상 준비로 표시하지 않는다. Agy의 MCP 미지원은 dependency failure가 아닌 unsupported capability로 유지한다. SDK cache 복구와 사용자 설정 변경은 여전히 Director의 책임이다.
5. 일반 PM·PL 감독 절차는 `supervision-next --org <organization.json> --state <pm-state> --dispatch <id> --observation <observation.json>`을 사용한다. activity는 liveness 정보일 뿐 semantic progress가 아니며, 실제 수행 receipt와 현재 decision cycle에 결속된 resolution만 durable 기록을 바꾼다. Message MCP의 여러 kickoff 조회도 고정 launch receipt와 pane·terminal 또는 server-start worktree binding이 없거나 모호하면 `ownership-unverifiable`로 거부하고 등록된 역할 terminal 또는 PM 재실행 경로를 안내한다.

후속 terminal adapter 보완은 watch 관측에서만 `orca terminal list --json`의 nonzero 종료, 잘못된 JSON, `ok: false`·non-array·누락 envelope를 `query-failed`/`unverifiable`로 전달한다. 성공한 빈 terminal array만 `terminal-list-confirmed-absent`가 되며, Director notification의 기존 관대한 fallback은 유지한다. 이 보완의 새 source 검증은 문서 자기 HEAD에 쓰지 않고 `/tmp/omt-supervision-terminal-adapter-fix-report.json`에 원본 frozen evidence와 함께 결속한다.

구현 source HEAD `23485509586f27e8c5d2f42c7c470890af391f01`의 실제 읽기 전용 Orca 관측은 `node plugins/oh-my-teams/scripts/teams-org.mjs director-watch --org /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json`으로 실행해 `/tmp/omt-supervision-runtime-rework-orca-observation.json`에 기록했다. 이 파일에서 supervision-reporting PM의 `observedAt`은 `2026-10-11T06:09:22.007Z`, runtime source는 `orca-terminal-list-and-launch-ledger`이고, launch terminal과 Run은 각각 기록되지만 dispatch는 `none-recorded`, worker liveness는 `unverifiable`, terminal status는 `present-unverified`다. 따라서 같은 worktree의 다른 Worker나 terminal 존재를 PM의 live 상태 또는 semantic progress로 승격하지 않으며, 최신 구현의 표적 회귀 101개도 state/org MCP의 env 없는 고정 시작 binding·다른 kickoff/task 격리, PM role-terminal live 승격 방지, durable escalation dedup/restart, receipt 없는 추천 action, invalid/future semantic proof 및 pending decision 처리 경계를 검증했다.

## 검사 기록

원래 조사에서 작업 트리 밖 의존성만 사용한 `npm test`는 `tests/document-mcp-read-only.test.mjs`와 `tests/message-mcp.test.mjs`가 `@modelcontextprotocol/sdk`를 찾지 못해 exit 1이었고, 로그는 `/tmp/omt-supervision-test-20261011.log`에 남아 있다. 이는 docs 변경이 아니라 현재 작업 트리에서 해석할 `node_modules`가 없던 환경 오류였다.

2026-10-11 재개 검사에서는 배정된 현재 워크트리에 `npm ci`를 실행해 95개 패키지를 설치했고 exit 0이었다(`/tmp/omt-supervision-a2-npm-ci-20261011.log`). 이어서 현재 워크트리의 `npm run format`, `npm run sync`, `npm run lint`, `npm test`는 모두 exit 0이었다(`/tmp/omt-supervision-a2-format-20261011.log`, `/tmp/omt-supervision-a2-sync-20261011.log`, `/tmp/omt-supervision-a2-lint-20261011.log`, `/tmp/omt-supervision-a2-test-20261011.log`). `npm test`는 총 1,357개 중 1,320개 통과, 0개 실패, 37개 건너뜀으로 끝났고 종료 코드 요약은 `/tmp/omt-supervision-a2-check-summary-20261011.txt`에 남겼다. 이 broad 검사는 소스·테스트가 당시 조사 HEAD `3699fcde6ef31d43fbd693684a07ab2afab55264`와 같을 때의 결과라서, post-merge `c2e50e9302edb954378581c453839e6884cf400c` 읽기 전용 대조나 이후 구현 Worker의 검사로 해석하지 않는다.

구현 후보 HEAD `122094f28d96c676a6a96b350d412191f48c98ef`의 frozen verify evidence `4c169dae8e128e8ae29eb15518500c543810407490e6e733f94085ddce31338e`는 이전 후보의 역사적 검사 기록이다. `npm run lint`와 `npm test`는 모두 exit 0이었고, 전체 test는 1,511개 중 1,474개 통과, 0개 실패, 37개 skip이었다. 원본 evidence와 lint·test 로그는 각각 `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-supervision-reporting/.omt/evidence/4c169dae8e128e8ae29eb15518500c543810407490e6e733f94085ddce31338e.json`, 같은 디렉터리의 `-0.log`, `-1.log`에 있다.

실제 완료한 기능 코드와 테스트의 source HEAD `23485509586f27e8c5d2f42c7c470890af391f01`은 그 이전 후보와 별도로 frozen verify evidence `3ab142fc26d0b4f4bebee2893a8a1b847cb9f9a6ddbca26a94e67c7a2b98b997`와 bound report `/tmp/omt-supervision-runtime-rework-report-2348550.json`에 결속되어 있다. 원본 evidence `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-supervision-reporting/.omt/evidence/3ab142fc26d0b4f4bebee2893a8a1b847cb9f9a6ddbca26a94e67c7a2b98b997.json`은 `unchanged: true`와 `npm run lint` exit 0(2,585ms), `npm test` exit 0(71,228ms)을 기록하며, 전체 test는 1,514개 중 1,477개 통과, 0개 실패, 37개 skip이다. 해당 lint·test 원본 로그와 hash는 같은 evidence 디렉터리의 `-0.log`, `-1.log`와 evidence JSON에 보존되어 있고, 위 표적 회귀는 101개 통과, 0개 실패였다. 이 수치는 조사 시점 검사 및 122094f 역사적 후보와 구분되는 최신 기능 구현의 검증 결과다.

이 문서의 Markdown Prettier 쓰기·확인은 모두 exit 0이었고(`/tmp/omt-supervision-a2-markdown-write-20261011.log`, `/tmp/omt-supervision-a2-markdown-check-20261011.log`), `git diff --check`도 exit 0이었다(`/tmp/omt-supervision-a2-diff-check-20261011.log`). 문서 검사 종료 코드 요약은 `/tmp/omt-supervision-a2-doc-check-summary-20261011.txt`에 남겼으며, frozen task `verify`는 새 커밋 HEAD에서 실행해 별도 JSON 보고서로 남긴다.

이번 workflow-rework 문서 보완은 source와 tests를 변경하지 않는 문서 전용 diff다. Markdown Prettier, `npm run format`, `npm run sync`, `npm run sync:check`, `git diff --check` 뒤 frozen task revision 1 hash `82fef224538890ee0a27ce43c105ff930ef576875c2f214333ec7e79b54cde07`의 verify를 새 문서 커밋 HEAD에서 한 번 실행한다. 그 뒤 생성할 `/tmp/omt-supervision-runtime-doc-final-report.json`은 그 문서 전용 HEAD와 원본 frozen evidence 전체를 결속한다. 이 문서는 그 보고서의 아직 생성되지 않은 최종 HEAD를 다시 쓰기 위해 추가 커밋을 만들지 않으며, 독립 재검토자는 위 `2348550` 기능 source의 실제 검사 연결과 final report가 보이는 문서 전용 diff인지 대조한다.
