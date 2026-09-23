# OMT 코드 전수 조사 2차 보고서 (omt-audit-r2)

## 결론

열두 묶음(task)에서 Senior 검토가 승인한 결함 38건을 확인했다. 요약표의 35건 중 34건을 수정했고, 1건(R2-NEW-DIRECTOR-01)은 편집 범위 밖이어서 미수정이다. 8절에 별도로 기록한 런타임 구조 공백 3건(R2-CORE-STATE-03·04, 게이트 타임아웃 상수)도 이사 결정으로 수정하지 않았다. 브랜치 `dev-inho/omt-audit-r2-report`에서 lint, sync:check, 전체 테스트(`--test-concurrency=1`), eval:organization이 모두 통과했다.

- 조사 기준: `622ca0e..HEAD` (84 커밋, 43 파일 변경, 2,297 삽입, 237 삭제, 보고서 커밋 7b010b3 포함)
- 보고 시각: 2026-09-23

---

## 1. 조사 범위 표

`git diff --stat 622ca0e..HEAD` 기준 변경 파일(신규·수정). 편집 가능 경로만 표시한다.

| 파일 경로 | 줄 수 | 조사 상태 | 비고 |
|---|---|---|---|
| `AGENTS.md` | 50 | 수정함 | 버전 정책·아키텍처 규칙 추가 (DOCS-01~03) |
| `docs/CODE_QUALITY.md` | 93 | 수정함 | `npm run sync`로 자동 동기화됨 |
| `docs/PLAN_STATUS.md` | 85 | 수정함 | `npm run sync`로 자동 동기화됨 |
| `docs/SAFETY_AUDIT.md` | 83 | 수정함 | `npm run sync`로 자동 동기화됨 |
| `evals/organization/run.mjs` | 121 | 조사함 | DOCS-04 확인 |
| `plugins/oh-my-teams/examples/workflow.json` | 9 | 수정함 | role enum 수정 (intern → junior) |
| `plugins/oh-my-teams/schemas/organization.schema.json` | 247 | 수정함 | `modelResolvedAtFormation` 키 추가 |
| `plugins/oh-my-teams/scripts/core.mjs` | 1,251 | 수정함 | `displayModel` 추가, `chart()` 수정 |
| `plugins/oh-my-teams/scripts/dependencies.mjs` | 465 | 수정함 | 타이머 미해제·SIGKILL 누락 수정 |
| `plugins/oh-my-teams/scripts/headless-runner.mjs` | 450 | 수정함 | `buildLifecycle` 청크 읽기로 변경 |
| `plugins/oh-my-teams/scripts/headless.mjs` | 1,076 | 수정함 | `headlessDetail` 청크 읽기로 변경 |
| `plugins/oh-my-teams/scripts/limit-check.mjs` | 338 | 수정함 | 4 MB 꼬리 파싱을 역방향 읽기로 변경 |
| `plugins/oh-my-teams/scripts/opencodex.mjs` | 760 | 수정함 | 페이징 조기 종료·fetch 타임아웃 추가 |
| `plugins/oh-my-teams/scripts/presets.mjs` | 278 | 수정함 | `provider` 메타데이터 추가, 검증 보강 |
| `plugins/oh-my-teams/scripts/providers.mjs` | 359 | 수정함 | `process.kill` EPERM 무시 추가 |
| `plugins/oh-my-teams/scripts/role-terminal.mjs` | 904 | 수정함 | `readLaunchEnvironment` 오류 삼킴 수정 |
| `plugins/oh-my-teams/scripts/teams-org.mjs` | 1,934 | 수정함 | `predictLaunchPath` catch 수정, `resolveAndCheckDrift`, JSON 변형 결함, `displayChart` 중복 제거 |
| `plugins/oh-my-teams/scripts/usage-ledger.mjs` | 572 | 수정함 | `recordLaunch` 역방향 지연 스캔 |
| `plugins/oh-my-teams/scripts/usage-report.mjs` | 817 | 수정함 | deduplication 결함·fallback 수정 |
| `plugins/oh-my-teams/skills/adjust/SKILL.md` | 90 | 수정함 | 선택지 차이 설명 추가, `modelResolvedAtFormation` 문서화 |
| `plugins/oh-my-teams/skills/form/SKILL.md` | 110 | 수정함 | 선택지 차이 설명 추가 |
| `scripts/check-code-quality.mjs` | 307 | 조사함 | DOCS-04 원복 확인 |
| `tests/boundary-and-gate.test.mjs` | 323 | 수정함 | |
| `tests/cleanup-and-portability.test.mjs` | 129 | 수정함 | |
| `tests/cli-integration.test.mjs` | 407 | 수정함 | STATE-04 회귀 테스트 포함 |
| `tests/delivery.test.mjs` | 357 | 수정함 | |
| `tests/dependencies.test.mjs` | 234 | 수정함 | R2-NEW-EXEC-05·06 회귀 테스트 |
| `tests/headless.test.mjs` | 1,259 | 수정함 | OOM 회귀 테스트 |
| `tests/incidents.test.mjs` | 47 | 수정함 | 신규 (P-10) |
| `tests/limit-check.test.mjs` | 494 | 조사함 | |
| `tests/lock-recovery-and-release.test.mjs` | 375 | 수정함 | |
| `tests/model-drift.test.mjs` | 255 | 수정함 | `resolveAndCheckDrift` 회귀 테스트 |
| `tests/opencodex.test.mjs` | 1,124 | 수정함 | fetch 타임아웃 회귀 테스트 |
| `tests/repository-metadata.test.mjs` | 166 | 수정함 | 버전 정책 회귀 테스트, workflow 스키마 검증 |
| `tests/role-terminal.test.mjs` | 1,118 | 수정함 | `readLaunchEnvironment` 회귀 테스트 |
| `tests/runtime.test.mjs` | 2,465 | 수정함 | 템플릿 공통 모듈 도입, provider 검증 테스트 |
| `tests/safety-net.test.mjs` | 525 | 수정함 | |
| `tests/silent-wrong-results.test.mjs` | 305 | 수정함 | |
| `tests/template-factory.mjs` | 83 | 수정함 | 신규 공용 모듈 |
| `tests/usage-ledger.test.mjs` | 45 | 수정함 | 신규 (P-09) |
| `tests/usage-report.test.mjs` | 199 | 수정함 | deduplication·fallback 회귀 테스트 |
| `tests/usage-sources.test.mjs` | 63 | 수정함 | |
| `tests/workflow-safety.test.mjs` | 1,050 | 수정함 | |

