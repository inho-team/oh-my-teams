# Agy 역할 터미널 실행 방법 탐색 결과

작성일: 2026-09-17  
상태: 완료  
환경: Windows 11 Pro 10.0.26200, Orca 1.4.204, Antigravity CLI 1.2.5, PowerShell  
워크트리: `C:/Users/kjsun/orca/workspaces/oh-my-teams/agy-probe-sandbox`  
워크트리 ID: `b17417a2-dbbc-4c0f-8605-dc79dfb58523::C:/Users/kjsun/orca/workspaces/oh-my-teams/agy-probe-sandbox`

---

## 1. 폭 조정 방식 비교 (#46 B 검증)

모든 실험에 `orca terminal create --worktree path:C:/Users/kjsun/orca/workspaces/oh-my-teams/agy-probe-sandbox --json`을 기반으로 사용했다.

### 1-1. Agy 신뢰 질문 (첫 실행)

실험용 워크트리(`agy-probe-sandbox`)는 Agy 신뢰 기록이 없는 새 폴더였다. 조합 1A 터미널을 최초로 열었을 때 신뢰 질문이 표시됐다.

**`terminal show` 응답 (신뢰 질문 발생 시점):**

```json
"agentWait": {
  "source": "prompt-text",
  "reason": "agent-trust-workspace",
  "since": 1789631664285
}
```

**`terminal read --screen` 발췌:**

```
Accessing workspace:
C:\Users\kjsun\orca\workspaces\oh-my-teams\a
Do you trust the contents of this project?
Antigravity CLI requires permission to read,
> Yes, I trust this folder
  No, exit
  ↑/↓ Navigate · enter Confirm
                   Gemini 3.8 Flash · medium
```

`> Yes, I trust this folder`가 이미 선택된 상태였다. `orca terminal send --text " " --enter`로 Enter 한 번을 전송해 신뢰를 수락했다. 이후 실험(1B·1C)에서는 같은 워크트리에서 신뢰 질문이 다시 나타나지 않았다.

**`tui-idle` 판정 (신뢰 질문 차단 상태):**
```json
{ "satisfied": false, "blockedReason": "agent-trust-workspace" }
```

신뢰 질문 화면에서는 `tui-idle`이 `satisfied: false`이며 `blockedReason: "agent-trust-workspace"`를 반환했다.

---

### 1-2. 조합 A: 기존 한 줄 (`mode con: cols=44; agy ...`)

**명령:**
```
orca terminal create --worktree path:... --title "probe-1A"
  --command "mode con: cols=44; agy --dangerously-skip-permissions --model gemini-3.8-flash-medium"
```

**터미널 핸들:** `term_8d5dd065-1711-4e8d-b0f8-b779b71c2927`

**`terminal show` 핵심 필드 (신뢰 답변 후 Agy 기동 완료 시점):**

| 필드 | 값 |
|---|---|
| `title` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| `agentIdentity` | (없음) |
| `agentWait` | `null` |
| `preview` 모델 줄 | `Gemini 3.8 Flash (Medium)` |

**`terminal read --screen` 발췌 (Agy 기동 완료 후):**

```
      ▄▀▀▄
     ▀▀▀▀▀▀
    ▀▀▀▀▀▀▀▀
   ▄▀▀    ▀▀▄
  ▄▀▀      ▀▀▄
  Antigravity CLI 1.2.5
  midowal0129@gmail.com (Google AI Ultra)
  Gemini 3.8 Flash (Medium)
  ~/orca/workspaces/oh-my-teams/agy-probe-sa
────────────────────────────────────────────
>
────────────────────────────────────────────
? for shortcuts    Gemini 3.8 Flash · medium
```

**`tui-idle` 결과 (Agy 기동 완료 후):**
```json
{ "satisfied": true, "status": "running" }
```

**판정:** `tui-idle satisfied: true`. 그러나 Orca는 이 터미널을 `antigravity`로 식별하지 않았다(`agentIdentity` 필드 없음). `title`이 PowerShell 실행 파일 경로 그대로 남아 있다.

**비고:** `mode con: cols=44`가 `;`로 연결된 탓에 Orca는 첫 번째 토큰인 `mode`를 에이전트 실행 파일로 인식하지 못하고, 결과적으로 `agentIdentity`를 설정하지 않은 것으로 추정된다(미확인, 소스 확인 필요).

---

### 1-3. 조합 B: 폭 조정 분리 (`mode con: cols=44` 먼저, 이후 `agy ...` 따로 전송)

**명령:**
```
orca terminal create --worktree path:... --title "probe-1B" --command "mode con: cols=44"
이후: orca terminal send --text "agy --dangerously-skip-permissions --model gemini-3.8-flash-medium" --enter
```

**터미널 핸들:** `term_16717aa6-209a-4874-a212-4de03bd11392`

