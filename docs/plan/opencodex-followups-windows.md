# Windows 프록시 시작·소유권 증명·종료

## 개요

Windows에서 OpenCodex 프록시를 시작하고, 그 프록시가 이 turn의 것임을 증명하고, 종료를 확인하는 경로를 구현했습니다(F-9). 이전에는 `startOpenCodexProxy`가 win32를 곧바로 거부했습니다. 설계는 [opencodex-followups-design.md](opencodex-followups-design.md)의 B절과 D절 "windows-proxy" 범위를 따릅니다.

GitHub Actions의 `windows-latest`에서 실제 Windows 프로세스로 이 경로를 실행해 통과를 확인했습니다. 실행한 대상은 Node로 만든 가짜 `ocx`이며, 실제 OpenCodex와 bun은 실행하지 않았습니다. 따라서 이 문서의 "확인"은 소유권 판정 알고리즘과 Windows 프로세스 조회·종료 명령이 CI 러너에서 동작한다는 뜻이고, 실제 프록시가 같은 형태의 프로세스 트리를 만든다는 뜻이 아닙니다.

## 구현 내용

### 시작 경로

Windows는 `process.execPath`로 `<runtime>/node_modules/@bitkyc08/opencodex/bin/ocx.mjs`를 직접 실행합니다. `.cmd` shim은 shell 없이 spawn할 수 없고 `cmd.exe` 계층이 트리에 끼어들기 때문에 쓰지 않습니다. POSIX는 이전과 같이 `.bin/ocx`를 실행합니다. 두 경로의 차이는 `openCodexLaunch(runtimePrefix)`가 한 곳에서 결정하며, `dependencies.mjs`의 `doctor`, `installRuntime`, `healthCheck`도 같은 함수를 씁니다.

프록시 자식의 환경은 `HOME`에 더해 Windows에서 `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`도 계정 홈 아래의 `.omt-proxy-home`으로 바꿉니다.

### 소유권 증명

Windows에는 프로세스 그룹이 없으므로 소유 트리를 `(pid, CreationDate)` 스냅샷과 부모 PID 체인으로 정의합니다.

- spawn 직전에 `notBefore`(spawn 2초 전의 FILETIME)를 기록합니다. 이 시각보다 먼저 만들어진 프로세스는 트리에 속하지 않습니다.
- `Get-CimInstance Win32_Process`로 `{pid, ppid, created}` 표를 읽고, 런처에서 시작해 `ppid`를 따라 후손을 찾습니다. Windows는 부모가 죽어도 자식의 `ppid`를 갱신하지 않으므로 죽은 런처의 후손도 찾을 수 있습니다.
- pid가 재사용된 경우는 `created`가 다르므로 원래 프로세스로 취급하지 않습니다. 런처 pid가 살아 있는데 `created`가 기록과 다르면 그 pid의 자식은 이 트리의 것이 아닙니다.
- 프록시를 소유했다고 인정하려면 `Get-NetTCPConnection -State Listen`의 리스너가 정확히 하나여야 하고, 그 pid가 헬스 응답 본문의 `pid`와 같아야 하며, 그 pid가 트리 구성원이어야 합니다. 하나라도 어긋나거나 조회에 실패하면 거부합니다(fail-closed).
- 헬스 본문의 `pid` 대조는 Windows 분기에서만 합니다. POSIX 동작은 바뀌지 않았습니다.

트리 계산과 리스너 판정은 표를 입력으로 받는 순수 함수(`windowsOwnedProcesses`, `windowsOwnedListener`)로 분리해서 모든 OS에서 단위 테스트합니다.

### 종료 증명

종료는 `taskkill /PID <pid> /T /F`로 하고, 종료 코드는 증거로 쓰지 않습니다. 프로세스 표를 다시 읽어 소유 트리에 남은 구성원이 없음을 확인해야 종료로 인정하며, 표를 읽지 못하면 `opencodex-proxy-exit-unverifiable`로 실패하고 lease를 유지합니다.