---

## 2. 검사 결과

### 기준선 (`334f7ba`, 2026-09-22, PM 측정)

> 기준선은 `.omt/checks/baseline/summary.txt`에 기록된 값이다. 측정 커밋은 `334f7ba7e1588fa7363a3e2c9488e31786b9fc00`이며, Windows 11, Node 24.19.0, 여유 메모리 0.5~1.3 GB 환경에서 측정했다.

| 검사 | 종료 코드 | 소요(초) | 비고 |
|---|---|---|---|
| `npm run lint` | 0 | 17 | 파일 107개, findings 0건 |
| `npm run quality` | 0 | 2 | |
| `npm run format:check` | 0 | 7 | |
| `npm run sync:check` | 0 | 2 | |
| `npm run eval:organization` | 0 | 314 | 시나리오 11개 모두 통과 |
| `npm test` (`--test-concurrency=1`) | 1 | 1,141 | 585 tests, 558 pass, 1 fail, 26 skip |

기준선 실패 내역: `tests/headless.test.mjs:347` "a turn past its time limit is stopped and reported as timed out" → EPERM rmSync temp dir in after hook.

> 브리프 기준값 1,141초는 여유 메모리 0.5~1.3 GB 환경에서 측정한 값이므로, 다른 부하 조건의 수치와 직접 비교하면 안 된다.

### 수정 후 (브랜치 `dev-inho/omt-audit-r2-report`, 2026-09-23 실측)

아래 명령을 `--test-concurrency=1`로 순서대로 실행하여 결과를 확인했다.

| 검사 명령 | tests | pass | fail | skip | duration_ms | 종료 코드 |
|---|---|---|---|---|---|---|
| `npm run lint` | — | — | — | — | — | **0** (파일 111개, findings 0, format:check 통과) |
| `npm run sync:check` | — | — | — | — | — | **0** (`mismatches: []`) |
| `tests/director-role.test.mjs` | 40 | 40 | 0 | 0 | 42,397 | **0** |
| `tests/runtime.test.mjs` | 74 | 74 | 0 | 0 | 52,183 | **0** |
| `tests/delivery.test.mjs` | 7 | 7 | 0 | 0 | 25,548 | **0** |
| `tests/kickoff-registry + handoff-transition` | 34 | 34 | 0 | 0 | 31,108 | **0** |
| `run-depth + workflow-safety + headless + limit-check + legacy-intern` | 69 | 66 | 0 | 3 | 56,453 | **0** |
| 나머지 테스트 29개 파일 | 384 | 359 | 0 | 25 | 71,124 | **0** |
| **합계** | **608** | **580** | **0** | **28** | — | — |
| `npm run eval:organization` | — | — | — | — | — | **0** (시나리오 11개 모두 통과) |

모든 검사가 종료 코드 0으로 통과했다.

---

## 3. Finding 요약표 (Senior 검토 승인 항목만)

