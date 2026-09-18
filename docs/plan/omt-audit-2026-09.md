# omt-audit 2026-09 보고서

- 작성일: 2026-09-18
- 상태: 초안 (audit-runtime-io·audit-state·audit-launch·audit-docs-repo·audit-tests 묶음 완료, 다른 묶음 미완)
- 대상: plugins/oh-my-teams/scripts (B1·B5·B3a·B3b·B4b 묶음), tests/ (T1·T2 묶음)
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

---

### audit-docs-repo

> 조사 대상: B6(scripts/check-code-quality.mjs, scripts/metadata.mjs, scripts/install.mjs, evals/organization/run.mjs, evals/organization/scenarios.json, plugins/orca/scripts/orca-org.mjs) + B7(plugins/oh-my-teams/skills/\*\*, plugins/oh-my-teams/references/\*\*)
> 조사 기준 커밋: 4d1d7d6

#### 1. 파일별 조사 상태

| 파일 | 묶음 | 줄 수 | 조사 상태 |
|---|---|---:|---|
| scripts/check-code-quality.mjs | B6 | 307 | 조사함 |
| scripts/metadata.mjs | B6 | 268 | 조사함 |
| scripts/install.mjs | B6 | 296 | 조사함 |
| evals/organization/run.mjs | B6 | 79 | 조사함 |
| evals/organization/scenarios.json | B6 | 65 | 조사함 |
| plugins/orca/scripts/orca-org.mjs | B6 | 13 | 조사함 |
| plugins/oh-my-teams/references/assist.md | B7 | 42 | 조사함 |
| plugins/oh-my-teams/references/bluf.md | B7 | 44 | 조사함 |
| plugins/oh-my-teams/references/kickoff-registry.md | B7 | 114 | 조사함 |
| plugins/oh-my-teams/references/korean-result-reporting.md | B7 | 54 | 조사함 |
| plugins/oh-my-teams/references/minimal-change.md | B7 | 45 | 조사함 |
| plugins/oh-my-teams/references/orca-runtime.md | B7 | 252 | 조사함 |
| plugins/oh-my-teams/references/user-choice.md | B7 | 30 | 조사함 |
| plugins/oh-my-teams/skills/adjust/SKILL.md | B7 | 61 | 조사함 |
| plugins/oh-my-teams/skills/close/SKILL.md | B7 | 52 | 조사함 |
| plugins/oh-my-teams/skills/disband/SKILL.md | B7 | 32 | 조사함 |
| plugins/oh-my-teams/skills/fluent-korean/SKILL.md | B7 | 52 | 조사함 |
| plugins/oh-my-teams/skills/form/SKILL.md | B7 | 85 | 조사함 |
| plugins/oh-my-teams/skills/help/SKILL.md | B7 | 77 | 조사함 |
| plugins/oh-my-teams/skills/intern/SKILL.md | B7 | 47 | 조사함 |
| plugins/oh-my-teams/skills/junior/SKILL.md | B7 | 47 | 조사함 |
| plugins/oh-my-teams/skills/kickoff/SKILL.md | B7 | 50 | 조사함 |
| plugins/oh-my-teams/skills/pl/SKILL.md | B7 | 101 | 조사함 |
| plugins/oh-my-teams/skills/pm/SKILL.md | B7 | 128 | 조사함 |
| plugins/oh-my-teams/skills/senior/SKILL.md | B7 | 53 | 조사함 |
| plugins/oh-my-teams/skills/status/SKILL.md | B7 | 34 | 조사함 |

---

#### 2. R1~R17 규칙 확정

##### 2-1. 확인된 규칙 (선언 위치 인용)

| id | 규칙 | 근거 위치 |
|---|---|---|
| R1 | 원시 `orca orchestration worker-start`·`worktree create --agent`로 역할을 띄우지 않는다 | `skills/pm/SKILL.md:33`, `skills/pl/SKILL.md:34`, `references/orca-runtime.md:81` |
| R2 | 감독 worker는 `worker-start` 래퍼와 `role-terminal`로만 시작한다 | `skills/pm/SKILL.md:19`, `skills/pl/SKILL.md:74`, `references/orca-runtime.md:79-98` |
| R3 | 주인 체크아웃에 커밋·병합하지 않는다. `merge-check`·`role-terminal`·`worker-start`가 거부한다 | `references/kickoff-registry.md:60-70`, `skills/kickoff/SKILL.md:45`, `skills/close/SKILL.md:10, 23` |
| R4 | 자기 결과를 자기가 승인하지 않는다 | `skills/pm/SKILL.md:36`, `skills/junior/SKILL.md:29` |
| R5 | 공통 수치·버전은 `scripts/metadata.mjs`가 정본, 직접 고치지 않는다 | `AGENTS.md:23-36`, `README.md`(추정, 미확인) |
| R6 | 실행 경로 판정은 `launch-matrix.mjs` 호환성 표가 정한다 | `references/orca-runtime.md:98, 171` |
| R7 | 불필요한 변경 규율, 기존 helper 재구현 금지 | `references/minimal-change.md:9, 21` |
| R8 | 공통 helper 위치 (`core/usage/workflow-store/status/orca-adapter`) | `docs/CODE_QUALITY.md:62-68` |
| R9 | 모듈 JSDoc, 공개 export JSDoc·@param·@returns, 180자 제한, 허위 @throws 금지 | `AGENTS.md:17`, `docs/CODE_QUALITY.md:25-60` |
| R10 | 보조 도구·사용자 결정은 각 정본 문서만 참조 | `references/assist.md:3`, `references/user-choice.md:3` |
| R11 | `worker-start`는 Run에 바인딩된 coordinator 터미널에서만 | `references/orca-runtime.md:189`, `references/kickoff-registry.md:77` |

##### 2-2. 규칙 쪽을 고쳐야 하는 항목

| id | 위치 | 내용 |
|---|---|---|
| C-R1 | `AGENTS.md:13` | 버전 정책은 `` `1.x.x` 범위``라고 적지만 현재 버전은 2.4.1이다. 현실과 문서가 어긋나는 확인 후보다. |
| C-R2 | 브리프 규칙 R13~R17 | 저장소 확인 결과: (a) Orca 재구현 금지 → `docs/plan/ai-native-agent-organization.md:53`(설계 문서에만 있음, `AGENTS.md`·`CODE_QUALITY.md` 정본에 없음). (b) 사용자 설정 쓰기 금지 → `role-terminal.mjs:36` 주석에 있고 `ai-native-agent-organization.md:355`가 근거로 지목됐으나, 해당 줄은 「기존 사용자 설정을 자동 덮어쓰지 않는다」로 조직 policy migration 문맥이며 설정 파일 쓰기 금지 규칙을 선언하지 않는다. (c) 임시 산출물 금지 → `headless.mjs:36`, `role-launch.mjs:441`, `docs/plan/headless-runtime.md:70`(설계·소스 주석에만 있음). (d) 어댑터 경유 금지 → 정본 문서에 없음(LAUNCH-02 결론 동일). (e) 스킬에 런타임 로직 중복 금지 → 명시 문장 없음(`ai-native-agent-organization.md` 원칙 4가 가장 가깝다). 모두 `AGENTS.md`·`CODE_QUALITY.md` 정본에 없다. |

##### 2-3. R12~R17 (plan.md의 미확인 규칙) 최종 확정

