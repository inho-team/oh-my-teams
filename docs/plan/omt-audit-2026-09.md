# OMT 전수 조사 보고서 2026-09

- 작성일: 2026-09-18
- 상태: 완료 (audit-runtime-io·audit-state·audit-launch·audit-docs-repo·audit-tests 묶음 전체 조사 완료)
- 대상: `plugins/oh-my-teams/scripts` (B1~B5 묶음), `plugins/oh-my-teams/references`, `plugins/oh-my-teams/skills`, `plugins/orca/scripts`, `scripts`, `evals`, `tests` (B6·B7·T1·T2 묶음)
- 관련 문서: `docs/plan/headless-runtime.md`, `docs/plan/ai-native-agent-organization.md`
- 조사 작업 파일은 PM 워크트리의 로컬 상태(.omt/, git 추적 제외)에 있다.

---

## 결론

**메모리 high 3건·medium 4건·low 1건, 아키텍처 medium 1건·low 3건, checks medium 1건·low 13건으로 발견 항목 합계 26건이며, 다음 kickoff에서 F-01·F-02·F-03·F-05·STATE-02 순서로 수정을 시작할 것을 권고한다.**

가장 중요한 발견 다섯 가지는 다음과 같다.

1. **F-01·F-02** (memory/high): `headless.mjs`가 폴링마다 Codex sessions 트리를 전체 재귀 탐색하고(F-01), stream.jsonl 전체를 반복 읽는다(F-02). 대시보드 2.5초 폴링 기준 RSS가 지속적으로 압박을 받는다.
2. **F-03** (memory/high): `usage-sources.mjs`의 `eachJsonLine`이 파일 전체를 메모리에 올린다. 모듈 주석과 구현이 불일치하며, 50MB 입력에서 RSS 84MB 증가를 측정했다.
3. **STATE-02** (memory/medium): `core.mjs`의 `run()` 함수에서 overflow 발생 시 timeout 경로와 달리 fallback 타이머가 없어, Windows에서 자식 프로세스 트리가 `close`를 보내지 않으면 `timeoutMs`(기본 300초)까지 대기할 수 있다.
4. **CLOSE-01** (architecture/medium): `close` 절차가 kickoff 브랜치(원격·로컬·하위 워크트리 브랜치)를 삭제하지 않아 kickoff마다 브랜치가 누적된다. `close/SKILL.md`의 회수·정리 절(6단계)에 브랜치 삭제 단계가 없다.
5. **DOCS-02** (checks/low): R13~R15·R17 규칙(Orca 재구현 금지, 어댑터 경유, 스킬 중복, 임시 산출물)이 `AGENTS.md`·`CODE_QUALITY.md` 정본 문서에 없다.

다음 kickoff에서 위 5개 항목을 우선 수정하고, checks/high 부재와 F-05(Windows 프로세스 트리) 실측을 병행할 것을 권고한다.

---

## 심각도 기준

| 심각도 | 판단 기준 |
|---|---|
| **high** | 측정으로 확인된 RSS 증가가 크고(50MB 이상), 폴링·반복 호출로 압박이 지속되거나, 프로세스가 무기한 블록될 수 있는 경로 |
| **medium** | 측정 또는 코드 구조 분석으로 확인된 자원 증가·진단 불능이지만, 실제 영향이 특정 시나리오(대용량 입력, 장기 실행, Windows 환경)에 한정되거나 실측이 부분적인 경우 |
| **low** | 근거가 확인됐으나 현재 규모에서 영향이 미미하거나, 진단성·문서 정확성 문제로 기능 결함은 없는 경우 |

---

## 조사 범위

### 대상 파일과 조사 상태

`legacy/`(git 추적 27개)와 `node_modules/`는 제외한다.

**브리프와 실제 저장소의 차이**: 브리프는 `scripts/**/*.mjs` 45개·약 14,300줄로 적었으나, 기준 커밋(4d1d7d6) 기준 `.mjs` 파일은 41개·15,166줄(+`dashboard.html` 294줄)이다.