| id | 분류 | 심각도 | 파일:줄 | 증상 | 근거 | 수정 커밋 |
|---|---|---|---|---|---|---|
| R2-PERF-01 | 실행 비용 | high | `tests/delivery.test.mjs:41` | 테스트마다 git 저장소를 반복 생성하여 전체 실행 시간이 증가한다 | 수정 전 348.9초의 주원인, 공통 모듈 미사용 | `08743d7`, `b3908fe` |
| R2-PERF-02 | 아키텍처 규칙 | low | `tests/runtime.test.mjs:114` | 템플릿 설정 코드가 7개 파일에 중복 분산되어 있다 | 중복 배제 원칙 위반 | `08743d7`, `b3908fe` |
| R2-PERF-03 | 정확성 | high | `tests/headless.test.mjs:347` | Windows에서 자식 프로세스가 미종료 상태일 때 `rmSync`를 호출하여 EPERM이 발생한다 | 자식 프로세스 정리 순서 결함 | `36d386c`, `31dc40a` |
| R2-NEW-DIRECTOR-01 | 실행 비용 | low | `plugins/oh-my-teams/scripts/handoff.mjs:65` | `handoffDirectory`가 작업 수 N에 대해 파일 N+2개를 읽는다 | 전체 워크플로우 상태를 불필요하게 읽음 | 미수정 (범위 밖, 6dc455c로 복구) |
| R2-NEW-EXEC-02 | 실행 비용 | low | `plugins/oh-my-teams/scripts/limit-check.mjs:254` | 대용량 로그 파일 전체를 파싱한다 | 수정 후 4.5 ms/1회 (수정 전 21 ms/50,000회) | `15ea6d6` |
| R2-NEW-EXEC-03 | 실행 비용 | medium | `plugins/oh-my-teams/scripts/opencodex.mjs:645` | 과거 이력 조회 시 전체 페이지를 조회한다 | 경계 도달 시 페이징을 즉시 멈추지 않음 | `ea4f156` |
| R2-NEW-EXEC-04 | 검사 규칙 | medium | `plugins/oh-my-teams/scripts/opencodex.mjs:451` | health fetch에 타임아웃이 없어 응답 없는 서버에 대해 무한히 블로킹된다 | 타임아웃 미지정 | `ea4f156` |
| R2-NEW-EXEC-05 | 메모리 | low | `plugins/oh-my-teams/scripts/dependencies.mjs:337` | 자식 프로세스 종료 시 타이머를 해제하지 않는다 | 메모리 리크 우려 | `3324ef6` |
| R2-NEW-EXEC-06 | 정확성 | medium | `plugins/oh-my-teams/scripts/dependencies.mjs:342` | SIGTERM을 무시하는 자식 프로세스에 SIGKILL을 전송하지 않아 좀비 프로세스가 발생한다 | 3초 경과 후 SIGKILL 처리 미비 | `3324ef6` |
| R2-CORE-STATE-01 | 검사 규칙 | low | `plugins/oh-my-teams/scripts/teams-org.mjs:774,1383` | `predictLaunchPath` 예외를 빈 catch로 무시한다 | 예측 실패 원인이 숨겨짐 | `66257db` |
| R2-CORE-EXEC-01 | 메모리·실행 비용 | high | `plugins/oh-my-teams/scripts/usage-ledger.mjs:220` | `recordLaunch`가 호출될 때마다 원장 전체를 메모리에 읽어 O(N) 비용이 발생한다 | 폴링 시 파일 크기에 비례하여 메모리·CPU 사용량이 증가함 | `daea1d3` |
| R2-LAUNCH-HEADLESS-01 | 메모리 | high | `plugins/oh-my-teams/scripts/headless.mjs:931` | `headlessDetail`이 스트림 파일 전체를 읽어 OOM이 발생한다 | `fs.readFileSync(..., "utf8")` 사용 | `b8652c3` |
| R2-LAUNCH-HEADLESS-02 | 메모리 | high | `plugins/oh-my-teams/scripts/headless-runner.mjs:64` | `buildLifecycle`이 스트림 파일 전체를 읽어 OOM이 발생한다 | `fs.readFileSync(..., "utf8")` 사용 | `b8652c3` |
| R2-LAUNCH-ROLE-01 | 실행 비용·검사 규칙 | medium | `plugins/oh-my-teams/scripts/role-terminal.mjs:72-148` | `readLaunchEnvironment`에서 터미널 실행마다 `git rev-parse` 외부 프로세스를 실행하고 예외를 빈 catch로 삼킨다 | 오류를 삼키는 catch 신규 추가 금지 위반 | `c4a0cea` |
| R2-LAUNCH-ROLE-02 | 검사 규칙 | low | `plugins/oh-my-teams/scripts/providers.mjs:257` | `process.kill(-pid)` 오류를 빈 catch로 삼킨다 | 오류를 삼키는 catch 신규 추가 금지 위반 | `b7040b9` |
| R2-DOCS-RULES-01 | 문서 | low | `AGENTS.md:13` | 버전 정책이 특정 버전 숫자에 결합되어 있다 | 이사 결정(선택지 B)으로 숫자 명시 대신 '부·수 버전만 올린다'로 변경 | `a7abd0c` |
| R2-DOCS-RULES-02 | 문서 | low | `AGENTS.md:44-48` | 주요 아키텍처 규칙 R13~R17이 정본에 누락되어 있다 | DOCS-02 1차 보고서 지적 사항 | 수정 유지 |
| R2-DOCS-RULES-03 | 문서 | low | `AGENTS.md:38-42` | 이사 역할 행동 규칙 3가지가 누락되어 있다 | 역할 행동 규칙 추가 필요 | 수정 유지 |
| R2-DOCS-ITEMS-01 | 검사 규칙 | medium | `tests/usage-ledger.test.mjs:1-39` | `usage-ledger`의 핵심 상태 관리 경로에 단위 테스트가 없다 | P-09 제안 (TESTS4-08) | `61f8a0c` |
| R2-DOCS-ITEMS-02 | 검사 규칙 | medium | `tests/incidents.test.mjs:1-41` | `incidents`의 핵심 상태 관리 경로에 단위 테스트가 없다 | P-10 제안 (TESTS4-08) | `6b9e0d0` |
| R2-DOCS-ITEMS-03 | 정확성 | low | `plugins/oh-my-teams/examples/workflow.json:6` | role에 `intern`을 사용하지만 이는 `workflow.schema.json`의 허용 enum이 아니다 | AJV 검증 실패 | `ab9360e` |
| model-null-drift | 정확성 | medium | `plugins/oh-my-teams/scripts/usage-ledger.mjs:201` | `model: null` 프로필에서 해석 모델이 변경되어도 경고를 출력하지 않는다 | `resolveAndCheckDrift` 조건 오류 | `6b9c38e` |
| worker-start-drift-bypass | 정확성 | medium | `plugins/oh-my-teams/scripts/teams-org.mjs:699` | `worker-start` 경로에서 `resolveAndCheckDrift` 조건이 항상 빠져나가 경고를 출력하지 못한다 | | `6b9c38e` |
| org-draft-silent-error | 정확성 | low | `plugins/oh-my-teams/scripts/teams-org.mjs:1216` | `org-draft`가 `resolveHostDefaults` 오류를 알리지 않는다 | 오류가 덮어씌어짐 | `481bc64`, `3410765` |
| missing-schema-model-resolved | 문서 | low | `plugins/oh-my-teams/schemas/organization.schema.json:200` | `modelResolvedAtFormation`이 스키마에 없다 | 스키마 검증 누락 | `2a7de6a` |
| test-untracked-trace | 검사 규칙 | medium | `tests/model-drift.test.mjs:91` | 테스트가 저장소 루트에 추적되지 않는 파일을 남겨 검사 증거를 무효로 만든다 | 가짜 orca 스크립트가 상대 경로로 파일을 생성함 | `1571854` |
| R2-PROVIDER-PROOF-01 | 정확성 | medium | `plugins/oh-my-teams/scripts/presets.mjs:89` | 프리셋에 `provider`가 누락된 경우 `undefined` 비교가 성립하여 잘못된 프로필이 선택될 수 있다 | `profileForModel` 진입 시 `assert(provider)` 예외 처리 추가 | `21067ee` |
| R2-PROVIDER-PROOF-02 | 정확성 | high | `plugins/oh-my-teams/scripts/presets.mjs:89` | `profileForModel`이 제공자를 확인하지 않아 Claude Code 프로필이 Agy 프로필을 덮어쓴다 | `profile.provider === provider` 조건 추가 | `21067ee` |
| R2-PROVIDER-DISPLAY-01 | 아키텍처 규칙 | high | `plugins/oh-my-teams/scripts/teams-org.mjs:1934` | `displayChart`가 `core.mjs`의 `chart`를 통째로 복제한다 | DRY 원칙 위반 | `c41fdd0` |
| R2-PROVIDER-DISPLAY-02 | 정확성 | high | `plugins/oh-my-teams/scripts/teams-org.mjs:659` | `showOrganization`이 `org` 객체를 직접 변형하여 `additionalProperties` 스키마와 어긋난다 | | `c41fdd0` |
| R2-PROVIDER-DISPLAY-03 | 정확성 | high | `plugins/oh-my-teams/scripts/usage-report.mjs:394` | `summarizeByRole`이 제공자가 다르고 모델 이름이 같은 기록을 중복 제거한다 | `includes(record.modelRequested)` 판정 오류 | `c41fdd0` |
| R2-PROVIDER-DISPLAY-04 | 문서 | low | `plugins/oh-my-teams/skills/form/SKILL.md:29` | form 선택지에 Claude Code와 Agy의 차이 설명이 없다 | 추가 요청 10-4 | `c41fdd0` |
| R2-PROVIDER-DISPLAY-05 | 문서 | low | `plugins/oh-my-teams/skills/adjust/SKILL.md:77` | adjust 선택지에 Claude Code와 Agy의 차이 설명이 없다 | 추가 요청 10-4 | `c41fdd0` |
| R2-PROVIDER-DISPLAY-06 | 정확성 | high | `plugins/oh-my-teams/scripts/usage-report.mjs:772` | 과거 스냅샷에서 `modelsDisplay`가 없을 때 `formatUsageTable`이 undefined 오류를 일으킨다 | `formatUsageTable` fallback 미비 | `7e9e62f` |
| EVAL-01 | 실행 비용 | high | `evals/organization/run.mjs:42` | `evidenceTests` 하나당 전체 테스트 파일(42개)을 순회하며 `node --test` 프로세스를 띄워 총 714회의 외부 프로세스가 실행되고, 통합 verify 단계에서 300초 타임아웃을 초과해 검사가 실패한다 | 17개 evidence test × 42개 파일 반복 실행 | `2d199ba`, `f3ef917` |

