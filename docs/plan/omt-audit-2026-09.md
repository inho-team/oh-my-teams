# omt-audit 2026-09 보고서

- 작성일: 2026-09-18
- 상태: 초안 (audit-runtime-io 묶음 완료, 다른 묶음 미완)
- 대상: plugins/oh-my-teams/scripts (B1·B5 묶음)
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