| id | 규칙 | 확인 결과 |
|---|---|---|
| R12 | 버전 정책 `1.x.x` | `AGENTS.md:13` 선언 확인. 단, 현재 버전 2.4.1과 어긋남(C-R1). |
| R13 | Orca 재구현 금지 | `docs/plan/ai-native-agent-organization.md:53`(설계 문서)에만 있음. `AGENTS.md`·`CODE_QUALITY.md` 정본 문서에 없음. |
| R14 | 어댑터를 거치지 않는 직접 호출 금지 | 정본 문서에 없음(`CODE_QUALITY.md:68`은 공통화 위치 설명). `LAUNCH-02` 판단과 동일. |
| R15 | 스킬 문서에 런타임 로직 중복 금지 | 명시 문장 없음. `ai-native-agent-organization.md` 원칙 4(「판단과 강제 조건을 분리한다」)가 가장 가깝다. |
| R16 | 사용자 설정 파일을 쓰지 않는다 | `role-terminal.mjs:36` 주석에 선언. 설계 문서 근거(`ai-native-agent-organization.md:355`)는 오해였음. LAUNCH-03에서 구현은 규칙 준수로 판정. |
| R17 | 임시 산출물을 워크트리에 남기지 않는다 | 소스 주석과 설계 문서(`headless-runtime.md:70`)에만 있음. `AGENTS.md`·`CODE_QUALITY.md` 정본에 없음. |

---

#### 3. 발견 후보

---

##### DOCS-01

- **id**: DOCS-01
- **분류**: checks
- **심각도 가안**: medium
- **파일:줄**: `AGENTS.md:13`
- **증상**: 버전 정책이 `` `1.x.x` 범위에서 버전을 올립니다``라고 적혀 있으나 현재 버전은 2.4.1이다. 주 버전 2로의 전환이 이미 이루어진 상태에서 문서는 여전히 `1.x.x`를 기술하고 있어, 정본과 현실이 어긋나는 규칙(C-R1)이다.
- **근거**: 코드 인용 — `AGENTS.md:13`:
  ```
  호환 가능한 기능 추가와 버그 수정은 `1.x.x` 범위에서 버전을 올립니다.
  ```
  `package.json`의 현재 버전: `2.4.1`. 측정: 해당 없음.
- **제안 수정**: `AGENTS.md:13`의 버전 정책 문장을 「`` `2.x.x` 범위에서 버전을 올립니다``」(또는 「semver 규칙에 따라 호환 변경은 마이너, 비호환 변경은 메이저를 올립니다」)로 수정하여 현재 실태와 일치시킨다.
- **예상 작업 크기**: XS (문장 수정 1줄)
- **회귀 방지 검사**: `tests/repository-metadata.test.mjs`에 버전 정책 문서 내 버전 범위가 `package.json` 주 버전과 일치하는지 확인하는 검사 추가 권고.

---

##### DOCS-02

- **id**: DOCS-02
- **분류**: checks
- **심각도 가안**: medium
- **파일:줄**: `docs/plan/ai-native-agent-organization.md:53` vs `AGENTS.md`, `docs/CODE_QUALITY.md`
- **증상**: 규칙 R13(「Orca의 감독 기능을 재구현하지 않는다」), R14(「어댑터를 거치지 않는 직접 호출 금지」), R15(「스킬 문서에 런타임 로직 중복 금지」), R17(「임시 산출물을 워크트리에 남기지 않는다」)은 설계 문서·소스 주석에만 존재하며 `AGENTS.md`·`CODE_QUALITY.md` 등 정본 문서에 없다. 에이전트가 정본으로 참조해야 할 규칙이 분산되어 있고, 검사 스크립트도 이들을 확인하지 않는다.
- **근거**:
  - `docs/plan/ai-native-agent-organization.md:53`: 원칙 8 「Orca의 감독 기능을 재구현하지 않는다」 (설계 문서에만 있음)
  - `AGENTS.md` 전문 grep: 해당 규칙 문장 없음.
  - `docs/CODE_QUALITY.md` 전문 grep: 해당 규칙 문장 없음.
  - `references/orca-runtime.md:15`: 「oh my teams는 Orca polling, lifecycle, 프로세스 회수 또는 업데이트 관리자를 재구현하지 않는다」 — 유일한 references 수준의 선언이지만 규칙 목록이 아니라 도입부 설명이다.
  측정: 해당 없음.
- **제안 수정**: R13~R15·R17에 해당하는 규칙을 `AGENTS.md`(또는 `docs/CODE_QUALITY.md`)에 명시적인 항목으로 추가하거나, 설계 문서 참조 링크를 `AGENTS.md`에 기재한다. 규칙이 자동 검사로 강제될 수 없다면 그 사실을 명시한다.
- **예상 작업 크기**: S (규칙 문장 추가 4~5항목 및 링크)
- **회귀 방지 검사**: `tests/skill-instructions.test.mjs`에 정본 문서에 없는 규칙을 스킬이 단독 선언하지 않는지 확인하는 검사 추가 권고.

---

##### DOCS-03

- **id**: DOCS-03
- **분류**: checks
- **심각도 가안**: medium
- **파일:줄**: `docs/plan/ai-native-agent-organization.md:53` vs `docs/plan/headless-runtime.md:7-16`
- **증상**: `ai-native-agent-organization.md:53`의 원칙 8은 「실행 소유권·프로세스·회수는 Orca를 사용한다」고 선언하나, `headless-runtime.md:7-16`은 headless 경로가 「Orca를 대체하는 감독 런타임」임을 명시적 설계 목표로 선언한다. 두 문서가 충돌하는지, `headless-runtime.md`가 공식 예외인지가 불명확하다. audit-runtime-io의 F-07과 동일 쟁점이며, B7 조사에서 `ai-native-agent-organization.md`에 headless 예외 조항이 없음을 직접 확인했다.
- **근거**:
  - `docs/plan/ai-native-agent-organization.md:53`: 「Orca의 감독 기능을 재구현하지 않는다. 스킬 패키지는 업무 계약과 gate를 담당하고, 실행 소유권·프로세스·회수는 Orca를 사용한다.」
  - `docs/plan/headless-runtime.md:7-16` 내용: headless 경로가 Orca 없는 실행을 2단계 목표로 명시.
  - `docs/plan/ai-native-agent-organization.md` 전체에 headless 예외 조항 없음(직접 확인).
  측정: 해당 없음.
- **제안 수정**: `ai-native-agent-organization.md:53`에 「headless-runtime.md가 명시적으로 선택할 때 허용되는 예외」 조항을 추가하거나, `headless-runtime.md`에 「원칙 8의 공식 예외」임을 명시한다.
- **예상 작업 크기**: XS (문서 보완 1~2문장)
- **회귀 방지 검사**: 문서 일관성 검사. `skill-instructions.test.mjs`에 headless 예외 선언 확인 추가 권고.

---

##### DOCS-04

