# Agy 터미널 경로 개선 계획 (Orca 판정 규칙)

- 작성일: 2026-09-17
- 상태: 초안 (Draft)
- 대상 버전: Orca 1.4.204, Antigravity CLI 1.2.5

## Orca 판정 규칙

설치된 Orca 1.4.204 번들 소스(`out/main/index.js` 및 `out/shared/shell-process-detection.js`)를 분석한 결과, 다음 5가지 판정 규칙이 확인되었습니다.

### 1. 에이전트 식별 (Agent Detection)
- **위치**: `out/shared/shell-process-detection.js` (`isShellProcess`), `out/main/index.js` (`isterminalrunningagent`)
- **규칙**: 터미널의 전경 프로세스(foreground process) 이름이 셸(`bash`, `zsh`, `cmd.exe`, `powershell.exe` 등)로 식별되면, 에이전트가 실행 중이 아닌 'bare shell' 상태로 간주하여 `isterminalrunningagent`가 `false`를 반환합니다. `out/main/index.js` 내 `isterminalrunningagent`에서 `ptycontroller.getforegroundprocess`를 호출하여 얻은 프로세스 객체를 기반으로 에이전트를 매핑하며, `isShellProcess`가 `true`면 거부됩니다.
- **PowerShell에서 여러 명령 실행 시 실패 원인 (#46 B)**: PowerShell에서 `mode con: cols=44; agy ...` 처럼 한 줄에 여러 명령(statement)을 적어 실행하면, 프로세스(exec)가 대체되지 않거나 복수 명령 실행 기간 동안 전경 프로세스가 계속 `powershell.exe`로 유지됩니다. 따라서 `isShellProcess('powershell.exe')`에 의해 셸로 간주되어, 에이전트로 식별되지 않고 실패하게 됩니다. 제목 기반 식별 또한 셸 이름(`powershell.exe`)으로 남아 있으면 실패 요인이 됩니다.

### 2. `terminal wait --for tui-idle` 판정
- **위치**: `out/main/index.js` 내 `q0i(e)` 함수 등 (화면 문자열 분석)
- **규칙**:
  - `antigravity`: 입력 `e`는 화면 버퍼 문자열을 소문자로 변환한 값(`e.toLowerCase()`)입니다. `e.lastIndexOf('antigravity cli')`로 배너를 찾고, 이어진 줄에서 온전히 `gemini`로 시작하는 줄(`e.startsWith('gemini', o)`)과 길이가 1이고 `>`인 줄(`s-o===1 && e.charCodeAt(o)===62`)이 모두 존재해야 대기로 판정합니다. 화면 폭(44) 조정 시 로고가 배너 위로 밀려나 모델 줄 맨 앞에 로고 문자가 붙지 않으므로 `gemini`로 시작할 수 있게 됩니다.
  - **Claude 판정**: `W0i(e)` 등에서 `V0i = '✳'` 상수를 사용해 `e.startsWith('✳')`로 제목을 검사하거나, `/hook/claude`로 들어오는 상태 훅 메시지로 판정합니다.
  - **상태 훅 및 제목**: `antigravity` 터미널은 화면 내 문자열(`antigravity cli`, `gemini`, `>`)만으로 대기를 판정하는 `q0i(e)` 함수에 완전히 의존하며, `Stop` 훅이나 터미널 제목(`✳`)은 판정 근거로 쓰이지 않습니다.

### 3. `blockedReason` 판정 (신뢰 질문 등)
- **위치**: `out/main/index.js` 화면 파싱 로직
- **규칙**: 화면 문자열에서 `do you trust`, `trust this`, `trusted workspace`의 마지막 위치(`lastIndexOf`)를 찾고, 그 이후 문자열에 `workspace`, `folder`, `directory`, `repo` 중 하나가 포함되어 있으면 `reason: 'agent-trust-workspace'`로 차단합니다.
- **버퍼 내 문구 잔존 문제**: 화면 전체(또는 버퍼)를 대상으로 `lastIndexOf`를 수행하므로, 질문에 답한 뒤에도 터미널 버퍼에 해당 문구가 남아 있으면(스크롤로 사라지지 않으면) 지워질 때까지 차단을 일으킵니다.

### 4. `orchestration dispatch --inject`의 `no_agent_detected` 조건
- **위치**: `out/main/index.js`
- **규칙**: `if (e.inject && !await n.isterminalrunningagent(l)) throw ken(l, 'no_agent_detected')`
- **설명**: 주입(`--inject`) 모드일 때 터미널이 에이전트를 실행 중이지 않으면(전경 프로세스가 셸 등) `no_agent_detected`로 작업을 거부합니다.

### 5. `worker-start --terminal`의 `agent_unconfigured` 조건
- **위치**: `out/main/index.js`
- **규칙**: `if (!await t.isterminalrunningagent(n)) throw new z('agent_unconfigured', 'terminal ${n} is not running a recognized agent.')`
- **설명**: 넘겨받은 터미널이 에이전트(`claude`, `codex` 등 식별된 에이전트)를 실행 중이 아니면 `agent_unconfigured`로 거부합니다. 이후 주입 시도 전, 에이전트 터미널이 `tui-idle` 상태에 도달할 때까지 대기합니다.

---

### 서술 대조 표 (`orca-runtime.md` 기준)

| 서술 | 소스의 규칙 | 일치 여부 | 근거 위치 |
| --- | --- | --- | --- |
| 101행: 한 번도 신뢰한 적 없는 저장소에서 Codex 띄우면 신뢰 화면 나옴 | 미확인 | 미확인 | (코드에 codex-trust-workspace 있음, 실제 동작 미확인) |
| 143행: Claude·Codex는 에이전트 전경 프로세스로 인식, Agy는 antigravity 에이전트로 인식 | 프로세스 이름 검사 (`isShellProcess`) 및 전경 프로세스 확인 로직 존재 | 일치 | `out/main/index.js` (`isterminalrunningagent`), `out/shared/shell-process-detection.js` |
| 147행: 화면에 폴더 신뢰 질문 남아 있으면 `agent-trust-workspace`로 거부 | 화면 텍스트 내 `do you trust` 등 포함 시 `agent-trust-workspace` 차단 | 일치 | `out/main/index.js` `agent-trust-workspace` 파싱 정규표현/문자열 조건 |
| 149행: Claude 대기는 제목(`✳` 시작)과 상태 훅, Codex는 `OpenAI Codex` 배너와 `model:`, `directory:` 줄로 판정 | Codex: `e.lastIndexOf('openai codex')` 후 `model:`, `directory:` 포함 확인 (`z0i` 함수) | 일치 | `out/main/index.js` `z0i` 함수, `agent-status` 훅 등 |
| 151행: Agy 터미널 대기는 `Antigravity CLI` 배너 뒤 `gemini`로 시작하는 줄과 `>`만 있는 줄이 모두 있어야 함 | `q0i(e)` 내에서 `antigravity cli`, `gemini` 시작, `>` 길이 1 확인 로직 | 일치 | `out/main/index.js` `q0i` 함수 |
| 151행: Windows에서 `powershell.exe`로 남으면 `no_agent_detected`로 거부 | PowerShell에서 복수 명령 시 `powershell.exe`가 전경 프로세스로 남아 `isShellProcess`에 걸려 차단됨 | 일치 | `out/shared/shell-process-detection.js`, `isterminalrunningagent` |
| 153행: Agy 터미널 `timeout` 등 거부 시 우회 주입 불가 | `no_agent_detected` 및 `agent_unconfigured` 발생 시 주입 및 시작 거부됨 | 일치 | `out/main/index.js` `worker-start` 및 `dispatch --inject` 거부 코드 |
| 155행: 예외 주입 경로 (Agy 터미널 대기 보고 한계 우회) | `dispatch --inject` 시도 시 터미널 에이전트 식별을 우선 확인 | 일치 | `out/main/index.js` `no_agent_detected` 방어 코드 |
| 171행: 신뢰 질문 답변 뒤 버퍼 문구 잔존 문제 | 화면 파싱 시 `lastIndexOf`로 전체 확인하므로, 버퍼 내 남아있으면 차단 | 일치 | `out/main/index.js` 문자열 포함(`workspace`, `folder` 등) 확인부 |
| 181행: 명령줄에 `--dangerously-skip-permissions` 등 우회 플래그 적용 시 도구 승인 건너뜀 | 소스 상에서 전달된 명령어 기반으로 에이전트가 실행됨 (Orca 단에서 차단하지 않음) | 일치 | (해당 부분은 터미널 래퍼와 Orca 명령 전달 방식에 해당됨) |

### 6. `agentIdentity` 결정 규칙과 `isTerminalRunningAgent`의 차이

번들 코드(`out/shared/pane-agent-identity-adapter.js` 및 `out/main/index.js`) 확인 결과, 두 판정은 서로 다른 목적과 로직을 가집니다.

1. **`agentIdentity` 결정 방식**:
   - `terminal show` 등에서 표시되는 `agentIdentity`는 `out/shared/pane-agent-identity-adapter.js`의 `resolveCanonicalPaneAgentIdentity` 함수를 통해 여러 출처의 증거(evidence)에 우선순위를 두어 결정됩니다.
   - **우선순위 (`PANE_AGENT_EVIDENCE_SOURCES`)**: `live-hook` > `process` (전경 프로세스) > `launch` (Orca 실행 기록) > `completed-hook` > `sleeping-session` > `sibling` > `title` (터미널 제목).
   - 동순위 증거에서 서로 다른 에이전트를 가리키면 `agents.size > 1` 로직에 따라 충돌(ambiguous)로 처리되어 `null`이 반환됩니다.
2. **`isTerminalRunningAgent`와의 차이**:
   - `isTerminalRunningAgent`(`out/main/index.js` 내 `d4i.isPtyRunning`)는 에이전트 실행 여부(boolean)를 가리는 liveness 체크로, 제목, 화면 버퍼(`tailBuffer`), 셸의 전경 자식 프로세스 이름 등을 복합적으로 확인하며, `agentIdentity` 결정과는 완전히 별개의 판정입니다.
3. **Windows 전경 프로세스 확인 방법**:
   - `out/main/index.js`의 `cqe()` 함수에서 `windows-process-tree`의 네이티브 모듈(`t.Mi`, `t.Ri` 호출 등)을 활용하여 셸(`n.pid`)의 자식 프로세스 트리를 탐색해 말단(활성) 프로세스 이름(예: `agy.exe`)을 알아냅니다. 셸 아래의 자식 프로세스를 정확히 감지합니다.
4. **실측 결과 설명 표**:

| 조건 (실측 사례) | `agentIdentity` | 소스 기반 설명 (규칙 적용) |
|---|---|---|
| gemini/gpt-oss 모델 (제목 지정) | `antigravity` | 전경 프로세스(`agy.exe` -> `antigravity`) 증거가 확보되었고, 제목(`probe...`) 증거와 충돌하지 않아 우선순위에 따라 `antigravity`로 판정됨. |
| claude-sonnet-4-6 (제목 지정: probe-2-claude, probe-2-claude-r2) | `null` (없음) | 프로세스는 `agy.exe`이나 화면 파싱, `claude` 상태 훅(`live-hook`) 등으로 인해 `claude` 증거와 `antigravity` 증거가 경합하여 충돌(ambiguous)로 처리되었을 가능성 높음 (미확인: 실제 충돌 증거 조합 로깅 필요). |
| `--title` 미지정 시 (gemini) | `null` (없음) | 프로세스 증거(`isForegroundProcessProofFresh`의 수명 초과 등)가 누락된 상황에서, 터미널 제목(`Terminal 1`)만으로는 에이전트를 식별할 수 없어 `null`이 반환되었을 수 있음 (미확인: 프로세스 증거 무효화 여부 등 실제 값 확인 필요). |

> **올바른 규칙 수정 필요 사항 (orca-runtime.md 불일치 시)**: 현재 `orca-runtime.md`의 서술은 설치된 소스의 실제 판정 기준(화면 파싱 문자열 기반 대기 및 차단 판독, 셸 프로세스 필터링)과 대체로 일치합니다. 단, Agy 대기 판정이 `gemini`로 시작하는 문자열에 강하게 의존(`startsWith('gemini', o)`)한다는 점이 확인되었으므로, 다른 모델(예: `claude`, `gpt-oss`) 사용 시 폭을 아무리 조정해도 해당 줄이 `gemini`로 시작하지 않기 때문에 무조건 실패할 수밖에 없음이 소스로 증명되었습니다.

## 설계

### 1. `scripts/launch-matrix.mjs` 공개 함수 시그니처
```javascript
/**
 * 주어진 환경 조합에서 터미널 실행 경로와 예측 결과를 반환합니다.
 * Agy 모델은 내부에서 계열('gemini', 'claude', 'gpt-oss')로 정규화됩니다.
 * 
 * @param {object} params
 * @param {'claude'|'codex'|'agy'} params.runner - 실행기
 * @param {string} [params.model] - 모델 이름 (예: 'gemini-3.1-pro-high')
 * @param {'win32'|'darwin'|'linux'} params.platform - 플랫폼
 * @param {'powershell'|'posix'} params.shell - 셸 종류
 * @param {boolean} params.trustRecordExists - 워크트리 신뢰 기록 유무
 * @param {boolean} params.skipDangerousModePermissionPrompt - 첫 실행 확인 질문 설정 우회 여부
 * @param {string} params.orcaVersion - Orca 버전
 * @param {string} params.cliVersion - Antigravity CLI 버전
 * @returns {MatrixResult}
 */
export function predictLaunchPath(params) {
  // ...
}
```

### 2. 칸의 값 (MatrixResult 스키마)
- `path`: `supervised-terminal` | `supervised-screen-path` | `headless` | `blocked`
- `reason`: 차단 또는 예외 경로인 경우 이유 코드 목록 (예: `agent-trust-workspace`, `claude-permission-prompt`, `unsupported_version`, `no_agent_detected`, `agent-trust-workspace-buffer`, `codex-trust-workspace`).
- `nextOwner` / `nextAction`: 거부 시 담당자와 다음 행동 가이드.
- `evidence`: `verified`(날짜·버전·재현 기록) | `source-derived`(번들 위치) | `unverified`. Orca나 CLI 버전이 표가 다루는 범위를 벗어나면 결과가 `unverified`로 떨어지는 규칙을 둡니다.

### 3. 표 전체 초안

차원 조합에 따른 예측 결과입니다. 규칙은 위에서부터 순차적으로 평가되며 처음 조건이 맞는 행이 적용됩니다 (마지막 행이 나머지 모든 조합을 덮습니다).
조건 평가 순서는 다음과 같습니다: 버전 범위(지원 여부) -> 신뢰 기록(trust) -> 첫 실행 확인 질문(skipPrompt) -> 실행기(runner) -> 모델 계열(model) -> 플랫폼(platform) -> 셸(shell).
실측과 소스로 뒷받침되지 않는 칸은 `evidence`를 `unverified`로 표기하고 터미널 생성을 사전 차단(`path: blocked`)합니다.

| 조건(runner/model/platform/shell/trust/skipPrompt) | 예상 path | reason | nextOwner / nextAction | evidence |
|---|---|---|---|---|
| 지원 버전 범위 밖 | blocked | unsupported_version | pm / 버전 지원 확인 | unverified |
| Agy / - / - / - / 신뢰 없음 / - | blocked | agent-trust-workspace | user / 폴더 신뢰 | verified (26-09-17, Orca 1.4.204, CLI 1.2.5; `docs/plan/agy-terminal-probes.md` 1-1절) |
| Codex / - / - / - / 신뢰 없음 / - | blocked | codex-trust-workspace | user / 폴더 신뢰 | source-derived (out/main/index.js) |
| Claude / - / - / - / - / skipPrompt=false | blocked | claude-permission-prompt | user / 권한 승인 | unverified |
| Agy / claude / - / - / 신뢰 있음 / - | blocked | claude-unsupported-by-orca | pm / headless 권장 | verified (26-09-17, Orca 1.4.204, CLI 1.2.5; `docs/plan/agy-terminal-probes.md` 2-2절) |
| Agy / gemini / win32 / powershell / 신뢰 있음 / - | headless | - | - / - | verified (26-09-17, CLI 1.2.4; `docs/plan/headless-runtime.md` Windows 검증) |
| Agy / - / win32 / - / 신뢰 있음 / - | blocked | agent-trust-workspace-buffer | pm / headless 권장 | verified (26-09-17, Orca 1.4.204, CLI 1.2.5; `docs/plan/agy-terminal-probes.md` 1-1절 버퍼 잔존 문제) |
| Agy / gemini,gpt-oss / posix / - / 신뢰 있음 / - | supervised-terminal | - | - / - | unverified |
| Claude / - / posix / - / - / skipPrompt=true | supervised-terminal | - | - / - | unverified |
| Codex / - / posix / - / 신뢰 있음 / - | supervised-terminal | - | - / - | unverified |
| 그 외 모든 미확인 조합 | blocked | untested_combination | pm / 검증 필요 | unverified |

**규칙 적용 예시:**
- `Agy / gemini / win32 / powershell / 신뢰 없음 / skipPrompt=true`: 2번째 행에 걸려 `blocked (agent-trust-workspace)`
- `Agy / claude / win32 / powershell / 신뢰 있음 / skipPrompt=true`: 5번째 행에 걸려 `blocked (claude-unsupported-by-orca)`
- `Agy / gemini / win32 / powershell / 신뢰 있음 / skipPrompt=true`: 6번째 행에 걸려 `headless`
- `Agy / gpt-oss / win32 / cmd / 신뢰 있음 / skipPrompt=true`: 7번째 행에 걸려 `blocked (agent-trust-workspace-buffer)`


### 4. 인접 실패 칸과 사전 점검
브리프 기준 7의 인접 실패 6가지를 다음 이유 코드로 사전 거부합니다 (자동 응답 없음):
1. **Codex 폴더 신뢰 질문**: 신뢰 없음 시 `codex-trust-workspace`
2. **Claude 권한 우회 첫 실행 확인**: `skipPrompt` 설정 안 된 경우 `claude-permission-prompt`
3. **Agy 신뢰 문구의 버퍼 잔존**: Agy 첫 실행 후 버퍼에 문구가 남아 차단되는 상황 예측 (`agent-trust-workspace-buffer`)
4. **Codex 역할 worker_done 미검증**: `unverified`
5. **터미널 제목이 셸 경로로 남는 경우**: PowerShell에서 복수 명령 실행 시 발생. `no_agent_detected`
6. **버전 범위 밖**: Orca/CLI 버전이 지원 범위 밖이면 `unsupported_version`

### 5. 거부 흐름과 표 불일치 신호
- **실행 전 거부**: `plugins/oh-my-teams/scripts/role-terminal.mjs`에서 터미널을 열기 전(`workflow-reserve` 이전)에 표를 조회합니다. 표가 `blocked`를 반환하면 터미널 생성과 attempt 예약을 중단하고, 이유 코드와 `nextAction`을 반환합니다.
- **사후 거부 분류**: 표가 성공(`supervised-terminal`)을 예측했으나 `terminal-idle-check`나 `worker-start`에서 실패하는 경우, 이를 "표 불일치" 신호로 분류합니다. `plugins/oh-my-teams/scripts/failures.mjs` 내 `failure-classify`가 받을 신호 이름은 `matrix-mismatch`이며, 분류 경로는 `matrix-mismatch -> review`로 지정합니다.

### 6. 새 터미널 경로 가능 여부
- **결론**: Orca `tui-idle`에 기대지 않는 감독 터미널 경로(`supervised-screen-path`)는 현재 Orca CLI 제약상 불가능합니다.
- **근거**: `orca orchestration dispatch --inject`를 사용하면 Task/Dispatch 컨텍스트는 생성되지만, 터미널이 `unsupervised` 상태로 남습니다. `worker-list`는 이를 `unsupervised`로 보고하고, `worker-stop` 등 lifecycle 제어 명령이 듣지 않습니다. 기존 에이전트 터미널의 lifecycle을 획득하는 `worker-start --terminal <handle>` 명령은 작업 계약 금지 조항에 의해 사용할 수 없습니다.

### 7. 기존 조건을 대체할 호출 지점 목록
기존의 하드코딩된 조건들을 표(matrix)를 읽는 로직으로 대체합니다.
- `plugins/oh-my-teams/scripts/role-terminal.mjs:56`: 폭 조정(narrow) 로직에서 Windows의 경우 폭 조정을 **생략**하도록 변경합니다. 이유: `mode con: cols=44`를 `agy` 실행과 함께 묶거나 분리하여 전송하더라도, 전경 프로세스가 `powershell.exe`로 남아 Orca가 에이전트를 식별하지 못하기 때문입니다(`docs/plan/agy-terminal-probes.md` 1절 조합 A, B 참조). 반면 POSIX에서는 터미널 에이전트 식별이 정상 동작하므로 기존처럼 `stty cols 44`를 함께 적용합니다.
- `plugins/oh-my-teams/scripts/role-terminal.mjs:497-502`: `platform === "win32" && /^gemini/...` 검사 대신 `predictLaunchPath` 결과가 `blocked`인지 확인.
- `plugins/oh-my-teams/scripts/role-terminal.mjs:315, 420, 521, 543`: `trustQuestion` 로직이 `agent-trust-workspace` 등 매트릭스의 reason 코드와 연계.
- `plugins/oh-my-teams/scripts/orca-adapter.mjs:484`: `blockedReason`이 매트릭스 예측과 다를 경우 `matrix-mismatch`로 분류.
- `plugins/oh-my-teams/scripts/workflow.mjs:740`: `validateExecutionInput`에서 headless receipt 처리 등 추가.

### 8. Headless receipt 형식과 검증 규칙
headless 모드 실행 시 workflow에 연결하기 위한 receipt 형식입니다.
```json
{
  "via": "headless-start",
  "executionId": "junior-launch-probes-rework-1",
  "runId": "run_26fc7d5e1e5b",
  "taskId": "headless:junior-launch-probes-rework-1",
  "dispatchId": "headless:junior-launch-probes-rework-1",
  "worktreeId": "b17417a2-dbbc-4c0f-8605-dc79dfb58523::C:/Users/kjsun/orca/workspaces/oh-my-teams/agy-launch-probes",
  "runnerPid": 2112,
  "modelRequested": "claude-sonnet-4-6"
}
```
- `plugins/oh-my-teams/scripts/workflow.mjs`의 `workflow-attach` 단계에서 `receipt.via === "headless-start"`인지 검사하고, `headless Worker ID`가 `taskId` 및 `dispatchId`와 일대일로 대응하는지 검증합니다. 통과하지 않으면 거부합니다.

## Orca 수정안

### 1. 판정 코드 최소 수정안
**위치:** `out/main/index.js` (`q0i` 함수 내 Agy 에이전트 식별 로직)
- **수정 전:** 
  ```javascript
  e.lastIndexOf('antigravity cli') ... e.startsWith('gemini', o)
  ```
- **수정 후:** 
  ```javascript
  // gemini 뿐만 아니라 claude, gpt-oss 등 다른 모델도 허용하도록 조건 완화
  e.lastIndexOf('antigravity cli') ... (e.startsWith('gemini', o) || e.startsWith('claude', o) || e.startsWith('gpt-oss', o))
  ```
**위치:** `out/shared/shell-process-detection.js` (`isShellProcess`)
- **수정안:** Windows PowerShell에서 복합 명령(`mode con: cols=44; agy...`) 사용 시 전경 프로세스가 여전히 `powershell.exe`로 남는 문제 해결을 위해, 터미널 내부 프로세스 트리에서 `agy.exe` 말단 프로세스 활성 상태를 직접 확인하는 로직 보강.

### 2. 재현 절차 (Windows 11)
1. PowerShell 기반의 새 워크트리를 생성합니다.
2. `orca terminal create --command "mode con: cols=44; agy --dangerously-skip-permissions --model gemini-3.1-pro-high"` 명령을 실행합니다.
3. **기대 결과:** Orca가 해당 터미널을 `antigravity` 에이전트로 식별(`agentIdentity`)하고, `tui-idle`이 만족되어 작업을 주입할 수 있어야 합니다.
4. **실제 결과:** 터미널 창의 프로세스가 `powershell.exe`로 남아 있어 `no_agent_detected` 또는 식별 불가(null)로 처리되고 작업 주입에 실패합니다.

### 3. stablyai/orca#21110 댓글 초안
(※ 참고: 이 댓글은 게시하지 않습니다.)
```markdown
Hello Orca team,

We have encountered a persistent issue on Windows where the agent detection logic incorrectly classifies Agy CLI terminals as bare shells when multiple statements are executed in PowerShell (e.g., `mode con: cols=44; agy ...`). Since the foreground process remains `powershell.exe` during execution, `isShellProcess` flags it as a shell, causing `agentIdentity` to be null.

Additionally, the `tui-idle` check in `q0i(e)` strictly asserts `e.startsWith('gemini', o)` after the `Antigravity CLI` banner. This hardcoded rule prevents other valid Agy models (like `claude-sonnet-4-6` or `gpt-oss-120b-medium`) from ever being detected as idle, even if the UI renders correctly. 

We propose relaxing the model name check in `q0i(e)` to include other model families, and improving the Windows foreground process tree parsing to accurately identify `agy.exe` as the leaf active process even when wrapped in a PowerShell composite command.

Thanks!
```