**`terminal show` 핵심 필드:**

| 필드 | 값 |
|---|---|
| `title` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| `agentIdentity` | (없음) |
| `agentWait` | `null` |
| `preview` 모델 줄 | `Antigravity CLI 1.2.5` / `Gemini 3.8 Flash (Medium)` |

**`terminal read --screen` 발췌:**

```
PS C:\Users\kjsun\orca\workspaces\oh-my-teams\agy-probe-sandbox>
                     agy --dangerously-skip-permissions --model gemini-3.8-flash-medium
      ▄▀▀▄
     ▀▀▀▀▀▀
    ▀▀▀▀▀▀▀▀
   ▄▀▀    ▀▀▄
  ▄▀▀      ▀▀▄
  Antigravity CLI 1.2.5
  midowal0129@gmail.com (Google AI Ultra)
  Gemini 3.8 Flash (Medium)
  ~/orca/workspaces/oh-my-teams/agy-probe-sa
────────────────────────────────────────────
>
────────────────────────────────────────────
? for shortcuts    Gemini 3.8 Flash · medium
```

**`tui-idle` 결과:**
```json
{ "satisfied": true, "status": "running" }
```

**판정:** `tui-idle satisfied: true`. 그러나 이 경우에도 `agentIdentity` 필드는 없다. `--command` 인수에 `mode con: cols=44`가 전달됐으므로 Orca는 `mode`를 에이전트로 인식하고 `agy`가 이후 `terminal send`로 입력됐음을 추적하지 못한 것으로 추정된다(미확인).

**신뢰 질문:** 1A에서 수락이 기록됐으므로 1B에서는 나타나지 않았다.

---

### 1-4. 조합 C: 폭 조정 없이 `agy`만 실행

**명령:**
```
orca terminal create --worktree path:... --title "probe-1C"
  --command "agy --dangerously-skip-permissions --model gemini-3.8-flash-medium"
```

**터미널 핸들:** `term_866a59ed-0090-4bd3-9f3d-1d1b53a25fcb`

**`terminal show` 핵심 필드** (저장된 증거 `probe-1C-show.json` 발췌):

| 필드 | 값 |
|---|---|
| `title` | `probe-1C` (생성 시 지정한 제목 유지) |
| `agentIdentity` | **`antigravity`** |
| `agentWait` | `null` |

**`terminal read` 발췌** (저장된 증거 `probe-1C-read.json`, `source: "stream"`):

```
     ▄▀▀▄
    ▀▀▀▀▀▀
   ▀▀▀▀▀▀▀▀
  ▄▀▀    ▀▀▄
 ▄▀▀      ▀▀▄

 Welcome to the Antigravity CLI. You are currently not signed in.

 ⣷  Signing in...
      ▄▀▀▄        Antigravity CLI 1.2.5
▀▀▀▀▀▀       midowal0129@gmail.com      (Google AI Ultra)
```

**비고:** 1C 증거는 메모리 부족으로 PM이 터미널을 닫기 직전에 저장한 것으로, Agy가 완전히 기동하는 도중의 스냅샷이다. 이후 재실험(probe-2-gemini-r2)에서 같은 `--command "agy ..."` 방식으로 완전 기동 시 `agentIdentity: "antigravity"`가 설정됨을 확인했다.

**`tui-idle` 결과:** 1C 자체는 미확인(터미널 종료 전 `tui-idle wait` 미실행). 단, 같은 방식의 재실험(probe-2-gemini-r2)에서 `satisfied: true` 확인.

**판정:** `--command`에 `agy`를 직접 지정하면 Orca가 `agentIdentity: "antigravity"`를 설정하고 `title`도 생성 시 지정한 값을 그대로 유지한다. 이것이 조합 A·B와 가장 다른 점이다.

---

### 1-5. 소결

| 조합 | 명령 | `title` | `agentIdentity` | `tui-idle satisfied` | `blockedReason` |
|---|---|---|---|---|---|
| A | `mode con: cols=44; agy ...` (한 줄) | powershell.exe 경로 | 없음 | true | — |
| B | `mode con: cols=44` 먼저, `agy ...` 따로 전송 | powershell.exe 경로 | 없음 | true | — |
| C | `agy ...` 만 | `probe-1C` (지정값 유지) | `antigravity` | true (재실험 확인) | — |

**핵심 발견:** Orca는 `--command`의 첫 번째 실행 파일을 기준으로 에이전트를 식별한다. `mode con:`이 앞에 오면 `mode`가 식별 대상이 돼 `agentIdentity`가 설정되지 않는다. `agy`를 `--command`의 첫 토큰으로 지정해야 `agentIdentity: "antigravity"`가 설정된다.

---

## 2. 모델 계열별 `tui-idle` 결과