- **id**: DOCS-04
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `scripts/check-code-quality.mjs:8-16`
- **증상**: `check-code-quality.mjs`의 `ignoredDirectories`에 `evals` 디렉터리가 없어, `evals/organization/run.mjs`가 품질 감사 대상에 포함된다. `run.mjs`는 `escapeForPattern`, `runEvidenceTest` 두 내부 함수를 JSDoc 없이 선언한다. 단, 두 함수 모두 `export`가 아니므로 현재 공개 export 검사에서는 findings 0으로 통과한다. `run.mjs`의 `publicExports: 0` 또한 설계 의도에 부합한다. 문제는 검사의 **사각지대**: 비공개 함수의 문서화와 evals 스크립트의 복잡도는 품질 검사가 측정하지 않는다.
- **근거**: `check-code-quality.mjs:8-16` — `ignoredDirectories`에 `evals` 없음:
  ```js
  const ignoredDirectories = new Set([
    ".git", ".omc", ".orca", ".omt",
    "legacy", "node_modules", "results",
  ]);
  ```
  `evals/organization/run.mjs:20-47` — 비공개 함수 2개, JSDoc 없음:
  ```js
  function escapeForPattern(name) { ... }   // line 20, no JSDoc
  async function runEvidenceTest(name) { ... }  // line 24, no JSDoc
  ```
  `npm run quality` 실행 결과: `evals/organization/run.mjs`의 `publicExports: 0`, `findings: []` — 현재 검사 통과.
  비용: 품질 검사가 비공개 함수를 포함하도록 확장하는 경우 검사 시간은 미측정.
- **제안 수정**: (a) 단기: `evals/organization/run.mjs`의 두 내부 함수에 JSDoc 추가(비공개라 강제되지 않으나 관례 일관성). (b) 중기: `check-code-quality.mjs`에 중요 비공개 함수(특히 eval 스크립트)의 선택적 문서화 검사 추가를 검토한다. `evals` 디렉터리를 `ignoredDirectories`에 추가하는 것도 의도를 명확히 하는 방법이다.
- **예상 작업 크기**: XS-S (JSDoc 추가 2건, 또는 ignoredDirectories 수정 1줄)
- **회귀 방지 검사**: 없음(현재 검사 통과). 필요 시 `tests/code-quality.test.mjs`에 evals 디렉터리 범위 확인 추가.

---

##### DOCS-05

- **id**: DOCS-05
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `scripts/metadata.mjs:37-45`
- **증상**: `declaredTestCount`는 `tests/` 디렉터리의 각 `.test.mjs` 파일을 `readFileSync`로 전체 읽고 `^test(`를 정규식으로 카운팅한다. 파일마다 전체 내용을 메모리에 올린다. 테스트 파일이 31개·합계 약 20,500줄인 지금은 허용 범위이나, 장기적으로 테스트 파일이 크게 늘면 `sync` 실행 비용이 증가한다. 또한 `테스트` 파일이 아닌 위치에 `test(` 패턴이 있으면 오탐할 수 있다.
- **근거**: `metadata.mjs:37-45`:
  ```js
  export function declaredTestCount(repoRoot = root) {
    const dir = path.join(repoRoot, "tests");
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".test.mjs"))
      .reduce((total, name) => {
        const text = fs.readFileSync(path.join(dir, name), "utf8");
        return total + (text.match(/^test\(/gm) ?? []).length;
      }, 0);
  }
  ```
  현재 테스트 파일 31개 총 줄 수 약 20,500(inventory.csv 기준 T1 20개·T2 11개). 측정: 미측정(현재 규모에서 `sync` 소요는 `RESULTS.md`에서 3.5초로 전체 sync 포함).
- **제안 수정**: 현재 규모에서는 허용 범위. 테스트 파일이 크게 늘면 파일 전체 대신 `createReadStream`으로 줄 단위 카운팅으로 전환하거나, 정적 카운트를 별도 파일에 캐시하는 방안 검토.
- **예상 작업 크기**: XS (현재 변경 없음, 미래 고려)
- **회귀 방지 검사**: `tests/repository-metadata.test.mjs`(기존 검사 유지).

---

##### DOCS-06

- **id**: DOCS-06
- **분류**: architecture
- **심각도 가안**: low
- **파일:줄**: `plugins/orca/scripts/orca-org.mjs:1-12`
- **증상**: `plugins/orca/scripts/orca-org.mjs`는 사전 1.1 런타임 경로의 호환성 진입점이며, 현재 구현을 `plugins/oh-my-teams/scripts/teams-org.mjs`의 `main`에 위임하는 13줄짜리 파일이다. 주석이 「pre-1.1 runtime path」라고 명시하는데, 현재 버전이 2.4.1인 시점에서 이 파일이 여전히 필요한지 여부가 불명확하다. 사용 여부를 추적하는 테스트나 문서가 없다.
- **근거**: `plugins/orca/scripts/orca-org.mjs:1-12`:
  ```js
  /**
   * Compatibility entry point for the pre-1.1 runtime path.
   * The active implementation lives under `plugins/oh-my-teams`.
   */
  import { main } from "../../oh-my-teams/scripts/teams-org.mjs";
  main(process.argv.slice(2)).catch(...)
  ```
  `docs/plan/oh-my-teams-rename-and-orca-integration.md`가 이름 변경 이력을 담고 있을 것으로 추정되나, 해당 파일이 1.1 이전 경로를 여전히 참조하는 외부 설치가 있는지 확인하지 못했음. 측정: 해당 없음.
- **제안 수정**: 1.1 이전 경로가 더 이상 사용되지 않는다고 확인되면 이 파일을 제거하거나 `legacy/`로 이동한다. 불확실하면 `tests/removed-skills.mjs` 패턴을 참고하여 사용 추적 검사를 추가한다.
- **예상 작업 크기**: XS (확인 후 제거 또는 유지)
- **회귀 방지 검사**: 제거 시 `install.mjs`·스킬 파일에서 이 경로를 참조하는 곳 없음을 확인. `tests/code-quality.test.mjs`에 호환 파일 목록 검사 추가 권고.

---

##### DOCS-07

- **id**: DOCS-07
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `plugins/oh-my-teams/references/assist.md:3` vs `plugins/oh-my-teams/skills/pm/SKILL.md:10, 21`
- **증상**: `assist.md:3`는 「이 문서가 정본이며 역할 스킬은 여기를 참조한다」고 선언한다. 그런데 `assist.md:11`은 선택 가능한 보조 도구 프로필 모델이 `gpt-oss-120b-medium`이어야 한다고 적는다. 이 값은 런타임(`scripts/worker.mjs`의 `assist` 코드)이 강제하는 값이며, 문서와 런타임이 각각 이 값을 기술하는 중복 선언이다. 모델 ID가 바뀌면 두 곳을 함께 바꿔야 한다.
- **근거**: `references/assist.md:11`:
  ```
  3. 선택된 프로필의 모델이 `gpt-oss-120b-medium`이어야 한다.
  ```
  런타임 강제 여부: `scripts/worker.mjs`가 `assist` 명령에서 이를 검증한다고 `assist.md:6-7`에 기술됨. 즉 문서가 런타임 로직의 일부를 반복 기술하는 구조다. 측정: 해당 없음.
- **제안 수정**: 런타임이 강제하는 값(모델 ID)은 문서에서 「런타임이 검사한다」고만 쓰고 구체적 값은 소스 코드를 정본으로 삼거나, 두 곳을 `scripts/metadata.mjs` 패턴처럼 단일 정본에서 동기화하는 방안 검토.
- **예상 작업 크기**: XS (문서 표현 수정 또는 sync 대상 추가)
- **회귀 방지 검사**: `tests/skill-instructions.test.mjs`에 `assist.md`의 모델 ID가 `worker.mjs`의 검증값과 일치하는지 확인하는 검사 추가 권고.

---

##### DOCS-08

