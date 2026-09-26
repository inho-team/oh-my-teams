# Agy 터미널 경로 개선 계획 (Orca 판정 규칙)

- 작성일: 2026-09-17
- 상태: Orca 1.4.210 재실측과 검토 반영 완료. 호환성 표는 `plugins/oh-my-teams/scripts/launch-matrix.mjs`가 정본이다. 판정 규칙이 Orca 1.4.210에서 교체되어, POSIX를 포함한 모든 플랫폼에서 폭 44 조정이 제거되었고 macOS에서는 폭 조정 여부와 무관하게 감독 터미널이 성립한다. Windows 조합의 근거 등급은 `verified`가 아니며, 근거였던 Orca 1.4.204의 판정 규칙은 더 이상 존재하지 않고 재검증할 Windows 머신이 없다.
- 대상 버전: Orca 1.4.210, Antigravity CLI 1.2.11

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

> **Orca 1.4.210 갱신**: 이 절이 분석한 `q0i(e)`는 Orca 1.4.204 번들의 판정 함수였다. Orca 1.4.210에서는 이 함수가 `Maa(e)`로 교체되었고, 프롬프트 줄이 `>` 하나이거나 `> <모드 이름> mode: ` 형식이면 대기로 판정한다. 함수 전체에 `gemini` 문자열이 없으므로, 위에서 서술한 `gemini`로 시작하는 줄 요구와 그에 따른 배너 폭 조정 근거는 더 이상 유효하지 않다([#104](https://github.com/inho-team/oh-my-teams/issues/104), 2026-09-25, Orca 1.4.210, Antigravity CLI 1.2.11 실측).

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

> **Orca 1.4.210 갱신**: 이 표는 Orca 1.4.204 번들을 분석해 작성했다. 151행이 근거로 삼은 `q0i` 함수는 1.4.210에서 `Maa(e)`로 교체되어 더 이상 `gemini`로 시작하는 줄을 요구하지 않으므로, 151행의 '일치' 판정은 1.4.204 당시에만 유효하다([#104](https://github.com/inho-team/oh-my-teams/issues/104)).

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

> **올바른 규칙 수정 필요 사항 (orca-runtime.md 불일치 시)**: 현재 `orca-runtime.md`의 서술은 설치된 소스의 실제 판정 기준(화면 파싱 문자열 기반 대기 및 차단 판독, 셸 프로세스 필터링)과 대체로 일치합니다. 단, Agy 대기 판정이 `gemini`로 시작하는 문자열에 강하게 의존(`startsWith('gemini', o)`)한다는 점이 확인되었으므로, 다른 모델(예: `claude`, `gpt-oss`) 사용 시 폭을 아무리 조정해도 해당 줄이 `gemini`로 시작하지 않기 때문에 무조건 실패할 수밖에 없음이 소스로 증명되었습니다. 이 결론은 Orca 1.4.204의 `q0i` 판정에서만 유효했다. Orca 1.4.210에서는 판정 함수가 `Maa(e)`로 교체되어 `gemini` 문자열에 의존하지 않으며, claude 계열도 폭 조정 없이 통과하는 것을 실측으로 확인해 이 결론은 반증되었다([#104](https://github.com/inho-team/oh-my-teams/issues/104), 2026-09-25).

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
 * @param {boolean} [params.allowUnverified=false] - 검증 모드. true일 때만 unverified인 supervised-terminal 후보 칸이 터미널 생성을 허용
 * @returns {MatrixResult}
 */
export function predictLaunchPath(params) {
  // ...
}
```

**검증 모드(`allowUnverified`) 전달 방식:**
초기 설계에서는 이 옵션으로 미검증 경로의 실행 승인을 받았습니다. #66 수정 후에는 실행 경로가 정해진 `supervised-terminal` 조합을 근거 등급만으로 차단하지 않습니다. `unverified-terminal-evidence` 경고와 환경 정보를 결과에 남기고, 실제 터미널의 준비 상태와 모델을 확인합니다. 옵션은 이전 호출과의 호환을 위해 유지합니다. 아래 표와 실측 기록의 검증 모드는 당시 정책을 나타내며 현재 실행 정책은 `launch-matrix.mjs`를 따릅니다.

### 2. 칸의 값 (MatrixResult 스키마)
- `path`: `supervised-terminal` | `supervised-screen-path` | `headless` | `blocked`
- `reason`: 차단 또는 예외 경로인 경우 이유 코드 목록 (예: `agent-trust-workspace`, `claude-permission-prompt`, `untested_version`, `untested_patch_version`, `no_agent_detected`, `agent-trust-workspace-buffer`, `codex-trust-workspace`).
- `nextOwner` / `nextAction`: 거부 시 담당자와 다음 행동 가이드.
- `evidence`: `verified`(날짜·버전·재현 기록) | `source-derived`(번들 위치) | `unverified`. Orca나 CLI 버전이 표가 다루는 범위를 벗어나면 결과가 `unverified`로 떨어지는 규칙을 둡니다.

### 3. 표 전체 초안

차원 조합에 따른 예측 결과입니다. 규칙은 위에서부터 순차적으로 평가되며 처음 조건이 맞는 행이 적용됩니다 (마지막 행이 나머지 모든 조합을 덮습니다).
조건 평가 순서는 다음과 같습니다: 버전 범위(지원 여부) -> 신뢰 기록(trust) -> 첫 실행 확인 질문(skipPrompt) -> 실행기(runner) -> 모델 계열(model) -> 플랫폼(platform) -> 셸(shell).
실측과 소스로 뒷받침되지 않는 칸은 `evidence`를 `unverified`로 표기하고 터미널 생성을 사전 차단(`path: blocked`)합니다.

| 조건(runner/model/platform/shell/trust/skipPrompt) | 예상 path | reason | nextOwner / nextAction | evidence |
|---|---|---|---|---|
| Agy / - / win32 / powershell / - / - (복합 명령 실행 시) | blocked | no_agent_detected | pm / 단일 명령으로 분리 | source-derived (out/shared/shell-process-detection.js) |
| Agy / - / - / - / 신뢰 없음 / - | blocked | agent-trust-workspace | user / 폴더 신뢰 | verified (26-09-17, Orca 1.4.204, CLI 1.2.5; `docs/plan/agy-terminal-probes.md` 1-1절) |
| Codex / - / - / - / 신뢰 없음 / - | blocked | codex-trust-workspace | user / 폴더 신뢰 | source-derived (out/main/index.js) |
| Claude / - / - / - / - / skipPrompt=false | blocked | claude-permission-prompt | user / 권한 승인 | unverified |
| Claude / - / win32 / - / - / skipPrompt=true | supervised-terminal | - | - / - | verified (26-09-17, Claude Code 2.1.274, Haiku 4.5; `plugins/oh-my-teams/references/orca-runtime.md` Claude 역할 검증, worker_done 확인) |
| *(규칙 7, 삭제됨)* Agy / claude / - / - / 신뢰 있음 / - | - | - | - | Orca 1.4.210 실측으로 반증되어 규칙을 삭제했다([#104](https://github.com/inho-team/oh-my-teams/issues/104)) |
| Agy / gemini / win32 / powershell / 신뢰 있음 / - | headless | orca-idle-requires-narrow-screen | - / 1.4.204의 좁은 화면 요구가 근거를 잃어 headless를 유지 | unverified (근거였던 Orca 1.4.204 판정 규칙이 1.4.210에서 사라졌고 Windows에서 재검증되지 않음, #104) |
| Agy / - / win32 / powershell / 신뢰 있음 / - (gemini 외 다른 계열 포함) | headless | agy-headless-fallback | - / Agy 역할 대체 경로 | unverified (근거였던 Orca 1.4.204 판정 규칙이 1.4.210에서 사라졌고 Windows에서 재검증되지 않음, #104) |
| Agy / - / posix / - / 신뢰 있음 / - | supervised-terminal | - | - / - | verified (모델 계열 무관; 26-09-25, Orca 1.4.210, CLI 1.2.11, #104) |
| Claude / - / posix / - / - / skipPrompt=true | supervised-terminal | - | - / - | unverified |
| Codex / - / - / - / 신뢰 있음 / - | blocked | codex-worker-done-unverified | pm / 브리프 기준 9 실측 | unverified |
| 그 외 모든 미확인 조합 | blocked | untested_combination | pm / 검증 필요 | unverified |

**규칙 적용 예시:**
- **Windows Claude**: `Claude / - / win32 / - / - / skipPrompt=true` -> 5번째 행(Claude / - / win32 / - / - / skipPrompt=true)에 걸려 `supervised-terminal`
- **Windows gemini Agy**: `Agy / gemini / win32 / powershell / 신뢰 있음 / skipPrompt=true` -> 7번째 행(Agy / gemini / win32 / powershell / 신뢰 있음 / -)에 걸려 `headless`(근거 unverified). `allowUnverified`는 더 이상 경로를 가르지 않고 이전 호출과의 호환을 위해서만 남아 있다.
- **Codex**: `Codex / - / - / - / 신뢰 없음 / -` -> 3번째 행(Codex / - / - / - / 신뢰 없음 / -)에 걸려 `blocked (codex-trust-workspace)`
- **검증에 쓰지 않은 버전**: 경로는 그대로 두고 근거 등급만 낮춘다. 패치 버전만 다르면 `untested_patch_version`을 붙이고 등급을 유지하며, 주·부 버전이 다르거나 버전을 확인하지 못하면 `untested_version`을 붙이고 등급을 한 단계 낮춘다(#61). Orca 버전은 Orca 터미널을 쓰는 경로에만, Antigravity CLI 버전은 Agy 역할에만 적용한다.


### 4. 인접 실패 칸과 사전 점검
브리프 기준 7의 인접 실패 6가지 중 4가지는 다음 이유 코드로 사전 거부하고, 버퍼 잔존과 실행 후 식별 불가 문제는 사후 거부로 처리합니다:
1. **Codex 폴더 신뢰 질문**: 신뢰 없음 시 `codex-trust-workspace` (사전 거부)
2. **Claude 권한 우회 첫 실행 확인**: `skipPrompt` 설정 안 된 경우 `claude-permission-prompt` (사전 거부)
3. **Agy 신뢰 문구의 버퍼 잔존 (사후 거부)**: 터미널을 다시 연 뒤에도 버퍼에 문구가 남아 차단되는 경우 `agent-trust-workspace-buffer` 반환
4. **Codex 역할 worker_done 미검증**: `codex-worker-done-unverified` (사전 거부)
5. **터미널 제목이 셸 경로로 남는 경우 (no_agent_detected)**:
   - **사전 거부**: 폭 조정(`mode con: cols=44`) 등 앞선 명령을 `agy`와 같은 줄에 붙이는 복합 명령 방식인 경우, 실행 전에 알 수 있으므로 매트릭스에서 미리 `no_agent_detected`로 차단(`blocked`)합니다.
   - **사후 거부**: 단일 명령으로 실행했음에도 실행 뒤 프로세스 이름이 셸로 남아 식별되지 않는 경우는 사후 거부 코드 `no_agent_detected`를 반환하며, 표 불일치 분류 규칙(`matrix-prediction-failure`)으로 연결합니다.
6. **검증에 쓰지 않은 버전**: 경로를 막지 않고 `untested_patch_version` 또는 `untested_version`으로 근거 등급만 낮춘다 (#61)

### 5. 거부 흐름과 표 불일치 신호
- **실행 전 거부**: `plugins/oh-my-teams/scripts/role-terminal.mjs`에서 터미널을 열기 전(`workflow-reserve` 이전)에 표를 조회합니다. 표가 `blocked`를 반환하면 터미널 생성과 attempt 예약을 중단하고, 이유 코드와 `nextAction`을 반환합니다.
- **사후 거부 분류**: 표가 성공(`supervised-terminal` 또는 `headless`)을 예측했으나 `terminal-idle-check`나 `worker-start` 단계에서 실패하는 경우, 이를 "표 불일치" 신호로 분류합니다. `plugins/oh-my-teams/scripts/failures.mjs`의 `classifyFailure` 함수가 처리할 신호는 다음과 같이 정의합니다:
  - **입력 필드(Signal)**: `kind: "matrix-mismatch"`, `predictedPath: "<예측된 path>"`, `actualReason: "<Orca가 반환한 실제 거부/실패 코드>"`
  - **분류 결과(Route)**: `category: "matrix-prediction-failure"`, `nextOwner: "pm"`, `action: "revise-matrix"`, `retryable: false`
  (기존 `failures.mjs`의 `not-started`, `workspace-context` 등 기존 경로와 겹치지 않는 새로운 분류 결과를 반환하게 합니다.)

### 6. 새 터미널 경로 가능 여부
- **결론**: Orca `tui-idle`에 기대지 않는 감독 터미널 경로(`supervised-screen-path`)는 현재 Orca CLI 제약상 불가능합니다.
- **근거**: 
  - `orca orchestration dispatch --inject`를 사용하면 Task/Dispatch 컨텍스트는 생성되지만, 터미널이 `unsupervised` 상태로 남습니다.
    > **명령:** `orca skills get orchestration --reference references/low-level-topology.md`
    > **원문:** "`dispatch --inject` creates authoritative Task/Dispatch context but deliberately keeps an operator-created process unsupervised: it creates no supervised worker resource row. `worker-show`, `worker-read`, and `worker-list` report the lane as `unsupervised`; `worker-stop` and `worker-abandon` do not close that process, and settled retain/release take no process action."
  - 기존 에이전트 터미널의 lifecycle을 획득하는 `worker-start --terminal <handle>` 명령은 저수준 문서에서 권장하나, 이번 작업 계약 금지 조항에 의해 사용할 수 없습니다.
    > **명령:** `orca skills get orchestration --reference references/low-level-topology.md`
    > **원문:** "Use `worker-start --terminal <handle>` when lifecycle ownership of an existing agent terminal is required. Never imply that low-level dispatch retroactively owns a process, never use it to route around the nested-depth limit, and never use it for an ownership handoff."
  - 관련 도움말 원문:
    > **명령:** `orca orchestration worker-start --help`
    > **원문:** "Not every worker has a terminal. Read output with worker-read --source auto or --source transcript, which always work; --source terminal is refused when there is none, and orca terminal verbs do not accept every worker handle. Nothing above needs you to know which kind you have — the orchestration verbs cover all of them."
    > **명령:** `orca orchestration dispatch --help`
    > **원문:** "--inject    (플래그, 설명 없음)"

### 7. 기존 조건을 대체할 호출 지점 목록
기존의 하드코딩된 조건들을 표(matrix)를 읽는 로직으로 대체합니다.
- `plugins/oh-my-teams/scripts/role-terminal.mjs`의 `launchLine`: 폭 조정(narrow) 로직을 제거합니다. Windows에서는 `mode con: cols=44`를 `agy` 실행과 함께 묶거나 분리하여 전송하더라도 전경 프로세스가 `powershell.exe`로 남아 Orca가 에이전트를 식별하지 못했습니다(`docs/plan/agy-terminal-probes.md` 1절 조합 A, B 참조). POSIX에서도 Orca 1.4.210의 판정 함수가 교체되어 폭 조정 없이 감독 터미널이 성립하는 것을 실측으로 확인했으므로([#104](https://github.com/inho-team/oh-my-teams/issues/104)), `stty cols 44`를 더 이상 붙이지 않고 모든 플랫폼에서 명령을 그대로 입력합니다.
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

| 필드 | 필수 여부 | 설명 |
|---|---|---|
| `via` | 필수 | `"headless-start"` 고정 값 |
| `executionId` | 필수 | 예약된 attempt의 `executionId` (worker ID와 동일해야 함) |
| `runId` | 필수 | 런타임이 부여한 ID |
| `taskId` | 필수 | `headless:<executionId>` 형식이어야 함 |
| `dispatchId` | 필수 | `headless:<executionId>` 형식이어야 함 |
| `worktreeId` | 필수 | 대상 워크트리 ID |
| `runnerPid` | 선택 | 헤드리스 러너 프로세스의 PID |
| `modelRequested` | 선택 | 실행 시 요청한 모델 이름 |

현재 `plugins/oh-my-teams/scripts/workflow.mjs`의 `validateExecutionInput`은 `schemaVersion`, `eventId`, `attemptId`와 `receipt` 내부의 5가지 ID(`executionId`, `runId`, `taskId`, `dispatchId`, `worktreeId`)가 모두 존재하는지(진실성(truthy))만 검사합니다.

**추가할 검사 로직 (`workflow-attach` 단계 등):**
`receipt.via === "headless-start"`인 경우를 조건부로 처리하여 다음을 추가합니다.
1. `taskId`와 `dispatchId`가 `headless:<executionId>` 형식으로 접두사 규칙을 따르는지 검사.
2. `executionId`가 예약된 worker ID와 정확히 대응하는지 검사.

**거부할 receipt 예시:**
- **접두사 불일치**: `taskId`가 `headless:junior-launch-probes`가 아니라 `task_123` 등 일반 형식을 띰.
- **`via` 누락**: `"via": "headless-start"` 필드가 없어 기본 Orca 영수증으로 간주되고, 형식 검증에서 실패함.
- **다른 worker ID**: 영수증의 `executionId`가 이 attempt를 위해 예약된 worker ID와 일치하지 않음.
- **필수 필드 누락**: `worktreeId` 등이 빠져 있음.

## Orca 수정안

### 1. 판정 코드 최소 수정안
**위치:** `out/main/index.js` (`q0i` 함수 내 Agy 에이전트 식별 로직)
- **수정 전:** 
  ```javascript
  e.lastIndexOf('antigravity cli') ... e.startsWith('gemini', o)
  ```
- **수정 후 제안:** 특정 모델명(`gemini`, `claude` 등) 하드코딩을 피하기 위해, 소문자로 변환된 버퍼(`e`)에서 배너 다음 줄의 구조적 특징(모델명 줄과 `>` 프롬프트 줄 간의 상대적 위치)을 판정 기준으로 삼거나, 판정할 모델 접두사를 설정 가능한 목록으로 추출합니다.
  ```javascript
  // 예시: 모델 줄이 빈 문자열이 아니고 다음 줄들에 프롬프트 '>'가 나오는지 확인하는 구조적 검사
  e.lastIndexOf('antigravity cli') ... /* 배너 아래 줄 확인 */ && s-o===1 && e.charCodeAt(o)===62
  ```

> **Orca 1.4.210 갱신**: 위 `q0i` 제안이 요청한 방향대로, 실제 Orca 1.4.210의 판정 함수(`Maa(e)`, 아래 「Orca 1.4.210 재실측」 절 참고)는 모델명을 하드코딩하지 않고 프롬프트 줄의 구조만으로 대기를 판정하도록 이미 교체되었다. 이 제안은 더 이상 필요하지 않다([#104](https://github.com/inho-team/oh-my-teams/issues/104)). 아래 `isShellProcess` 제안은 Windows 전경 프로세스 인식 문제를 다루며, 이 문제는 아직 확인되지 않았다.

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

Additionally, the `tui-idle` check in `q0i(e)` strictly asserts `e.startsWith('gemini', o)` after the `antigravity cli` banner on the lowercase buffer. This hardcoded rule prevents other valid Agy models (like `claude-sonnet-4-6` or `gpt-oss-120b-medium`) from ever being detected as idle, even if the UI renders correctly. 

We propose modifying the `tui-idle` check in `q0i(e)` to avoid hardcoding model family names. Instead, the check could rely on the structural layout of the screen buffer (such as the presence of any non-empty model string followed by the `>` prompt line) or use a configurable list of supported model prefixes. We also propose improving the Windows foreground process tree parsing to accurately identify `agy.exe` as the leaf active process even when wrapped in a PowerShell composite command.

Thanks!
```

---

## 기준 9 실측 결과

### 3차 실측 (2026-09-18, 수정 커밋 fe368a1·d7c7ab2·5fe61a1)

런타임: `agy-live-verification` @ `fe368a1`. 환경: Windows 11 Pro 10.0.26200, Orca 1.4.204, Antigravity CLI 1.2.5, PowerShell.

| 조합 | 워크트리(신뢰 기록) | 결과 | 표와의 대조 |
|---|---|---|---|
| r3-c6 Codex `gpt-5.6-luna` | 새 워크트리 `verify-r3-c6-codex-luna-new`(회수함) | `role-terminal`이 터미널 생성 전 거부: `[codex-trust-workspace]` | **표 입력 배선 결함.** `readLaunchEnvironment`는 `codexTrustRecordExists: true`를 돌려주지만, 표 4행은 Agy 신뢰 기록인 `trustRecordExists`를 보고, `predictLaunchPath` 호출에 codex 값이 전달되지 않는다. |
| r3-c2 Agy `gemini-3.8-flash-medium` (`--allow-unverified`) | `agy-probe-sandbox`(Agy 신뢰 있음) | `role-terminal` ready=true(`agentIdentity=antigravity`). `terminal-idle-check`가 `tui-idle` 미보고로 거부. `orca terminal wait --for tui-idle --timeout-ms 120000`도 timeout. | **표 불일치(사후 거부).** 표 8행은 `supervised-terminal`을 예측했으나 `tui-idle`에 도달하지 못한다. |
| r3-c1 Agy `gemini-3.1-pro-high` | 새 워크트리 `verify-r3-c1-agy-gemini-pro-new`(회수함, Agy 신뢰 없음) | `role-terminal`이 터미널 생성 전 거부: `[agent-trust-workspace]` | **표 3행과 일치.** |
| r3-c3 Agy `claude-sonnet-4-6` | `agy-probe-sandbox` | `role-terminal`이 터미널 생성 전 거부: `[claude-unsupported-by-orca]` | **표 7행과 일치.** |
| r3-c4 Agy `gpt-oss-120b-medium` (`--allow-unverified`) | `agy-probe-sandbox` | `headless` 경로로 거부. 이유 코드가 빈 배열이어서 메시지가 `"refused by matrix []"`로 나온다. | **경미한 결함.** 표 9행의 `reason`이 비어 있다. |
| r5-c6 Codex `gpt-5.6-luna` | 새 워크트리 `verify-r5-c6-codex-luna-new`(기준 `fef87c6`, 회수함) | `role-terminal --allow-unverified` → ready=true → `terminal-idle-check` idle=true → `worker-start` (task `task_e16a4a21060e`, dispatch `ctx_1a6f307bf0c3`, `binding.modelProof=unproven`) → `orchestration check --wait` → `worker_done`, outcome succeeded, 커밋 `b5e1cc3` → `worker-release` → 터미널 닫기 → 워크트리 회수 | **Codex 감독 터미널 경로가 `worker_done`까지 처음으로 검증되었다.** 표 12행의 근거 등급을 `unverified`에서 `verified`로 올릴 수 있다. |

---

## #46·#55 판정 (2026-09-18)

환경: Windows 11 Pro 10.0.26200, Orca 1.4.204, Antigravity CLI 1.2.5, PowerShell.

### #46 A — Windows에서 `mode con:` 뒤에도 `tui-idle`이 충족되지 않음

**판정: 재현 확인, Orca 쪽 원인으로 미해결.**

이번 실측에서 `agy-probe-sandbox`(Agy 신뢰 있음) 워크트리에 `gemini-3.8-flash-medium`을 단일 명령(`agy …`)으로 띄웠을 때 `agentIdentity: antigravity`로 식별은 되었으나, `orca terminal wait --for tui-idle --timeout-ms 120000`이 만료까지 만족되지 않았다. `mode con: cols=44`를 먼저 보낸 뒤 `agy`를 따로 보내면 `tui-idle: satisfied: true`가 되지만 아래 B의 이유로 에이전트 식별이 깨진다. 두 조건을 동시에 만족시키는 방법이 Orca 1.4.204에서 존재하지 않는다. 근본 원인은 「Orca 수정안」 절 1에서 분석한 `q0i(e)` 함수의 `gemini`-하드코딩 판정과 Windows 화면 폭 조건이다.

### #46 B — `mode con: …; agy …`로 띄운 터미널을 Orca가 agy로 인식하지 못함

**판정: 재현 확인, Orca 쪽 원인으로 미해결.**

빈 PowerShell 터미널에 `mode con: cols=44`를 먼저 보내고 `agy`를 따로 보내면 `tui-idle: satisfied: true`가 되지만, `agentIdentity`가 비고 터미널 제목이 `powershell.exe`로 남는다. 이는 「Orca 판정 규칙 1」 절에서 분석한 대로, PowerShell에서 복합 명령 혹은 순차 명령 실행 시 전경 프로세스가 `powershell.exe`로 유지되어 `isShellProcess` 판정을 통과하지 못하는 현상이다. OMT가 고칠 수 있는 원인이 아니며, 「Orca 수정안 1」의 `isShellProcess` 보강(Windows 전경 프로세스 트리에서 `agy.exe` 말단 프로세스 확인)이 적용되어야 해결된다.

### #46 C — `--inject-fallback`이 `inject_rejected`를 결과로 돌려주지 않음

**판정: PR에서 수정 완료(이슈 #46 코멘트 확인).**

C는 `--inject-fallback`이 `inject_rejected`·`no_agent_detected` 거부를 던지지 않고 `status: "blocked"` 결과로 돌려주도록 수정되었으며, 거부 원문·`injectRefusal`·`taskId`·`taskClosed`가 함께 기록된다. 이번 실측 범위 밖에서 이미 반영되었다.

### #46 D — 주입 거부 시 Task가 남고 예약 시도가 소진됨

**판정: PR에서 수정 완료(이슈 #46 코멘트 확인).**

D는 주입 경로의 `inject_rejected`·`no_agent_detected`가 `not-started` 신호로 번역되어 `workflow-release`에서 예약한 시도를 돌려받도록 수정되었다. 이번 실측 범위 밖에서 이미 반영되었다.

---

### #55 A — Windows의 비 Gemini Agy 역할이 실행 전에 거부되지 않음

**판정: 수정 완료.**

이번 실측에서 `agy-probe-sandbox`에서 `claude-sonnet-4-6` Agy 역할을 실행했을 때 `role-terminal`이 터미널 생성 전 `[claude-unsupported-by-orca]`로 거부했다. 표 7행과 일치한다. `gpt-oss-120b-medium` Agy 역할은 `headless` 경로로 거부되었다(표 9행). 두 경우 모두 터미널을 열기 전에 실행 경로가 결정되어 제안 1이 반영된 상태다.

### #55 B — 비 Gemini Agy 역할 대체 경로(headless)의 검증

**판정: 수정 완료, `orca-runtime.md` 및 표에 반영됨.**

`headless-start`가 provider `agy`에서 모델 무관하게 동작한다는 것이 이미 문서에 기록되어 있고, 표 8·9행이 `headless` 경로를 명시한다. 이번 실측에서도 해당 분기가 런타임에서 정상적으로 적용됨을 확인했다.

### #55 C — headless 실행을 workflow 시도에 연결하는 receipt 형식이 없음

**판정: 수정 완료, 「headless receipt 형식」 절에 반영됨.**

「headless receipt 형식」 절이 `via: "headless-start"`와 worker ID 대응 형식을 정의하고, `validateExecutionInput`에서 검증하는 로직을 명시한다. 런타임 코드(`workflow.mjs`)와 표가 이 형식을 반영한다.

---

### 결론

**#46은 열어 둔다.** A와 B의 근본 원인은 Orca의 `q0i(e)` 판정 하드코딩과 Windows 전경 프로세스 트리 파싱이며, OMT 범위에서 해결할 수 없다. Orca 수정(`q0i` 판정 완화 및 `isShellProcess` 보강)이 적용되기 전까지 Windows에서 Agy Gemini 역할의 감독 터미널 경로는 사용할 수 없다.

**#55는 닫을 수 있다.** 비 Gemini Agy 역할의 실행 전 거부(A), headless 경로 검증(B), headless receipt 형식(C)이 모두 표와 런타임에 반영되었다. 이번 실측(`r3-c3`, `r3-c4`)에서도 런타임 동작이 표와 일치함을 확인했다.

## Orca 1.4.210 재실측 (2026-09-25)

환경은 macOS(darwin 24.6.0), Orca 1.4.210, Antigravity CLI 1.2.11이다. `orca terminal create`로 터미널을 열고 `orca terminal wait --for tui-idle`과 `orca terminal show`로 확인했다.

| 조합 | 폭 조정 | `tui-idle` | `agentIdentity` |
|---|---|---|---|
| `agy --model claude-sonnet-4-6` | 없음 | `satisfied: true` | `antigravity` |
| `agy --model gemini-3.1-pro-high` | 없음 | `satisfied: true` | `antigravity` |
| `stty cols 44; agy --model gemini-3.1-pro-high` | `cols 44` | `satisfied: true` | `antigravity` |

차단 대상이던 claude 계열이 폭 조정 없이 통과했고, 폭을 조정하든 하지 않든 결과가 같았다. `agentIdentity`는 터미널을 연 직후에는 `null`이었다가 몇 초 뒤 `antigravity`로 확정되므로, 조회 시점이 이르면 식별 실패로 오인할 수 있다.

Orca 1.4.210 번들에서 프롬프트 줄을 판정하는 조건은 다음 한 줄이며, 함수 전체에 `gemini`라는 문자열이 없다.

```js
function Maa(e){return e===`>`||/^>\s+[a-z][a-z-]*\s+mode:\s/i.test(e)}
```

에이전트 식별도 화면 문자열이 아니라 `antigravity:{detectCmd:"agy", …}`처럼 실행 명령을 기준으로 삼는다.

## launch-matrix 규칙 순서 수정 (2026-09-26, `agy-win-untrusted-path`)

`launch-matrix.mjs`의 규칙 순서가 플랫폼을 보지 않는 규칙 3(`runner==="agy" && !trustRecordExists` →
`supervised-terminal`)을 win32 전용 규칙 8·9(`headless`)보다 먼저 평가했다. 새로 만든 워크트리는
정의상 항상 신뢰 기록이 없으므로(`readLaunchEnvironment`는 정확 일치로 신뢰를 판정한다), 이
구멍은 Windows에서 Agy 역할을 처음 여는 기본 경로에 걸렸고 「기준 9 실측 결과」 절의 `r3-c1`
행이 그 증상을 실측으로 확인한 바 있다(새 워크트리, Agy 신뢰 없음, `role-terminal`이 터미널
생성 전 `[agent-trust-workspace]`로 거부). 이는 「#46 판정」 절의 결론("Windows에서 Agy Gemini
역할의 감독 터미널 경로는 사용할 수 없다")과 모순되는 동작이었다.

규칙 2와 3 사이에 `runner === "agy" && platform === "win32" && trustRecordExists !== true` →
`headless` 규칙(2-1)을 추가해, 신뢰 상태를 확인하기 전에 win32 + agy를 먼저 걸러내도록
고쳤다. `!trustRecordExists`(엄격 false만 잡음) 대신 `trustRecordExists !== true`를 조건으로
써서, `trustRecordExists === "unknown"`인 경우도 명시적으로 headless로 보낸다(기존에는 문자열
`"unknown"`이 truthy라서 규칙 8·9의 `&& trustRecordExists` 체크를 우연히 통과했을 뿐, 의도가
코드에 드러나 있지 않았다).

**확인한 것**: `docs/plan/headless-runtime.md`의 2026-09-17 Windows 검증은 신뢰 기록이 없는
새 임시 Git 저장소에서 `headless-start`로 Agy(gemini) 역할을 실행해, 신뢰 질문에 막히지 않고
파일 작성과 커밋까지 `done`으로 끝냄을 실측으로 확인했다.

**확인하지 못한 것**: 그 headless 검증 워크트리의 `trustRecordExists` 값이 정확히 `false`였는지
`unknown`이었는지(당시 기록은 "임시 Git 저장소"라고만 적었다), headless 프로세스가 신뢰 질문을
아예 띄우지 않는지 아니면 `--dangerously-skip-permissions`로 넘기는지의 메커니즘, Windows에서
Agy 자체가 trustedWorkspaces에 기록하는 경로 표기. 규칙 8·9와 같은 이유로(근거였던 Orca
1.4.204 판정 규칙이 위 「Orca 1.4.210 재실측」 절에서 교체된 것이 확인되었고, 재검증할 Windows
머신이 없음) 새 규칙의 `evidence`는 `verified`로 올리지 않고 `unverified`로 남긴다.

### PM 지시로 판단한 추가 과제: `role-terminal.mjs`의 신뢰 기록 경로 비교(제거함)

작업 계약 files 목록에는 없으나 PM이 명시적으로 범위를 확장해 판단을 지시했다. `readLaunchEnvironment`가
`trusted.some((t) => String(t) === worktreePath)`로 신뢰 기록을 정확 일치 비교하던 부분을 검토했다.

처음에는 win32에서만 대소문자·구분자를 정규화하는 `trustedWorkspaceMatches` 헬퍼를 구현했으나,
독립 검토(`review-agy-win-1`, finding `trust-normalization-speculative-scope`)에서 최소 변경
규율을 근거로 되돌리도록 판정받아 제거했다(`role-terminal.mjs`를 기준 커밋과 같게 되돌리고,
관련 단위 테스트도 제거했다).

**되돌린 이유**: 위 규칙 2-1이 이미 win32 + agy의 실행 경로 결정을 `trustRecordExists` 값과
무관하게 만들었으므로, 이 정규화는 판정 결과를 하나도 바꾸지 않고 진단·로그 목적에만 기여했다.
Windows에서 Agy가 실제로 `trustedWorkspaces`에 기록하는 경로 표기(대소문자·구분자)도 확인하지
못한 채 만든 방어적 확장이었고, 같은 파일을 동시에 고치는 `fix/terminal-delivery-judgment`
브랜치와의 병합 충돌 위험만 늘렸다. 경로 표기 차이(대소문자·구분자) 문제는 규칙 2-1로 판정
결과에서 분리되었으므로 정규화를 두지 않았다. 앞으로 win32에서 신뢰 기록 값에 따라 갈리는
규칙이 생기면 그때 정규화를 다시 판단한다.