조합 C 방식(`--command "agy --dangerously-skip-permissions --model <모델>"`)으로 각 모델을 시험했다. 실험 워크트리는 동일하며 신뢰 질문은 1A에서 이미 수락됐으므로 이후 실험에서는 나타나지 않았다.

**실험 방법:** `terminal create` → `terminal wait --for tui-idle --timeout-ms 30000~45000` → 별도 순차 호출로 `terminal show` → `terminal read --screen` → `terminal close`.

### 2-1. gemini-3.8-flash-medium (재실험: probe-2-gemini-r2)

**터미널 핸들:** `term_ce65706d-223c-4522-a294-99d22ca32072`

**`terminal show` 핵심 필드 (tui-idle 충족 후):**

| 필드 | 값 |
|---|---|
| `title` | `probe-2-gemini-r2` (지정값 유지) |
| `agentIdentity` | **`antigravity`** |
| `agentWait` | `null` |

**`terminal read --screen` 발췌:**

```
      ▄▀▀▄        Antigravity CLI 1.2.5
     ▀▀▀▀▀▀       midowal0129@gmail.com (Google AI Ultra)
    ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (Medium)
   ▄▀▀    ▀▀▄     ~/orca/workspaces/oh-my-teams/agy-probe-sandbox
  ▄▀▀      ▀▀▄
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
? for shortcuts                                                                                Gemini 3.8 Flash · medium
```

**`tui-idle` 결과:** `{ "satisfied": true, "status": "running" }`

**판정:** `agentIdentity: "antigravity"` 설정, `tui-idle satisfied: true`. 모델 줄 `Gemini 3.8 Flash (Medium)` 확인.

---

### 2-2. claude-sonnet-4-6 (재실험: probe-2-claude-r2)

**터미널 핸들:** `term_9966d0f2-f51f-4b92-ba77-422827bdd791`

**`terminal show` 핵심 필드 (tui-idle 충족 후):**

| 필드 | 값 |
|---|---|
| `title` | `probe-2-claude-r2` (지정값 유지) |
| `agentIdentity` | 없음 |
| `agentWait` | `null` |

**`terminal read --screen` 발췌:**

```
      ▄▀▀▄        Antigravity CLI 1.2.5
     ▀▀▀▀▀▀       midowal0129@gmail.com (Google AI Ultra)
    ▀▀▀▀▀▀▀▀      Claude Sonnet 4.6 (Thinking)
   ▄▀▀    ▀▀▄     ~/orca/workspaces/oh-my-teams/agy-probe-sandbox
  ▄▀▀      ▀▀▄
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
? for shortcuts                                                                             Claude Sonnet 4.6 (Thinking)
```

**`tui-idle` 결과:** `{ "satisfied": true, "status": "running" }`

**판정:** `agentIdentity` 없음. 화면은 완전히 기동된 상태(프롬프트, 모델 줄 `Claude Sonnet 4.6 (Thinking)` 확인)임에도 Orca가 `antigravity`로 식별하지 않는다. `tui-idle`은 `satisfied: true`이며 이는 에이전트 식별이 아니라 일반 셸 idle 판정일 가능성이 있다.

**비고:** 이전 attempt의 관찰(claude-sonnet-4-6 `agentIdentity` 없음)과 일치한다. gemini와 gpt-oss는 순차 show에서 `agentIdentity: "antigravity"`가 확인됐으나, claude-sonnet-4-6은 동일한 방식에서도 설정되지 않는다. Orca 1.4.204에서 `antigravity` 식별 규칙이 모델 계열(모델 줄에 `gemini` 또는 `gpt-oss` 포함 여부)에 의존하는 것으로 추정된다(미확인, Orca 소스 확인 필요).

---

### 2-3. gpt-oss-120b-medium (재실험: probe-2-gpt2)

**터미널 핸들:** `term_b0619d15-4c92-4263-bc85-691a2cd6c0a6`

**`terminal show` 핵심 필드 (tui-idle 충족 후):**

| 필드 | 값 |
|---|---|
| `title` | `probe-2-gpt2` (지정값 유지) |
| `agentIdentity` | **`antigravity`** |
| `agentWait` | `null` |

**`terminal read --screen` 발췌:**

```
      ▄▀▀▄        Antigravity CLI 1.2.5
     ▀▀▀▀▀▀       midowal0129@gmail.com (Google AI Ultra)
    ▀▀▀▀▀▀▀▀      GPT-OSS 120B (Medium)
   ▄▀▀    ▀▀▄     ~/orca/workspaces/oh-my-teams/agy-probe-sandbox
  ▄▀▀      ▀▀▄
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
? for shortcuts                                                                                    GPT-OSS 120B (Medium)
```

**`tui-idle` 결과:** `{ "satisfied": true, "status": "running" }`

