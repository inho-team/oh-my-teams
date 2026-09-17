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
   - `terminal show` 등에서 표시되는 `agentIdentity`는 여러 출처의 증거(evidence)에 우선순위를 두어 결정됩니다.
   - **우선순위 (PANE_AGENT_EVIDENCE_SOURCES)**: `live-hook` > `process` (전경 프로세스) > `launch` (Orca 실행 기록) > `completed-hook` > `sleeping-session` > `sibling` > `title` (터미널 제목).
   - 동순위 증거에서 서로 다른 에이전트를 가리키면 충돌(ambiguous)로 처리되어 `null`이 반환됩니다. 언제든 상위 증거가 변경되면 갱신됩니다.
2. **`isTerminalRunningAgent`와의 차이**:
   - `isTerminalRunningAgent`는 에이전트 실행 여부(boolean)를 가리는 liveness 체크로, `isPtyRunning`을 통해 제목, 화면 버퍼, 셸의 전경 자식 프로세스 이름 등을 복합적으로 확인하며, `agentIdentity`와는 완전히 별개의 판정입니다.
3. **Windows 전경 프로세스 확인 방법**:
   - `cqe()` 함수에서 `windows-process-tree.node`의 네이티브 모듈(`t.Mi` 및 `t.Ri` 등)을 활용하여 셸(`n.pid`)의 자식 프로세스 트리를 탐색해 말단(활성) 프로세스 이름(예: `agy.exe`)을 알아냅니다. 따라서 셸 아래의 자식 프로세스를 정확히 감지합니다.
4. **실측 결과 설명 표**:

| 조건 (실측 사례) | `agentIdentity` | 소스 기반 설명 (규칙 적용) |
|---|---|---|
| gemini/gpt-oss 모델 (제목 지정) | `antigravity` | 전경 프로세스(`agy.exe` -> `antigravity`) 증거가 우세하여 `antigravity`로 판정됨. |
| claude-sonnet-4-6 (제목 미지정) | `null` (없음) | 프로세스는 `agy.exe`이나, 화면/명령어에서 `claude` 키워드가 감지(또는 훅 발생)되어 증거 충돌(ambiguous)로 `null`이 되었을 수 있음 (미확인: 실제 어느 증거끼리 충돌했는지 로깅 필요). |
| `--title` 미지정 시 (gemini) | `null` (없음) | 자동 부여된 `Terminal 1` 등의 제목을 fallback으로 파싱하는 과정에서 기각(rejectTitleFallback)되거나 프로세스 증거가 무효화되었을 수 있음 (미확인: fallback 기각 조건과 프로세스 증거 무효화 조건의 실제 값 확인 필요). |

> **올바른 규칙 수정 필요 사항 (orca-runtime.md 불일치 시)**: 현재 `orca-runtime.md`의 서술은 설치된 소스의 실제 판정 기준(화면 파싱 문자열 기반 대기 및 차단 판독, 셸 프로세스 필터링)과 대체로 일치합니다. 단, Agy 대기 판정이 `gemini`로 시작하는 문자열에 강하게 의존(`startsWith('gemini', o)`)한다는 점이 확인되었으므로, 다른 모델(예: `claude`, `gpt-oss`) 사용 시 폭을 아무리 조정해도 해당 줄이 `gemini`로 시작하지 않기 때문에 무조건 실패할 수밖에 없음이 소스로 증명되었습니다.