증명이 통과해도 결과는 `{termination: "exited-snapshot", descendantsExited: false}`입니다. POSIX의 `{termination: "exited", descendantsExited: true}`와 구분하는 이유는 스냅샷 이후에 생겨 트리를 벗어난 프로세스를 이 방식으로는 볼 수 없기 때문입니다. `runnerTurnProven`의 요건은 바꾸지 않았고(PM 결정), 그 결과 Windows runner turn은 완료해도 unverified로 남습니다. 이 성질은 `tests/headless.test.mjs`의 "a proxy that proves only an exited snapshot leaves the turn unverified" 테스트가 모든 OS에서 확인합니다.

### 상태 확인 종료

`healthCheck`는 Windows에서 `taskkill /T /F`로 자식 트리 전체를 끝냅니다. POSIX는 이전처럼 `child.kill("SIGTERM")`이며 바뀌지 않았습니다.

## CI 검증 결과

- 저장소: `inho-team/oh-my-teams`, 브랜치 `dev-inho/ocf-win`, draft PR [#80](https://github.com/inho-team/oh-my-teams/pull/80)(`[CI 전용]`, 병합하지 않고 닫았습니다).
- 코드 변경을 검증한 실행: <https://github.com/inho-team/oh-my-teams/actions/runs/35639597540> (커밋 `71a49d6`).
- 첫 실행(커밋 `efc77db`)은 Windows에서 1건이 실패했고 그 원인과 수정은 아래 "CI로 새로 알게 된 사실"에 적었습니다.

| OS | 전체 | 통과 | 실패 | 건너뜀 |
|---|---|---|---|---|
| windows-latest | 575 | 564 | 0 | 11 |
| ubuntu-latest | 575 | 572 | 0 | 3 |
| macos-latest | 575 | 572 | 0 | 3 |

로컬(macOS)의 `npm run format`, `sync`, `lint`, `test`도 통과했습니다(575개 중 572개 통과, 3개 건너뜀).

## Windows에서 새로 실행된 테스트

이전에는 모두 `posixOnly`로 건너뛰던 항목입니다. 테스트 이름은 소스와 같습니다.

`tests/opencodex.test.mjs`, 프록시 시작과 종료:

- an owned proxy is accepted only as the sole listener of its own process tree
- a listener that is a child of the launcher is owned and ended with it (새로 추가)
- a healthy responder outside the launcher's process tree is refused (Windows 전용, 새로 추가)
- a health body naming another pid than the listener is refused (Windows 전용, 새로 추가)
- a health body that does not name the port is refused
- a descendant left behind by an exited launcher is ended, not ignored
- stopping ends every member of the owned tree, including one that ignores termination
- a tree whose exit cannot be inspected is unverifiable and keeps its lease
- the proxy child runs with a private HOME, not the user's (Windows에서는 `USERPROFILE`도 확인)

`tests/opencodex.test.mjs`, lease와 reclaim:

- a lease records its owner and, after spawn, the proxy group
- a live owner keeps the home and is told apart from a dead one
- a dead owner's lease is taken over and its orphaned proxy group is ended
- a reused owner pid does not count as a live owner
- a reused proxy group id is not ended
- a lease whose state cannot be proven clean is kept and reported as unverifiable
- a turn killed with SIGKILL leaves a lease and proxy that the next turn cleans up (Windows의 기대 결과는 아래 참고)
- a live owner that appears during a reclaim is never displaced
- a reclaimer that finds the lease replaced while it waited leaves the new owner alone
- many acquirers racing for a dead owner's lease leave exactly one holder (Windows는 2회전)
- a reclaim mutex left by a dead reclaimer blocks only that lease and is reported as stuck
- a reclaim in progress by a live process is waited for, then reported as held

모든 OS에서 실행되는 새 테스트:

- `tests/opencodex.test.mjs`: a Windows proxy tree is the launcher and its descendants created after the spawn / a dead launcher's descendants stay owned because Windows keeps their parent pid / a reused launcher pid takes no children with it / a snapshot pair counts only when pid and creation time both match / a Windows listener is owned only when it is the sole listener, in the tree and named by health / the runtime launch names this Node for the package entry on Windows and the bin script elsewhere
- `tests/headless.test.mjs`: a proxy that proves only an exited snapshot leaves the turn unverified
- `tests/dependencies.test.mjs`: a passing health check ends the launcher it started, a health check on Windows ends the launcher's child, not only the launcher (뒤의 것은 Windows 전용)

이미 있던 `tests/headless.test.mjs`의 "a stop request is recorded as a cancel request and never as a completed turn"도 Windows에서 실행하도록 바꿨고 통과했습니다.

공유 가짜 `ocx`는 `tests/fake-ocx.mjs`에 있습니다. POSIX에서는 `.bin/ocx` 스크립트로, Windows에서는 `bin/ocx.mjs` 모듈로 같은 내용을 씁니다.

## 남긴 posixOnly와 사유

Windows에서 건너뛰는 11개 전부입니다. 사유는 테스트의 skip 메시지 또는 인접 주석에도 적혀 있습니다.

| 테스트 | 사유 |
|---|---|
| a healthy responder that another process group owns is refused | 다른 프로세스 그룹의 리더가 헬스에 응답하는 상황은 Windows에 그룹이 없어 만들 수 없습니다. Windows에서는 "트리 밖 pid가 리스너"인 위 테스트가 대신합니다. |
| a healthy runtime is reused when only unrelated catalog checks fail | 가짜 `npm`, `codex`, `git`, `node`를 `/bin/sh` 스크립트로 PATH에 두는 방식이며 Windows의 PATH 조회는 `.cmd`를 찾습니다. |
| a failing check the backend requires blocks turns but never replaces a healthy runtime | 위와 같습니다. |
| an unhealthy runtime is still reinstalled | 위와 같습니다. |
| the installer reports the plan when the runtime install fails after the plugins | 위와 같습니다. |
| a successful install leaves no health directory in the active tree or the owned base | 위와 같은 가짜 도구 모음을 씁니다. |
| a failed status check also leaves no health directory behind | 위와 같습니다. |
| the status check under a fake HOME never writes to the real HOME | 위와 같습니다. |
| prune never removes anything outside the ownership prefix through a link | symlink 생성에 Windows 권한이 필요하고, prune은 이 task 범위 밖이라 이식하지 않았습니다. |
| an OpenCodex turn with every stage proven is reported done with its request set | 완료로 인정하려면 provider의 프로세스 그룹이 비었음을 봐야 하는데 Windows에는 그룹이 없습니다. 의도한 결과이며 exited-snapshot 테스트가 Windows에서 unverified를 확인합니다. |
| a descendant that outlives the provider makes the turn unverifiable, not done | 같은 이유입니다. |

설계 B4 표의 이식 후보 가운데 2~5번(dependencies의 가짜 런타임)은 이번에 이식하지 않았습니다. Windows의 `doctor`와 `installRuntime` 전체 경로를 실행하는 일은 미검증 항목인 "Windows runtime-install 전체"에 속하고, `.cmd` shim 실행 문제(U7)까지 함께 풀어야 하기 때문입니다. 한편 설계가 POSIX 전용으로 유지하라고 한 11번(SIGTERM을 무시하는 구성원)과 18번(그룹 id 재사용)은 Windows에서도 실행되도록 바꿨습니다. 11번은 taskkill이 강제 종료이므로 "종료를 무시하는 자식도 끝난다"는 형태로 통과했고, 18번은 `CreationDate` 불일치로 종료하지 않는다는 동일한 검증이 됩니다.

## 설계 C절 미확인 항목 중 CI로 확인한 것과 못한 것

| 번호 | 판정 | 근거와 남은 부분 |
|---|---|---|
| U6 | 부분 확인 | CI 러너에서 `Get-CimInstance`로 자식의 `ppid`와 `CreationDate`를 조회할 수 있고, 부모가 먼저 죽어도 후손의 `ppid`가 그대로 남으며, `taskkill /T /F`가 트리를 끝낸다는 것을 가짜 `ocx`로 확인했습니다. 실제 OpenCodex 런처와 bun의 부모 자식 관계는 확인하지 못했습니다. |
| U7 | 부분 확인 | `process.execPath`로 `.mjs` 런처를 shell 없이 spawn하는 경로는 동작합니다. `.cmd` shim이 실제로 `EINVAL`을 내는지는 시험하지 않았고, 실제 `bin/ocx.mjs`가 shim과 같은 동작을 하는지도 확인하지 못했습니다. |
| U8 | 못함 | 실제 bun의 명령줄과 `bun.exe` 존재는 실제 설치본이 필요합니다. |
| U9 | 못함 | `taskkill /F` 뒤 실제 OpenCodex의 pid 파일과 포트 파일이 남는지는 실제 프록시가 필요합니다. |
| U11 | 못함 | `buildDesktop3pRegistry`는 이 task 범위 밖입니다. |
| U16 | 못함 | `/api/stop` 인증 조건은 실제 프록시가 필요합니다. |

## CI로 새로 알게 된 사실

- Windows에서 Node가 만든 자식은 libuv의 kill-on-close 작업 개체에 들어가므로, 부모 프로세스가 죽으면 non-detached 자식도 함께 끝납니다. 첫 실행에서 "a turn killed with SIGKILL leaves a lease and proxy that the next turn cleans up"가 이 때문에 실패했습니다(러너를 죽인 뒤에도 프록시가 살아 있다고 가정했기 때문입니다). Windows에서는 turn이 강제 종료되면 lease만 남고 프록시는 함께 끝나며, 테스트는 이 결과를 기대하도록 고쳤습니다. 프록시를 detached로 띄우면 이 성질이 사라지므로 Windows에서는 detached를 쓰지 않습니다.
- PowerShell 호출은 한 번에 1초 안팎이 걸려서 Windows의 프록시 시작·종료 테스트가 느립니다. "an owned proxy is accepted only as the sole listener of its own process tree"가 약 8.8초, lease 경합 테스트가 약 6초였고, Windows 작업 전체는 약 2분으로 다른 OS의 약 1분보다 깁니다. lease 경합 테스트는 회전 수를 Windows에서 4회에서 2회로 줄였습니다.

## 설계와 다르게 구현한 곳

- 종료 증명을 스냅샷만으로 하지 않고 프로세스 표에서 트리를 다시 계산합니다. 스냅샷 이후에 생긴 후손도 `ppid` 체인에 있으면 종료 대상에 더하므로 설계보다 엄격합니다. 이전 판정을 약하게 만드는 방향의 변경은 없습니다.
- 종료 결과의 `descendantsExited`를 `false`로 둡니다. `headless-runner.mjs`가 `proxyExited = stopped?.descendantsExited === true`로 읽으므로, 이 값이 `true`이면 소비처가 트리 전체 종료로 오해하기 때문입니다.
- `notBefore`(spawn 2초 전 시각)를 새로 도입했습니다. 스냅샷이 없는 시점(헬스 확인 전 실패, 죽은 소유자의 고아 정리)에도 pid 재사용과 옛 프로세스를 걸러내기 위해서입니다.
- 리스너 조회는 `Get-NetTCPConnection`을 씁니다.
- `healthCheck`, `openCodexLaunch`, `windowsProcessTable`, `windowsOwnedProcesses`, `windowsOwnedListener`, `killWindowsProcessTree`를 export 했습니다. 테스트가 직접 호출하기 위해서이며 코드 품질 감사의 공개 export 수가 이에 맞게 바뀌었습니다(`npm run sync`).

## 미검증 항목

- 실제 구독 로그인, 실제 모델 호출. 이 task는 로그인과 모델 호출을 하지 않았습니다.
- 데스크톱 Orca에서의 동작.
- Windows의 runtime-install 전체 경로(`npm ci`, `.cmd` shim, 설치 후 상태 확인). 이 task는 시작·소유권·종료 경로만 다룹니다.
- 실제 OpenCodex 프록시의 기동. CI는 가짜 `ocx`만 실행했으므로 실제 런처와 bun의 프로세스 트리에서 소유권 판정이 성립하는지는 확인하지 못했습니다(U6 잔여, U8, U9).
- 백신·방화벽이 `taskkill`이나 포트 조회에 미치는 영향, 그리고 PowerShell이 제한된 환경(예: 제약 언어 모드)에서의 동작. 조회가 실패하면 fail-closed로 거부하므로 안전한 쪽으로 실패하지만 실제 환경에서 얼마나 자주 그런지는 알 수 없습니다.
- Windows runner turn은 설계대로 unverified로 남으며 완료 증명을 받지 못합니다. 이를 바꾸려면 `runnerTurnProven`의 요건을 바꾸는 별도 결정이 필요합니다.
