# omt-audit 2026-09 보고서

- 작성일: 2026-09-18
- 상태: 초안 (audit-runtime-io·audit-state·audit-launch 묶음 완료, 다른 묶음 미완)
- 대상: plugins/oh-my-teams/scripts (B1·B5·B3a·B3b·B4b 묶음)
- 관련 문서: .omt/audit/plan.md, .omt/audit/static-candidates.md, .omt/audit/checks/RESULTS.md

## 작업 초안

### audit-runtime-io

> 조사 대상: B1(dashboard.mjs, dashboard.html, headless.mjs, headless-runner.mjs, providers/*.mjs 7개) + B5(usage.mjs, usage-ledger.mjs, usage-report.mjs, usage-sources.mjs, providers.mjs)
> 조사 기준 커밋: 4d1d7d6

#### 1. 파일별 조사 상태

| 파일 | 묶음 | 줄 수 | 조사 상태 |
|---|---|---:|---|
| plugins/oh-my-teams/scripts/dashboard.mjs | B1 | 185 | 조사함 |
| plugins/oh-my-teams/scripts/dashboard.html | B1 | 295 | 조사함 |
| plugins/oh-my-teams/scripts/headless.mjs | B1 | 876 | 조사함 |
| plugins/oh-my-teams/scripts/headless-runner.mjs | B1 | 98 | 조사함 |
| plugins/oh-my-teams/scripts/providers/agy.mjs | B1 | 74 | 조사함 |
| plugins/oh-my-teams/scripts/providers/claude.mjs | B1 | 51 | 조사함 |
| plugins/oh-my-teams/scripts/providers/codex.mjs | B1 | 54 | 조사함 |
| plugins/oh-my-teams/scripts/providers/http.mjs | B1 | 91 | 조사함 |
| plugins/oh-my-teams/scripts/providers/index.mjs | B1 | 78 | 조사함 |
| plugins/oh-my-teams/scripts/providers/ollama.mjs | B1 | 230 | 조사함 |
| plugins/oh-my-teams/scripts/providers/shared.mjs | B1 | 201 | 조사함 |
| plugins/oh-my-teams/scripts/usage.mjs | B5 | 206 | 조사함 |
| plugins/oh-my-teams/scripts/usage-ledger.mjs | B5 | 171 | 조사함 |
| plugins/oh-my-teams/scripts/usage-report.mjs | B5 | 797 | 조사함 |
| plugins/oh-my-teams/scripts/usage-sources.mjs | B5 | 794 | 조사함 |
| plugins/oh-my-teams/scripts/providers.mjs | B5 | 217 | 조사함 |

---

#### 2. 발견 후보

---

##### F-01

- **id**: F-01
- **분류**: memory
- **심각도 가안**: high
- **파일:줄**: `headless.mjs:213-238`
- **증상**: `codexRolloutModel`이 `~/.codex/sessions` 트리를 매 호출마다 재귀적으로 전체 탐색하며 Codex 세션 rollout 파일을 찾는다. 호출 경로: `headlessStatus`(668) ← `waitHeadless` 1초 폴링(801-807), 대시보드 목록 4초 폴링(`dashboard.html:182`), 상세 2.5초 폴링(`dashboard.html:281`). 세션 파일이 쌓일수록 폴링 1회의 비용이 선형 증가한다.
- **근거**: 코드 인용 — `headless.mjs:218-236`:
  ```js
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) {
        // readFileSync 전체 읽기
        for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) { ... }
      }
    }
  }
  ```
  측정 결과 (임시 가짜 트리, HEAD=TARGET_THREAD인 파일 1개):

  | 파일 수 | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|
  | 100 | 5.4 | 49.7 | 49.7 | 0.1 |
  | 1,000 | 3.9 | 51.0 | 50.8 | −0.2 |
  | 5,000 | 27.1 | 50.8 | 53.8 | 2.9 |

  스크립트 요지: 빈 서브 디렉터리 3개에 `n`개 파일을 균등 분배, 마지막 파일만 대상 threadId. 호출 1회 시간과 RSS를 측정. 5,000개에서 27ms. 실제 Codex 장기 사용자(수천 세션)에서는 이 비용이 폴링마다 누적된다.
- **제안 수정**: threadId를 캐시 키로 세션 결과를 프로세스 수명 동안 메모이즈하거나, Codex rollout 파일에 예측 가능한 경로 규칙이 있다면 직접 경로로 접근하도록 변경.
- **예상 작업 크기**: S (캐시 Map 추가 + 테스트 보완)
- **회귀 방지 검사**: `headless.test.mjs`의 Codex 경로 테스트; 캐시 무효화 시나리오 추가 필요

---

##### F-02

- **id**: F-02
- **분류**: memory
- **심각도 가안**: high
- **파일:줄**: `headless.mjs:613-616, 688-691, 767-784`
- **증상**: `readTurn`, `headlessStatus`, `headlessDetail` 모두 `stream.jsonl` 파일 전체를 `readFileSync`로 읽은 뒤 `split(/\r?\n/)`으로 모든 줄 배열을 만들고 `JSON.parse`한다. Codex 경우 session이 없으면 `headlessStatus`(694-704)는 이전 턴 스트림도 전부 읽는다. `headlessDetail`(780-785)은 모든 턴의 stream·stderr·prompt를 읽은 뒤 잘라낸다.
- **근거**: 코드 인용 — `headless.mjs:613-617`:
  ```js
  const stream = readHeadlessStream(
    worker.provider,
    fs.existsSync(file("stream.jsonl"))
      ? fs.readFileSync(file("stream.jsonl"), "utf8")
      : "",
    options,
  );
  ```
  측정 결과 (stream.jsonl 1회 readFileSync+split+parse, 단순 assistant JSON 이벤트 줄 ~250B):

  | 크기(MB) | 줄 수 | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 1.0 | 4,178 | 13.3 | 52.0 | 55.4 | 3.4 |
  | 10.0 | 41,776 | 63.6 | 74.1 | 112.8 | 38.7 |
  | 50.0 | 208,880 | 435.2 | 183.0 | 390.8 | 207.8 |

  스크립트 요지: ~250B 이벤트 줄을 목표 크기까지 쓴 파일을 `readFileSync`→ `split` → `JSON.parse`로 처리. 10MB에서 RSS 39MB 증가, 50MB에서 208MB 증가. 대시보드 2.5초 폴링이면 RSS 압박이 지속된다.
- **제안 수정**: `headlessStatus`는 마지막 몇 줄(역순 탐색 또는 tail)만 읽어 result/marker를 추출하도록 파싱 방식 변경. 전체 transcript가 필요한 `headlessDetail`은 사용자 요청 시에만 호출하도록 유지하되, 폴링 경로(`listHeadless`, `headlessStatus`)에서 transcript 전체 파싱을 분리.
- **예상 작업 크기**: M (파싱 경로 분리 + 회귀 테스트)
- **회귀 방지 검사**: `headless.test.mjs`의 status/detail 경로; 큰 스트림 fixture 추가 필요

---

##### F-03

- **id**: F-03
- **분류**: memory
- **심각도 가안**: high
- **파일:줄**: `usage-sources.mjs:186-206`
- **증상**: `eachJsonLine`이 `readFileSync`로 파일 전체를 읽고 `split(/\r?\n/)`으로 모든 줄 배열을 만든다. 모듈 주석은 "한 줄 이상 메시지를 붙잡지 않는다"고 설명하지만(`usage-sources.mjs:183-185`), 구현은 전체 파일을 메모리에 올린다. Claude 대화 기록(JSONL) 전체가 대상이다.
- **근거**: 코드 인용 — `usage-sources.mjs:186-206`:
  ```js
  function eachJsonLine(file, visit) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");  // 전체 읽기
    } catch { return; }
    let index = 0;
    for (const line of text.split(/\r?\n/)) {  // 전체 배열
      ...
      if (visit(entry, index) === false) return;
      ...
    }
  }
  ```
  주석(183-185): "Entries are visited one at a time and dropped, so a long transcript's message text is never held beyond the line being read."
  실제로는 `text` 변수에 파일 전체가 남아 있다. `split` 결과도 전체 줄 배열이다.

  측정 결과 (10/50MB JSONL, ~200B/줄):

  | 크기(MB) | 줄 수 | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 10.0 | 54,614 | 75.3 | 74.8 | 99.7 | 24.9 |
  | 50.0 | 273,067 | 430.9 | 149.2 | 233.6 | 84.4 |

  스크립트 요지: ~200B 줄을 목표 크기까지 쓴 파일에서 eachJsonLine 시뮬레이션. 50MB에서 RSS 84MB 증가.
  (100MB 측정은 메모리 부족 위험으로 50MB로 제한)
- **제안 수정**: `readline`의 줄별 읽기 스트림(`createReadStream + createInterface`)으로 교체하여 전체 파일을 메모리에 올리지 않도록 변경. 주석("한 줄 이상 메시지를 붙잡지 않는다")도 구현에 맞게 수정하거나, 구현을 주석에 맞게 변경.
- **예상 작업 크기**: S-M (스트림 읽기 전환 + 비동기 콜백 체인 조정 필요 여부 확인)
- **회귀 방지 검사**: `usage-sources.test.mjs`; 큰 파일 fixture 혹은 청크 읽기 검증 추가 필요

---

##### F-04

- **id**: F-04
- **분류**: memory
- **심각도 가안**: medium
- **파일:줄**: `usage-ledger.mjs:138-169`
- **증상**: `recordLaunch`는 한 줄을 append하기 전에 ledger 전체를 `readLaunches`(47-61)로 읽고 파싱한다(`resolveLaunchKickoff` 계산용). ledger에는 회전이나 상한이 없으므로 장기 운영 시 매 launch마다 비용이 선형 증가한다.
- **근거**: 코드 인용 — `usage-ledger.mjs:158-165`:
  ```js
  kickoffPmWorktreeId: resolveLaunchKickoff(
    kickoffs,
    readLaunches(orgFile),  // ledger 전체 재읽기
    { stateDir: ..., callerCwd },
  ),
  ```
  측정 결과 (readLaunches 1회 기준, ~200B/줄):

  | 줄 수 | ledger 크기(MB) | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 1,000 | 0.2 | 5.8 | 50.4 | 51.0 | 0.7 |
  | 10,000 | 2.1 | 15.2 | 56.5 | 60.0 | 3.6 |
  | 100,000 | 20.6 | 151.4 | 101.5 | 152.5 | 51.0 |

  스크립트 요지: ledger 파일에 n줄을 쓰고 readLaunches 1회 시간·RSS를 측정. 100k줄(약 21MB)에서 151ms 및 51MB 증가.
  단, 실제 사용에서 100k 줄은 극단적 시나리오이며, 10k 이하에서는 15ms 이하로 허용 범위.
- **제안 수정**: `resolveLaunchKickoff`를 위해 ledger 전체를 읽지 않고, `findLast` 대신 최근 N개(예: 1000줄)만 역방향 읽기. 또는 kickoff-ID 기준 인덱스 파일을 별도 유지.
- **예상 작업 크기**: S (역방향 탐색 제한 추가)
- **회귀 방지 검사**: `usage-ledger.mjs` 관련 테스트; `resolveLaunchKickoff` 단위 테스트 추가 필요

---

##### F-05

- **id**: F-05
- **분류**: memory
- **심각도 가안**: medium
- **파일:줄**: `headless-runner.mjs:56-57`, `headless.mjs:532-538`
- **증상**: runner는 detached 프로세스로 spawn된다(`headless.mjs:532-538`). `stopChild`는 `child.kill()`을 호출하고 5초 뒤 `SIGKILL`을 예약(`headless-runner.mjs:56-57`)한다. Windows에서 `child.kill()`(내부적으로 `TerminateProcess`)는 직접 자식은 끝내지만 손자 프로세스(예: 자식이 생성한 쉘 또는 서브프로세스)는 끝내지 않을 수 있다. `stop.request` 파일 폴링은 `POLL_MS=500ms`마다 실행되며(`headless-runner.mjs:59-65`), 이는 정지 경로의 의도적 설계이지만 손자 프로세스 정리를 보장하지 않는다.
- **근거**: 코드 인용 — `headless-runner.mjs:53-58`:
  ```js
  const stopChild = (why) => {
    if (reason) return;
    reason = why;
    child.kill();
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  };
  ```
  `headless.mjs:532-538`:
  ```js
  const runner = spawn(process.execPath, [RUNNER, turnDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runner.unref();
  ```
  `headless-runtime.md:9-10`: "stopping by file rather than by signal works the same on Windows, where a signal from another process terminates the runner before it can stop its child." — 파일 기반 중단이 Windows에서 runner 자신의 생존을 보호하지만, child의 하위 프로세스 정리는 설명하지 않는다.
  측정: 미측정 (실제 프로세스 트리 확인은 Windows 실환경 필요)
- **제안 수정**: Windows에서 프로세스 트리 전체를 끝내려면 `taskkill /T /F /PID <pid>` 또는 `uiautomation` 기반 Job Object를 사용. `headless-runner.mjs`에 플랫폼별 killTree 유틸리티 추가 고려.
- **예상 작업 크기**: M (플랫폼별 kill 로직 추가 + Windows 실환경 검증)
- **회귀 방지 검사**: `headless.test.mjs`의 stop 경로; Windows 손자 프로세스 남은 여부 확인 검사 추가

---

##### F-06

- **id**: F-06
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `usage-sources.mjs:183-185`
- **증상**: 주석 "Entries are visited one at a time and dropped, so a long transcript's message text is never held beyond the line being read."이 구현 사실과 다르다. `readFileSync`로 전체 파일을 읽으면 `text` 변수에 파일 전체가 메모리에 남고, `split` 결과도 전체 줄 배열이다. 실제로는 visit 콜백에 넘기는 `entry` 하나만 즉시 처리될 뿐 파일 전체가 메모리에서 해제되지 않는다.
- **근거**: `usage-sources.mjs:186-191`:
  ```js
  function eachJsonLine(file, visit) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");  // 전체 파일 메모리 보유
    } catch { return; }
    ...
    for (const line of text.split(/\r?\n/)) {  // 전체 줄 배열 생성
  ```
  F-03 측정에서 50MB 파일에 84MB RSS 증가로 확인.
- **제안 수정**: 주석을 현재 구현("전체 파일을 읽고 줄 단위로 방문한다")에 맞게 수정하거나, 구현을 스트림 읽기로 변경 후 주석을 유지.
- **예상 작업 크기**: XS (주석 수정만) 또는 S-M (구현 변경 포함, F-03과 동일)
- **회귀 방지 검사**: F-03 동일

---

##### F-07

- **id**: F-07
- **분류**: architecture
- **심각도 가안**: medium
- **파일:줄**: `headless.mjs:532-538`, `headless-runner.mjs` 전체
- **증상**: headless 경로가 프로세스 소유·중단·회수를 직접 수행한다. `docs/plan/ai-native-agent-organization.md:53` 원칙 8("Orca의 감독 기능을 재구현하지 않는다. …프로세스·회수는 Orca를 사용한다")과 구조적으로 충돌하는 후보다.
- **근거**: `ai-native-agent-organization.md:53`: "Orca의 감독 기능을 재구현하지 않는다. 스킬 패키지는 업무 계약과 gate를 담당하고, 실행 소유권·프로세스·회수는 Orca를 사용한다."
  반론: `docs/plan/headless-runtime.md`는 "Orca를 대체하는 감독 런타임"을 명시적 설계 목표로 선언하며(`headless-runtime.md:7-16`), 이를 "Orca 없는 실행, 2단계"로 표제한다. 표 11-15줄에서 Orca 기능별 대응을 명시적으로 나열하고 있다. 따라서 headless-runtime.md가 원칙 8의 예외 선언에 해당하는지 여부가 판정 기준이다.
- **판정**: **보완 필요** — `headless-runtime.md`가 설계 예외를 선언하고 있으나, `ai-native-agent-organization.md`(정본 설계 원칙)에 이 예외가 명시되지 않았다. 두 문서가 충돌하는지, `headless-runtime.md`의 예외가 공식 승인된 것인지 Senior/PM의 판단이 필요하다.
- **제안 수정**: `ai-native-agent-organization.md:53`에 headless 런타임에 대한 예외 조항("headless-runtime.md가 명시적으로 선택할 때 허용")을 추가하거나, 두 문서 간 관계를 명확히 기술.
- **예상 작업 크기**: XS (문서 보완)
- **회귀 방지 검사**: `skill-instructions.test.mjs` 또는 문서 일관성 검사

---

#### 3. 사전 후보 확인·반박·보완

| 사전 후보 | 판정 | 근거 |
|---|---|---|
| **C-M1** | **확인** | `headless.mjs:213-238`에서 재귀 탐색 코드 확인. 측정: 100→1,000→5,000 파일에서 5.4ms→3.9ms→27.1ms. 5,000개에서 27ms로, 1초 폴링 주기(waitHeadless)와 4초 대시보드 폴링 기준 유의미한 비용. → F-01로 등록 |
| **C-M2** | **확인** | `headless.mjs:613-617, 688-691`에서 `readFileSync` + 전체 split+parse 확인. 측정: 1/10/50MB에서 13ms(3.4MB RSS)/64ms(38.7MB RSS)/435ms(207.8MB RSS). 50MB 스트림에서 RSS 200MB 초과. 2.5초 폴링 기준 심각. → F-02로 등록 |
| **C-M3** | **확인** | `usage-sources.mjs:186-206`에서 `readFileSync` 전체 읽기 확인. 측정: 10/50MB에서 75ms(25MB RSS)/431ms(84MB RSS). 주석과 구현 불일치도 확인(→ F-06). → F-03으로 등록 |
| **C-M4** | **확인** | `usage-ledger.mjs:158-165`에서 `readLaunches` 전체 재읽기 확인. 측정: 1k/10k/100k줄에서 5.8ms/15.2ms/151ms, RSS 증가 0.7/3.6/51MB. 10k 이하에서는 허용 범위이나 상한 없음. → F-04로 등록 |
| **C-M6** | **확인(일부)** | `headless-runner.mjs:56-57`에서 `child.kill()` 확인. Windows 손자 프로세스 정리 미보장은 코드 구조상 타당. 단, `headless-runtime.md:9-10`에서 파일 기반 중단의 이유는 "runner 자신의 생존" 보호이며 child 트리 정리 문제는 별도 사안. 측정: 미측정(실환경 필요). → F-05로 등록 |
| **C-M9** | **반박(문제 없음 확인)** | `dashboard.mjs:29, 56-80`에서 `BODY_LIMIT = 64 * 1024` 확인. 상한 초과 시 `reject + request.destroy()` 처리 확인. 추가 메모리 위험 없음. 사전 후보 판정("없음")과 일치. |
| **C-A2** | **보완 필요** | `headless.mjs:532-538`, `headless-runner.mjs` 전체에서 프로세스 직접 소유·중단 확인. `ai-native-agent-organization.md:53` 원칙 8과 구조 충돌 확인. 반론: `headless-runtime.md`가 명시적 예외를 선언하나 두 문서 간 관계가 불명확. Senior/PM 판단 필요. → F-07로 등록 |

---

#### 4. 발견 후보 요약

| id | 분류 | 심각도 | 핵심 |
|---|---|---|---|
| F-01 | memory | high | codexRolloutModel: sessions 트리 폴링마다 재귀 탐색 |
| F-02 | memory | high | headlessStatus/Detail: stream.jsonl 전체 읽기 반복 |
| F-03 | memory | high | eachJsonLine: readFileSync 전체 읽기 + split 전 파일 보유 |
| F-04 | memory | medium | recordLaunch: ledger 전체 재읽기(상한 없음) |
| F-05 | memory | medium | headless-runner: Windows 손자 프로세스 정리 미보장 |
| F-06 | checks | low | eachJsonLine 주석과 구현 불일치 |
| F-07 | architecture | medium | headless 프로세스 직접 관리 vs 원칙 8 충돌 여부 |

high 3개, medium 3개, low 1개. 합계 7개.

---

#### 5. 남은 의심

- **C-M2 추가 경로**: `headlessDetail`이 모든 턴의 stream을 읽는 경로(768-788)는 대시보드 상세 요청마다 발생한다. 턴이 많은 장기 worker에서 총 읽기량이 회차별로 누적되는지 확인 필요(미측정).
- **F-05 Windows 실측**: `child.kill()` 이후 손자 프로세스 생존 여부는 실제 Windows 환경에서 `tasklist`로 확인해야 한다(임시 디렉터리 방식으로 측정 불가).
- **usage-sources.mjs 대용량 파일 상한**: 100MB 이상 Claude 대화 기록(매우 긴 세션)에서 eachJsonLine의 메모리 상한이 Node.js 기본 힙(`--max-old-space-size`)과 충돌할 가능성(미측정, 50MB 제한으로 측정).

---

### audit-state

> 조사 대상: B2(workflow.mjs, workflow-store.mjs, gates.mjs, evidence.mjs, failures.mjs, lessons.mjs, incidents.mjs) + B4a(teams-org.mjs, core.mjs)
> 조사 기준 커밋: 4d1d7d6

#### 1. 파일별 조사 상태

| 파일 | 묶음 | 줄 수 | 조사 상태 |
|---|---|---:|---|
| plugins/oh-my-teams/scripts/workflow.mjs | B2 | 1,504 | 조사함 |
| plugins/oh-my-teams/scripts/workflow-store.mjs | B2 | 163 | 조사함 |
| plugins/oh-my-teams/scripts/gates.mjs | B2 | 453 | 조사함 |
| plugins/oh-my-teams/scripts/evidence.mjs | B2 | 440 | 조사함 |
| plugins/oh-my-teams/scripts/failures.mjs | B2 | 133 | 조사함 |
| plugins/oh-my-teams/scripts/lessons.mjs | B2 | 71 | 조사함 |
| plugins/oh-my-teams/scripts/incidents.mjs | B2 | 266 | 조사함 |
| plugins/oh-my-teams/scripts/teams-org.mjs | B4a | 1,329 | 조사함 |
| plugins/oh-my-teams/scripts/core.mjs | B4a | 945 | 조사함 |

---

#### 2. 발견 후보

---

##### STATE-01

- **id**: STATE-01
- **분류**: memory
- **심각도 가안**: medium
- **파일:줄**: `workflow-store.mjs:89`, `workflow-store.mjs:101`, `workflow-store.mjs:118`
- **증상**: `appendWorkflowEvent`가 중복 여부를 `state.eventIds.includes(event.id)`로 확인한다. `Array.includes`는 O(n) 선형 탐색이며, 이벤트마다 `state.eventIds.push(event.id)`로 상한 없이 늘어난다. `saveWorkflowState`는 저장할 때마다 `eventIds`를 포함한 state 전체를 JSON 직렬화하여 쓰므로 이벤트가 쌓일수록 비용이 선형 증가한다.
- **근거**: 코드 인용 — `workflow-store.mjs:89-101`:
  ```js
  if (state.eventIds.includes(event.id)) return false;
  // ...
  state.eventIds.push(event.id);
  ```
  `workflow-store.mjs:118-121`:
  ```js
  writeJSON(path.join(directory, "transaction.json"), {
    state,
    events: pendingEvents.get(state) ?? [],
  });
  ```
  測定結果 (eventIds 크기별 includes 1회 + JSON.stringify 1회, 임시 스크립트 %TEMP%\omt-audit-measure-state):

  | eventIds 수 | includes(ms) | 직렬화(ms) | 합계(ms) | payload(KB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 1,000 | 0 | 1 | 1 | 24 | 0 |
  | 10,000 | 0 | 3 | 3 | 235 | 1 |
  | 100,000 | 1 | 34 | 35 | 2,344 | 5 |

  스크립트 요지: 길이 n의 eventIds 배열을 생성하고 미존재 키에 대한 includes 1회 + JSON.stringify 1회 측정. 100k 이벤트에서 35ms, payload 2.3MB. 단일 workflow에서 100k 이벤트는 극단적 시나리오(예: 1만 태스크 × 10이벤트/태스크)이며, 10k 이하에서는 3ms 미만으로 허용 범위.
- **제안 수정**: `eventIds`를 `Set<string>`으로 교체하여 includes를 O(1)로 줄인다. JSON 직렬화 시 `Array.from(eventIds)`로 변환하거나, state 저장 직전에 배열로 바꾼다. 기존 `state.json`의 배열 형식을 로드할 때 Set으로 변환하는 마이그레이션 처리 필요.
- **예상 작업 크기**: S (Set 교체 + 직렬화 호환성 확인)
- **회귀 방지 검사**: `workflow.test.mjs`의 이벤트 중복 방지 테스트; 기존 배열 state.json을 로드·저장하는 왕복 테스트 추가 필요

---

##### STATE-02

- **id**: STATE-02
- **분류**: memory
- **심각도 가안**: medium
- **파일:줄**: `core.mjs:537-557`
- **증상**: `run()` 함수에서 overflow 발생 시 `child.kill()`을 호출하지만(`core.mjs:557`) fallback 타이머를 걸지 않는다. timeout 경로는 `fallbackTimer = setTimeout(() => finish(-1), 1000)`(`core.mjs:541`)으로 1초 후 강제 종료하지만, overflow 경로는 `child.kill()` 후 `close` 이벤트가 오길 기다린다. Windows에서 `child.kill()`이 자식 트리를 끝내지 않으면 `close`가 오지 않아 promise가 `timeoutMs`(기본 300초)까지 남는다. 또한 매 data chunk마다 `Buffer.byteLength(stdout) + Buffer.byteLength(stderr)` 재계산이 발생한다.
- **근거**: 코드 인용 — `core.mjs:537-557`:
  ```js
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill();
    // Some process trees never deliver `close`; return an uncertain result.
    fallbackTimer = setTimeout(() => finish(-1), 1000);  // timeout에만
  }, timeoutMs);

  stream.on("data", (data) => {
    stdout += data;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) {
      overflow = true;
      stdout = stdout.slice(0, maxBytes / 2);
      stderr = stderr.slice(0, maxBytes / 2);
      child.kill();  // fallback 타이머 없음
    }
  });
  ```
  주석 `core.mjs:540`: \"Some process trees never deliver \`close\`\" — timeout 경로에는 fallback이 있으나 overflow 경로에는 없다.

  측정 결과 (Buffer.byteLength 재계산 비용, 8MB 출력 시뮬레이션, 임시 스크립트):

  | chunk 크기 | 목표 | 재계산 횟수 | 경과(ms) | RSS 증가(MB) |
  |---|---|---|---|---|
  | 64KB | 8MB | 128 | 786 | 64 |
  | 16KB | 8MB | 512 | 2,753 | 68 |
  | 4KB | 8MB | 2,048 | 10,347 | 56 |

  overflow 후 close 미착신 시 대기: 미측정(Windows 실환경 필요).
- **제안 수정**: overflow 시에도 `fallbackTimer = setTimeout(() => finish(-1), 1000)`을 추가하여 timeout과 대칭적으로 처리. `Buffer.byteLength` 재계산은 현재 길이를 별도 `totalBytes` 변수로 추적하면 O(1)로 줄일 수 있다.
- **예상 작업 크기**: S (fallback 타이머 추가 + byteLength 카운터 변수 추가)
- **회귀 방지 검사**: `core.mjs` 관련 `run` 테스트; overflow 후 close 미착신 시나리오(Windows 프로세스 트리) 추가 필요

---

##### STATE-03

- **id**: STATE-03
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `gates.mjs:181`, `gates.mjs:255`
- **증상**: `loadReviews`는 `reviews/` 디렉터리 전체를 읽어 `taskId`로 필터링하고(`gates.mjs:181-183`), `matchingDecision`은 `decisions/` 디렉터리 전체를 읽어 탐색한다(`gates.mjs:255-263`). 두 함수는 `gateCheck`, `recordReviewLocked`, `acceptOutcomeLocked`에서 각각 호출되며, 리뷰·결정 파일이 쌓일수록 전체 읽기 비용이 선형 증가한다.
- **근거**: 코드 인용 — `gates.mjs:180-183`:
  ```js
  export function loadReviews(stateDir, task) {
    return readJsonDirectory(path.join(stateDir, "reviews")).filter(
      (review) => review.taskId === task.id,
    );
  }
  ```
  `gates.mjs:253-263`:
  ```js
  function matchingDecision(stateDir, task, report, reviewIds) {
    return readJsonDirectory(path.join(stateDir, "decisions")).find(
      (decision) => decision.taskId === task.id && ...
    );
  }
  ```
  `readJsonDirectory`는 `readdirSync + sort + map(readJSON)`으로 디렉터리 전체 읽기(`core.mjs:169-176`).
  측정: 미측정(리뷰·결정 파일 수는 workflow 규모에 의존하며, 수십~수백 개가 상한일 가능성이 높아 실제 영향은 낮을 것으로 추정).
- **제안 수정**: `reviews/<taskId>/` 하위 구조로 분리하거나, task-keyed 인덱스 파일을 두어 전체 스캔을 줄이는 방안 검토. 현재 규모에서 문제가 없다면 허용 가능.
- **예상 작업 크기**: S-M (디렉터리 구조 변경 시 마이그레이션 포함)
- **회귀 방지 검사**: `gates.test.mjs`의 리뷰 로드 테스트; 리뷰 파일 수 증가 시 로드 시간 측정 추가 필요

---

##### STATE-04

- **id**: STATE-04
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `teams-org.mjs:570-572`, `teams-org.mjs:1011-1013`
- **증상**: `predictLaunchPath` 호출 실패를 빈 `catch` 블록으로 무시한다. 예외를 로깅하지 않아 예측 실패 원인(launch-matrix 로직 오류, 환경 정보 누락 등)이 숨겨진다. `matrixPrediction`이 `undefined`로 남아도 후속 함수는 이를 허용하므로 기능상 문제는 없으나 진단성이 낮다.
- **근거**: 코드 인용 — `teams-org.mjs:570-572`:
  ```js
  } catch {
    // 예측 실패 시 matrixPrediction undefined (기존 동작 유지)
  }
  ```
  `teams-org.mjs:1011-1013`:
  ```js
  } catch {
    // 예측 실패 시 기존 동작 유지 (matrixPrediction undefined)
  }
  ```
  측정: 해당 없음(진단성 문제).
- **제안 수정**: `catch (error)` 로 받아 `process.stderr.write` 또는 구조화된 경고 출력 추가. 또는 결과 객체에 `matrixPredictionError: error.message`를 포함하여 호출자가 판단할 수 있게 한다.
- **예상 작업 크기**: XS (catch 블록에 경고 출력 1줄 추가 × 2개소)
- **회귀 방지 검사**: `predictLaunchPath` 실패 시 stderr 출력 확인 테스트

---

##### STATE-05

- **id**: STATE-05
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `workflow.mjs:44`
- **증상**: `validateWorkflowRequest`가 `export`로 공개되어 있으나, 모듈 내부 `createWorkflow`(`workflow.mjs:234`)에서만 호출되고 외부 파일에서 import하지 않는다. 의도하지 않은 공개 API가 유지보수 범위를 모호하게 만들 수 있다.
- **근거**: `grep "validateWorkflowRequest" scripts/*.mjs` 결과:
  ```
  workflow.mjs:44: export function validateWorkflowRequest(...)
  workflow.mjs:234: validateWorkflowRequest(request);
  ```
  `teams-org.mjs` import 목록(62-74줄)에 없음. 다른 스크립트 파일에도 없음.
  측정: 해당 없음.
- **제안 수정**: 외부 사용이 없다면 `export` 제거 검토. 테스트 또는 미래 API용으로 남겨둔 경우 JSDoc에 `@internal` 태그를 추가하여 의도 명시.
- **예상 작업 크기**: XS
- **회귀 방지 검사**: `workflow.test.mjs`에서 `validateWorkflowRequest` 직접 호출 여부 확인 후 제거 가능

---

#### 3. 사전 후보 확인·반박·보완

| 사전 후보 | 판정 | 근거 |
|---|---|---|
| **C-M5** | **확인(일부)** | `core.mjs:537-557`에서 overflow 후 fallback 타이머 없음 확인. 매 chunk마다 `Buffer.byteLength` 재계산 측정: 64KB chunk × 128회 = 786ms, 4KB chunk × 2,048회 = 10,347ms. overflow 후 close 미착신 시간: 미측정(Windows 실환경 필요). → STATE-02로 등록 |
| **C-M7** | **확인(낮은 우선순위)** | `workflow-store.mjs:89, 101`에서 `eventIds.includes` O(n) + state 전체 직렬화 확인. 측정: 100k 이벤트 35ms, payload 2.3MB. 10k 이하 3ms 미만(허용 범위). `pendingEvents`는 WeakMap(누수 없음, 사전 후보 일치). → STATE-01로 등록(medium 유지) |

---

#### 4. 발견 후보 요약

| id | 분류 | 심각도 | 핵심 |
|---|---|---|---|
| STATE-01 | memory | medium | eventIds: includes O(n) 탐색 + state 전체 직렬화(상한 없음) |
| STATE-02 | memory | medium | run() overflow 후 fallback 타이머 없음: close 미착신 시 timeoutMs까지 대기 |
| STATE-03 | checks | low | gates: reviews/decisions 디렉터리 전체 스캔(측정 미완) |
| STATE-04 | checks | low | teams-org: predictLaunchPath 예외 무음 삼킴 2개소 |
| STATE-05 | checks | low | workflow: validateWorkflowRequest 외부 미사용 export |

medium 2개, low 3개. 합계 5개.

---

#### 5. 남은 의심

- **STATE-01 Set 전환 직렬화 호환**: `eventIds`를 Set으로 바꾸면 `JSON.stringify`가 `{}`로 직렬화하므로 `writeJSON` 직전 `Array.from(state.eventIds)`로 변환하는 처리 필요. 기존 `state.json`에서 배열을 읽어 Set으로 변환하는 로드 경로 확인 필요.
- **STATE-02 overflow 후 Windows close**: Windows에서 `child.kill()` 이후 손자 프로세스가 `close`를 보내지 않는 사례(F-05와 유사)가 overflow 경로에도 적용되는지 실측 확인 필요(미측정).
- **STATE-03 측정 필요**: reviews/decisions 디렉터리가 장기 workflow·다수 재시도 시나리오에서 얼마나 쌓이는지 측정 후 low→medium 상향 여부 판단 가능.
- **incidents.mjs state 크기**: `loadState`는 `state.json` 하나에 모든 인시던트를 저장하며, `maxOpen` 설정으로 활성 수가 제한되므로 실질적 위험은 낮을 것으로 추정(미측정).

---

### audit-launch

> 조사 대상: B3a(orca-adapter.mjs, local-adapter.mjs, adapters.mjs, execution.mjs, worker.mjs) + B3b(role-launch.mjs, role-terminal.mjs, launch-matrix.mjs, host-defaults.mjs) + B4b(contracts.mjs, kickoff-registry.mjs, delivery.mjs, workspace.mjs, status.mjs, org-draft.mjs, presets.mjs, quota.mjs)
> 조사 기준 커밋: 4d1d7d6

#### 1. 파일별 조사 상태

| 파일 | 묶음 | 줄 수 | 조사 상태 |
|---|---|---:|---|
| plugins/oh-my-teams/scripts/orca-adapter.mjs | B3a | 870 | 조사함 |
| plugins/oh-my-teams/scripts/local-adapter.mjs | B3a | 265 | 조사함 |
| plugins/oh-my-teams/scripts/adapters.mjs | B3a | 107 | 조사함 |
| plugins/oh-my-teams/scripts/execution.mjs | B3a | 134 | 조사함 |
| plugins/oh-my-teams/scripts/worker.mjs | B3a | 713 | 조사함 |
| plugins/oh-my-teams/scripts/role-launch.mjs | B3b | 454 | 조사함 |
| plugins/oh-my-teams/scripts/role-terminal.mjs | B3b | 799 | 조사함 |
| plugins/oh-my-teams/scripts/launch-matrix.mjs | B3b | 415 | 조사함 |
| plugins/oh-my-teams/scripts/host-defaults.mjs | B3b | 152 | 조사함 |
| plugins/oh-my-teams/scripts/contracts.mjs | B4b | 310 | 조사함 |
| plugins/oh-my-teams/scripts/kickoff-registry.mjs | B4b | 424 | 조사함 |
| plugins/oh-my-teams/scripts/delivery.mjs | B4b | 195 | 조사함 |
| plugins/oh-my-teams/scripts/workspace.mjs | B4b | 184 | 조사함 |
| plugins/oh-my-teams/scripts/status.mjs | B4b | 277 | 조사함 |
| plugins/oh-my-teams/scripts/org-draft.mjs | B4b | 133 | 조사함 |
| plugins/oh-my-teams/scripts/presets.mjs | B4b | 152 | 조사함 |
| plugins/oh-my-teams/scripts/quota.mjs | B4b | 196 | 조사함 |

---

#### 2. 발견 후보

---

##### LAUNCH-01

- **id**: LAUNCH-01
- **분류**: memory
- **심각도 가안**: low
- **파일:줄**: `role-terminal.mjs:588-595` (`until` 함수), `role-terminal.mjs:539-545` (`readScreen` 함수)
- **증상**: `openRoleTerminal`의 `until()` 내부 루프(`role-terminal.mjs:591-594`)가 `pollMs`(기본 1500ms) 간격으로 `observe()`를 반복 호출하고, `observe()`는 매번 `readScreen()`을 통해 `orca terminal read --terminal ... --screen --json`을 외부 프로세스로 실행한다. `settleMs`(기본 8000ms) 동안 최대 7회, Enter 전송 후 `readyMs`(기본 90000ms) 동안 최대 61회, 합계 최대 70회의 외부 프로세스가 생성된다. 이는 사전 후보 C-M8이 "감시 스크립트의 낭비와 같은 유형"으로 지적한 패턴이다. 단, `settleMs`·`readyMs`로 상한이 제한되므로 무한 폴링은 아니다.
- **근거**: 코드 인용 — `role-terminal.mjs:588-596`:
  ```js
  const until = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    let seen = await observe(orca, handle, typed, execute);      // 즉시 1회
    while (!seen.started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs)); // 1500ms 대기
      seen = await observe(orca, handle, typed, execute);         // 폴링 1회
    }
    return seen;
  };
  ```
  `role-terminal.mjs:539-545`:
  ```js
  async function readScreen(orca, handle, execute) {
    const read = await runOrcaJson(
      orca,
      ["terminal", "read", "--terminal", handle, "--screen"],
      { execute },
    );
    return read.result?.terminal?.tail ?? [];
  }
  ```
  측정 결과 (코드 구조 분석, 워크트리 밖 임시 Node 스크립트):

  | 경로 | settleMs(ms) | readyMs(ms) | pollMs(ms) | 최대 readScreen 호출 |
  |---|---|---|---|---|
  | 즉시 시작(최선) | 8,000 | - | 1,500 | 7 |
  | Enter 전송 + 대기(최악) | 8,000 | 90,000 | 1,500 | 70 |

  실제 외부 프로세스 실행 비용(orca CLI spawn 오버헤드)은 미측정(실환경 Orca 필요).
- **제안 수정**: Orca가 `terminal wait --for tui-idle` 이벤트를 지원하므로, 폴링 대신 해당 명령 1회로 대기하고 타임아웃 시에만 screen read를 시도하는 방식으로 전환 검토. 또는 `pollMs`를 늘려 외부 프로세스 수를 줄이는 단기 완화 가능.
- **예상 작업 크기**: S (폴링 루프를 `terminal wait` 단일 호출로 교체)
- **회귀 방지 검사**: `role-terminal.test.mjs`의 launch 경로 테스트; Enter 전송 경로·trust 경로별 screen read 횟수 확인 추가

---

##### LAUNCH-02

- **id**: LAUNCH-02
- **분류**: architecture
- **심각도 가안**: low
- **파일:줄**: `role-terminal.mjs:24`, `role-terminal.mjs:342`, `role-terminal.mjs:396`, `role-terminal.mjs:416`, `role-terminal.mjs:520`, `role-terminal.mjs:540`, `role-terminal.mjs:571`, `role-terminal.mjs:601`, `role-terminal.mjs:619`, `role-terminal.mjs:746`
- **증상**: `role-terminal.mjs`가 `orca-adapter.mjs`의 `runOrcaJson`과 `selectOrcaExecutable`을 직접 import하여 10개소에서 사용한다. 사전 후보 C-A1은 이를 "어댑터를 거치지 않는 직접 호출"로 지적했다. 단, `adapters.mjs`의 `executionAdapter` port는 실행 런타임(orca vs local)을 추상화하는 레이어이고, `role-terminal.mjs`가 사용하는 `runOrcaJson`은 Orca 터미널 UI(terminal create/read/rename/close/wait/send) 전용 유틸리티로, 실행 어댑터 port의 적용 범위(worker 생성·확인·중단)와 다르다. `CODE_QUALITY.md:68`은 `orca-adapter.mjs`를 "실행 파일 선택, runtime discovery, JSON 호출, worktree 생성"의 공통 위치로 선언하고 있어, 직접 import 자체는 공통 헬퍼 위치 규칙(R8)에 부합한다.
- **근거**: `role-terminal.mjs:24`:
  ```js
  import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";
  ```
  `adapters.mjs:24-37`의 `EXECUTION_ADAPTERS`는 `translateCode`, `assertDiscovery`, `readWorkspaceClaim`, `confirmWorkspace` 4가지 실행 어댑터 port만 포함하며 `runOrcaJson`은 포함하지 않는다.
  `CODE_QUALITY.md:68`: "`orca-adapter.mjs`: 실행 파일 선택, runtime discovery, JSON 호출, worktree 생성"
  `static-candidates.md:26`: C-A1 — "어댑터 경유 규칙이 저장소에 명시되지 않았으므로 먼저 규칙 근거부터 확인해야 한다."
  측정: 해당 없음(아키텍처 판단 문제).
- **판정**: **규칙 근거 미확인** — `CODE_QUALITY.md:68`에서 직접 import의 근거는 확인되나, "어댑터를 거치지 않는 직접 호출 금지" 규칙이 `AGENTS.md`, `CODE_QUALITY.md` 등 정본 문서에 없어 규칙 위반으로 단정할 수 없다(`static-candidates.md`의 C-A1 판단과 동일). Senior/PM의 판정 필요.
- **제안 수정**: 판정을 위해 `AGENTS.md` 또는 `CODE_QUALITY.md`에 "Orca 터미널 UI 조작은 `runOrcaJson` 직접 사용 가능, 실행 어댑터 port(`adapters.mjs`)는 worker 생명주기(start/stop/confirm)에만 적용"을 명시하거나, 위반 여부 확인 후 조치 결정.
- **예상 작업 크기**: XS (문서 명시만 필요한 경우)
- **회귀 방지 검사**: 문서 일관성 검사; `skill-instructions.test.mjs`

---

##### LAUNCH-03

- **id**: LAUNCH-03
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `role-terminal.mjs:36`, `role-terminal.mjs:87-111`, `role-terminal.mjs:113-125`, `role-terminal.mjs:131-204`
- **증상**: `readLaunchEnvironment`가 사용자 설정 파일(`~/.gemini/antigravity-cli/settings.json`, `~/.claude/settings.json`, `CODEX_HOME/config.toml` 또는 `~/.codex/config.toml`)을 읽기만 하고 쓰지 않는다. `role-terminal.mjs:36` 주석은 "사용자 설정 파일은 읽기만 하고 쓰지 않습니다"로 명시하고 있어 설계 의도에 부합한다. 사전 후보의 "사용자 설정 파일을 쓰지 않는다" 규칙(plan.md R13~R17에서 근거 확인 진행 중) 확인 결과, 이 경로는 위반이 없다.
- **근거**: `role-terminal.mjs:36`:
  ```
  * 사용자 설정 파일은 읽기만 하고 쓰지 않습니다.
  ```
  `role-terminal.mjs:96-111` (Agy settings.json — readFileSync만):
  ```js
  const text = fs.readFileSync(agySettingsFile, "utf8");
  const settings = JSON.parse(text);
  ```
  `role-terminal.mjs:117-121` (claude settings.json — readFileSync만):
  ```js
  const text = fs.readFileSync(claudeSettingsFile, "utf8");
  const settings = JSON.parse(text);
  ```
  `role-terminal.mjs:159` (codex config.toml — readFileSync만):
  ```js
  const tomlText = fs.readFileSync(codexConfigFile, "utf8");
  ```
  fs.writeFile/writeFileSync/appendFile 호출 없음. 측정: 해당 없음.
- **판정**: **문제 없음(규칙 준수 확인)** — 세 설정 파일 모두 읽기 전용 접근이며 주석의 선언과 일치. 발견 후보에서 제외 가능하나, "사용자 설정 파일을 쓰지 않는다" 규칙이 정본 문서(AGENTS.md 등)에 없음을 `static-candidates.md`(C-R2)가 이미 지적하고 있으므로, 규칙 근거 추가 여부는 B7 묶음이 결론낼 사안임.
- **제안 수정**: 없음(현재 구현 적절). 다만 `ai-native-agent-organization.md:355`에 있다고 사전 후보가 언급한 근거 확인을 B7 묶음에서 완료해야 함.
- **예상 작업 크기**: XS (문서 확인만)
- **회귀 방지 검사**: `role-terminal.test.mjs`의 `readLaunchEnvironment` 경로; 설정 파일 쓰기 여부 확인 테스트

---

##### LAUNCH-04

- **id**: LAUNCH-04
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `launch-matrix.mjs:8-11`, `launch-matrix.mjs:194-414`
- **증상**: `MATRIX_RULES` 표는 위에서 아래로 순서대로 평가하며 첫 번째 매칭 행이 적용된다(`launch-matrix.mjs:8-11`). 표 주석과 설계 문서(`docs/plan/agy-terminal-path.md`) 출처가 명시되어 있고, `predictLaunchPath` 함수가 정본 역할을 수행한다(R6 규칙). 조사 결과, R6("실행 경로 판정은 `launch-matrix.mjs` 호환성 표가 정한다")는 `references/orca-runtime.md:98,171`을 근거로 하며, `launch-matrix.mjs`의 주석 및 `docs/plan/agy-terminal-path.md` 출처가 이를 뒷받침한다. 단, `MATRIX_RULES`는 현재 11개 규칙이 순서에 민감하게 작동하므로 규칙 추가·변경 시 의도치 않은 오버라이드 가능성이 있다.
- **근거**: `launch-matrix.mjs:8-11`:
  ```js
  * 규칙은 위에서 아래로 순서대로 평가하며, 처음 조건이 맞는 행이 적용됩니다.
  * 마지막 행은 나머지 모든 조합을 덮습니다.
  * 출처: `docs/plan/agy-terminal-path.md` 설계 절.
  ```
  `predictLaunchPath` 함수가 `MATRIX_RULES`를 `find`로 순서대로 평가하고 결과에 버전 근거 등급을 적용(`applyVersionEvidence`, `applyVerificationGate`).
  측정: 해당 없음(구조 분석 문제).
- **판정**: **현재 구현 적절, 주의 필요** — 정본 역할(R6)은 충족. 순서 의존성은 구조적 특성이며, 현재 테스트(`tests/launch-matrix.test.mjs`, 705줄)가 다양한 조합을 검증하고 있다. 규칙 추가 시 순서 오버라이드 위험은 문서·테스트로 관리되어야 함.
- **제안 수정**: 규칙 추가 지침(순서 결정 기준)을 `launch-matrix.mjs` 모듈 주석 또는 `docs/plan/agy-terminal-path.md`에 명시하는 것을 권장.
- **예상 작업 크기**: XS (주석 보완)
- **회귀 방지 검사**: `tests/launch-matrix.test.mjs`; 신규 규칙 추가 시 기존 조합 회귀 테스트 유지

---

#### 3. 사전 후보 확인·반박·보완

| 사전 후보 | 판정 | 근거 |
|---|---|---|
| **C-M8** | **확인(낮은 우선순위)** | `role-terminal.mjs:588-595`에서 `pollMs=1500ms` 간격의 `orca terminal read` 외부 프로세스 반복 확인. 코드 구조 분석 기준 최대 70회(settleMs=8s, readyMs=90s). 단, `settleMs`·`readyMs`로 상한이 있어 무한 폴링 아님. 실제 프로세스 spawn 비용은 미측정(Orca 실환경 필요). → LAUNCH-01로 등록 |
| **C-A1** | **규칙 근거 미확인** | `role-terminal.mjs:24`에서 `runOrcaJson`을 `orca-adapter.mjs`에서 직접 import 확인. `adapters.mjs`의 `executionAdapter` port는 worker 생명주기(start/stop/confirm) 전용이며 터미널 UI 조작은 포함하지 않음. `CODE_QUALITY.md:68`이 `orca-adapter.mjs`를 공통 JSON 호출 위치로 선언. "어댑터 경유 금지" 규칙은 정본 문서에 없음. → LAUNCH-02로 등록(규칙 근거 판정은 Senior/PM 필요) |

---

#### 4. 발견 후보 요약

| id | 분류 | 심각도 | 핵심 |
|---|---|---|---|
| LAUNCH-01 | memory | low | role-terminal: pollMs 간격 orca terminal read 외부 프로세스 반복(최대 70회/launch) |
| LAUNCH-02 | architecture | low | role-terminal: runOrcaJson 직접 import — 어댑터 경유 규칙 근거 미확인 |
| LAUNCH-03 | checks | low | readLaunchEnvironment: 사용자 설정 파일 읽기 전용 확인(규칙 준수, 문제 없음) |
| LAUNCH-04 | checks | low | launch-matrix: 순서 민감 규칙 표 — 규칙 추가 지침 부재 |

low 4개. 합계 4개.

---

#### 5. 남은 의심

- **LAUNCH-01 실측 필요**: `orca terminal read` 외부 프로세스 1회 spawn 비용(시간·RSS)은 실환경 Orca에서만 측정 가능. 비용이 높으면 `terminal wait` 전환 우선순위가 높아짐(미측정).
- **LAUNCH-02 규칙 확정**: "어댑터를 거치지 않는 직접 호출 금지" 규칙의 정본 문서 존재 여부를 B7 묶음이 확인 후 판정 확정 필요.
- **LAUNCH-03 규칙 근거 위치**: `ai-native-agent-organization.md:355`(사용자 설정 파일 쓰기 금지)가 실제 해당 내용을 담고 있는지 B7 묶음이 확인 필요.
- **worker.mjs 사용자 설정 쓰기**: `worker.mjs`는 `fs.writeFile`을 사용하나 대상이 state/evidence 디렉터리에 한정됨을 추가 확인했으나, 설정 파일 접근 경로가 없음을 확인했으므로 별도 후보 없음.