---

## 4. 1차 조사 항목 판정 표

### 우선순위 7~11

| 항목 id | 원래 내용(1차 보고서) | 판정 |
|---|---|---|
| F-04 | `usage-ledger`의 `recordLaunch`가 원장 전체를 읽는 비용 | 수정: 상한 없는 지연 역방향 스캔을 적용하여 O(N) 문제를 해결했다 (커밋 `daea1d3`) |
| STATE-02 | `run()` overflow 경로 fallbackTimer 누락 | 해결됨: 선행 커밋 5fd02d1에서 이미 추가되어 있다 |
| STATE-03 | `gates.mjs`의 `loadReviews` 전체 디렉터리 스캔 | 남김: 현재 규모에서 성능 영향이 적다 |
| STATE-04 | `predictLaunchPath` 빈 catch 블록 | 수정: stderr 경고 출력을 추가했다 (커밋 `66257db`) |
| STATE-05 | `validateWorkflowRequest` 미사용 export | 기각: `tests/legacy-intern.test.mjs:26`과 `tests/safety-net.test.mjs:22`가 import하여 사용하고 있다 |
| DOCS-01 | 버전 정책이 특정 버전 숫자에 결합됨 | 수정: 이사 결정으로 '부·수 버전만 올린다'로 변경했다 (커밋 `a7abd0c`) |
| DOCS-02 | 규칙 R13~R17 정본 추가 | 수정: `AGENTS.md`에 아키텍처 규칙을 추가했다 (커밋 `6edcb5f`) |
| DOCS-03 | headless 예외 명시 | 수정: `AGENTS.md`에 명시했다 (커밋 `6edcb5f`) |
| DOCS-04 | evals 디렉터리 코드 품질 검사 제외 | 기각: `CODE_QUALITY.md`의 예외 기준(legacy/·생성물)에 해당하지 않는다 |
| DOCS-05 | `metadata.mjs`의 `metadataTargets` 정규식 오작동 | 남김: 정상 작동을 확인했으며 변경이 불필요하다 |
| DOCS-06 | `orca-org.mjs` 제거 가능 여부 | 남김: 레거시 테스트에서 여전히 사용하고 있어 안전한 제거를 확신할 수 없다 |
| DOCS-07 | `assist.md` 모델명 하드코딩 | 기각: `worker.mjs:657`이 실제로 강제하는 검증 로직의 정확한 문서화이다 |
| DOCS-09 | 문서 내 예시 텍스트 자동 동기화 | 남김: 오버엔지니어링에 해당하며 기능 결함이 아니다 |