**판정:** `agentIdentity: "antigravity"` 설정, `tui-idle satisfied: true`. 모델 줄 `GPT-OSS 120B (Medium)` 확인.

**비고:** 이전 attempt의 증거 파일(`probe-2-gpt-show.json`)에서는 agentIdentity가 없었으나, 이는 Agy 기동 도중(로그인 배너 단계)에 show를 실행했기 때문이다. 완전 기동 후 순차 show에서는 `antigravity`로 식별됐다.

---

### 2-4. 모델 계열별 소결

| 모델 | 터미널 제목 | `agentIdentity` | `tui-idle satisfied` | 화면 모델 줄 |
|---|---|---|---|---|
| gemini-3.8-flash-medium | `probe-2-gemini-r2` | **`antigravity`** | true | `Gemini 3.8 Flash (Medium)` |
| claude-sonnet-4-6 | `probe-2-claude-r2` | 없음 | true | `Claude Sonnet 4.6 (Thinking)` |
| gpt-oss-120b-medium | `probe-2-gpt2` | **`antigravity`** | true | `GPT-OSS 120B (Medium)` |

**핵심 발견:**

1. `tui-idle`은 모든 모델에서 `satisfied: true`가 된다. 단, 이는 에이전트 식별이 아니라 화면 idle 상태 판정임을 시사한다.
2. `agentIdentity: "antigravity"`는 gemini 계열과 gpt-oss 계열에서는 설정되지만, claude-sonnet-4-6에서는 설정되지 않는다. Orca의 `antigravity` 식별 규칙이 모델 줄 또는 프로세스 패턴에서 `claude`를 `antigravity`와 다른 에이전트(`claude` 자체)로 처리할 가능성이 있다(미확인, Orca 소스 확인 필요).
3. `agentIdentity` 설정 여부와 무관하게 `tui-idle satisfied: true`가 된다. 따라서 `tui-idle`만으로는 Orca가 터미널을 `antigravity`로 인식했는지 판별할 수 없다.

---

## 3. `tui-idle` 비의존 감독 터미널 경로 가능 여부

### 참조 문서 근거

**`orca skills get orchestration --reference references/low-level-topology.md` 원문:**

```
`dispatch --inject` creates authoritative Task/Dispatch context but deliberately
keeps an operator-created process unsupervised: it creates no supervised worker
resource row. `worker-show`, `worker-read`, and `worker-list` report the lane as
`unsupervised`; `worker-stop` and `worker-abandon` do not close that process, and
settled retain/release take no process action.

Use `worker-start --terminal <handle>` when lifecycle ownership of an existing
agent terminal is required. Never imply that low-level dispatch retroactively
owns a process, never use it to route around the nested-depth limit, and never
use it for an ownership handoff.
```

**`orca orchestration worker-start --help` 원문 (관련 발췌):**

```
Not every worker has a terminal. Read output with worker-read --source auto or
--source transcript, which always work; --source terminal is refused when there
is none, and orca terminal verbs do not accept every worker handle. Nothing above
needs you to know which kind you have — the orchestration verbs cover all of them.
```

**`orca orchestration dispatch --help` 원문:**

```
--inject    (플래그, 설명 없음)
```

### 판정

`orca orchestration dispatch --inject`로 작업을 넘기면 Task/Dispatch 컨텍스트는 생성되지만, 대상 터미널이 **감독되지 않은(unsupervised)** 상태로 남는다. 구체적으로 다음과 같은 제약이 있다.

- `worker-show`, `worker-read`, `worker-list`는 해당 lane을 `unsupervised`로 보고한다.
- `worker-stop`과 `worker-abandon`은 해당 프로세스를 종료하지 않는다.
- `retain/release`도 프로세스 작동에 영향을 주지 않는다.

반면 `worker-start --terminal <handle>`을 사용하면 기존에 열린 에이전트 터미널의 lifecycle 소유권을 확보할 수 있다. 그러나 이 명령은 작업 계약 constraints에서 금지된 `orca orchestration worker-start`에 해당하므로 실행할 수 없다.

**결론:** `tui-idle`에 기대지 않고 OMT가 화면으로 대기를 판정한 뒤 Orca Task/Dispatch로 작업을 넘기면서 `worker-list` liveness, `worker_done` 완료 메시지, `worker-stop`·`worker-release` 회수가 감독 worker와 같은 수준으로 동작하는 명령 조합은 Orca CLI에 존재하지 않는다. `dispatch --inject`는 liveness와 lifecycle 회수를 지원하지 않으며, `worker-start --terminal`은 이번 작업 계약이 금지하고 있다.

---

DONE: 조합 1A·1B·1C 폭 조정 방식 비교, 조합 2 모델 3종(gemini·claude·gpt-oss) tui-idle 및 agentIdentity 비교, 조합 3 감독 터미널 경로 도움말·참조 문서 판정 완료