- **id**: DOCS-08
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `plugins/oh-my-teams/skills/help/SKILL.md:8`
- **증상**: `help/SKILL.md:8`은 「이 표는 설치된 스킬 목록과 일치하도록 `tests/code-quality.test.mjs`가 검사하므로, 매번 다시 조사하면 같은 결과를 더 비싸게 얻을 뿐이다」라고 명시한다. 즉 스킬 목록 표가 자동 검사로 고정되어 있다. 단, `help/SKILL.md:14`의 `<!-- help:start -->` 블록 안의 표를 `code-quality.test.mjs`가 실제로 검사하는지 여부를 소스 내 인용으로 직접 확인하지 않았다. 이 주석 자체가 런타임 로직을 문서에 기술하는 패턴(R15)의 경계선에 있다.
- **근거**: `help/SKILL.md:8`:
  ```
  이 표는 설치된 스킬 목록과 일치하도록 `tests/code-quality.test.mjs`가 검사하므로,
  매번 다시 조사하면 같은 결과를 더 비싸게 얻을 뿐이다.
  ```
  `tests/code-quality.test.mjs`에서 help 스킬 목록을 검사하는 코드가 있다고 문서가 주장하나, B6·B7 조사에서 해당 테스트 파일을 직접 읽지 않았으므로 인용 미확인. 측정: 해당 없음.
- **제안 수정**: `tests/code-quality.test.mjs`가 실제로 이 표를 검사하는지 직접 확인 후 판정. 검사가 없으면 주석을 수정하거나 검사를 추가한다. 검사가 있으면 현재 상태가 적절하다.
- **예상 작업 크기**: XS (확인 후 0~1줄 수정)
- **회귀 방지 검사**: `tests/code-quality.test.mjs`에 help 표 동기화 검사가 있어야 함.

---

##### DOCS-09

- **id**: DOCS-09
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `plugins/oh-my-teams/skills/form/SKILL.md:24-28`
- **증상**: `form/SKILL.md:24-28`의 모델 선택지 표에는 각 역할의 권장 모델 ID(`claude:fable`, `agy:gemini-3.1-pro-high` 등)가 명시되어 있다. 이 모델 ID들은 `scripts/metadata.mjs`로 동기화되지 않으며, 모델 ID가 바뀌거나 새 모델이 추가될 때 수동으로 갱신해야 한다. 자동 검사로 정합성을 보장하는 장치가 없다.
- **근거**: `form/SKILL.md:24-28`:
  ```markdown
  | PM | Claude Fable → `claude:fable`, Claude Opus → `claude:opus`, Codex Astra → `codex:gpt-6-astra`, Agy Gemini Pro → `agy:gemini-3.1-pro-high` |
  | PL | Claude Opus → `claude:opus`, Codex Sol → `codex:gpt-5.6-sol`, ...
  ```
  `scripts/metadata.mjs`의 `metadataTargets`에 `form/SKILL.md`는 포함되지 않음(직접 확인).
  측정: 해당 없음.
- **제안 수정**: `form/SKILL.md`의 모델 선택지가 검증된 모델 카탈로그(`agy models`, `codex.listed`)와 일치하는지 확인하는 검사를 `tests/skill-instructions.test.mjs`에 추가하는 것을 검토한다. 비용: 모델 카탈로그가 동적으로 바뀌므로 단순 정적 검사로는 한계가 있다.
- **예상 작업 크기**: S (검사 추가, 동적 카탈로그 연동 방법 결정 필요)
- **회귀 방지 검사**: 해당 없음(현재 없음). 추가 권고.

---

#### 4. 사전 후보 판정표

| 사전 후보 | 대상 묶음 | 판정 | 근거 |
|---|---|---|---|
| **C-R1** | B7 | **확인** | `AGENTS.md:13`에서 버전 정책 `1.x.x` 선언 확인. 현재 버전 2.4.1과 어긋남. → DOCS-01로 등록 |
| **C-R2(a)** Orca 재구현 금지 | B7 | **확인(설계 문서에만)** | `ai-native-agent-organization.md:53`에만 있음. 정본(`AGENTS.md`, `CODE_QUALITY.md`)에 없음. → DOCS-02로 등록 |
| **C-R2(b)** 어댑터 경유 금지 | B7 | **확인(근거 없음)** | 정본 문서에 없음. `CODE_QUALITY.md:68`은 위치 설명. LAUNCH-02 결론 동일. → DOCS-02로 등록 |
| **C-R2(c)** 임시 산출물 금지 | B7 | **확인(소스 주석·설계 문서에만)** | 정본 문서에 없음. → DOCS-02로 등록 |
| **C-R2(d)** 스킬에 런타임 로직 중복 금지 | B7 | **확인(명시 없음)** | 정본 문서에 없음. 원칙 4가 가장 가깝다. → DOCS-02로 등록 |
| **C-R2(e)** 사용자 설정 파일 쓰기 금지 | B7 | **부분 확인** | `role-terminal.mjs:36` 주석에 선언. `ai-native-agent-organization.md:355`는 별도 문맥으로 근거 오해. 설정 파일 쓰기 금지 자체는 구현에서 준수됨(LAUNCH-03 판단). → DOCS-02에 기록(근거 오해 수정). |
| **C-A2** headless 재구현 | B7 | **확인(예외 선언 없음)** | `ai-native-agent-organization.md`에 headless 예외 조항 없음을 직접 확인. F-07 판단과 동일. → DOCS-03으로 등록 |

---

#### 5. 스킬 문서 런타임 로직 중복 조사

| 파일 | 중복 내용 | 심각도 |
|---|---|---|
| `references/assist.md:11` | 보조 도구 허용 모델 ID(`gpt-oss-120b-medium`) — 런타임이 강제하는 값을 문서도 기술 | low (DOCS-07) |
| `references/orca-runtime.md` 전체 | Orca 터미널 대기 판정 규칙, `--inject-fallback` 조건, `role-terminal` 순서 등 런타임 절차 상세를 스킬 가이드에 복제. 의도적 설계(역할이 절차를 알아야 함)이나 Orca 변경 시 두 곳 갱신 필요. | 허용(의도적 설계) |
| `skills/pm/SKILL.md:19`, `skills/pl/SKILL.md:19` | `role-terminal` 사용 순서·`worker-start` 래퍼 인수 목록 — `orca-runtime.md`와 중복 | 허용(역할별 요약 필요) |
| `skills/help/SKILL.md:8` | 「`tests/code-quality.test.mjs`가 검사한다」 — 테스트 파일 이름을 스킬에 기술 | low (DOCS-08) |

대부분의 중복은 역할 스킬이 절차를 요약해야 하는 의도적 설계이며, 정본 참조 링크(`orca-runtime.md`)를 통해 단방향으로 관리된다. 문제 있는 중복은 DOCS-07·08로 등록했다.

---

#### 6. 검사 스크립트 사각지대 조사

| 사각지대 | 파일:줄 | 비용 | 제안 |
|---|---|---|---|
| 비공개 함수 문서화 미검사 | `scripts/check-code-quality.mjs:215-217` | 검사 확장 S-M | 선택적 비공개 함수 JSDoc 검사 추가 (DOCS-04) |
| 스킬 문서 모델 ID 최신성 미검사 | `scripts/check-code-quality.mjs` 전반 | 검사 구현 M(동적 카탈로그 연동 필요) | `agy models` 대조 검사 (DOCS-09) |
| 버전 정책 문서와 실제 버전 일치 미검사 | `scripts/metadata.mjs`의 `metadataTargets` | 검사 추가 XS | regex로 `AGENTS.md` 버전 정책 확인 (DOCS-01) |
| 설계 문서 간 규칙 선언 일관성 미검사 | - | 검사 구현 M | 설계 원칙·정본 문서 상호 참조 검사 (DOCS-02) |