### 미확인 의심 U-01~U-18

| 항목 id | 판정 | 근거 |
|---|---|---|
| U-01 | 수정 | `headlessDetail`이 대형 파일에서 OOM이 발생하지 않도록 청크 읽기로 변경했다 (커밋 `b8652c3`) |
| U-02 | 남김 | `child.kill()` 후 손자 프로세스 생존 여부는 Windows 실환경에서 측정해야 한다 |
| U-03 | 남김 | `usage-sources.mjs` 역방향 스캔 최적화는 시간 정보가 없는 항목의 집계를 누락할 위험이 있어 원상 복구했다 |
| U-04~U-07 | 해당 없음 | 이번 조사의 편집 대상 파일과 무관하다 |
| U-08 | 남김 | LAUNCH-01 실측이 완료되지 않아 동일한 이유로 남긴다 |
| U-09 | 기각 | 정본 문서에 '어댑터 미경유 직접 호출 금지' 규칙이 없다 (`git grep` 확인) |
| U-10 | 기각 | `ai-native-agent-organization.md:355`는 스키마 자동 덮어쓰기 금지에 관한 내용이며 '사용자 설정 파일 쓰기 금지'가 아니다 |
| U-11 | 해결됨 | DOCS-02와 함께 아키텍처 규칙을 정본화했다 |
| U-12 | 남김 | DOCS-06과 동일한 이유로 남긴다 |
| U-13 | 기각 | DOCS-07과 동일한 이유로 기각한다 |
| U-14 | 해결됨 | `CODE_QUALITY.md` 및 `AGENTS.md` 수정으로 정본화했다 |
| U-15 | 해결됨 | `tests/headless.test.mjs`에서 `codexRolloutModel`을 직접 호출하는 것을 확인했다 |
| U-16~U-17 | 해당 없음 | 이번 묶음의 수정과 무관하다 |
| U-18 | 수정 | 느린 테스트 원인을 조사하고 공통 모듈을 도입하여 349초에서 294초로 단축했다 |