| 파일 | 묶음 | 조사 상태 |
|---|---|---|
| `evals/organization/run.mjs` | B6 | 조사함 |
| `evals/organization/scenarios.json` | B6 | 조사함 |
| `plugins/oh-my-teams/references/assist.md` | B7 | 조사함 |
| `plugins/oh-my-teams/references/bluf.md` | B7 | 조사함 |
| `plugins/oh-my-teams/references/kickoff-registry.md` | B7 | 조사함 |
| `plugins/oh-my-teams/references/korean-result-reporting.md` | B7 | 조사함 |
| `plugins/oh-my-teams/references/minimal-change.md` | B7 | 조사함 |
| `plugins/oh-my-teams/references/orca-runtime.md` | B7 | 조사함 |
| `plugins/oh-my-teams/references/user-choice.md` | B7 | 조사함 |
| `plugins/oh-my-teams/scripts/adapters.mjs` | B3a | 조사함 |
| `plugins/oh-my-teams/scripts/contracts.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/core.mjs` | B4a | 조사함 |
| `plugins/oh-my-teams/scripts/dashboard.html` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/dashboard.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/delivery.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/evidence.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/execution.mjs` | B3a | 조사함 |
| `plugins/oh-my-teams/scripts/failures.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/gates.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/headless-runner.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/headless.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/host-defaults.mjs` | B3b | 조사함 |
| `plugins/oh-my-teams/scripts/incidents.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/kickoff-registry.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/launch-matrix.mjs` | B3b | 조사함 |
| `plugins/oh-my-teams/scripts/lessons.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/local-adapter.mjs` | B3a | 조사함 |
| `plugins/oh-my-teams/scripts/orca-adapter.mjs` | B3a | 조사함 |
| `plugins/oh-my-teams/scripts/org-draft.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/presets.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/providers.mjs` | B5 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/agy.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/claude.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/codex.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/http.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/index.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/ollama.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/providers/shared.mjs` | B1 | 조사함 |
| `plugins/oh-my-teams/scripts/quota.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/role-launch.mjs` | B3b | 조사함 |
| `plugins/oh-my-teams/scripts/role-terminal.mjs` | B3b | 조사함 |
| `plugins/oh-my-teams/scripts/status.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/scripts/teams-org.mjs` | B4a | 조사함 |
| `plugins/oh-my-teams/scripts/usage-ledger.mjs` | B5 | 조사함 |
| `plugins/oh-my-teams/scripts/usage-report.mjs` | B5 | 조사함 |
| `plugins/oh-my-teams/scripts/usage-sources.mjs` | B5 | 조사함 |
| `plugins/oh-my-teams/scripts/usage.mjs` | B5 | 조사함 |
| `plugins/oh-my-teams/scripts/worker.mjs` | B3a | 조사함 |
| `plugins/oh-my-teams/scripts/workflow-store.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/workflow.mjs` | B2 | 조사함 |
| `plugins/oh-my-teams/scripts/workspace.mjs` | B4b | 조사함 |
| `plugins/oh-my-teams/skills/adjust/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/close/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/disband/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/fluent-korean/LICENSE` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/fluent-korean/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/form/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/help/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/intern/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/junior/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/kickoff/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/pl/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/pm/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/senior/SKILL.md` | B7 | 조사함 |
| `plugins/oh-my-teams/skills/status/SKILL.md` | B7 | 조사함 |
| `plugins/orca/scripts/orca-org.mjs` | B6 | 조사함 |
| `scripts/check-code-quality.mjs` | B6 | 조사함 |
| `scripts/install.mjs` | B6 | 조사함 |
| `scripts/metadata.mjs` | B6 | 조사함 |
| `tests/agy-start.test.mjs` | T1 | 조사함 |
| `tests/boundary-and-gate.test.mjs` | T1 | 조사함 |
| `tests/cleanup-and-portability.test.mjs` | T1 | 조사함 |
| `tests/cli-integration.test.mjs` | T1 | 조사함 |
| `tests/code-quality.test.mjs` | T1 | 조사함 |
| `tests/dashboard.test.mjs` | T1 | 조사함 |
| `tests/delivery.test.mjs` | T1 | 조사함 |
| `tests/execution-port.test.mjs` | T2 | 조사함 |
| `tests/fake-agent.mjs` | T1 | 조사함 |
| `tests/headless.test.mjs` | T2 | 조사함 |
| `tests/kickoff-registry.test.mjs` | T1 | 조사함 |
| `tests/launch-matrix.test.mjs` | T2 | 조사함 |
| `tests/lock-recovery-and-release.test.mjs` | T1 | 조사함 |
| `tests/org-draft.test.mjs` | T1 | 조사함 |
| `tests/provider-adapters.test.mjs` | T1 | 조사함 |
| `tests/reduced-organization.test.mjs` | T1 | 조사함 |
| `tests/removed-skills.mjs` | T1 | 조사함 |
| `tests/repository-metadata.test.mjs` | T1 | 조사함 |
| `tests/review-format.test.mjs` | T1 | 조사함 |
| `tests/role-dispatch.test.mjs` | T2 | 조사함 |
| `tests/role-terminal.test.mjs` | T2 | 조사함 |
| `tests/run-depth.test.mjs` | T1 | 조사함 |
| `tests/runtime.test.mjs` | T2 | 조사함 |
| `tests/safety-net.test.mjs` | T2 | 조사함 |
| `tests/silent-wrong-results.test.mjs` | T1 | 조사함 |
| `tests/skill-instructions.test.mjs` | T2 | 조사함 |
| `tests/supervision.test.mjs` | T1 | 조사함 |
| `tests/usage-report.test.mjs` | T2 | 조사함 |
| `tests/usage-sources.test.mjs` | T2 | 조사함 |
| `tests/workflow-recovery.test.mjs` | T1 | 조사함 |
| `tests/workflow-safety.test.mjs` | T2 | 조사함 |

100개 파일 전부 조사함. 누락 없음.

---

## 검사 결과

기준 커밋: HEAD `4d1d7d6` (2026-09-18). 검사는 직렬(순차)로 실행했다. `npm test`는 300초 제한으로 1차 실행이 26번째 파일(usage-report) 도중에 중단되어 두 번에 나눠 실행했다. 직렬 테스트 전체 소요는 약 376초 이상이다.

| 검사 | 결과 | 소요 | 여유 메모리 전→후 | 비고 |
|---|---|---:|---|---|
| `npm run lint` | 통과 | 11.2초 | 813→650MB | quality+format:check 포함 |
| `npm run quality` | 통과 | 2.6초 | 789→941MB | 89 파일, export 275/275, @param 태그 235, @returns 237, @throws 134, findings 0 |
| `npm run format:check` | 통과 | 8.2초 | 888→698MB | Prettier 3.9.6. 대상은 .mjs/.json뿐이다(dashboard.html·.md 제외) |
| `npm test` (1차, `--test-concurrency=1`) | 300초 제한으로 중단 | 300.4초 | 708→1192MB | 파일 1~25 통과(최상위 테스트 341개 통과, 실패 없음). 26번 usage-report 실행 도중 종료됨 |
| `npm test` (2차, 파일 26~29) | 통과 | 75.8초 | 638→297MB | 23/23 통과. 종료 후 여유 메모리 400MB 미만으로 중단 |
| `npm run eval:organization` | 통과 | 54.0초 | 335→786MB | 증거 10건 모두 통과(합계 51.7초). 결정적 로컬 fixture이며 모델 품질은 검증하지 않는다 |
| `npm run sync:check` | 통과 | 3.5초 | 746→637MB | mismatches 0 |

가장 느린 테스트: deliver 3건(26.0/21.8/17.9초), worker allowance 19.8초, component acceptance 13.7초, owning checkout 10.1초. 경고 문구(Warning/Deprecation): 발견하지 못했다.

---

## 발견 목록

### 요약표

| id | 분류 | 심각도 | 파일:줄 | 핵심 |
|---|---|---|---|---|
| F-01 | memory | high | `headless.mjs:213-238` | codexRolloutModel: sessions 트리 폴링마다 전체 재귀 탐색 |
| F-02 | memory | high | `headless.mjs:613-616, 688-691, 768-784` | headlessStatus/Detail: stream.jsonl 전체 읽기 반복 |
| F-03 | memory | high | `usage-sources.mjs:186-206` | eachJsonLine: readFileSync 전체 읽기 + split 전 파일 보유 |
| F-04 | memory | medium | `usage-ledger.mjs:138-169` | recordLaunch: ledger 전체 재읽기(상한 없음) |
| F-05 | memory | medium | `headless-runner.mjs:53-58`, `headless.mjs:532-538` | headless-runner: Windows 손자 프로세스 정리 미보장 |
| F-06 | checks | low | `usage-sources.mjs:183-185` | eachJsonLine 주석과 구현 불일치 |
| F-07 | architecture | low | `headless.mjs:532-538`, `headless-runner.mjs` 전체 | headless 프로세스 직접 관리와 원칙 8의 충돌 여부 |
| STATE-01 | memory | medium | `workflow-store.mjs:89, 101, 118` | eventIds: includes O(n) 탐색 + state 전체 직렬화(상한 없음) |
| STATE-02 | memory | medium | `core.mjs:537-557` | run() overflow 후 fallback 타이머 없음 |
| STATE-03 | checks | low | `gates.mjs:181, 255` | reviews/decisions 디렉터리 전체 스캔(측정 미완) |
| STATE-04 | checks | low | `teams-org.mjs:570-572, 1011-1013` | predictLaunchPath 예외 무음 삼킴 2개소 |
| STATE-05 | checks | low | `workflow.mjs:44` | validateWorkflowRequest 외부 미사용 export |
| LAUNCH-01 | memory | low | `role-terminal.mjs:588-595, 539-545` | pollMs 간격 orca terminal read 외부 프로세스 반복(최대 70회/launch) |
| LAUNCH-02 | architecture | low | `role-terminal.mjs:24` | runOrcaJson 직접 import — 어댑터 경유 규칙 근거 미확인 |
| CLOSE-01 | architecture | medium | `plugins/oh-my-teams/skills/close/SKILL.md:42-44` | close 절차에 kickoff 브랜치(원격·로컬·하위 워크트리) 삭제 단계 없음 |
| DOCS-01 | checks | low | `AGENTS.md:13` | 버전 정책 `1.x.x` — 현재 2.4.1과 불일치 |
| DOCS-02 | checks | low | `ai-native-agent-organization.md:53` vs `AGENTS.md`, `CODE_QUALITY.md` | R13~R15·R17 규칙이 정본 문서에 없음 |
| DOCS-03 | checks | low | `ai-native-agent-organization.md:53` vs `headless-runtime.md:7-16` | 원칙 8과 headless 설계 목표 충돌: 예외 조항 미선언 |
| DOCS-04 | checks | low | `scripts/check-code-quality.mjs:8-16` | 비공개 함수 문서화 사각지대(evals/run.mjs) |
| DOCS-05 | checks | low | `scripts/metadata.mjs:37-45` | declaredTestCount: 테스트 파일 전체 읽기(현재 규모 허용 범위) |
| DOCS-06 | architecture | low | `plugins/orca/scripts/orca-org.mjs:1-12` | pre-1.1 호환 파일, 제거 여부 미확인 |
| DOCS-07 | checks | low | `references/assist.md:11` | 보조 도구 허용 모델 ID 런타임 로직 중복 선언 |
| DOCS-09 | checks | low | `skills/form/SKILL.md:24-28` | 모델 선택지 자동 동기화 없음 |
| TESTS4-07 | checks | low | `tests/` 전반 | 타임아웃 중단 시 t.after 클린업 미보장 |
| TESTS4-08 | checks | low | `tests/` — `incidents.mjs`, `usage-ledger.mjs` 직접 단위 테스트 없음 | 핵심 상태 관리 경로 단위 테스트 부재 |
| CHECKS-INT-01 | checks | medium | `tests/headless.test.mjs:564`, `tests/headless.test.mjs:28-37` | 병렬 npm test 시 Windows 11에서 t.after rmSync EPERM — integration gate 통과 실패 |

**합계**: memory high 3건, memory medium 4건, memory low 1건 / architecture medium 1건(CLOSE-01), architecture low 3건 / checks medium 1건(CHECKS-INT-01), checks low 13건. 총 26건.

### 상세 항목

---

#### F-01

- **id**: F-01
- **분류**: memory
- **심각도**: high (초안 가안 high 유지 — 측정으로 확인된 선형 비용 증가와 폴링 경로의 지속성이 기준에 부합함)
- **파일:줄**: `plugins/oh-my-teams/scripts/headless.mjs:213-238`
- **증상**: `codexRolloutModel`이 `~/.codex/sessions` 트리를 매 호출마다 재귀적으로 전체 탐색하며 Codex 세션 rollout 파일을 찾는다. 호출 경로는 `headlessStatus`(668줄) ← `waitHeadless` 1초 폴링(801-807줄), 대시보드 목록 4초 폴링(`dashboard.html:182`), 상세 2.5초 폴링(`dashboard.html:281`)이다. 세션 파일이 쌓일수록 폴링 1회의 비용이 선형 증가한다.
- **근거**: 코드 인용 — `headless.mjs:218-237`:
  ```js
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) {
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
- **제안 수정**: threadId를 캐시 키로 세션 결과를 프로세스 수명 동안 메모이즈하거나, Codex rollout 파일에 예측 가능한 경로 규칙이 있다면 직접 경로로 접근하도록 변경한다.
- **예상 작업 크기**: S (캐시 Map 추가 + 테스트 보완)
- **회귀 방지 검사**: `headless.test.mjs`의 Codex 경로 테스트. 캐시 무효화 시나리오 추가 필요.

---

#### F-02

- **id**: F-02
- **분류**: memory
- **심각도**: high (초안 가안 high 유지 — 50MB 스트림에서 RSS 208MB 증가 측정, 2.5초 폴링 기준 지속성 확인)
- **파일:줄**: `plugins/oh-my-teams/scripts/headless.mjs:613-616, 688-691, 768-784`
- **증상**: `readTurn`, `headlessStatus`, `headlessDetail` 모두 `stream.jsonl` 파일 전체를 `readFileSync`로 읽은 뒤 `split(/\r?\n/)`으로 모든 줄 배열을 만들고 `JSON.parse`한다. Codex의 경우 session이 없으면 `headlessStatus`(695-703줄)는 이전 턴 스트림도 전부 읽는다. `headlessDetail`(768-784줄)은 모든 턴의 stream·stderr·prompt를 읽은 뒤 잘라낸다.
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
  `headless.mjs:688-691`:
  ```js
  const streamFile = path.join(turnDir, "stream.jsonl");
  const stream = readHeadlessStream(
    worker.provider,
    fs.existsSync(streamFile) ? fs.readFileSync(streamFile, "utf8") : "",
  ```
  측정 결과 (stream.jsonl 1회 readFileSync+split+parse, 단순 assistant JSON 이벤트 줄 약 250B):

  | 크기(MB) | 줄 수 | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 1.0 | 4,178 | 13.3 | 52.0 | 55.4 | 3.4 |
  | 10.0 | 41,776 | 63.6 | 74.1 | 112.8 | 38.7 |
  | 50.0 | 208,880 | 435.2 | 183.0 | 390.8 | 207.8 |

  스크립트 요지: 약 250B 이벤트 줄을 목표 크기까지 쓴 파일을 `readFileSync`→`split`→`JSON.parse`로 처리. 10MB에서 RSS 39MB 증가, 50MB에서 208MB 증가. 대시보드 2.5초 폴링이면 RSS 압박이 지속된다.
- **제안 수정**: `headlessStatus`는 마지막 몇 줄(역순 탐색 또는 tail)만 읽어 result/marker를 추출하도록 파싱 방식을 변경한다. 전체 transcript가 필요한 `headlessDetail`은 사용자 요청 시에만 호출하도록 유지하되, 폴링 경로(`listHeadless`, `headlessStatus`)에서 transcript 전체 파싱을 분리한다.
- **예상 작업 크기**: M (파싱 경로 분리 + 회귀 테스트)
- **회귀 방지 검사**: `headless.test.mjs`의 status/detail 경로. 큰 스트림 fixture 추가 필요.

---

#### F-03

- **id**: F-03
- **분류**: memory
- **심각도**: high (초안 가안 high 유지 — 50MB에서 RSS 84MB 증가 측정, 주석과 구현 불일치)
- **파일:줄**: `plugins/oh-my-teams/scripts/usage-sources.mjs:186-206`
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
  주석(183-185): "Entries are visited one at a time and dropped, so a long transcript's message text is never held beyond the line being read." — 실제로는 `text` 변수에 파일 전체가 남아 있다. `split` 결과도 전체 줄 배열이다.

  측정 결과 (10/50MB JSONL, 약 200B/줄):

  | 크기(MB) | 줄 수 | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 10.0 | 54,614 | 75.3 | 74.8 | 99.7 | 24.9 |
  | 50.0 | 273,067 | 430.9 | 149.2 | 233.6 | 84.4 |

  스크립트 요지: 약 200B 줄을 목표 크기까지 쓴 파일에서 eachJsonLine 시뮬레이션. 50MB에서 RSS 84MB 증가. 100MB 측정은 메모리 부족 위험으로 50MB로 제한함.
- **제안 수정**: `readline`의 줄별 읽기 스트림(`createReadStream + createInterface`)으로 교체하여 전체 파일을 메모리에 올리지 않도록 변경한다. 주석("한 줄 이상 메시지를 붙잡지 않는다")도 구현에 맞게 수정하거나, 구현을 주석에 맞게 변경한다.
- **예상 작업 크기**: S-M (스트림 읽기 전환 + 비동기 콜백 체인 조정 필요 여부 확인)
- **회귀 방지 검사**: `usage-sources.test.mjs`. 큰 파일 fixture 또는 청크 읽기 검증 추가 필요.

---

#### F-04

- **id**: F-04
- **분류**: memory
- **심각도**: medium (초안 가안 medium 유지 — 10k 이하에서 15ms 미만으로 허용 범위이나 상한 없음)
- **파일:줄**: `plugins/oh-my-teams/scripts/usage-ledger.mjs:138-169`
- **증상**: `recordLaunch`는 한 줄을 append하기 전에 ledger 전체를 `readLaunches`(47-61줄)로 읽고 파싱한다(`resolveLaunchKickoff` 계산용). ledger에는 회전이나 상한이 없으므로 장기 운영 시 매 launch마다 비용이 선형 증가한다.
- **근거**: 코드 인용 — `usage-ledger.mjs:158-165`:
  ```js
  kickoffPmWorktreeId: resolveLaunchKickoff(
    kickoffs,
    readLaunches(orgFile),  // ledger 전체 재읽기
    { stateDir: ..., callerCwd },
  ),
  ```
  측정 결과 (readLaunches 1회 기준, 약 200B/줄):

  | 줄 수 | ledger 크기(MB) | 시간(ms) | RSS 전(MB) | RSS 후(MB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 1,000 | 0.2 | 5.8 | 50.4 | 51.0 | 0.7 |
  | 10,000 | 2.1 | 15.2 | 56.5 | 60.0 | 3.6 |
  | 100,000 | 20.6 | 151.4 | 101.5 | 152.5 | 51.0 |

  스크립트 요지: ledger 파일에 n줄을 쓰고 readLaunches 1회 시간·RSS를 측정. 100k줄(약 21MB)에서 151ms 및 51MB 증가. 단, 실제 사용에서 100k 줄은 극단적 시나리오이며, 10k 이하에서는 15ms 이하로 허용 범위이다.
- **제안 수정**: `resolveLaunchKickoff`를 위해 ledger 전체를 읽지 않고, `findLast` 대신 최근 N개(예: 1,000줄)만 역방향 읽기로 처리하거나, kickoff-ID 기준 인덱스 파일을 별도로 유지한다.
- **예상 작업 크기**: S (역방향 탐색 제한 추가)
- **회귀 방지 검사**: `usage-ledger.mjs` 관련 테스트. `resolveLaunchKickoff` 단위 테스트 추가 필요.

---

#### F-05

- **id**: F-05
- **분류**: memory
- **심각도**: medium (초안 가안 medium 유지 — 실측 미완이나 코드 구조상 위험이 타당하고, F-05와 STATE-02가 동일 근본 원인을 공유함)
- **파일:줄**: `plugins/oh-my-teams/scripts/headless-runner.mjs:53-58`, `plugins/oh-my-teams/scripts/headless.mjs:532-538`
- **증상**: runner는 detached 프로세스로 spawn된다(`headless.mjs:532-538`). `stopChild`는 `child.kill()`을 호출하고 5초 뒤 `SIGKILL`을 예약한다(`headless-runner.mjs:53-58`). Windows에서 `child.kill()`(내부적으로 `TerminateProcess`)는 직접 자식은 끝내지만 손자 프로세스(예: 자식이 생성한 셸 또는 서브프로세스)는 끝내지 않을 수 있다. `stop.request` 파일 폴링은 `POLL_MS=500ms`마다 실행되며(`headless-runner.mjs:59-65`), 이는 정지 경로의 의도적 설계이지만 손자 프로세스 정리를 보장하지 않는다.
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
    cwd: worker.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runner.unref();
  ```
  `headless-runtime.md:9-10`: "stopping by file rather than by signal works the same on Windows, where a signal from another process terminates the runner before it can stop its child." — 파일 기반 중단이 Windows에서 runner 자신의 생존을 보호하지만, child의 하위 프로세스 정리는 설명하지 않는다.
  측정: 미측정 (실제 프로세스 트리 확인은 Windows 실환경 필요).
- **제안 수정**: Windows에서 프로세스 트리 전체를 끝내려면 `taskkill /T /F /PID <pid>` 또는 Job Object를 사용한다. `headless-runner.mjs`에 플랫폼별 killTree 유틸리티 추가를 검토한다.
- **예상 작업 크기**: M (플랫폼별 kill 로직 추가 + Windows 실환경 검증)
- **회귀 방지 검사**: `headless.test.mjs`의 stop 경로. Windows 손자 프로세스 잔존 여부 확인 검사 추가.
- **수정 완료** (task fix-process-tree-stop): `killTree(pid, signal)` 헬퍼 추가 — Windows: `taskkill /T /F /PID`로 손자까지 종료, POSIX: `process.kill(-pid, signal)`로 프로세스 그룹 전체 신호. `stopChild`가 `child.kill()` 대신 `killTree`를 사용하며, 종료 실패 메시지를 `killError`로 exit.json에 기록해 조용히 삼키지 않음. 자식을 `detached: true`(POSIX만)로 spawn해 독립 프로세스 그룹 형성. Windows 손자 프로세스 실측: Windows 실환경 없어 코드 경로(taskkill /T) + 공개 CI(PR #67 Windows 러너 EBUSY 재현)로 근거 삼음. 테스트: `tests/headless.test.mjs` — "F-05: killTree — POSIX에서 실제 자식 프로세스를 종료하고 killError가 null이다" 외 2개.


---

#### F-06

- **id**: F-06
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — F-03과 동일 코드 경로이며 독립 항목으로 분리 유지)
- **파일:줄**: `plugins/oh-my-teams/scripts/usage-sources.mjs:183-185`
- **증상**: 주석 "Entries are visited one at a time and dropped, so a long transcript's message text is never held beyond the line being read."이 구현 사실과 다르다. `readFileSync`로 전체 파일을 읽으면 `text` 변수에 파일 전체가 메모리에 남고, `split` 결과도 전체 줄 배열이다.
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
  F-03 측정에서 50MB 파일에 84MB RSS 증가로 확인됨.
- **제안 수정**: 주석을 현재 구현("전체 파일을 읽고 줄 단위로 방문한다")에 맞게 수정하거나, 구현을 스트림 읽기로 변경 후 주석을 유지한다.
- **예상 작업 크기**: XS (주석 수정만) 또는 S-M (구현 변경 포함, F-03과 동일)
- **회귀 방지 검사**: F-03과 동일.

---

#### F-07

- **id**: F-07
- **분류**: architecture
- **심각도**: low (senior 검토 반영 — 아키텍처 원칙 문서 충돌로 기능 결함이 없는 경우에 해당하여 low로 조정)
- **파일:줄**: `plugins/oh-my-teams/scripts/headless.mjs:532-538`, `plugins/oh-my-teams/scripts/headless-runner.mjs` 전체
- **증상**: headless 경로가 프로세스 소유·중단·회수를 직접 수행한다. `docs/plan/ai-native-agent-organization.md:53` 원칙 8("Orca의 감독 기능을 재구현하지 않는다. 프로세스·회수는 Orca를 사용한다")과 구조적으로 충돌하는 후보다.
- **근거**: `ai-native-agent-organization.md:53`: "Orca의 감독 기능을 재구현하지 않는다. 스킬 패키지는 업무 계약과 gate를 담당하고, 실행 소유권·프로세스·회수는 Orca를 사용한다."
  반론: `docs/plan/headless-runtime.md:7-16`은 "Orca를 대체하는 감독 런타임"을 명시적 설계 목표로 선언하며 이를 "Orca 없는 실행, 2단계"로 표제한다. 표 11-15줄에서 Orca 기능별 대응을 명시적으로 나열하고 있다. 따라서 `headless-runtime.md`가 원칙 8의 예외 선언에 해당하는지 여부가 판정 기준이다.
  B7 조사에서 `ai-native-agent-organization.md` 전체에 headless 예외 조항이 없음을 직접 확인했다. 측정: 해당 없음.
- **판정**: 보완 필요 — `headless-runtime.md`가 설계 예외를 선언하고 있으나, `ai-native-agent-organization.md`(정본 설계 원칙)에 이 예외가 명시되지 않았다. Senior/PM의 판단이 필요하다.
- **제안 수정**: `ai-native-agent-organization.md:53`에 headless 런타임에 대한 예외 조항을 추가하거나, 두 문서 간 관계를 명확히 기술한다.
- **예상 작업 크기**: XS (문서 보완)
- **회귀 방지 검사**: `skill-instructions.test.mjs` 또는 문서 일관성 검사.

---

#### STATE-01

- **id**: STATE-01
- **분류**: memory
- **심각도**: medium (초안 가안 medium 유지 — 10k 이하에서 3ms 미만으로 허용 범위이나 구조적 O(n) 탐색)
- **파일:줄**: `plugins/oh-my-teams/scripts/workflow-store.mjs:89, 101, 118`
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
  측정 결과 (eventIds 크기별 includes 1회 + JSON.stringify 1회):

  | eventIds 수 | includes(ms) | 직렬화(ms) | 합계(ms) | payload(KB) | RSS 증가(MB) |
  |---|---|---|---|---|---|
  | 1,000 | 0 | 1 | 1 | 24 | 0 |
  | 10,000 | 0 | 3 | 3 | 235 | 1 |
  | 100,000 | 1 | 34 | 35 | 2,344 | 5 |

  스크립트 요지: 길이 n의 eventIds 배열을 생성하고 미존재 키에 대한 includes 1회 + JSON.stringify 1회 측정. 100k 이벤트에서 35ms, payload 2.3MB. 단일 workflow에서 100k 이벤트는 극단적 시나리오(예: 1만 태스크 × 10이벤트/태스크)이며, 10k 이하에서는 3ms 미만으로 허용 범위이다.
- **제안 수정**: `eventIds`를 `Set<string>`으로 교체하여 includes를 O(1)로 줄인다. JSON 직렬화 시 `Array.from(eventIds)`로 변환하거나 state 저장 직전에 배열로 바꾼다. 기존 `state.json`의 배열 형식을 로드할 때 Set으로 변환하는 마이그레이션 처리가 필요하다.
- **예상 작업 크기**: S (Set 교체 + 직렬화 호환성 확인)
- **회귀 방지 검사**: `workflow.test.mjs`의 이벤트 중복 방지 테스트. 기존 배열 state.json을 로드·저장하는 왕복 테스트 추가 필요.
- **수정**: `workflow-store.mjs`에 `eventIdSets` WeakMap을 추가해 `appendWorkflowEvent` 최초 호출 시 Set 캐시를 구성한다. `state.eventIds`는 배열로 유지해 직렬화·외부 코드 호환을 보장한다. 왕복 테스트와 Set 캐시 동작 테스트를 `tests/workflow-recovery.test.mjs`에 추가했다. 커밋: `009b2aa` (브랜치: `dev-inho/audit-w1-eventids`).

---

#### STATE-02

- **id**: STATE-02
- **분류**: memory
- **심각도**: medium (초안 가안 medium 유지 — overflow 후 fallback 타이머 누락이 코드에서 확인됨)
- **파일:줄**: `plugins/oh-my-teams/scripts/core.mjs:537-557`
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
  주석 `core.mjs:540`: "Some process trees never deliver `close`" — timeout 경로에는 fallback이 있으나 overflow 경로에는 없다.

  측정 결과 (Buffer.byteLength 재계산 비용, 8MB 출력 시뮬레이션):

  | chunk 크기 | 목표 | 재계산 횟수 | 경과(ms) | RSS 증가(MB) |
  |---|---|---|---|---|
  | 64KB | 8MB | 128 | 786 | 64 |
  | 16KB | 8MB | 512 | 2,753 | 68 |
  | 4KB | 8MB | 2,048 | 10,347 | 56 |

  overflow 후 close 미착신 시 대기: 미측정(Windows 실환경 필요).
- **제안 수정**: overflow 시에도 `fallbackTimer = setTimeout(() => finish(-1), 1000)`을 추가하여 timeout과 대칭적으로 처리한다. `Buffer.byteLength` 재계산은 현재 길이를 별도 `totalBytes` 변수로 추적하면 O(1)로 줄일 수 있다.
- **예상 작업 크기**: S (fallback 타이머 추가 + byteLength 카운터 변수 추가)
- **회귀 방지 검사**: `core.mjs` 관련 `run` 테스트. overflow 후 close 미착신 시나리오(Windows 프로세스 트리) 추가 필요.
- **수정 완료** (task fix-process-tree-stop): `totalBytes` 추적 변수 추가로 매 chunk마다 `Buffer.byteLength` 재계산 제거. overflow 후 `fallbackTimer = setTimeout(() => finish(-1), 1000)` 추가로 timeout 경로와 대칭화. 잘라내기 이후 `totalBytes`를 실제 byteLength로 재계산해 정확도 유지. 테스트: `tests/execution-port.test.mjs` — "STATE-02: run() overflow 후 close 없이도 fallback 타이머가 resolve한다", "STATE-02: run() overflow 후 stdout/stderr 잘라내기 길이가 정확하다". Windows close 미착신 시나리오는 Windows 실환경 없어 코드 경로로만 확인.


---

#### STATE-03

- **id**: STATE-03
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 측정 미완이며 수십~수백 개가 상한일 가능성이 높아 실제 영향이 낮을 것으로 추정)
- **파일:줄**: `plugins/oh-my-teams/scripts/gates.mjs:181, 255`
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
  측정: 미측정(리뷰·결정 파일 수는 workflow 규모에 의존하며, 수십~수백 개가 상한일 가능성이 높아 실제 영향은 낮을 것으로 추정함).
- **제안 수정**: `reviews/<taskId>/` 하위 구조로 분리하거나, task-keyed 인덱스 파일을 두어 전체 스캔을 줄이는 방안을 검토한다. 현재 규모에서 문제가 없다면 허용 가능하다.
- **예상 작업 크기**: S-M (디렉터리 구조 변경 시 마이그레이션 포함)
- **회귀 방지 검사**: `gates.test.mjs`의 리뷰 로드 테스트. 리뷰 파일 수 증가 시 로드 시간 측정 추가 필요.

---

#### STATE-04

- **id**: STATE-04
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 기능상 문제는 없으나 진단성 저하)
- **파일:줄**: `plugins/oh-my-teams/scripts/teams-org.mjs:570-572, 1011-1013`
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
- **제안 수정**: `catch (error)`로 받아 `process.stderr.write` 또는 구조화된 경고 출력을 추가하거나, 결과 객체에 `matrixPredictionError: error.message`를 포함하여 호출자가 판단할 수 있게 한다.
- **예상 작업 크기**: XS (catch 블록에 경고 출력 1줄 추가 × 2개소)
- **회귀 방지 검사**: `predictLaunchPath` 실패 시 stderr 출력 확인 테스트.

---

#### STATE-05

- **id**: STATE-05
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 기능상 문제는 없으나 의도하지 않은 공개 API)
- **파일:줄**: `plugins/oh-my-teams/scripts/workflow.mjs:44`
- **증상**: `validateWorkflowRequest`가 `export`로 공개되어 있으나, 모듈 내부 `createWorkflow`(`workflow.mjs:234`)에서만 호출되고 외부 파일에서 import하지 않는다. 의도하지 않은 공개 API가 유지보수 범위를 모호하게 만들 수 있다.
- **근거**: `grep "validateWorkflowRequest" scripts/*.mjs` 결과:
  ```
  workflow.mjs:44: export function validateWorkflowRequest(...)
  workflow.mjs:234: validateWorkflowRequest(request);
  ```
  `teams-org.mjs` import 목록(62-74줄)에 없음. 다른 스크립트 파일에도 없음. 측정: 해당 없음.
- **제안 수정**: 외부 사용이 없다면 `export` 제거를 검토한다. 테스트 또는 미래 API용으로 남겨둔 경우 JSDoc에 `@internal` 태그를 추가하여 의도를 명시한다.
- **예상 작업 크기**: XS
- **회귀 방지 검사**: `workflow.test.mjs`에서 `validateWorkflowRequest` 직접 호출 여부 확인 후 제거 가능.

---

#### LAUNCH-01

- **id**: LAUNCH-01
- **분류**: memory
- **심각도**: low (초안 가안 low 유지 — settleMs·readyMs로 상한이 있어 무한 폴링 아님. 실제 spawn 비용 미측정)
- **파일:줄**: `plugins/oh-my-teams/scripts/role-terminal.mjs:588-595, 539-545`
- **증상**: `openRoleTerminal`의 `until()` 내부 루프가 `pollMs`(기본 1,500ms) 간격으로 `observe()`를 반복 호출하고, `observe()`는 매번 `readScreen()`을 통해 `orca terminal read` 외부 프로세스를 실행한다. `settleMs`(기본 8,000ms) 동안 최대 7회, Enter 전송 후 `readyMs`(기본 90,000ms) 동안 최대 61회, 합계 최대 70회의 외부 프로세스가 생성된다.
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
  코드 구조 분석 기준 최대 70회(settleMs=8s, readyMs=90s). 실제 외부 프로세스 실행 비용(orca CLI spawn 오버헤드)은 미측정(실환경 Orca 필요).
- **제안 수정**: Orca가 `terminal wait --for tui-idle` 이벤트를 지원하므로, 폴링 대신 해당 명령 1회로 대기하고 타임아웃 시에만 screen read를 시도하는 방식으로 전환을 검토한다. 또는 `pollMs`를 늘려 외부 프로세스 수를 줄이는 단기 완화가 가능하다.
- **예상 작업 크기**: S (폴링 루프를 `terminal wait` 단일 호출로 교체)
- **회귀 방지 검사**: `role-terminal.test.mjs`의 launch 경로 테스트. Enter 전송 경로·trust 경로별 screen read 횟수 확인 추가.

---

#### LAUNCH-02

- **id**: LAUNCH-02
- **분류**: architecture
- **심각도**: low (초안 가안 low 유지 — 규칙 근거 미확인으로 위반 단정 불가, Senior/PM 판정 필요)
- **파일:줄**: `plugins/oh-my-teams/scripts/role-terminal.mjs:24`
- **증상**: `role-terminal.mjs`가 `orca-adapter.mjs`의 `runOrcaJson`과 `selectOrcaExecutable`을 직접 import하여 10개소에서 사용한다. 사전 후보 C-A1은 이를 "어댑터를 거치지 않는 직접 호출"로 지적했다. 단, `adapters.mjs`의 `executionAdapter` port는 실행 런타임(orca vs local)을 추상화하는 레이어이고, `role-terminal.mjs`가 사용하는 `runOrcaJson`은 Orca 터미널 UI(terminal create/read/rename/close/wait/send) 전용 유틸리티로, 실행 어댑터 port의 적용 범위(worker 생명주기 start/stop/confirm)와 다르다.
- **근거**: `role-terminal.mjs:24`:
  ```js
  import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";
  ```
  `adapters.mjs:24-37`의 `EXECUTION_ADAPTERS`는 `translateCode`, `assertDiscovery`, `readWorkspaceClaim`, `confirmWorkspace` 4가지 실행 어댑터 port만 포함하며 `runOrcaJson`은 포함하지 않는다.
  `CODE_QUALITY.md:68`: "`orca-adapter.mjs`: 실행 파일 선택, runtime discovery, JSON 호출, worktree 생성"
  측정: 해당 없음(아키텍처 판단 문제).
- **판정**: 규칙 근거 미확인 — `CODE_QUALITY.md:68`에서 직접 import의 근거는 확인되나, "어댑터를 거치지 않는 직접 호출 금지" 규칙이 `AGENTS.md`, `CODE_QUALITY.md` 등 정본 문서에 없어 규칙 위반으로 단정할 수 없다. Senior/PM의 판정이 필요하다.
- **제안 수정**: 판정을 위해 `AGENTS.md` 또는 `CODE_QUALITY.md`에 "Orca 터미널 UI 조작은 `runOrcaJson` 직접 사용 가능, 실행 어댑터 port(`adapters.mjs`)는 worker 생명주기(start/stop/confirm)에만 적용"을 명시하거나, 위반 여부 확인 후 조치를 결정한다.
- **예상 작업 크기**: XS (문서 명시만 필요한 경우)
- **회귀 방지 검사**: 문서 일관성 검사. `skill-instructions.test.mjs`.

---

#### DOCS-01

- **id**: DOCS-01
- **분류**: checks
- **심각도**: low (senior 검토 반영 — 진단/문서화의 명확성 문제로 기능 결함이 없는 경우에 해당하여 low로 조정)
- **파일:줄**: `AGENTS.md:13`
- **증상**: 버전 정책이 `` `1.x.x` 범위에서 버전을 올립니다``라고 적혀 있으나 현재 버전은 2.4.1이다. 주 버전 2로의 전환이 이미 이루어진 상태에서 문서는 여전히 `1.x.x`를 기술하고 있어, 정본과 현실이 어긋난다.
- **근거**: 코드 인용 — `AGENTS.md:13`:
  ```
  호환 가능한 기능 추가와 버그 수정은 `1.x.x` 범위에서 버전을 올립니다.
  ```
  `package.json`의 현재 버전: `2.4.1`. 측정: 해당 없음.
- **제안 수정**: `AGENTS.md:13`의 버전 정책 문장을 `` `2.x.x` 범위에서 버전을 올립니다``(또는 "semver 규칙에 따라 호환 변경은 마이너, 비호환 변경은 메이저를 올립니다")로 수정하여 현재 실태와 일치시킨다.
- **예상 작업 크기**: XS (문장 수정 1줄)
- **회귀 방지 검사**: `tests/repository-metadata.test.mjs`에 버전 정책 문서 내 버전 범위가 `package.json` 주 버전과 일치하는지 확인하는 검사 추가 권고.

---

#### DOCS-02

- **id**: DOCS-02
- **분류**: checks
- **심각도**: low (senior 검토 반영 — 진단/문서화의 명확성 문제로 기능 결함이 없는 경우에 해당하여 low로 조정)
- **파일:줄**: `docs/plan/ai-native-agent-organization.md:53` vs `AGENTS.md`, `docs/CODE_QUALITY.md`
- **증상**: 규칙 R13("Orca의 감독 기능을 재구현하지 않는다"), R14("어댑터를 거치지 않는 직접 호출 금지"), R15("스킬 문서에 런타임 로직 중복 금지"), R17("임시 산출물을 워크트리에 남기지 않는다")은 설계 문서·소스 주석에만 존재하며 `AGENTS.md`·`CODE_QUALITY.md` 등 정본 문서에 없다.
- **근거**:
  - `docs/plan/ai-native-agent-organization.md:53`: 원칙 8 "Orca의 감독 기능을 재구현하지 않는다" (설계 문서에만 있음)
  - `AGENTS.md` 전문 grep: 해당 규칙 문장 없음.
  - `docs/CODE_QUALITY.md` 전문 grep: 해당 규칙 문장 없음.
  - `references/orca-runtime.md:15`: "oh my teams는 Orca polling, lifecycle, 프로세스 회수 또는 업데이트 관리자를 재구현하지 않는다" — 유일한 references 수준의 선언이지만 규칙 목록이 아니라 도입부 설명이다.
  측정: 해당 없음.
- **제안 수정**: R13~R15·R17에 해당하는 규칙을 `AGENTS.md`(또는 `docs/CODE_QUALITY.md`)에 명시적인 항목으로 추가하거나, 설계 문서 참조 링크를 `AGENTS.md`에 기재한다. 규칙이 자동 검사로 강제될 수 없다면 그 사실을 명시한다.
- **예상 작업 크기**: S (규칙 문장 추가 4~5항목 및 링크)
- **회귀 방지 검사**: `tests/skill-instructions.test.mjs`에 정본 문서에 없는 규칙을 스킬이 단독 선언하지 않는지 확인하는 검사 추가 권고.

---

#### DOCS-03

- **id**: DOCS-03
- **분류**: checks
- **심각도**: low (senior 검토 반영 — 진단/문서화의 명확성 문제로 기능 결함이 없는 경우에 해당하여 low로 조정)
- **파일:줄**: `docs/plan/ai-native-agent-organization.md:53` vs `docs/plan/headless-runtime.md:7-16`
- **증상**: `ai-native-agent-organization.md:53`의 원칙 8은 "실행 소유권·프로세스·회수는 Orca를 사용한다"고 선언하나, `headless-runtime.md:7-16`은 headless 경로가 "Orca를 대체하는 감독 런타임"임을 명시적 설계 목표로 선언한다. 두 문서가 충돌하는지, `headless-runtime.md`가 공식 예외인지가 불명확하다. B7 조사에서 `ai-native-agent-organization.md`에 headless 예외 조항이 없음을 직접 확인했다.
- **근거**:
  - `docs/plan/ai-native-agent-organization.md:53`: "Orca의 감독 기능을 재구현하지 않는다. 스킬 패키지는 업무 계약과 gate를 담당하고, 실행 소유권·프로세스·회수는 Orca를 사용한다."
  - `docs/plan/headless-runtime.md:7-16`: headless 경로가 Orca 없는 실행을 2단계 목표로 명시.
  - `docs/plan/ai-native-agent-organization.md` 전체에 headless 예외 조항 없음(직접 확인).
  측정: 해당 없음.
- **제안 수정**: `ai-native-agent-organization.md:53`에 "headless-runtime.md가 명시적으로 선택할 때 허용되는 예외" 조항을 추가하거나, `headless-runtime.md`에 "원칙 8의 공식 예외"임을 명시한다.
- **예상 작업 크기**: XS (문서 보완 1~2문장)
- **회귀 방지 검사**: 문서 일관성 검사. `skill-instructions.test.mjs`에 headless 예외 선언 확인 추가 권고.

---

#### DOCS-04

- **id**: DOCS-04
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 현재 검사 통과, 사각지대만 존재)
- **파일:줄**: `scripts/check-code-quality.mjs:8-16`
- **증상**: `check-code-quality.mjs`의 `ignoredDirectories`에 `evals` 디렉터리가 없어 `evals/organization/run.mjs`가 품질 감사 대상에 포함된다. `run.mjs`는 `escapeForPattern`, `runEvidenceTest` 두 내부 함수를 JSDoc 없이 선언한다. 단, 두 함수 모두 `export`가 아니므로 현재 공개 export 검사에서는 findings 0으로 통과한다.
- **근거**: `check-code-quality.mjs:8-16` — `ignoredDirectories`에 `evals` 없음:
  ```js
  const ignoredDirectories = new Set([
    ".git", ".omc", ".orca", ".omt",
    "legacy", "node_modules", "results",
  ]);
  ```
  `evals/organization/run.mjs:20-47` — 비공개 함수 2개, JSDoc 없음.
  `npm run quality` 실행 결과: `evals/organization/run.mjs`의 `publicExports: 0`, `findings: []` — 현재 검사 통과.
- **제안 수정**: (a) 단기: `evals/organization/run.mjs`의 두 내부 함수에 JSDoc 추가. (b) 중기: `check-code-quality.mjs`에 중요 비공개 함수(특히 eval 스크립트)의 선택적 문서화 검사 추가를 검토하거나, `evals` 디렉터리를 `ignoredDirectories`에 추가하여 의도를 명확히 한다.
- **예상 작업 크기**: XS-S (JSDoc 추가 2건 또는 ignoredDirectories 수정 1줄)
- **회귀 방지 검사**: 없음(현재 검사 통과). 필요 시 `tests/code-quality.test.mjs`에 evals 디렉터리 범위 확인 추가.

---

#### DOCS-05

- **id**: DOCS-05
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 현재 규모 허용 범위)
- **파일:줄**: `scripts/metadata.mjs:37-45`
- **증상**: `declaredTestCount`는 `tests/` 디렉터리의 각 `.test.mjs` 파일을 `readFileSync`로 전체 읽고 `^test(` 정규식으로 카운팅한다. 파일마다 전체 내용을 메모리에 올린다. 테스트 파일이 31개·합계 약 20,500줄인 지금은 허용 범위이나, 장기적으로 테스트 파일이 크게 늘면 `sync` 실행 비용이 증가한다.
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
- **제안 수정**: 현재 규모에서는 허용 범위이다. 테스트 파일이 크게 늘면 파일 전체 대신 `createReadStream`으로 줄 단위 카운팅으로 전환하거나, 정적 카운트를 별도 파일에 캐시하는 방안을 검토한다.
- **예상 작업 크기**: XS (현재 변경 없음, 미래 고려)
- **회귀 방지 검사**: `tests/repository-metadata.test.mjs`(기존 검사 유지).

---

#### DOCS-06

- **id**: DOCS-06
- **분류**: architecture
- **심각도**: low (초안 가안 low 유지 — 사용 추적 미확인)
- **파일:줄**: `plugins/orca/scripts/orca-org.mjs:1-12`
- **증상**: `plugins/orca/scripts/orca-org.mjs`는 pre-1.1 런타임 경로의 호환성 진입점이며, 현재 구현을 `plugins/oh-my-teams/scripts/teams-org.mjs`의 `main`에 위임하는 13줄짜리 파일이다. 주석이 "pre-1.1 runtime path"라고 명시하는데, 현재 버전이 2.4.1인 시점에서 이 파일이 여전히 필요한지 여부가 불명확하다.
- **근거**: `plugins/orca/scripts/orca-org.mjs:1-12`:
  ```js
  /**
   * Compatibility entry point for the pre-1.1 runtime path.
   * The active implementation lives under `plugins/oh-my-teams`.
   */
  import { main } from "../../oh-my-teams/scripts/teams-org.mjs";
  main(process.argv.slice(2)).catch(...)
  ```
  측정: 해당 없음.
- **제안 수정**: 1.1 이전 경로가 더 이상 사용되지 않는다고 확인되면 이 파일을 제거하거나 `legacy/`로 이동한다. 불확실하면 `tests/removed-skills.mjs` 패턴을 참고하여 사용 추적 검사를 추가한다.
- **예상 작업 크기**: XS (확인 후 제거 또는 유지)
- **회귀 방지 검사**: 제거 시 `install.mjs`·스킬 파일에서 이 경로를 참조하는 곳이 없음을 확인한다.

---

#### DOCS-07

- **id**: DOCS-07
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 런타임 로직 중복 선언이지만 기능 결함 없음)
- **파일:줄**: `plugins/oh-my-teams/references/assist.md:11` vs `plugins/oh-my-teams/skills/pm/SKILL.md:10, 21`
- **증상**: `assist.md:11`은 보조 도구 허용 모델이 `gpt-oss-120b-medium`이어야 한다고 적는다. 이 값은 런타임(`scripts/worker.mjs`의 `assist` 코드)이 강제하는 값이며, 문서와 런타임이 각각 이 값을 기술하는 중복 선언이다. 모델 ID가 바뀌면 두 곳을 함께 바꿔야 한다.
- **근거**: `references/assist.md:11`:
  ```
  3. 선택된 프로필의 모델이 `gpt-oss-120b-medium`이어야 한다.
  ```
  런타임 강제 여부: `scripts/worker.mjs`가 `assist` 명령에서 이를 검증한다고 `assist.md:6-7`에 기술됨. 측정: 해당 없음.
- **제안 수정**: 런타임이 강제하는 값(모델 ID)은 문서에서 "런타임이 검사한다"고만 쓰고 구체적 값은 소스 코드를 정본으로 삼거나, 두 곳을 `scripts/metadata.mjs` 패턴처럼 단일 정본에서 동기화하는 방안을 검토한다.
- **예상 작업 크기**: XS (문서 표현 수정 또는 sync 대상 추가)
- **회귀 방지 검사**: `tests/skill-instructions.test.mjs`에 `assist.md`의 모델 ID가 `worker.mjs`의 검증값과 일치하는지 확인하는 검사 추가 권고.

---

#### DOCS-09

- **id**: DOCS-09
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 자동 동기화 미비이나 기능 결함 없음)
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

#### TESTS4-07

- **id**: TESTS4-07
- **분류**: checks
- **심각도**: low (초안 가안 low 유지 — 정상 실행 시 클린업 적절, 타임아웃 중단 시만 문제)
- **파일:줄**: `tests/` 전반 — 임시 디렉터리 생성 파일 (31개 중 `mkdtempSync` 사용 파일 23개)
- **증상**: 대부분의 테스트 파일은 `mkdtempSync`로 임시 디렉터리를 생성하고 `t.after(() => fs.rmSync(...))`로 정리한다. 단, 1차 npm test 실행이 usage-report 파일 도중에 300초 제한으로 중단되었다(RESULTS.md:8). 이 경우 `t.after` 클린업이 실행되지 않아 `os.tmpdir()` 아래에 임시 디렉터리가 남았을 가능성이 있다. Node.js test runner는 비정상 종료 시 `t.after` 콜백을 보장하지 않는다.
- **근거**: RESULTS.md:8:
  ```
  npm test (1차, --test-concurrency=1) | 300초 제한으로 중단 | 300.4초
  ```
  임시 디렉터리 생성: `code-quality.test.mjs:16`, `dashboard.test.mjs:19`, `delivery.test.mjs:36`, `headless.test.mjs:27`, `kickoff-registry.test.mjs:28`, `lock-recovery-and-release.test.mjs:30` 등. 모두 `os.tmpdir()` 아래에 생성. 측정: 미측정(실제 잔여 디렉터리 확인 미수행).
- **판정**: 확인(설계는 적절, 타임아웃 시 클린업 미보장) — 정상 실행 시 임시 디렉터리 클린업은 올바르게 구현됨. 타임아웃으로 중단될 경우 `os.tmpdir()`에 임시 디렉터리가 남을 수 있으나, OS 임시 디렉터리는 OS가 주기적으로 정리하며 워크트리에는 남지 않음(R17 준수).
- **제안 수정**: 타임아웃 연장(300초)을 검토하거나, 가장 느린 테스트(deliver 26/21/17초, worker allowance 19초)의 성능 개선을 통해 전체 실행 시간을 줄이는 방안을 검토한다.
- **예상 작업 크기**: S-M (타임아웃 조정 또는 느린 테스트 개선)
- **회귀 방지 검사**: `npm test` 전체 실행 완료(현재 2차 분할 실행 필요).

---

#### TESTS4-08

- **id**: TESTS4-08
- **분류**: checks
- **심각도**: low (senior 검토 반영 — 진단/문서화의 명확성 문제로 기능 결함이 없는 경우에 해당하여 low로 조정)
- **파일:줄**: `tests/` — `incidents.mjs`, `usage-ledger.mjs` 직접 테스트 없음
- **증상**: `incidents.mjs`(265줄, B2)는 `boundary-and-gate.test.mjs:17`과 `runtime.test.mjs:69`에서 임포트되어 간접적으로 검사되나, `incidents.mjs`를 직접 대상으로 하는 전용 테스트 파일이 없다. 마찬가지로 `usage-ledger.mjs`(170줄, B5)는 `usage-report.test.mjs:16`에서만 임포트되며, `recordLaunch`·`readLaunches` 등의 핵심 함수를 직접 단위 테스트하는 파일이 없다. 두 모듈 모두 상태를 파일 시스템에 저장하고 읽는 중요 함수들을 갖고 있으며, 발견 후보 F-04(usage-ledger)와 incidents 상태 크기 의심이 이들과 관련이 있다.
- **근거**:
  - `tests/` 디렉터리에 `incidents.test.mjs`·`usage-ledger.test.mjs` 없음 (inventory.csv 확인).
  - `incidents.mjs` 관련: `boundary-and-gate.test.mjs:17`에서 `classifyIncident`, `incidentStatus` 임포트. `runtime.test.mjs:69`에서 `incidentStatus` 임포트 및 `:1984`에서 1개 인시던트 상태 검사.
  - `usage-ledger.mjs` 관련: `usage-report.test.mjs:16`에서 `readLaunches`, `ledgerFile`, `recordLaunch` 임포트. F-04 발견 항목의 `recordLaunch` 전체 재읽기 패턴은 `usage-report.test.mjs`에서 간접 검증되지만, ledger 크기·회전 없는 상한 관련 단위 테스트 없음.
  측정: 해당 없음(커버리지 구조 분석).
- **제안 수정**: `tests/usage-ledger.test.mjs`를 추가하여 `recordLaunch`·`readLaunches` 왕복, `resolveLaunchKickoff` 동작을 단위 테스트한다. `tests/incidents.test.mjs`를 추가하여 `classifyIncident`·`incidentStatus` 상태 변이를 단위 테스트한다.
- **예상 작업 크기**: S (단위 테스트 2~3개 추가 × 2 파일)
- **회귀 방지 검사**: 신규 `usage-ledger.test.mjs`·`incidents.test.mjs`.

---

#### CHECKS-INT-01

- **id**: CHECKS-INT-01
- **분류**: checks
- **심각도**: medium (측정으로 확인된 재현 가능한 실패이며, Windows + 병렬 실행이라는 특정 시나리오에 한정됨. 직렬 실행과 GitHub Actions CI를 우회 근거로 삼아 integration gate를 통과하지 못한 채 integration-pending으로 남음)
- **파일:줄**: `tests/headless.test.mjs:564`, `tests/headless.test.mjs:28-37`
- **증상**: 테스트 `"agy turn.json carries --print-timeout from worker default and per-turn timeoutMs"`(`headless.test.mjs:564`)가 기본 병렬 `npm test`(node --test 기본 동시 실행)에서 Windows 11에서 두 번 연속 실패했다. 테스트 본문은 통과하지만 `t.after`의 정리 단계(`headless.test.mjs:28-37`)의 `fs.rmSync(maxRetries 5, retryDelay 200)`가 `EPERM, Permission denied: ...\AppData\Local\Temp\omt-headless-XXXX`로 실패한다.
- **근거**:
  - 같은 파일을 단독 실행하면 14/14 통과.
  - `--test-concurrency=1` 직렬 3묶음 실행에서 29개 파일 359/359 통과(합계 약 240초).
  - 이번 kickoff의 workflow 통합 gate(고정 검사 `npm test`, verify 명령별 300초 제한)가 통과하지 못해 integration-pending으로 남았다.
  - `--test-concurrency`는 `NODE_OPTIONS`로 줄 수 없어 우회하지 않았다. 전달 근거는 직렬 359/359와 PR의 GitHub Actions CI로 삼았다.
  - 원인 가설: 테스트가 띄운 detached headless runner(또는 그 자식)가 정리 시점에 아직 임시 디렉터리를 잡고 있다. F-05(Windows 프로세스 트리 잔존)와 같은 유형이다. 가설은 가설로 적는다.
  - 측정: 재현 2회 확인(병렬 실행). 직렬 실행 359/359 통과로 우회 경로 확인.
- **제안 수정**: (a) 테스트 정리 전에 runner 종료를 기다리거나(stop 후 `exit.json` 확인), (b) headless-runner가 Windows에서 프로세스 트리를 종료하게 하고(F-05 수정과 연동), (c) 회귀 방지로 병렬 실행을 CI의 Windows 러너에서 돌린다.
- **예상 작업 크기**: S-M (runner 종료 확인 로직 추가 + Windows 실환경 검증, F-05 수정과 함께 처리 가능)
- **회귀 방지 검사**: CI Windows 러너에서 병렬 `npm test` 실행 추가.
- **수정 완료** (task fix-process-tree-stop): `sandbox(t)` `t.after`에서 `waitAllRunnersExited(state)`를 호출해 모든 headless runner의 exit.json 기록을 확인한 뒤 `rmSync`를 실행. stop.request를 먼저 써 실행 중인 턴을 중단하고, exit.json이 나타날 때까지(최대 8초) 100ms 간격으로 폴링. 이 방식은 증상(EPERM)이 아닌 실제 원인(runner가 파일 핸들을 보유 중)을 해결함. macOS에서 병렬 `npm test` 371/371 통과 확인. Windows 실측: 실환경 없어 코드 경로 + PR #67 CI 근거로 확인.


---

#### CLOSE-01

- **id**: CLOSE-01
- **분류**: architecture
- **심각도**: medium (자원 누적 — kickoff 횟수에 비례하여 원격·로컬·하위 워크트리 브랜치가 무한 누적되므로 자원 증가가 지속됨. 기능 결함은 없으나 브랜치 관리 비용 증가)
- **파일:줄**: `plugins/oh-my-teams/skills/close/SKILL.md:42-44`
- **증상**: `close` 절차의 회수·정리 단계(6단계)가 worker를 release하고 child worktree를 회수하도록 지시하지만, kickoff 시 생성된 원격 브랜치·로컬 브랜치·하위 워크트리 브랜치를 삭제하는 단계가 없다. kickoff를 반복할수록 브랜치가 누적된다. 반면 `disband`는 복구를 위한 브랜치 보존이 요구될 수 있으므로 구분이 필요하다.
- **근거**: `plugins/oh-my-teams/skills/close/SKILL.md:42-44`:
  ```text
  6. Orca의 현재 가이드에 따라 정산이 끝난 worker를 release하고 child worktree를 회수한다. 보존되지 않은 변경, 살아 있는 프로세스, 상태 불명 worker가 있으면 삭제하지 않으며, 종료를 확인하지 못한 worker는 `worker-abandon`으로 봉인한다.
  ```
  이 단계에서 worktree를 회수한다고 기술하지만, kickoff 브랜치(원격 브랜치: `git push origin --delete <branch>`, 로컬 브랜치: `git branch -d <branch>`) 삭제 지시가 없다. kickoff마다 브랜치가 생성되지만 제거되지 않으므로 장기 운영 시 브랜치가 누적된다.
  측정: 해당 없음(코드·문서 구조 분석).
- **제안 수정**: `close` 절차의 6단계(또는 별도 정리 단계)에 다음을 추가한다. (a) 전달(병합)이 확인된 뒤 kickoff의 원격 브랜치와 로컬 브랜치를 삭제한다. (b) 하위 워크트리가 삭제되면 해당 워크트리 전용 브랜치도 삭제한다. (c) `disband`는 복구 가능성을 위해 브랜치를 보존하는 정책을 유지한다. `close/SKILL.md` 6단계와 7단계 사이에 브랜치 정리 절차를 명시하거나, 8단계 최종 정리 목록에 브랜치 삭제를 포함한다.
- **예상 작업 크기**: XS (문서 절차 추가)
- **회귀 방지 검사**: `tests/skill-instructions.test.mjs`에 close 절차에 브랜치 삭제 언급이 있는지 확인하는 검사 추가 권고.

---

## 미확인 의심

다음 항목은 근거가 충분하지 않아 발견 목록에서 제외하고 이 절에 별도로 기록한다.

| id | 출처 | 내용 |
|---|---|---|
| U-01 | audit-runtime-io 남은 의심 | `headlessDetail`이 모든 턴의 stream을 읽는 경로(768-788줄)는 대시보드 상세 요청마다 발생한다. 턴이 많은 장기 worker에서 총 읽기량이 회차별로 누적되는지 확인 필요(미측정). |
| U-02 | audit-runtime-io 남은 의심 | F-05 Windows 실측: `child.kill()` 이후 손자 프로세스 생존 여부는 실제 Windows 환경에서 `tasklist`로 확인해야 한다(임시 디렉터리 방식으로 측정 불가). |
| U-03 | audit-runtime-io 남은 의심 | `usage-sources.mjs` 대용량 파일 상한: 100MB 이상 Claude 대화 기록에서 eachJsonLine의 메모리 상한이 Node.js 기본 힙(`--max-old-space-size`)과 충돌할 가능성(미측정, 50MB 제한으로 측정). |
| U-04 | audit-state 남은 의심 | STATE-01 Set 전환 직렬화 호환: `eventIds`를 Set으로 바꾸면 `JSON.stringify`가 `{}`로 직렬화하므로 `writeJSON` 직전 `Array.from(state.eventIds)`로 변환하는 처리 필요. 기존 `state.json`에서 배열을 읽어 Set으로 변환하는 로드 경로 확인 필요. |
| U-05 | audit-state 남은 의심 | STATE-02 overflow 후 Windows close: Windows에서 `child.kill()` 이후 손자 프로세스가 `close`를 보내지 않는 사례(F-05와 유사)가 overflow 경로에도 적용되는지 실측 확인 필요(미측정). |
| U-06 | audit-state 남은 의심 | STATE-03 측정 필요: reviews/decisions 디렉터리가 장기 workflow·다수 재시도 시나리오에서 얼마나 쌓이는지 측정 후 low→medium 상향 여부 판단 가능. |
| U-07 | audit-state 남은 의심 | `incidents.mjs` state 크기: `loadState`는 `state.json` 하나에 모든 인시던트를 저장하며, `maxOpen` 설정으로 활성 수가 제한되므로 실질적 위험은 낮을 것으로 추정(미측정). |
| U-08 | audit-launch 남은 의심 | LAUNCH-01 실측 필요: `orca terminal read` 외부 프로세스 1회 spawn 비용(시간·RSS)은 실환경 Orca에서만 측정 가능. 비용이 높으면 `terminal wait` 전환 우선순위가 높아짐(미측정). |
| U-09 | audit-launch 남은 의심 | LAUNCH-02 규칙 확정: "어댑터를 거치지 않는 직접 호출 금지" 규칙의 정본 문서 존재 여부를 B7 묶음이 확인 후 판정 확정 필요. |
| U-10 | audit-launch 남은 의심 | LAUNCH-03 규칙 근거 위치: `ai-native-agent-organization.md:355`(사용자 설정 파일 쓰기 금지)가 실제 해당 내용을 담고 있는지 B7 묶음이 확인 필요. |
| U-11 | audit-docs-repo 남은 의심 | DOCS-02 규칙 확정: R13~R17 중 정본 문서에 추가해야 할 항목의 우선순위와 추가 형식(별도 절 vs 기존 절 보완)은 PM·Senior의 설계 판단 필요. |
| U-12 | audit-docs-repo 남은 의심 | DOCS-06 사용 추적: `plugins/orca/scripts/orca-org.mjs`를 1.1 이전 설치에서 실제로 참조하는지 여부는 사용 로그나 릴리스 노트 확인 필요(미측정). |
| U-13 | audit-docs-repo 남은 의심 | DOCS-07 단일 정본 타당성: `assist.md`의 모델 ID 동기화를 `metadata.mjs` 패턴으로 처리할 경우 비용 대비 효과 검토 필요. |
| U-14 | audit-docs-repo 남은 의심 | R16(사용자 설정 쓰기 금지) 정본화: `role-terminal.mjs:36` 주석에만 선언된 이 규칙을 `AGENTS.md`나 `CODE_QUALITY.md`에 추가할 필요가 있는지 판단 필요. |
| U-15 | audit-tests 남은 의심 | TESTS4-04 codexRolloutModel 커버리지: `headless.test.mjs`에서 `codexRolloutModel` 함수를 직접 호출하여 검증하는 테스트가 있는지, 어느 코드 경로에서 호출되는지 추가 확인 필요(미확인). |
| U-16 | audit-tests 남은 의심 | TESTS4-07 실제 잔여 디렉터리: 1차 npm test 300초 타임아웃으로 중단된 후 `os.tmpdir()` 아래에 남은 `omt-*` 임시 디렉터리가 있는지 실제 확인 필요(미측정). |
| U-17 | audit-tests 남은 의심 | TESTS4-02 실측: CI 환경에서 300ms/1,500ms 대기가 부족한 경우의 `rmSync` 실패율은 실환경 측정 필요. |
| U-18 | audit-tests 남은 의심 | 느린 테스트 원인: deliver(26초)·worker allowance(19초)·component acceptance(13.7초)·owning checkout(10.1초)의 소요 원인이 스크립트 복잡도인지 sleep 대기인지 확인 필요(미조사). |

발견 목록에서 제외된 항목 중 LAUNCH-03(readLaunchEnvironment: 사용자 설정 파일 읽기 전용 확인, 규칙 준수)·TESTS4-01(fake-agent SLEEP: 의도적 설계)·TESTS4-05(workflow-recovery: 설계 적절)·TESTS4-06(code-quality 테스트: 검사 존재 확인)는 근거 확인 후 문제 없음으로 판정했다.

---

## 규칙 목록

### 확인된 규칙 (R1~R11)

| id | 규칙 | 근거 위치 |
|---|---|---|
| R1 | 원시 `orca orchestration worker-start`·`worktree create --agent`로 역할을 띄우지 않는다 | `skills/pm/SKILL.md:33`, `skills/pl/SKILL.md:34`, `references/orca-runtime.md:81` |
| R2 | 감독 worker는 `worker-start` 래퍼와 `role-terminal`로만 시작한다 | `skills/pm/SKILL.md:19`, `skills/pl/SKILL.md:74`, `references/orca-runtime.md:79-98` |
| R3 | 주인 체크아웃에 커밋·병합하지 않는다. `merge-check`·`role-terminal`·`worker-start`가 거부한다 | `references/kickoff-registry.md:60-70`, `skills/kickoff/SKILL.md:45`, `skills/close/SKILL.md:10, 23` |
| R4 | 자기 결과를 자기가 승인하지 않는다 | `skills/pm/SKILL.md:36`, `skills/junior/SKILL.md:29` |
| R5 | 공통 수치·버전은 `scripts/metadata.mjs`가 정본, 직접 고치지 않는다 | `AGENTS.md:23-36` |
| R6 | 실행 경로 판정은 `launch-matrix.mjs` 호환성 표가 정한다 | `references/orca-runtime.md:98, 171` |
| R7 | 불필요한 변경 규율, 기존 helper 재구현 금지 | `references/minimal-change.md:9, 21` |
| R8 | 공통 helper 위치(`core`/`usage`/`workflow-store`/`status`/`orca-adapter`) | `docs/CODE_QUALITY.md:62-68` |
| R9 | 모듈 JSDoc, 공개 export JSDoc·`@param`·`@returns`, 180자 제한, 허위 `@throws` 금지 | `AGENTS.md:17`, `docs/CODE_QUALITY.md:25-60` |
| R10 | 보조 도구·사용자 결정은 각 정본 문서만 참조 | `references/assist.md:3`, `references/user-choice.md:3` |
| R11 | `worker-start`는 Run에 바인딩된 coordinator 터미널에서만 | `references/orca-runtime.md:189`, `references/kickoff-registry.md:77` |
| R12 | 버전 정책 `1.x.x` | `AGENTS.md:13` 선언 확인. 단, 현재 버전 2.4.1과 어긋남(DOCS-01). |

### R13~R17 확인 결과

| id | 규칙 | 확인 결과 |
|---|---|---|
| R13 | Orca 재구현 금지 | `docs/plan/ai-native-agent-organization.md:53`(설계 문서)에만 있음. `AGENTS.md`·`CODE_QUALITY.md` 정본 문서에 없음(DOCS-02). |
| R14 | 어댑터를 거치지 않는 직접 호출 금지 | 정본 문서에 없음(`CODE_QUALITY.md:68`은 공통화 위치 설명). LAUNCH-02 판단과 동일(DOCS-02). |
| R15 | 스킬 문서에 런타임 로직 중복 금지 | 명시 문장 없음. `ai-native-agent-organization.md` 원칙 4("판단과 강제 조건을 분리한다")가 가장 가깝다(DOCS-02). |
| R16 | 사용자 설정 파일을 쓰지 않는다 | `role-terminal.mjs:36` 주석에 선언. `ai-native-agent-organization.md:355`는 조직 policy migration 문맥으로 이 규칙을 선언하지 않음. 구현은 규칙 준수(LAUNCH-03 판정). 정본화 여부는 U-14로. |
| R17 | 임시 산출물을 워크트리에 남기지 않는다 | 소스 주석과 설계 문서(`headless-runtime.md:70`)에만 있음. `AGENTS.md`·`CODE_QUALITY.md` 정본에 없음(DOCS-02). |

### 규칙 쪽을 고쳐야 하는 항목

| id | 위치 | 내용 |
|---|---|---|
| C-R1 | `AGENTS.md:13` | 버전 정책 `` `1.x.x` 범위``라고 적지만 현재 버전은 2.4.1이다. `2.x.x`로 수정 필요(DOCS-01). |
| C-R2 | 브리프 규칙 R13~R17 | (a) Orca 재구현 금지: `ai-native-agent-organization.md:53`(설계 문서에만 있음). (b) 어댑터 경유 금지: 정본 문서에 없음. (c) 임시 산출물 금지: 소스 주석·설계 문서에만 있음. (d) 스킬 런타임 로직 중복 금지: 명시 없음. (e) 사용자 설정 파일 쓰기 금지: `role-terminal.mjs:36` 주석에 선언, 정본화 미완. 모두 `AGENTS.md`·`CODE_QUALITY.md` 정본에 없다(DOCS-02). |

---

## 새 자동 검사 제안

다음은 이번 조사에서 제안하는 새 자동 검사이다. 구현은 이번 범위 밖이다.

| 제안 id | 검사 내용 | 목적 | 구현 비용 |
|---|---|---|---|
| P-01 | `tests/repository-metadata.test.mjs`에 `AGENTS.md` 버전 정책 범위가 `package.json` 주 버전과 일치하는지 확인 | DOCS-01 회귀 방지 | XS |
| P-02 | `tests/skill-instructions.test.mjs`에 정본 문서에 없는 규칙을 스킬이 단독 선언하지 않는지 확인 | DOCS-02 회귀 방지 | M |
| P-03 | `tests/skill-instructions.test.mjs`에 headless 예외 조항 선언 확인 추가 | DOCS-03 회귀 방지 | XS |
| P-04 | `tests/skill-instructions.test.mjs`에 `assist.md`의 모델 ID가 `worker.mjs` 검증값과 일치하는지 확인 | DOCS-07 회귀 방지 | XS |
| P-05 | `headless.mjs`의 큰 스트림 fixture를 이용한 메모리 압박 검사 | F-02 회귀 방지 | M |
| P-06 | `usage-sources.test.mjs`에 큰 파일 fixture 또는 청크 읽기 검증 추가 | F-03 회귀 방지 | S |
| P-07 | `workflow.test.mjs`에 기존 배열 state.json을 로드·저장하는 왕복 테스트 추가 | STATE-01 회귀 방지 | S |
| P-08 | `tests/code-quality.test.mjs`에 `evals` 디렉터리 범위 명시적 확인 추가 | DOCS-04 사각지대 명시 | XS |
| P-09 | `tests/usage-ledger.test.mjs` 신규: `recordLaunch`·`readLaunches` 왕복, `resolveLaunchKickoff` 동작 단위 테스트 | TESTS4-08, F-04 회귀 방지 | S |
| P-10 | `tests/incidents.test.mjs` 신규: `classifyIncident`·`incidentStatus` 상태 변이 단위 테스트 | TESTS4-08 회귀 방지 | S |

---

## 다음 kickoff 우선순위

### 수정 순서와 묶음(PR 단위 제안)

| 우선순위 | PR 묶음 | 포함 항목 | 예상 크기 | 이유 |
|---|---|---|---|---|
| 1 | `fix/headless-stream-read` | F-01, F-02 | M | high/memory, 폴링 경로 RSS 압박 즉시 개선 가능 |
| 2 | `fix/usage-sources-stream` | F-03, F-06 | S-M | high/memory, eachJsonLine 스트림 전환으로 주석 불일치도 해소 |
| 3 | `fix/core-overflow-fallback` | STATE-02 | S | medium/memory, overflow 후 close 미착신 Windows 위험 제거 |
| 4 | `fix/headless-runner-kill-tree` | F-05, CHECKS-INT-01 | M | medium/memory+checks, Windows 손자 프로세스 정리 및 병렬 테스트 정리 실패(같은 유형, 실환경 검증 병행) |
| 5 | `fix/state-eventids-set` | STATE-01 | S | medium/memory, O(n) 탐색 제거 |
| 6 | `docs/fix-close-branch-cleanup` | CLOSE-01 | XS | medium/architecture, close 절차에 브랜치 정리 단계 추가 |
| 7 | `refactor/ledger-read` | F-04 | S | medium/memory, ledger 역방향 읽기(극단적 시나리오 대응) |
| 8 | `docs/fix-rules-and-version` | DOCS-01, DOCS-02, DOCS-03, LAUNCH-02 | S | low/checks, 정본 문서 규칙 추가·버전 정책 수정·문서 충돌 해소 |
| 9 | `test/add-unit-tests` | TESTS4-08, P-09, P-10 | S | low/checks, usage-ledger·incidents 단위 테스트 추가 |
| 10 | `fix/minor-checks` | STATE-04, STATE-05, DOCS-04, DOCS-07, DOCS-09 | XS-S | low/checks, 예외 무음·미사용 export·문서 정합성 정리 |
| 11 | `fix/legacy-compat` | DOCS-06 | XS | low/architecture, pre-1.1 호환 파일 사용 여부 확인 후 제거 |

### 특이 사항

- **F-05·CHECKS-INT-01·STATE-02의 Windows 프로세스 트리 문제**: F-05(headless-runner 손자 프로세스 정리 미보장)·CHECKS-INT-01(병렬 테스트 시 t.after rmSync EPERM)·STATE-02(overflow 후 close 미착신)가 같은 근본 원인(Windows 프로세스 트리 종료 미보장)을 공유하므로 함께 수정하는 것을 권고한다.
- **F-01·F-02 캐시 설계**: F-01 캐시 추가와 F-02 tail 읽기 전환은 `headlessStatus`의 파싱 경로를 함께 변경하므로 하나의 PR로 묶는 것이 안전하다.
- **TESTS4-07**: `npm test` 전체를 한 번의 실행으로 완료하려면 300초 제한을 늘리거나 가장 느린 테스트(deliver, worker allowance)의 원인을 조사해야 한다. 이는 단기 수정보다 별도 조사 태스크로 다루는 것을 권고한다.

## 남은 사항

- 결론 문장과 합계 문장의 발견 수치(memory medium, checks medium·low)는 PM이 요약표와 항목별 심각도에 맞춰 직접 정정했다. Junior·Senior 프로필의 Agy 할당량이 소진되어(429 RESOURCE_EXHAUSTED) 하위 역할에 맡길 수 없었고, 이사가 이 예외를 승인했다.

---

## 부록: F-01·F-02 수정 전후 측정 수치 (fix-headless-stream-read, 2026-09-20)

측정 환경: macOS, Node.js v26.7.0. 스크립트는 워크트리 밖 `/tmp/omt-measure-{before,after}.mjs`(커밋 안 함).

### F-01: `codexRolloutModel` sessions 트리 탐색 비용

수정 전 — 호출마다 sessions 트리를 전체 재귀 탐색:

| 세션 파일 수 | 1회 탐색 시간(ms) | RSS 증가(MB) |
|---|---|---|
| 100 | 0.7 | 2.5 |
| 1,000 | 1.3 | 0.1 |
| 5,000 | 5.0 | 4.0 |

수정 후 — 첫 조회만 탐색하고 이후는 프로세스 수명 캐시(`Map`) 적중:

| 세션 파일 수 | 1차 탐색(ms) | 캐시 히트(ms) |
|---|---|---|
| 100 | 0.5 | 0.000 |
| 1,000 | 1.3 | 0.000 |
| 5,000 | 3.7 | 0.000 |

반복 폴링(waitHeadless 1초, dashboard 2.5~4초) 경로에서 세션 파일이 5,000개일 때 폴링 1회당 5ms → 0ms(캐시 적중)로 개선.

> cache-null-model-stale 수정(후속 커밋)으로 `turn_context`가 아직 기록되지 않은 경우(`model = null`)는 캐시에 저장하지 않게 바뀌어, 해당 상태에서는 매 폴링마다 재탐색이 일어난다. 모델이 확정된 이후의 캐시 적중 동작(위 수치의 전제)은 그대로 유지된다.

### F-02: `headlessStatus` stream.jsonl 읽기 비용

수정 전 — `readFileSync`로 전체 읽기 후 `split(/\r?\n/)`→`JSON.parse`:

| 파일 크기(MB) | 줄 수 | 시간(ms) | RSS 증가(MB) |
|---|---|---|---|
| 1.0 | 9,711 | 5.1 | 3.6 |
| 10.0 | 97,092 | 43.1 | 53.5 |
| 50.0 | 485,453 | 204.7 | 228.3 |

수정 후 — head 4KB + tail 64KB fd 읽기(파일이 68KB 미만이면 전체 읽기):

| 파일 크기(MB) | 읽은 KB | 시간(ms) | RSS 증가(MB) |
|---|---|---|---|
| 1.0 | 136.0 | 1.7 | 0.2 |
| 10.0 | 136.0 | 1.4 | 0.0 |
| 50.0 | 136.0 | 1.3 | 0.1 |

> 읽은 136KB = headlessStatus 직접 1회(4+64KB) + headlessUsageSummary→readTurn 1회(4+64KB). 파일 크기가 1MB→50MB로 50배 늘어도 읽는 바이트는 고정. RSS 증가는 50MB 기준 228MB → 0.1MB로 약 2,300배 감소.

## 부록: F-03·F-06 수정 전후 측정 수치 (fix-usage-sources-stream, 2026-09-20)

측정 환경: macOS, Node.js v26.7.0. 스크립트는 워크트리 밖 `/tmp/omt-measure-f03/{before,after}.mjs`(커밋 안 함).
선택 근거: 호출자 2곳(`collectClaudeTranscripts`, `readCodexRollout`)이 모두 동기 함수이며, 비동기 readline으로 전환하면 공개 export 시그니처까지 변경되므로, 동기 경로를 유지한 채 청크 단위로 읽어 줄 경계에서 처리하는 방식을 선택했다.

### F-03: `eachJsonLine` 전체 파일 읽기 비용

수정 전 — `readFileSync`로 파일 전체 읽기 후 `split(/\r?\n/)` 전체 줄 배열 생성:

| 파일 크기(MB) | 줄 수 | 시간(ms) | RSS 증가(MB) |
|---|---|---|---|
| 10.0 | 45,004 | 36 | 41.6 |
| 50.0 | 225,017 | 174 | 178.4 |

수정 후 — 64 KiB 청크 단위 동기 읽기 + `StringDecoder` 경계 처리:

| 파일 크기(MB) | 줄 수 | 시간(ms) | RSS 증가(MB) |
|---|---|---|---|
| 10.0 | 45,004 | 33 | 4.3 |
| 50.0 | 225,017 | 158 | 4.9 |

> RSS 증가는 50MB 기준 178MB → 4.9MB로 약 36배 감소. 처리 시간은 유사(33~36ms / 158~174ms). 한 번에 보유하는 메모리는 청크(64 KiB) + tail 한 줄 분량으로 파일 크기와 무관하게 고정된다.