---

#### 7. 발견 후보 요약

| id | 분류 | 심각도 | 핵심 |
|---|---|---|---|
| DOCS-01 | checks | medium | `AGENTS.md` 버전 정책 `1.x.x` — 현재 2.4.1과 불일치 |
| DOCS-02 | checks | medium | R13~R15·R17 규칙이 정본 문서에 없음 — 설계 문서·소스 주석에만 분산 |
| DOCS-03 | checks | medium | `ai-native-agent-organization.md` 원칙 8 vs `headless-runtime.md` — 예외 조항 미선언 |
| DOCS-04 | checks | low | `check-code-quality.mjs` 비공개 함수 문서화 사각지대 (`evals/run.mjs`) |
| DOCS-05 | checks | low | `metadata.mjs:declaredTestCount` — 테스트 파일 전체 읽기 (현재 규모 허용 범위) |
| DOCS-06 | architecture | low | `plugins/orca/scripts/orca-org.mjs` — pre-1.1 호환 파일, 제거 여부 미확인 |
| DOCS-07 | checks | low | `assist.md` 모델 ID 런타임 로직 중복 선언 |
| DOCS-08 | checks | low | `help/SKILL.md` — 테스트 파일 참조 주석 실제 검사 여부 미확인 |
| DOCS-09 | checks | low | `form/SKILL.md` 모델 선택지 자동 동기화 없음 |

medium 3개, low 6개. 합계 9개.

---

#### 8. 남은 의심

- **DOCS-02 규칙 확정**: R13~R17 중 정본 문서에 추가해야 할 항목의 우선순위와 추가 형식(별도 절 vs 기존 절 보완)은 PM·Senior의 설계 판단 필요.
- **DOCS-06 사용 추적**: `plugins/orca/scripts/orca-org.mjs`를 1.1 이전 설치에서 실제로 참조하는지 여부는 사용 로그나 릴리스 노트 확인 필요(미측정).
- **DOCS-07 단일 정본 타당성**: `assist.md`의 모델 ID 동기화를 `metadata.mjs` 패턴으로 처리할 경우 비용 대비 효과 검토 필요.
- **DOCS-08 확인 완료**: `tests/code-quality.test.mjs:172-213`에서 `help/SKILL.md`의 스킬 목록 표를 실제로 검사함을 확인. DOCS-08의 \"검사 여부 미확인\" 의심은 해소됨(검사 존재 확인). 단, 주석이 \"rebuild하지 않도록\"의 의도 설명이므로 삭제할 이유 없음.
- **R16(사용자 설정 쓰기 금지) 정본화**: `role-terminal.mjs:36` 주석에만 선언된 이 규칙을 `AGENTS.md`나 `CODE_QUALITY.md`에 추가할 필요가 있는지 판단 필요.

---

### audit-tests