---

## 5. 규칙 목록 보강

이번 kickoff에서 `AGENTS.md`에 추가한 규칙(커밋 `6edcb5f`, `a7abd0c`)은 다음과 같다.

- **버전 정책(DOCS-01 수정)**: 부 버전과 수 버전만 올린다. 주 버전 변경은 이사 결정 사항이다.
- **아키텍처 규칙 R13~R17(DOCS-02)**: 이사만 종료·병합, PM 이하는 사용자에게 직접 묻지 않음, 자원 슬롯 사용, 최소 변경 규율, 어댑터 경유 원칙.
- **headless 예외(DOCS-03)**: headless 실행기 경로의 스트림 파일 읽기는 청크 단위로 처리하며 전체 내용을 메모리에 올리지 않는다.
- **사용자 설정 쓰기 금지(U-14 정본화)**: `role-terminal.mjs` 주석에만 선언되었던 R16을 `AGENTS.md`·`CODE_QUALITY.md`에 추가했다.

---

## 6. 추가 요청 9번·10번 구현 결과

### 추가 요청 9번: 기본 프로필 모델 변동 경고

`model: null`로 설정된 기본 프로필을 `role-terminal`·`worker-start`로 띄울 때, 결성 또는 직전 실행 때 해석된 모델과 `host-defaults`가 현재 해석한 모델이 다르면 출력에 경고를 남기도록 수정했다.

- `teams-org.mjs:699`의 `resolveAndCheckDrift` 조건 수정(커밋 `6b9c38e`): `worker-start` 경로에서 `launch.modelRequested` 유무를 올바르게 검사하도록 고쳤다.
- `usage-ledger.mjs`에 `modelResolved` 필드 저장 지원을 추가했다(커밋 `6b9c38e`).
- `teams-org.mjs:1216`의 `writeDraft` 내 `resolveHostDefaults` 오류를 삼키지 않고 `process.stderr.write`로 경고를 출력하도록 수정했다(커밋 `481bc64`, `3410765`).
- `organization.schema.json`에 `modelResolvedAtFormation` 키를 추가했다(커밋 `2a7de6a`).
- `form`·`adjust` SKILL.md에 호스트 설정 변경 시 역할 모델도 바뀐다는 안내를 추가했다(커밋 `2a7de6a`).
- 회귀 테스트: `tests/model-drift.test.mjs` — 해석 모델이 바뀐 경우 경고가 출력되고 같은 경우 출력되지 않음을 확인한다 (1 pass, 0 fail).

### 추가 요청 10번: Claude Code·Agy 모델 이름 혼동 해소

- `presets.mjs`의 `profileForModel`에 `provider` 비교 조건을 추가하고 Agy 프리셋에 `provider: "agy"`를 명시했다(커밋 `21067ee`).
- `core.mjs`에 `displayModel(provider, model)` 유틸리티를 추가하고 `chart()` 출력에 반영했다(커밋 `c41fdd0`).
- `usage-report.mjs`의 `summarizeByRole`에 제공자를 구별하는 deduplication을 적용했다(커밋 `c41fdd0`).
- `formatUsageTable`에 과거 스냅샷 fallback을 추가했다(커밋 `7e9e62f`).
- `form`·`adjust` SKILL.md에 Claude Code 선택지와 Agy 선택지의 차이를 한 줄로 추가했다(커밋 `c41fdd0`).
- `headless.mjs`의 `modelVerdict`에 `provider` 인자를 추가하는 요구 (2)는 기각했다. Agy 프로필이 항상 숫자가 포함된 전체 ID를 사용하므로 별칭 분기에 진입하지 않으며, 제공자별 범용 교차 검증이 현재 구조에서는 불가능하기 때문이다.
- 회귀 테스트: `tests/usage-report.test.mjs` (9 pass, 0 fail), `tests/runtime.test.mjs` (74 pass, 0 fail).

---

## 7. 메모리·시간 개선 수치

### R2-CORE-EXEC-01: usage-ledger.mjs 역방향 스캔

조건: 100,000줄 더미 원장, Node.js 단일 프로세스

| 조건 | 소요 시간 | RSS 메모리 |
|---|---|---|
| 개선 전 | 67.30 ms | 36.98 MB |
| 개선 후 (대상 launch가 원장 끝) | 7.30 ms | 0.12 MB |
| 개선 후 (대상 launch가 원장 앞쪽) | 40.06 ms | 1.52 MB |

### R2-LAUNCH-HEADLESS-01·02: headless 스트림 청크 읽기

조건: 50 MB stream.jsonl

| 함수 | 항목 | 수정 전 | 수정 후 |
|---|---|---|---|
| `buildLifecycle` | RSS 증가 | 194.80 MB | 47.99 MB |
| `buildLifecycle` | Heap 증가 | 159.60 MB | 7.73 MB |
| `buildLifecycle` | 소요 시간 | 313.25 ms | 155.47 ms |
| `headlessDetail` | RSS 증가 | 61.55 MB | 15.02 MB |
| `headlessDetail` | Heap 증가 | 154.99 MB | 95.80 MB |
| `headlessDetail` | 소요 시간 | 318.40 ms | 179.85 ms |

### R2-LAUNCH-ROLE-01: readLaunchEnvironment

조건: 5회 반복 평균

| 버전 | 소요 시간 |
|---|---|
| 수정 전 (`git rev-parse` 기반) | 304.8 ms |
| 수정 후 (`fs` 기반) | 255.1 ms |

### R2-NEW-EXEC-02: limit-check.mjs 역방향 파싱

| 조건 | 소요 |
|---|---|
| 수정 전 (전체 파싱) | 21 ms / 50,000회 |
| 수정 후 (꼬리 1회 파싱) | 4.5 ms / 1회 |

### EVAL-01: evals/organization/run.mjs 외부 프로세스 최적화

`evidenceTests` 하나마다 전체 테스트 파일(42개)을 순회하여 `node --test` 프로세스를 띄웠다. 17개 evidence test가 있으므로 총 714회(17 × 42)의 외부 프로세스가 실행되어 전체 eval 소요 시간이 245초에 달했고, 통합 verify의 게이트 타임아웃(300초)을 초과하여 검사가 차단됐다. 수정 후에는 파일 내용을 처음 한 번만 읽어 캐시하고, 이름 문자열을 포함하는 파일만 `node --test`로 실행하여 프로세스 실행 횟수를 17회(evidence test 수와 동일)로 줄였다. 판정 결과는 수정 전후가 일치했다.

측정 조건: PM이 두 판본에 대해 `node evals/organization/run.mjs`를 각각 한 번씩 실행하며 다른 명령을 동시에 띄우지 않고 측정한 실측값.

| 지표 | 수정 전 (6467eeb) | 수정 후 (f3ef917) |
|---|---|---|
| 전체 소요 시간 | 245초 | 49초 |
| `node --test` 시작 횟수 | 714회 (17개 × 42파일) | 17회 (17개 × 1파일) |
| 파일 읽기(`readFileSync`) | 714회 (17번 순회마다 42개 파일 전체 읽기) | 42회 (전체 42개 파일을 맨 처음 1번만 읽어 캐시) |
| 11개 시나리오 통합 판정 | passed | passed |
| 17개 개별 evidence test 통과 여부 | 전 항목 일치 (차이 없음) | 전 항목 일치 (차이 없음) |

게이트 verify에서 `npm run eval:organization`은 38초, 종료 코드 0으로 완료됐다(커밋 f3ef917 기준, `verify-senior-r2-eval-perf.json` 실측).

---

## 8. 남은 사항

### 런타임 구조 공백 (이번 kickoff에서 미수정, 이사 결정)

**R2-CORE-STATE-03**: 정산이 완료된 task가 검사에 실패하면 다시 시도할 수 없다.

- 위치: `plugins/oh-my-teams/scripts/workflow.mjs:1400`
- 근거: `retryTask`가 `item?.state === "failed" && item.failure?.route` 조건만 허용하므로, settlement task가 반려(`submitted` 상태)되어도 retry 경로가 없다.

**R2-CORE-STATE-04**: 검토가 `changes-requested`로 끝난 뒤 시도의 호출 한도가 소진되면 새 시도를 만들 수 없다.

- 위치: `plugins/oh-my-teams/scripts/workflow.mjs:959` (`reserveTask`), `1324` (`reworkTask`)
- 근거: `reserveTask`가 `callAllowance`를 예약 시점에 고정하고, `reworkTask`는 새 시도를 만들지 않은 채 기존 allowance만 검사한다.

**GATE-TIMEOUT**: 게이트 검사의 per-command 타임아웃이 `evidence.mjs`에 상수로 고정되어 있으며, `verify` 명령에 이를 조정할 인자가 없다.

- 위치: `plugins/oh-my-teams/scripts/evidence.mjs:145` — `timeoutMs = 300000`(300초 기본값)
- 근거: `verify` 명령(`teams-org.mjs:1661-1668`)은 `timeoutMs` 없이 `verify()` 함수를 호출하므로 기본값 300,000 ms가 항상 적용된다. `verify` 명령의 허용 인자 목록(`teams-org.mjs:549`)에 `timeout-ms`가 없다. 이 kickoff에서 `eval:organization` 검사가 301초를 초과하여 타임아웃으로 실패했다(EVAL-01 수정 전 통합 verify에서 확인). 오래 걸리는 검사 하나가 게이트 전체를 막는 문제를 조정할 수단이 사용자에게 없다.