> 조사 대상: T1(tests/*.mjs 20개) + T2(tests/*.mjs 11개), 합계 31개
> 조사 기준 커밋: 4d1d7d6

#### 1. 파일별 조사 상태

| 파일 | 묶음 | 줄 수 | 조사 상태 |
|---|---|---:|---|
| tests/agy-start.test.mjs | T1 | 297 | 조사함 |
| tests/boundary-and-gate.test.mjs | T1 | 344 | 조사함 |
| tests/cleanup-and-portability.test.mjs | T1 | 145 | 조사함 |
| tests/cli-integration.test.mjs | T1 | 424 | 조사함 |
| tests/code-quality.test.mjs | T1 | 229 | 조사함 |
| tests/dashboard.test.mjs | T1 | 301 | 조사함 |
| tests/delivery.test.mjs | T1 | 360 | 조사함 |
| tests/fake-agent.mjs | T1 | 95 | 조사함 |
| tests/kickoff-registry.test.mjs | T1 | 486 | 조사함 |
| tests/lock-recovery-and-release.test.mjs | T1 | 405 | 조사함 |
| tests/org-draft.test.mjs | T1 | 173 | 조사함 |
| tests/provider-adapters.test.mjs | T1 | 466 | 조사함 |
| tests/reduced-organization.test.mjs | T1 | 263 | 조사함 |
| tests/removed-skills.mjs | T1 | 48 | 조사함 |
| tests/repository-metadata.test.mjs | T1 | 182 | 조사함 |
| tests/review-format.test.mjs | T1 | 85 | 조사함 |
| tests/run-depth.test.mjs | T1 | 303 | 조사함 |
| tests/silent-wrong-results.test.mjs | T1 | 329 | 조사함 |
| tests/supervision.test.mjs | T1 | 245 | 조사함 |
| tests/workflow-recovery.test.mjs | T1 | 74 | 조사함 |
| tests/execution-port.test.mjs | T2 | 780 | 조사함 |
| tests/headless.test.mjs | T2 | 623 | 조사함 |
| tests/launch-matrix.test.mjs | T2 | 705 | 조사함 |
| tests/role-dispatch.test.mjs | T2 | 842 | 조사함 |
| tests/role-terminal.test.mjs | T2 | 964 | 조사함 |
| tests/runtime.test.mjs | T2 | 2416 | 조사함 |
| tests/safety-net.test.mjs | T2 | 557 | 조사함 |
| tests/skill-instructions.test.mjs | T2 | 1065 | 조사함 |
| tests/usage-report.test.mjs | T2 | 686 | 조사함 |
| tests/usage-sources.test.mjs | T2 | 670 | 조사함 |
| tests/workflow-safety.test.mjs | T2 | 1071 | 조사함 |

---

#### 2. 발견 후보

---

##### TESTS4-01

- **id**: TESTS4-01
- **분류**: memory
- **심각도 가안**: low
- **파일:줄**: `tests/fake-agent.mjs:74-75`
- **증상**: `fake-agent.mjs`는 prompt에 `SLEEP`이 포함되면 `setInterval(() => {}, 1000)`으로 프로세스를 무한히 살려둔다. 이 파일은 `headless.test.mjs`와 `dashboard.test.mjs`에서 `startHeadlessWorker`의 agent CLI로 실행되는 자식 프로세스다. 각 테스트는 `waitHeadless` + `stopHeadless`로 프로세스를 정상 종료시키지만, 종료가 실패하면(예: Windows 손자 프로세스 정리 미완 — F-05와 같은 원인) `setInterval`이 남는다. `headless.test.mjs:29-38`과 `dashboard.test.mjs:21-28`의 `t.after`는 300ms/1500ms 지연 후 `rmSync`를 시도하므로, runner 프로세스가 살아 있으면 파일 잠금 충돌이 발생한다(`maxRetries: 5, retryDelay: 200`으로 완화).
- **근거**: 코드 인용 — `fake-agent.mjs:73-75`:
  ```js
  if (prompt.includes("CRASH")) process.exit(3);
  if (prompt.includes("SLEEP")) {
    setInterval(() => {}, 1000);  // 프로세스를 무한 살려두는 타이머
  ```
  `headless.test.mjs:306-318`: SLEEP 에이전트를 `stopHeadless`로 종료 후 `waitHeadless`로 확인하는 테스트가 있고, 정상 경로에서 올바르게 정리됨.
  측정: 의도적 설계이므로 측정 없음.
- **판정**: **문제 없음(설계 의도)** — SLEEP은 실행 중인 에이전트를 시뮬레이션하는 의도적 설계이며, 테스트가 `stopHeadless`·`waitHeadless`로 올바르게 종료함. 단, Windows에서 F-05 문제(손자 프로세스 미정리)가 발생하면 이 타이머가 잔존할 가능성 있음 — 발견 후보로는 낮은 우선순위.
- **제안 수정**: 없음(현재 구현 적절). F-05가 수정되면 이 위험도 함께 줄어듦.
- **예상 작업 크기**: XS (F-05 연동)
- **회귀 방지 검사**: `headless.test.mjs`의 stop 경로; SLEEP 에이전트 종료 후 남은 프로세스 확인

---

##### TESTS4-02

- **id**: TESTS4-02
- **분류**: memory
- **심각도 가안**: low
- **파일:줄**: `tests/dashboard.test.mjs:21-28`, `tests/headless.test.mjs:29-38`, `tests/usage-report.test.mjs:35-44`
- **증상**: `dashboard.test.mjs`·`headless.test.mjs`·`usage-report.test.mjs`의 `sandbox`/`tempDir` 함수는 `t.after(async () => { await new Promise(setTimeout(...)); fs.rmSync(...) })`로 정리한다. 이 패턴에서 `setTimeout` 대기(300ms·300ms·1500ms)는 detached headless runner가 파일을 해제하도록 기다리기 위함이다. 코드 주석(`"Give stopped runners a moment to release their files on Windows"`)이 이유를 설명한다. 대기 시간이 충분하지 않으면 `rmSync`가 실패할 수 있으며, `maxRetries: 5, retryDelay: 200`으로 최대 1초 추가 재시도가 있다. 대기 시간이 고정값이고 시스템 부하 상황에서는 부족할 수 있다.
- **근거**: 코드 인용 — `dashboard.test.mjs:21-28`:
  ```js
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  ```
  `usage-report.test.mjs:35-44`: 동일 패턴, 1500ms 대기(detached headless runner 해제 대기).
  `headless.test.mjs:29-38`: 동일 패턴, 300ms 대기.
  측정: 미측정(실환경 부하에 따라 다름).
- **판정**: **설계 의도, 주의 필요** — Windows 파일 잠금 문제에 대한 현실적 대응이며, `maxRetries`로 어느 정도 완화됨. 단, CI 환경에서 부하가 높을 때 `rmSync` 실패 가능성이 있다. RESULTS.md에 따르면 1차 테스트 실행이 usage-report 도중에 시간 초과로 중단되었는데, 이 대기가 누적 소요 시간에 기여할 수 있다.
- **제안 수정**: `waitHeadless`가 완전히 종료됨을 확인한 이후에 `rmSync`를 호출하도록 순서를 보장하거나, 대기 시간을 환경 변수로 조정 가능하게 변경. F-05(Windows 손자 프로세스 정리)가 해결되면 이 대기 필요성도 줄어듦.
- **예상 작업 크기**: S (대기 조정 또는 종료 확인 강화)
- **회귀 방지 검사**: `headless.test.mjs`·`dashboard.test.mjs`·`usage-report.test.mjs`; CI 환경 실행 안정성

---

##### TESTS4-03

- **id**: TESTS4-03
- **분류**: memory
- **심각도 가안**: low
- **파일:줄**: `tests/usage-sources.test.mjs:660-669`
- **증상**: `usageHomes` 함수의 `agyHome` 기본값 검증 테스트(`tests/usage-sources.test.mjs:660-669`)가 `os.homedir()`를 직접 사용하여 기대값을 구성한다. 이 테스트는 `OMT_AGY_HOME` 환경변수를 주입하지 않아 실제 사용자 홈 디렉터리에 의존한다. 테스트가 실제 홈 디렉터리를 읽거나 쓰지는 않지만(경로 문자열 비교만), CI 환경의 홈 디렉터리 경로가 달라도 통과한다. 이와 달리 동일 파일의 다른 테스트들은 `tempDir`로 격리된 디렉터리를 사용하고 `usage-report.test.mjs`의 `isolateHomes`는 `HOME`·`USERPROFILE` 등을 빈 디렉터리로 교체한다.
- **근거**: 코드 인용 — `usage-sources.test.mjs:660-669`:
  ```js
  const homes = usageHomes(
    { codexHome: "/explicit/codex" },
    { CLAUDE_CONFIG_DIR: "/env/claude", CODEX_HOME: "/env/codex" },
    // OMT_AGY_HOME 미주입 → 기본값이 os.homedir() 기반
  );
  assert.equal(
    homes.agyHome,
    path.join(os.homedir(), ".gemini", "antigravity-cli"),
  );
  ```
  이 테스트는 `usageHomes(options, env)` 함수에서 `env`에 `OMT_AGY_HOME`이 없을 때 `os.homedir()`를 사용함을 검증한다. 실제 홈 디렉터리를 읽거나 쓰지 않으며, 경로 문자열 일치를 검사한다.
  측정: 해당 없음(경로 비교 문제).
- **판정**: **낮은 우선순위, 검토 필요** — 실제 홈 경로를 읽거나 쓰지 않으므로 데이터 오염 위험은 없음. 단, `agyHome` 기본값이 `os.homedir()` 기반임을 검증하는 테스트가 실제 홈 경로에 의존하는 것은 격리 원칙에 약간 어긋난다. `usage-report.test.mjs:544-560`의 `isolateHomes` 패턴처럼 env를 주입하여 격리할 수 있다.
- **제안 수정**: `usageHomes({ codexHome: "..." }, {})` 대신 `usageHomes({ codexHome: "..." }, { OMT_AGY_HOME: undefined })`와 명시적 env를 사용하고 `os.homedir()` 대신 가짜 homedir를 전달하는 방식으로 격리 강화. 또는 현재 테스트의 의도(기본값 확인)가 충족되므로 허용 가능.
- **예상 작업 크기**: XS (env 격리 추가)
- **회귀 방지 검사**: 기존 테스트 유지.

---

##### TESTS4-04

- **id**: TESTS4-04
- **분류**: checks
- **심각도 가안**: medium
- **파일:줄**: `tests/fake-agent.mjs:62-67`, `tests/headless.test.mjs:208-209`
- **증상**: `fake-agent.mjs`는 Codex 모드에서 `FAKE_CODEX_HOME` 환경변수가 설정되면 `~/.codex/sessions/…` 형식과 동일한 롤아웃 파일을 생성한다(`fake-agent.mjs:62-67`). `headless.test.mjs:208-209`는 이 환경변수를 임시 디렉터리로 설정하고 `t.after`로 삭제하여 올바르게 격리한다. 단, `codexRolloutModel` 공개 함수(`headless.mjs`)의 실제 동작(rollout 파일에서 모델 추출)을 검증하는 `headless.test.mjs:300-450` 범위에 `FAKE_CODEX_HOME`을 사용하지 않는 코드 경로가 있는지 확인이 필요하다. 특히, Codex SLEEP 시나리오에서 rollout 파일이 생성된 상태로 runner가 종료되지 않을 경우 `FAKE_CODEX_HOME` 경로가 정리되지 않을 가능성이 있다.
- **근거**: 코드 인용 — `fake-agent.mjs:60-67`:
  ```js
  const home = process.env.FAKE_CODEX_HOME;
  if (home) {
    const dir = path.join(home, "sessions", "2026", "09", "17");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `rollout-2026-09-17T00-00-00-${id}.jsonl`),
      ...
    );
  }
  ```
  `headless.test.mjs:207-209`:
  ```js
  process.env.FAKE_CODEX_HOME = box.codexHome;
  t.after(() => delete process.env.FAKE_CODEX_HOME);
  ```
  `box.codexHome`은 `sandbox(t)`에서 반환된 임시 디렉터리 하위 경로이고 `t.after(async () => fs.rmSync(dir, ...))`로 정리됨.
  측정: 해당 없음(설계 구조 분석).
- **판정**: **확인(클린업 경로 적절)** — `FAKE_CODEX_HOME`은 임시 디렉터리로 격리되고 `sandbox.t.after`가 디렉터리 전체를 정리한다. 실제 `~/.codex`를 접근하지 않으므로 홈 경로 오염 없음. Codex SLEEP 시나리오에서 runner 미종료 시 F-05와 동일한 Windows 파일 잠금 문제가 발생할 수 있으나 `maxRetries`로 완화. 단, 검사 대상 행동(`codexRolloutModel` 함수)이 실제로 어떤 경로에서 테스트되는지 추가 확인이 필요하다(미확인 의심).
- **제안 수정**: 없음(현재 격리 구조 적절). `codexRolloutModel`의 실제 동작 테스트 커버리지를 `headless.test.mjs`에서 확인 권장.
- **예상 작업 크기**: XS
- **회귀 방지 검사**: `headless.test.mjs`의 Codex 롤아웃 경로 테스트.

---

##### TESTS4-05

- **id**: TESTS4-05
- **분류**: checks
- **심각도 가안**: medium
- **파일:줄**: `tests/workflow-recovery.test.mjs:27-35`
- **증상**: `workflow-recovery.test.mjs`는 `child_process.spawn`으로 Node.js 자식 프로세스를 직접 띄워 파일 잠금을 테스트한다. `t.after(() => child.kill("SIGKILL"))`을 등록하여 정리하고, 실제 테스트 본체에서도 `child.kill("SIGKILL")` 후 `await once(child, "close")`로 종료를 확인한다(`workflow-recovery.test.mjs:39-40`). 이 패턴은 올바르게 설계되어 있다. 단, Windows에서 `SIGKILL`이 `TerminateProcess`로 처리되므로 `Atomics.wait`로 블록된 프로세스가 즉시 종료될 것으로 기대하나, SharedArrayBuffer 기반 블로킹의 종료 동작이 모든 Node.js 버전에서 보장되는지 확인이 필요하다. `engines.node: >=22.13`(cleanup-and-portability.test.mjs:97-100 기준)이 전제됨.
- **근거**: 코드 인용 — `workflow-recovery.test.mjs:27-35`:
  ```js
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { withFileLock } from ${JSON.stringify(module)}; withFileLock(process.argv[1], () =>
      {process.stdout.write('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);});`,
    lock,
  ]);
  t.after(() => child.kill("SIGKILL"));
  ```
  `workflow-recovery.test.mjs:35-40`: `t.after` 클린업과 명시적 `kill + await close`로 이중 보호.
  측정: 해당 없음(설계 구조 분석).
- **판정**: **확인(설계 적절, 주의 필요)** — 파일 잠금 회복 시나리오를 실제 자식 프로세스로 검증하는 적절한 설계. `t.after` 클린업이 있어 테스트 종료 시 자동 정리됨. `Atomics.wait` 기반 블로킹의 Windows 종료 동작은 Node.js >=22.13에서 지원됨(engines 조건 충족).
- **제안 수정**: 없음(현재 구현 적절). Node.js 버전 범위가 변경될 경우 `Atomics.wait` 동작 확인 필요.
- **예상 작업 크기**: XS
- **회귀 방지 검사**: `workflow-recovery.test.mjs` 기존 테스트 유지.

---

##### TESTS4-06

- **id**: TESTS4-06
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `tests/code-quality.test.mjs:172-213`
- **증상**: `code-quality.test.mjs:172-213`은 `help/SKILL.md`의 스킬 목록 표(`<!-- help:start -->` 이후 블록)가 실제로 설치된 스킬 목록과 일치하는지 검사한다. DOCS-08(audit-docs-repo)에서 이 검사의 존재를 확인하지 못해 "미확인 의심"으로 남겼으나, T1 묶음 조사에서 검사가 존재함을 확인했다. 단, 이 테스트가 `plugins/oh-my-teams/skills/help/SKILL.md`를 직접 읽으므로, 스킬 목록이 변경될 때 `help/SKILL.md`와 테스트가 함께 갱신되어야 한다는 의존성이 있다. 검사(`code-quality.test.mjs:216-228`)는 스킬 목록을 스캔하지 말고 그대로 출력하도록(`그대로 출력한다`) 지시하는 내용도 포함된다.
- **근거**: 코드 인용 — `code-quality.test.mjs:172-196`:
  ```js
  test("the help tables list exactly the installed skills", () => {
    const skills = path.resolve("plugins/oh-my-teams/skills");
    const installed = fs.readdirSync(skills)
      .filter((entry) => fs.existsSync(path.join(skills, entry, "SKILL.md")));
    const help = fs.readFileSync(path.join(skills, "help", "SKILL.md"), "utf8");
    const rendered = help.split("<!-- help:start -->")[1];
    // ... listed와 installed 교차 검사
  });
  ```
  DOCS-08의 "미확인 의심" 해소: 검사 존재 확인. `help/SKILL.md:8`의 주석("이 표는 설치된 스킬 목록과 일치하도록 `tests/code-quality.test.mjs`가 검사한다") 내용이 사실임.
  측정: 해당 없음.
- **판정**: **문제 없음** — 검사가 존재하며 정상 동작 중. DOCS-08 의심 해소.
- **제안 수정**: 없음.
- **예상 작업 크기**: 해당 없음
- **회귀 방지 검사**: `tests/code-quality.test.mjs` 기존 테스트 유지.

---

##### TESTS4-07

- **id**: TESTS4-07
- **분류**: checks
- **심각도 가안**: low
- **파일:줄**: `tests/` 전반 — 임시 디렉터리 생성 파일 (31개 중 `mkdtempSync` 사용 파일 23개)
- **증상**: 대부분의 테스트 파일은 `mkdtempSync`로 임시 디렉터리를 생성하고 `t.after(() => fs.rmSync(...))` 또는 `try/finally { fs.rmSync(...) }` 패턴으로 정리한다. 워크트리에 임시 파일을 남기지 않는 설계가 일관되게 적용되어 있다. 단, 1차 npm test 실행이 usage-report 파일 도중에 300초 제한으로 중단되었다(RESULTS.md:8). 이 경우 `t.after` 클린업이 실행되지 않아 `os.tmpdir()` 아래에 임시 디렉터리가 남았을 가능성이 있다. Node.js test runner는 비정상 종료 시 `t.after` 콜백을 보장하지 않는다.
- **근거**: RESULTS.md:8:
  ```
  npm test (1차, --test-concurrency=1) | 300초 제한으로 중단 | 300.4초
  ```
  임시 디렉터리 생성: `code-quality.test.mjs:16`, `dashboard.test.mjs:19`, `delivery.test.mjs:36`, `headless.test.mjs:27`, `kickoff-registry.test.mjs:28`, `lock-recovery-and-release.test.mjs:30`, 등. 모두 `os.tmpdir()` 아래에 생성.
  측정: 미측정(실제 잔여 디렉터리 확인 미수행).
- **판정**: **확인(설계는 적절, 타임아웃 시 클린업 미보장)** — 정상 실행 시 임시 디렉터리 클린업은 올바르게 구현됨. 타임아웃으로 중단될 경우 `os.tmpdir()`에 임시 디렉터리가 남을 수 있으나, OS 임시 디렉터리는 OS가 주기적으로 정리하며 워크트리에는 남지 않음(R17 준수). 실제 잔여 여부는 미측정.
- **제안 수정**: 타임아웃 연장(300초)을 검토하거나, 가장 느린 테스트(deliver 26/21/17초, worker allowance 19초)의 성능 개선을 통해 전체 실행 시간을 줄이는 방안 검토. 또는 테스트 파일 병렬 실행 조정.
- **예상 작업 크기**: S-M (타임아웃 조정 또는 느린 테스트 개선)
- **회귀 방지 검사**: `npm test` 전체 실행 완료(현재 2차 분할 실행 필요).

---

##### TESTS4-08

- **id**: TESTS4-08
- **분류**: checks
- **심각도 가안**: medium
- **파일:줄**: `tests/` — `incidents.mjs`, `usage-ledger.mjs` 직접 테스트 없음
- **증상**: `incidents.mjs`(265줄, B2)는 `boundary-and-gate.test.mjs:17`과 `runtime.test.mjs:69`에서 임포트되어 간접적으로 검사되나, `incidents.mjs`를 직접 대상으로 하는 전용 테스트 파일이 없다. 마찬가지로 `usage-ledger.mjs`(170줄, B5)는 `usage-report.test.mjs:16`에서만 임포트되며, `recordLaunch`·`readLaunches` 등의 핵심 함수를 직접 단위 테스트하는 파일이 없다. 두 모듈 모두 상태를 파일 시스템에 저장하고 읽는 중요 함수들을 갖고 있으며, 발견 후보 F-04(usage-ledger)와 C-M7(incidents.mjs state 크기)가 이들과 관련이 있다.
- **근거**:
  - `tests/` 디렉터리에 `incidents.test.mjs`·`usage-ledger.test.mjs` 없음 (inventory.csv 확인).
  - `incidents.mjs` 관련: `boundary-and-gate.test.mjs:17`에서 `classifyIncident`, `incidentStatus` 임포트. `runtime.test.mjs:69`에서 `incidentStatus` 임포트 및 `:1984`에서 1개 인시던트 상태 검사.
  - `usage-ledger.mjs` 관련: `usage-report.test.mjs:16`에서 `readLaunches`, `ledgerFile`, `recordLaunch` 임포트. F-04 발견 항목의 `recordLaunch` 전체 재읽기 패턴은 `usage-report.test.mjs`에서 간접 검증되지만, ledger 크기·회전 없는 상한 관련 단위 테스트 없음.
  측정: 해당 없음(커버리지 구조 분석).
- **판정**: **확인(커버리지 부분적)** — 두 모듈이 완전히 무커버 상태는 아니지만, 핵심 상태 관리 경로(incidents 상태 변이, ledger append/read 왕복)에 대한 직접 단위 테스트가 없다. F-04 회귀를 방지하는 `usage-ledger.mjs` 단위 테스트 추가가 권장된다.
- **제안 수정**: `tests/usage-ledger.test.mjs`를 추가하여 `recordLaunch`·`readLaunches` 왕복, `resolveLaunchKickoff` 동작을 단위 테스트. `tests/incidents.test.mjs`를 추가하여 `classifyIncident`·`incidentStatus` 상태 변이를 단위 테스트. 또는 기존 파일에 테스트 케이스 추가.
- **예상 작업 크기**: S (단위 테스트 2~3개 추가 × 2 파일)
- **회귀 방지 검사**: 신규 `usage-ledger.test.mjs`·`incidents.test.mjs`.

---

#### 3. 사전 후보 판정표

| 사전 후보 | 판정 | 근거 |
|---|---|---|
| 정적 사전 후보 없음 (T1·T2는 사전 후보 없음) | 해당 없음 | plan.md의 사전 후보(C-M*)는 B1·B2·B5 묶음 대상 |
| **DOCS-08(audit-docs-repo 남은 의심)** | **해소** | `tests/code-quality.test.mjs:172-213`에서 스킬 목록 표 검사 확인 → TESTS4-06 등록 |

---

#### 4. 발견 후보 요약

| id | 분류 | 심각도 | 핵심 |
|---|---|---|---|
| TESTS4-01 | memory | low | fake-agent SLEEP: setInterval 의도적 설계(F-05 해결 시 위험 감소) |
| TESTS4-02 | memory | low | sandbox/tempDir async 클린업: Windows 파일 잠금 대기 고정값(F-05 연동) |
| TESTS4-03 | memory | low | usage-sources 테스트: agyHome 기본값 검증이 실제 os.homedir() 의존 |
| TESTS4-04 | checks | medium | fake-agent Codex FAKE_CODEX_HOME: 격리 적절, codexRolloutModel 커버리지 확인 필요 |
| TESTS4-05 | checks | medium | workflow-recovery: spawn+Atomics.wait 기반 잠금 테스트 — 설계 적절, Windows 종료 동작 주의 |
| TESTS4-06 | checks | low | code-quality 테스트: help 스킬 목록 검사 존재 확인(DOCS-08 해소) |
| TESTS4-07 | checks | low | 타임아웃 중단 시 t.after 클린업 미보장 — OS tmpdir에 잔여 가능성 |
| TESTS4-08 | checks | medium | incidents.mjs·usage-ledger.mjs 직접 단위 테스트 없음 |

medium 3개, low 5개. 합계 8개.
(문제 없음/설계 의도: TESTS4-01·TESTS4-05·TESTS4-06 — 발견 후보이나 조치 불필요)

---

#### 5. 남은 의심

- **TESTS4-04 codexRolloutModel 커버리지**: `headless.test.mjs`에서 `codexRolloutModel` 함수를 직접 호출하여 검증하는 테스트가 있는지, 어느 코드 경로에서 호출되는지 추가 확인 필요(미확인).
- **TESTS4-07 실제 잔여 디렉터리**: 1차 npm test 300초 타임아웃으로 중단된 후 `os.tmpdir()` 아래에 남은 `omt-*` 임시 디렉터리가 있는지 실제 확인 필요(미측정).
- **TESTS4-02 실측**: CI 환경에서 300ms/1500ms 대기가 부족한 경우의 `rmSync` 실패율은 실환경 측정 필요.
- **느린 테스트 원인**: RESULTS.md에서 가장 느린 테스트는 deliver(26초)·worker allowance(19초)·component acceptance(13.7초)·owning checkout(10.1초). 이 중 deliver는 실제 git worktree 생성·commit을 포함하므로 slow가 예상되지만, worker allowance·component acceptance의 소요 원인이 스크립트 복잡도인지 sleep 대기인지 확인 필요(미조사).