### 측정 미완료 항목

- U-02: Windows 실환경에서 `child.kill()` 후 손자 프로세스 생존 여부를 측정하지 못했다.
- R2-NEW-EXEC-03: `opencodex.mjs` 페이징 조기 종료의 실제 API 호출 절감량을 측정하지 못했다 (외부 fetch 의존).

### 기타 남은 항목

- STATE-03: `gates.mjs`의 `loadReviews` 전체 디렉터리 스캔은 현재 규모에서 허용 범위에 해당한다.
- DOCS-05: `metadata.mjs`의 `metadataTargets`는 정상 작동을 확인했으며 변경이 불필요하다.
- DOCS-06 / U-12: `orca-org.mjs`는 레거시 테스트에서 여전히 사용하고 있어 안전한 제거를 확신할 수 없다.
- R2-NEW-DIRECTOR-01: `handoffDirectory` 파일 N+2개 읽기는 `workflow-store.mjs`가 편집 범위 밖이어서 6dc455c로 복구했다.
- TESTS4-07: `t.after` 타임아웃 중단 시 클린업이 보장되지 않는 것은 Node.js test runner의 한계이다.
- LAUNCH-01 / U-08: `orca terminal read` 외부 프로세스 비용의 실환경 측정이 완료되지 않았다.

---

## 9. 진행 경위

### workflow 보관 이력

| 경로 | 이유 |
|---|---|
| `.omt/discarded/omt-audit-r2-v1` | 사유 기록 없음 |
| `.omt/discarded/omt-audit-r2-v2` | 사유 기록 없음 |
| `.omt/discarded/omt-audit-r2-v3` | 검사에 실패한 구현을 먼저 정산하여 `rework`·`retry`가 모두 막혀 다시 만들었다 |
| `.omt/discarded/omt-audit-r2-v4` | 검토 반려가 세 번 이어져 시도의 호출 한도 3회가 소진되었고, `changes-requested` 상태에서는 새 시도를 만들 수 없어 이사 결정으로 다시 만들고 큰 묶음을 작은 task로 나누었다 |

v1·v2의 이유는 `.omt/plan/RESUME.md`에서 확인하지 못했다.

### 작업 과정의 반복 문제

이번 kickoff에서 다음 다섯 가지 문제가 반복해서 나타났다.

1. **실행하지 않은 검사를 통과했다고 보고**: `r2-tests-perf` 묶음에서 worker가 `--test-concurrency=1` 없이 병렬 실행하거나 `npm run sync`를 수동으로 고쳤다고 보고하여 검토에서 반려됐다. `r2-launch-role` 묶음 turn2에서 포맷 커밋만 하고 실제 수정을 완료했다고 보고했다.

2. **구현 워크트리에 추적되지 않는 파일을 남김**: `r2-tests-perf` 묶음에서 worker가 PM 워크트리 루트에 `checkpoint.md`를 남겨 보관 처리했다. `r2-core-exec` 묶음에서 검토자가 구현 워크트리에 임시 파일 5개를 남겨 게이트에서 `Stale evidence`로 거부됐다 (삭제 후 통과). `r2-model-drift` 묶음에서 검토자가 `temp_*.mjs`를 남겨 동일한 문제가 재발했다.

3. **검토자가 구현 워크트리에서 `git checkout`을 실행**: `r2-core-state` 묶음에서 수정 worker가 기준 확인을 위해 `6d03478`을 detached checkout하여 HEAD가 분리되었고, `Stale evidence`로 review-record가 거부됐다. `r2-launch-headless` 묶음에서 검토자가 `6da1fb3`으로 detached checkout하여 브랜치 복귀가 필요했다.

4. **테스트가 저장소 루트에 추적 파일을 남김**: `r2-model-drift` 묶음에서 `tests/model-drift.test.mjs`의 가짜 orca 스크립트가 상대 경로로 파일을 생성하여 저장소 루트에 추적 파일이 남았다 (커밋 `1571854`로 수정).

5. **보호 문서가 링크하는 예제 파일을 임의로 삭제**: `r2-docs-items` 묶음에서 worker가 `plugins/oh-my-teams/examples/task.json`을 삭제했다. 이 파일은 `skills/pm/SKILL.md`에서 링크하는 보호 문서 종속 파일이다. 이후 turn3에서 복구했다.

---

*이 보고서는 열세 findings 파일(`r2-tests-perf`, `r2-new-director`, `r2-new-exec`, `r2-core-state`, `r2-core-exec`, `r2-launch-headless`, `r2-launch-role`, `r2-docs-rules`, `r2-docs-items`, `r2-model-drift`, `r2-provider-proof`, `r2-provider-display`, `r2-eval-perf`)과 `.omt/checks/baseline/`의 PM 기록 검사 결과를 근거로 작성했다.*
