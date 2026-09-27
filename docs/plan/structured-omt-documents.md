# `.omt` 정형 문서 체계 설계

이 문서는 브리프 `/Users/jinsungkim/orca/oh-my-teams/.omt/briefs/structured-omt-documents-2026-09-27.md`(revision `sha256:f9d5fae50ec0d020a9cf2e4b4566699853a3cee69935aa27c4a566049edde692`)가 요청한 첫 작업 파동의 산출물이다. 이 파동은 조사와 설계만 수행하며, 어떤 런타임·스키마·스킬·테스트도 바꾸지 않는다. 독립 검토를 통과한 뒤에야 두 번째 작업 파동이 이 설계를 구현한다.

## 1단계: 지속 객체 전수 조사

### 1.1 조사 방법과 완전성 근거

`.omt` 아래에 상태를 남기는 모든 지점을 찾기 위해 다음 명령으로 `plugins/oh-my-teams/scripts/*.mjs` 전체를 전수 검색했다.

```text
grep -rn "writeJSON(\|writeFileSync(\|appendFileSync(\|renameSync(" plugins/oh-my-teams/scripts/*.mjs
```

이 네 함수는 파일 시스템에 내용을 남기는 유일한 통로다. `writeJSON`(`plugins/oh-my-teams/scripts/core.mjs:232-238`)이 임시 파일에 쓴 뒤 `fs.renameSync`로 원자적으로 교체하는 공용 헬퍼이므로, JSON을 남기는 모든 지점이 이 함수를 거치거나(대부분) `fs.writeFileSync`/`fs.appendFileSync`를 직접 호출한다(로그·JSONL·마크다운처럼 JSON이 아닌 형식). 검색 결과로 나온 파일마다 그 주변 함수를 직접 읽어 다음을 확인했다. 결과는 아래 1.2절의 표에 정리한다.

- 어떤 논리 객체를 쓰는지와 그 경로 생성 규칙
- append-only(재작성 거부)인지, overwrite(덮어쓰기)인지, 파생 상태를 재계산해 덮어쓰는지
- 스키마로 검증하는지, 아니면 assert만으로 형태를 확인하는지

이 검색은 `.mjs` 소스 코드 자체에서 실행되는 모든 쓰기 경로를 대상으로 하므로, 새 모듈이 추가되어도 같은 명령을 다시 실행하면 같은 방법으로 완전성을 재확인할 수 있다. 이 grep을 CI에 고정하는 방안은 5.5절에 제안한다.

### 1.2 지속 객체 목록

브리프가 예시로 든 객체(organization, kickoff 등록, workflow, task, execution/attempt, review, acceptance, evidence, report, director signal)를 포함해 검색으로 확인한 모든 지속 객체를 정리한다.

| # | 객체 | 쓰는 지점(file:line) | 경로 | 스키마 | 쓰기 방식과 revision |
|---|---|---|---|---|---|
| 1 | organization | `saveOrg`, `core.mjs:1142-1184`(생성은 `teams-org.mjs:1383`) | `<project>/.omt/organization.json` | `organization.schema.json` | overwrite. `revision`(정수) 낙관적 동시성: `expectedRevision`이 현재 `revision`과 다르면 거부(`core.mjs:1157-1160`). 갱신 전 이전 판을 `history/org-<revision>.json`에 아카이브(`core.mjs:1169-1178`) |
| 2 | organization 이력 | `core.mjs:1170-1177`(`saveOrg` 안) | `<project>/.omt/history/org-<n>.json` | 없음 | write-once(revision마다 새 파일) |
| 3 | kickoff 등록 항목 | `kickoff-registry.mjs:232`(최초), `:428`(등록), `:459`(bind), `:510`(레거시 이동), `:644`(release) | `<project>/.omt/kickoffs/<sha256(worktreeId)>.json`(해시는 `kickoff-registry.mjs:108`) | 없음(assert로만 검증) | overwrite. revision 카운터는 없고, `kickoff-bind`는 같은 `runId` 재입력만 멱등 허용(`kickoff-registry.md:69`) |
| 4 | kickoff 아카이브 | `kickoff-registry.mjs:715` | `<project>/.omt/history/kickoff-<hash>-<createdAt>.json` | 없음 | append-only(원본은 `kickoff-release`가 unlink) |
| 5 | workflow request | `workflow.mjs:301` | `.omt/workflows/<id>/request.json` | `workflow.schema.json`(request 형태) | 생성 시 1회. `withWorkflowUpdate`(파일 락)로 보호되고 기존 파일이 있으면 거부(`workflow.mjs:296-299`) |
| 6 | workflow용 organization 스냅샷 | `workflow.mjs:302` | `.omt/workflows/<id>/organization.json` | `organization.schema.json` | 생성 시 1회, 불변 |
| 7 | task revision(동결) | `workflow.mjs:304-313` | `.omt/workflows/<id>/tasks/<taskId>/revisions/<revision>.json` | `task.schema.json` | append-only. revision마다 새 파일이 생기고 기존 파일은 다시 쓰지 않는다 |
| 8 | integration task | `workflow.mjs:324`, 갱신은 `workflow.mjs:837`(`extendIntegrationChecks`) | `.omt/workflows/<id>/integration-task.json` | `task.schema.json` | overwrite이나 `taskHash()`로 내용 무결성을 확인하고, 승인 이후에는 잠긴다(`docs/WORKFLOW_EXECUTION.md:35-41`) |
| 9 | workflow 이벤트 | `workflow-store.mjs:23`(`recoverTransaction` 안), 실제 대기열은 `appendWorkflowEvent`(`workflow-store.mjs:86-112`) | `.omt/workflows/<id>/events/<6자리순번>-<eventId>.json` | 없음 | append-only, 이벤트 id 중복은 거부하지 않고 `false`를 반환해 멱등 처리(`workflow-store.mjs:97`) |
| 10 | workflow 상태(materialized state) | `workflow-store.mjs:25`(`recoverTransaction`), `saveWorkflowState`(`workflow-store.mjs:122-134`) | `.omt/workflows/<id>/state.json` | 없음(내부 불변식은 코드로 검증) | overwrite. `updatedAt` 갱신, 낙관적 동시성은 `.lock` 파일과 `withWorkflowUpdate`로 대체 |
| 11 | workflow transaction 저널 | `workflow-store.mjs:127`(`saveWorkflowState`) | `.omt/workflows/<id>/transaction.json` | 없음 | **비지속 객체**. `{state, events}`를 먼저 쓰고 즉시 `recoverTransaction`으로 반영한 뒤 `fs.unlinkSync`로 삭제한다(`workflow-store.mjs:12-27`). 프로세스가 중간에 죽어도 다음 `withWorkflowUpdate` 호출이 같은 파일을 발견해 반영을 재개한다 |
| 12 | review 기록 | `recordReviewLocked`, `gates.mjs:417` | `<stateDir>/reviews/<id>.json`(경로 헬퍼 `gates.mjs:39-40`) | `review.schema.json` | append-only: `assert(!fs.existsSync(target), ...)`로 같은 id 재작성을 거부(`gates.mjs:399-400`). `taskRevision`, `taskHash(task)`, `evidenceKey`를 기록에 고정해 어떤 소스를 검토했는지 못 바꾸게 한다(`gates.mjs:404-412`) |
| 13 | gate 상태 | `gates.mjs:421`, `acceptOutcomeLocked`에서 `:491` | `<stateDir>/gates/<taskId>.json`(헬퍼 `gates.mjs:43-44`) | 없음 | overwrite. review/acceptance 기록으로부터 다시 계산하는 파생 상태 |
| 14 | acceptance decision | `acceptOutcomeLocked`, `gates.mjs:489` | `<stateDir>/decisions/<id>.json`(헬퍼 `gates.mjs:41-42`) | 없음 | append-only(재작성 거부, review와 동일한 패턴) |
| 15 | evidence 기록 | `evidence.mjs:326` | `<store>/<key>.json`(`key = hash(fingerprint)`, `evidence.mjs:273`) | 없음(내부 필드 `schemaVersion: 1`만 스스로 표시) | 내용주소화. 같은 `key`가 이미 있고 재사용 가능하면 그대로 반환, 아니면 다시 쓴다(`evidence.mjs:274-278`) |
| 16 | evidence 검사 로그 | `evidence.mjs:287` | `<store>/<key>-<index>.log` | 없음 | overwrite. `logHash`로 evidence 레코드에서 무결성을 확인 |
| 17 | worker run 스냅샷 | `worker.mjs:408-409` | `<stateDir>/runs/<runId>/{organization,task}.json` | 없음 | overwrite(사실상 create-only, `runId`가 실행마다 새로 생성됨) |
| 18 | worker report | `worker.mjs:569`, `:573` | `<stateDir>/runs/<runId>/report.json` | 없음(gate가 `taskRevision`/실행 바인딩을 검증) | overwrite |
| 19 | provider 호출 로그 | `worker.mjs:240` | `<runDir>/call-<n>/output.txt` | 없음 | overwrite |
| 20 | assist 리포트/로그 | `worker.mjs:749`, `:745` | `<stateDir>/assists/<id>.{json,log}` | 없음 | overwrite, `organizationRevision` 필드로 조직 판을 기록 |
| 21 | advise 리포트/로그 | `worker.mjs:948`, `:944` | `<stateDir>/advice/<id>.{json,log}` | 없음 | overwrite, `organizationRevision` + `briefHash` |
| 22 | prepared input 스냅샷 | `workspace.mjs:55-56`, `:67` | `<outputDir>/{organization,task,input}.json` | 없음 | overwrite, `taskRevision`/`organizationRevision` 포함 |
| 23 | worktree attach 시 `.omt` 스냅샷 | `workspace.mjs:150-151` | `<workspace>/.omt/{organization,task}.json` | 없음 | overwrite |
| 24 | worktree attach 기록 | `workspace.mjs:167` | `<stateDir>/worktrees/<name>.json` | 없음 | overwrite(이름 재사용 시 덮어씀) |
| 25 | handoff checkpoint 문서 | `handoff.mjs:111-114` | `<state>/workflows/<wfId>/tasks/<taskId>/handoff/checkpoint.md` | `HANDOFF_SECTIONS` 구조 검증(`handoff.mjs:11-19`) | overwrite(임시 파일 write 후 `fs.renameSync`로 원자적 교체), `sequence` 필드로 순서 보존 |
| 26 | handoff checkpoint 메타 | `handoff.mjs:125` | `<...>/handoff/checkpoint.json` | 없음 | overwrite, `sequence`/`head`/`updatedAt` |
| 27 | handoff snapshot | `handoff-snapshot.mjs:99` | `<...>/handoff/snapshot-<index>.json` | 없음 | create-only |
| 28 | director signal(inbox) | `sendSignal`, `director.mjs:140,144,177`(그 외 `:362,437,463,603,749`) | `<ownerProject>/.omt/director/inbox/<id>.json`(헬퍼 `director.mjs:36-37`) | 없음(코드로 `kind` enum만 검증) | overwrite. `seq`(정수)로 순서를 매기고 `withFileLock`(잠금 파일 `director.mjs:41-43`)으로 동시성 제어 |
| 29 | resource 슬롯 | `resources.mjs:210` | `<ownerProject>/.omt/resources/<id>.json` | 없음 | **약한 지속**: 생성 후 `releaseResource`가 `unlinkSync`로 즉시 삭제하는 임대 기록 |
| 30 | incident 인덱스 | `incidents.mjs:158,249` | `<stateDir>/incidents/state.json` | 없음 | overwrite(전체 재기록), `withFileLock` |
| 31 | incident 개별 레코드 | `incidents.mjs:159,250` | `<stateDir>/incidents/<id>.json` | `incident.schema.json`은 수집 입력(`ingestIncident`)의 형태만 검증하며 저장된 레코드 자체의 정본 스키마가 아니다(`incident.schema.json`의 `required`는 `source`/`externalId`/`dedupeKey`/`summary`/`evidence`/`observedAt`로, 저장 시 추가되는 파생 필드를 포함하지 않는다) | overwrite |
| 32 | lesson candidate | `lessons.mjs:68` | `<stateDir>/lessons/candidates/<fingerprint>.json` | 없음 | **write-once**: 같은 지문이 이미 있으면 그대로 반환하고 다시 쓰지 않는다 |
| 33 | quota 스냅샷 | `quota.mjs:170` | `<pm-state>/quota/<poolId>/<observedAt>.json` | 없음 | overwrite, 시각으로 파일이 나뉘는 관측 로그 |
| 34 | usage 스냅샷(수동) | `usage-report.mjs:704` | `<project>/.omt/history/usage-<entry>-<createdAt>.json` | 없음 | `usage-report --write`를 줄 때만 생성되는 조회 스냅샷 |
| 35 | OpenCodex 런타임 설치 상태 | `dependencies.mjs:462,465`(스테이징 manifest·lockfile), `:497`(검증 완료 manifest), `:507,509`(`runtimes/<fingerprint>` rename), `:511,516`(`active.json` 교체) | `os.homedir()/.omt/runtime/opencodex/{active.json, runtimes/<fingerprint>/, locks/<fingerprint>.lock}`(경로 헬퍼 `runtimePaths(root)`가 `base = path.resolve(root, "opencodex")`를 세 경로 모두의 기준으로 삼음, `dependencies.mjs:84-93`; `root`는 항상 `defaultRuntimeRoot()`가 반환하는 `os.homedir()/.omt/runtime`, `dependencies.mjs:642-644`; 모든 호출부(`teams-org.mjs:1512,1515,1520,1526`, `headless-runner.mjs:190,212`, `providers.mjs:210-211`)가 같은 `root`를 넘겨 우회 경로가 없다) | 없음 | overwrite/rename 기반. **프로젝트 `.omt`가 아니라 사용자 홈 디렉터리의 `.omt/runtime/opencodex`**라는 점이 표의 다른 34개 행과 다르다 |

### 1.3 문서화 대상에서 제외하는 런타임 상태와 이유

다음은 `.omt` 아래에 실제로 기록을 남기지만, 정형 문서 체계의 대상으로 삼지 않는다.

| 상태 | 근거 |
|---|---|
| `transaction.json`(workflow), `.lock`/`.inbox.lock`/`.resources.lock`/`gates-write.lock`/`.omt-opencodex-turn.lock` 류 | 모두 처리 과정에서만 잠깐 존재하다가 삭제되거나 즉시 소비되는 저널·잠금 파일이다. 어떤 역할도 이를 읽고 판단을 내리지 않으므로 참조 대상이 될 수 없다 |
| headless worker/turn 상태(`worker.json`, `turn.json`, `runner.json`, `exit.json`, `pids.json`, `opencodex.json` 등, `headless.mjs:677-756`, `headless-runner.mjs:297-438`) | `headless.mjs:10`의 모듈 주석이 "measurements are in docs/plan/headless-runtime.md"라고 명시한다. `AGENTS.md`의 아키텍처 규칙은 `docs/plan/headless-runtime.md`가 선언한 헤드리스 실행 경로만 "Orca의 감독 기능을 재구현하지 않는다" 규칙의 예외로 인정하므로, 그 경로가 스스로 관리하는 실행 상태를 이 설계가 다시 정의하지 않는다 |
| jev 판단 기록(`<stateDir>/judgments/<id>.json`, `jev.mjs:221`) | 기록 자체의 `responsibility` 필드가 "shadow judgment; it changes no decision and approves nothing"(`jev.mjs:162-163`)라고 명시한다. 어떤 게이트도 이 기록을 정본으로 읽지 않으므로 지속 업무 문서가 아니다 |
| opencodex 리스·프록시 락(`opencodex.mjs:699,913-918`) | 로컬 프로세스 간 배타적 실행을 위한 락 파일이며 업무 판단을 담지 않는다 |
| launch ledger(`usage-ledger.mjs:237`, `<orgDir>/usage/launches.jsonl`), prompt-answer 로그(`prompt-supervision.mjs:158`) | 역할 연결과 감독 재시도를 위한 append-only 관측 로그다. 사람이나 역할이 업무 산출물로 읽거나 참조하지 않고, `usage-report`가 집계 목적으로만 읽는다 |
| provider 호출 원본 로그(`worker.mjs:240,745,944`의 `output.txt`/로그 파일) | report의 `log`/`logHash` 필드가 참조만 보존하며, 로그 자체는 report가 정본으로 삼는 실행 결과의 원재료일 뿐 업무 문서가 아니다 |
| resource 슬롯(표 1.2의 #29) | 해제 시 즉시 삭제되는 임대 기록이며, 남아 있는 동안에도 "누가 자원을 쓰고 있는가"라는 실행 중 상태이지 업무 산출물이 아니다 |
| OpenCodex 런타임 설치 상태(표 1.2의 #35) | 프로젝트 `.omt`가 아니라 사용자 홈(`os.homedir()/.omt/runtime/opencodex`)에 있는 머신 전역 실행 환경 캐시다(`dependencies.mjs:84-93,642-644`). 특정 kickoff·workflow·organization에 속하지 않고 같은 머신의 모든 프로젝트가 공유하며, 어떤 역할도 이를 업무 산출물로 읽거나 참조하지 않고 오직 OpenCodex 기동 전 자동 검증에만 쓰인다 |

## 2단계: 참조 행렬

모든 지속 객체(표 1.2)에 대해 참조 문서 유형, 읽는/갱신하는 역할, 검증 지점, 수명주기를 정리한다. "정형 문서 대상"란이 예인 객체가 3단계 설계의 문서 체계에 편입되는 대상이며, 아니오인 객체는 기존 형태를 그대로 유지하되 새 문서에서 식별자로만 참조한다(브리프의 "필요한 문서 내용을 자체 필드에 복제하지 않고 안정적인 문서 식별자 또는 검증 가능한 참조를 보존한다"는 조건 4를 따른다).

| 객체 | 정형 문서 대상 | 읽는 역할 | 갱신 역할 | 검증 지점 | 수명주기 |
|---|---|---|---|---|---|
| organization(#1) | 아니오(참조만) | 전 역할 | 이사(폼 스킬을 통해서만) | `validateOrg`, `expectedRevision` 일치 | kickoff 전체 기간 지속, revision마다 이력 보존 |
| organization 이력(#2) | 아니오(참조만) | 이사(감사 목적) | 없음(`saveOrg`가 자동 아카이브) | 없음 | revision마다 새 파일로 영구 보존 |
| kickoff 등록 항목(#3) | 예(`01. 기획`) | 이사, PM | 이사(`kickoff-claim`), PM(`kickoff-bind`) | 필수 5필드 존재, `organizationRevision` 일치, 워크트리 중복 금지 | kickoff 생성부터 `kickoff-release`까지, 이후 `history/`로 이관되어 조회만 가능 |
| workflow request/task revisions(#5,#7) | 예(`03. 구현`) | PM, PL, Senior, Junior | PM(생성), 이후 불변 | `task.schema.json`/`workflow.schema.json` | workflow 생성 시 고정, 재작성되지 않고 새 revision으로만 갱신 |
| workflow용 organization 스냅샷(#6) | 아니오(참조만) | PM, PL, Senior, Junior(workflow 생성 시점 조직 상태 확인용) | 없음(생성 시 1회, 이후 불변) | 없음 | workflow 전체 기간 고정 |
| integration task(#8) | 예(`03. 구현`, `integration-ref`) | PM, PL, 통합 담당 Senior | PM(생성), `extendIntegrationChecks` 호출자(검사 확장) | `taskHash` 일치, 승인 후 잠금(`workflow.mjs:691-694,826-837`) | workflow 생성부터 통합 수용까지, 승인 후 불변 |
| workflow 이벤트(#9) | 아니오(참조만) | PM, PL(감사·재구성용) | 런타임 자동(모든 workflow 명령) | 이벤트 id 중복 방지 | workflow 전체 기간 append-only 보존 |
| workflow 상태(#10) | 아니오(참조만, `03. 구현` 문서의 `workflowRef`가 가리킴) | PM, PL, Senior, Junior | 런타임 자동(모든 workflow 명령) | `.lock` 기반 동시성, `recoverTransaction` | workflow 전체 기간 지속 |
| execution/attempt(reserve·attach·settle) | 예(`03. 구현`) | PL, Senior, Junior | 예약자(PL/PM), 실행자 | `workflow-reserve`/`workflow-attach`/`workflow-settle`의 낙관적 동시성(`state.json`의 `revision`) | 예약부터 정산까지, workflow state 안에 보존 |
| review 기록(#12) | 예(`04. 검토`) | PM, Senior(다른 실행), 이사 | 배정된 독립 Senior만 | `seniorEnoughToReview`, 실행 신원 독립성, `taskRevision`/`taskHash` 고정. 기록 자체의 저장은 대응 `04. 검토` 문서 없이도 진행되며(write-once, 3.7절 5번 항목), 문서 존재는 아래 gate 상태에서 확인한다 | 작성 후 불변(append-only) |
| gate 상태(#13) | 아니오(참조만, `04. 검토`/`05. 수용` 문서가 가리킴) | PM, Senior, 이사 | 런타임 자동(review/acceptance 기록 시 재계산) | review/acceptance 기록으로부터 재계산하되, `review-complete`/`outcome-accepted`는 대응 문서의 `documentState`가 `exists: true`인 review/decision만 인정한다(3.7절 5번 항목, 이사 판정 2·3) | task 진행 중 갱신되는 파생 상태, 원본(review/decision)이 정본 |
| acceptance decision(#14) | 예(`05. 수용`) | PM, 이사 | PM(또는 `ACCEPTED_RISK_AUTHORITIES`에 속한 신원) | 모든 필요 review 완료 여부(문서 존재까지 확인된 review만 인정), 기준 충족 여부. 기록 자체는 대응 `05. 수용` 문서 없이도 저장되며(write-once), `outcome-accepted` 게이트가 문서 존재를 확인한다 | 작성 후 불변 |
| evidence(#15) | 예(`06. 인도`, 참조만) | 검토자, 이사 | 검사를 실행한 실행 신원 | `logHash`, 재현 가능한 fingerprint | 내용주소 저장이므로 사실상 영구, 재사용됨 |
| evidence 검사 로그(#16) | 아니오(참조만, evidence 레코드의 `logHash`가 가리킴) | 검토자 | 검사를 실행한 실행 신원 | `logHash` | evidence와 함께 내용주소 보존 |
| worker run 스냅샷(#17) | 아니오(참조만, report가 가리킴) | 배정자 | worker 자신 | 없음 | 실행 1회당 생성, report와 함께 보존 |
| report(#18) | 예(`06. 인도`, 참조만) | 배정자, 검토자 | 작성한 worker 자신 | evidence·review 바인딩 확인 | 실행 1회당 1건, 불변 |
| assist 리포트(#20) | 아니오(참조만) | 호출한 역할 자신 | 호출한 역할 자신 | `organizationRevision` | 호출 1회당 생성, 감사용으로 유지 |
| advise 리포트(#21) | 아니오(참조만) | 호출한 역할 자신 | 호출한 역할 자신 | `organizationRevision` + `briefHash` | 호출 1회당 생성, 감사용으로 유지 |
| prepared input 스냅샷(#22) | 아니오(참조만) | 실행 대상 worker | `prepare` 호출자 | `taskRevision`/`organizationRevision` | 실행 준비 시점에 생성, 실행 종료 후에도 감사용으로 유지 |
| worktree attach 스냅샷·기록(#23,#24) | 아니오(참조만) | 실행 대상 worker, PL | `attach` 호출자 | 없음 | worktree 생성부터 회수까지 |
| director signal(#28) | 예(`07. 종료`) | 이사, PM | PM(발신), 이사(ack) | `kind` enum, `seq` 순서 | closed 처리 전까지 inbox에 남고, closed 후 이력만 남김 |
| kickoff 아카이브(#4) | 예(`07. 종료`, 파생) | 이사 | `kickoff-release`(자동) | 없음(단순 이관) | 영구 보존 |
| handoff checkpoint/snapshot(#25-27) | 아니오(참조만) | 인계받는 실행 | 한도에 걸린 실행 자신 | `HANDOFF_SECTIONS` | task 진행 중 갱신, task 종료 후에도 이력으로 유지 |
| incident, lesson candidate(#30-32) | 예(`07. 종료`, 참조만) | 이사 | incidents/lessons 파이프라인(자기 스키마로 계속 관리) | 코드 assert | 운영 관측 기록. 문서 체계는 존재 여부와 경로만 `incidentRefs[]`/`lessonCandidateRefs[]`로 인용하며 레코드 자체의 정본 위치는 바꾸지 않는다 |
| quota 스냅샷(#33) | 아니오(참조만) | PM, 이사(감독 목적) | quota 관측 파이프라인 자동 | 없음 | 관측 시각마다 생성되는 조회용 이력 |
| usage 스냅샷(#34) | 아니오(참조만) | 이사, PM(사용량 확인) | `usage-report --write` 호출자 | 없음 | 수동 스냅샷 요청 시점마다 생성 |

## 3단계: 정형 문서 체계 설계

### 3.1 업무 흐름과 단계 폴더

1단계·2단계 조사에서 드러난 실제 업무 흐름은 다음 일곱 단계로 나뉜다. 각 단계는 서로 다른 정본 소유자와 검증 지점을 가지므로 번호·이름·책임이 겹치지 않는다.

| 폴더 | 책임 | 주 정본 소유자 | 대응하는 기존 지속 객체 |
|---|---|---|---|
| `01. 기획` | 목표·수용 기준·범위를 확정하고 kickoff를 등록한다 | 이사(브리프), PM(kickoff 등록) | 브리프, kickoff 등록 항목 |
| `02. 설계` | 구현 전에 계약을 문서로 확정하고 독립 검토를 받는다(이 문서 자체가 그 사례다) | 설계를 배정받은 역할. `skills/pm/SKILL.md:46`이 정하는 조건은 "Senior 유무"가 아니라 "이번 실행에 하위 역할이 하나라도 있는지"이므로, PM은 이번 실행의 역할 목록에 Senior든 Junior든 하위 역할이 하나라도 있으면 직접 작성하지 않고 그 가운데 이 일을 맡을 수 있는 역할에게 먼저 배정한다. PM 직접 작성은 이번 실행에 하위 역할이 하나도 없을 때만 허용한다(3.4절 참고) | 없음(신규 문서 유형) |
| `03. 구현` | workflow/task 계약과 execution/attempt 진행, 다중 task workflow의 통합 계약을 기록한다 | PM(workflow request), 실행 역할(attempt) | workflow request, task revisions, execution/attempt, integration task |
| `04. 검토` | 독립 Senior가 구현을 검토한다 | 배정된 독립 Senior | review 기록 |
| `05. 수용` | PM(또는 accepted-risk 권한자)이 최종 판정을 내린다 | PM | acceptance decision |
| `06. 인도` | 검증된 결과를 주인 체크아웃에 전달한다 | 이사(`deliver`) | evidence/report 참조, kickoff 등록 항목의 `delivered` |
| `07. 종료` | kickoff를 닫고 이사에게 보고한다 | 이사 | director signal, kickoff 아카이브 |

`02. 설계`는 브리프가 명시한 "구현보다 먼저 정형 문서 체계의 설계 문서가 완성되고 독립 검토를 통과한다"(조건 1)는 원칙을 이 kickoff 자체가 어느 폴더에서 관리되는지 규정하기 위한 단계이며, `03. 구현`부터는 기존 workflow/task/execution 계약을 문서 식별자로 감싸는 단계다. `06. 인도`는 `delivery.mjs`가 직접 `.omt` 파일을 쓰지 않고 git 병합만 수행하므로(3.1절 조사에서 `delivery.mjs`에는 `writeJSON`/`writeFileSync`/`appendFileSync` 호출이 없음을 확인했다), 이 폴더의 문서는 evidence/report를 참조만 하고 실질적인 갱신은 kickoff 등록 항목의 `delivered` 필드(`kickoff-registry.mjs`)에서 일어난다는 점을 그대로 반영한다.

**확정된 결정(이사·PM, 2026-09-27).** `03. 구현`의 통합 task는 하위 task revision과 같은 `workflow-task-ref` 문서에 합치지 않고 별도 `docType` `integration-ref`로 분리한다. 근거는 다음 네 곳의 코드가 통합 task를 하위 task와 다른 생명주기로 다루기 때문이다. `workflow.mjs:278-279`가 `integrationTask.schemaVersion === 2 && !tasks.some(task => task.id === integrationTask.id)`로 통합 task에 하위 task와 겹치지 않는 별도 id를 강제하고, `workflow.mjs:319-324`가 `integration-task.json`이라는 별도 파일에 쓰며 자기 `taskHash`를 `state.integration.taskHash`에 기록하고, `workflow.mjs:691-694`가 통합 수용 시 이 `taskHash`를 다시 계산해 일치하는지 검증하는 자체 게이트를 가지며, `workflow.mjs:826-837`(`extendIntegrationChecks`)이 검사 확장 때마다 파일을 다시 쓰고 `taskHash`를 갱신하는, 하위 task revision에는 없는 별도 갱신 경로를 갖는다. 이 결정은 3.2절 표와 2단계 참조 행렬에 반영했다.

### 3.2 폴더별 문서 유형과 필수 필드

각 정형 문서는 공통 봉투(envelope) 필드를 공유하고, 폴더별 본문(body) 필드를 추가한다.

공통 봉투(모든 정형 문서가 가짐):

```json
{
  "schemaVersion": 1,
  "docId": "<3.5절의 안정적 식별자>",
  "stage": "planning|design|implementation|review|acceptance|delivery|closure",
  "kickoffId": "<kickoff 등록 해시>",
  "workflowId": "<workflow id, 없으면 null>",
  "revision": 1,
  "author": { "role": "director|pm|pl|senior|junior", "executionId": "<실행 신원>" },
  "createdAt": "<ISO 시각>",
  "basedOnRevision": null,
  "reason": "<이 revision을 만든 사유>"
}
```

폴더별 본문:

| 폴더 | 문서 유형 | 본문 필수 필드 |
|---|---|---|
| `01. 기획` | kickoff-brief-ref | `briefPath`, `acceptanceSummary`, `nonGoals`, `constraints`, `kickoffEntryRef` |
| `02. 설계` | design-contract | `problemStatement`, `decisions[]`, `openQuestions[]`, `reviewRequirementRef` |
| `03. 구현` | workflow-task-ref | `workflowRef`, `taskRef`, `attemptRefs[]` |
| `03. 구현`(다중 task workflow만) | integration-ref | `integrationTaskRef`, `taskHashRef`, `extensionHistory[]`(각 항목은 `extendIntegrationChecks` 호출 시점의 `taskHash`와 사유) |
| `04. 검토` | review-ref | `reviewFileRef`, `conclusion`, `criteriaRefs[]` |
| `05. 수용` | acceptance-ref | `decisionFileRef`, `acceptedBy`, `criteriaSatisfied[]` |
| `06. 인도` | delivery-ref | `evidenceRef`, `reportRef`, `deliveredCommit` |
| `07. 종료` | closure-record | `directorSignalRef`, `kickoffArchiveRef`, `outcome`, `incidentRefs[]`(없으면 빈 배열), `lessonCandidateRefs[]`(없으면 빈 배열) |

모든 `*Ref` 필드는 3.6절의 참조 형식을 따르며 참조 대상 문서·파일의 전문을 복제하지 않는다. 이는 review/acceptance 기록이 `taskHash`만 고정하고 task 본문을 복제하지 않는 기존 패턴(`gates.mjs:404-412`)을 그대로 계승한 것이다.

**확정된 결정(이사·PM, 2026-09-27).** `07. 종료`의 `incidentRefs[]`/`lessonCandidateRefs[]`는 `incidents.mjs`/`lessons.mjs`가 쓰는 기존 레코드(표 1.2 #30-32)를 복제하지 않고, 그 파일의 상대 경로만 담는 참조다. incident/lesson 파이프라인은 계속 자기 스키마와 저장 위치를 그대로 쓰며, closure-record는 "이 kickoff를 닫을 때 연결된 incident/lesson이 있었다"는 사실만 기록한다.

### 3.3 상태 전이

각 문서는 `open → in-review → resolved` 세 상태만 가진다. `02. 설계` 문서는 독립 검토(`design-independent-review`류 요구)를 통과해야 `resolved`가 되고, `resolved` 이전에는 하위 단계(`03. 구현` 이하) 문서가 그 설계 문서를 참조할 수 없다. 이 전이는 review.schema.json의 `conclusion`(`approved|changes-requested|inconclusive`)을 그대로 재사용하며, `approved`만 `resolved`로 전이시키고 `changes-requested`/`inconclusive`는 `open`으로 되돌린다. 새 상태 어휘를 만들지 않는 이유는 AGENTS.md의 "런타임에서 강제하는 값이나 검사 로직을 스킬 문서에 중복해서 선언하지 않는다"는 규칙을 지키기 위해서다.

### 3.4 역할별 작성·검토·수정 권한과 독립성

| 역할 | 작성 | 검토 | 수정 | 독립성 제약 |
|---|---|---|---|---|
| Director | `01. 기획`(kickoff-brief-ref), `07. 종료` | 없음(최종 `close`가 판정을 대체) | 자기가 쓴 문서만 | 이사만 `close`·병합을 수행한다는 조직 규칙을 그대로 따름 |
| PM | `01. 기획`(kickoff 등록), `03. 구현`(workflow request), `05. 수용`. `02. 설계`는 `skills/pm/SKILL.md:46`("이번 실행에 하위 역할이 하나라도 있으면 PM은 최종 산출물을 직접 작성하지 않는다. 산출물은 그 일을 맡을 수 있는 가장 낮은 역할에게 배정한다")이 규정한 조건을 그대로 적용한다. 조건은 Senior의 유무가 아니라 "이번 실행에 하위 역할이 하나라도 있는지"이므로, Senior는 없지만 Junior만 있는 실행에서도 PM은 `02. 설계`를 직접 쓰지 않는다. 실제로 누가 맡는지(예: Junior가 초안을 쓰고 Senior 부재 시 PL·PM이 검토만 맡는지)는 이번 실행의 역할 목록과 각 역할 SKILL.md의 한계(`junior/SKILL.md`의 "구조를 이해해야 하는 설계 판단은 직접 결론 내리지 않는다")에 따라 배정 시점에 정해지며, 이 설계 문서는 배정 대상을 미리 고정하지 않는다. PM 직접 작성은 이번 실행의 역할 목록에 하위 역할이 하나도 없을 때만 허용한다 | 없음 | 자기가 쓴 문서, `05. 수용`은 PM 전용 | `acceptOutcomeLocked`가 요구하는 대로 모든 필요 review가 끝나야 작성 가능 |
| PL | `03. 구현`(attempt 배정) | 없음(배정만) | 배정 관련 필드만 | Junior/Senior 산출물을 대신 승인하지 않음 |
| Senior | `02. 설계`, `03. 구현`(자기 배정분), `04. 검토`(다른 실행의 산출물) | `04. 검토` | 자기가 작성한 문서만, 검토 문서는 배정된 Senior만 | `senior/SKILL.md`의 "자신이 설계·작성한 변경을 독립 검토로 승인하지 않는다"는 한계를 그대로 반영해, 같은 실행 신원이 작성자이자 검토자인 문서는 거부한다(`implementationExecutionId !== reviewer.executionId` 검사를 문서 계층에도 적용) |
| Junior | `03. 구현`(배정된 구현) | 없음 | 자기가 작성한 문서만 | 검토·수용 문서를 절대 갱신하지 않음(`junior/SKILL.md`의 한계와 동일) |

독립성 검사는 review.schema.json이 이미 요구하는 `reviewer.executionId`와 `implementationExecutionId`의 불일치 검사(`gates.mjs`의 `assertReportBinding`류)를 문서 저장 계층에 그대로 얹는다. 새 판정 로직을 만들지 않고 기존 게이트 함수를 재사용하는 것이 AGENTS.md의 "Orca의 감독 기능을 재구현하지 않는다" 규칙과 일치한다.

#### 3.4.1 호출자 신원 인증의 한계

이 설계의 모든 권한·독립성 검사(`author.executionId`가 실제로 그 역할인지, `reviewer.executionId`가 구현자와 다른지)는 문서를 쓰는 프로세스가 스스로 밝힌 `executionId`가 진짜라는 전제 위에 있다. 이 전제는 새로 만드는 것이 아니라 기존 시스템이 이미 안고 있는 한계를 그대로 물려받는다. `references/orca-runtime.md:212`(「호출자 식별의 한계」 절)는 "호출한 터미널은 환경 변수 `ORCA_TERMINAL_HANDLE`로만 알 수 있고, 이 값이 진짜인지 증명하는 수단은 없다"고 명시하며, "위조를 막는 일은 Orca가 호출자를 인증하는 기능을 제공해야 가능하다"고 밝힌다. `skills/pl/SKILL.md:99`도 검증 캐시에 대해 "해시와 로그는 전송 무결성 확인이며 악의적 로컬 작성자를 인증하지는 않는다"고 같은 한계를 명시한다. 이 설계가 제안하는 문서 저장 계층의 권한 검사도 같은 성격이다. 즉 감독 관계가 없는 실행의 실수(다른 역할 폴더에 잘못 쓰는 시도 등)는 막지만, 같은 머신에서 `executionId`를 일부러 위조하는 프로세스는 막지 못한다. 이 설계는 Orca가 호출자를 인증하는 새 기능을 전제하지 않으며, 그런 기능을 이 kickoff 범위에서 새로 만들지도 않는다.

### 3.5 경로와 독립된 문서 식별자

**확정된 결정(PM, 2026-09-27).** 문서를 실제로 담는 디렉터리는 브리프 조건 3("`.omt` 아래에 `01. 기획`으로 시작하는 단계별 폴더가 결정적으로 생성되고")과 제약("단계별 폴더 이름은 사용자가 요청한 `01. 기획` 형식을 보존한다")에 따라 `01. 기획`부터 `07. 종료`까지, 3.1절 표가 정의한 폴더 이름 문자열 그 자체로 생성한다. 이 폴더 이름은 표시용 별칭이 아니라 실제 저장 경로의 세그먼트다.

```
.omt/documents/<kickoffHash>/<workflowId|none>/<폴더 이름>/<docType>/<localId>/
```

`<폴더 이름>`은 `01. 기획`, `02. 설계`, `03. 구현`, `04. 검토`, `05. 수용`, `06. 인도`, `07. 종료` 일곱 값 가운데 하나만 허용하며, 런타임이 소유한 `stageSlug → 폴더 이름` 매핑 테이블(3.8절의 product-canonical 자산)로만 결정한다. 이 매핑은 1:1 고정이고, 이 경로를 조립하는 코드는 문서 저장 헬퍼 하나뿐이다(AGENTS.md의 "어댑터를 거치지 않는 직접 호출 금지" 규칙).

경로 문자열은 식별자로 쓰지 않는다. `docId`(논리 식별자, 참조 무결성 검사와 orchestration 메시지에 쓰는 값)는 폴더 이름 문자열을 담지 않고, workflow id와 같은 패턴(`WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/`, `workflow-store.mjs:7`)을 그대로 계승한 ASCII 슬러그 세그먼트를 대신 쓴다. 콜론(`:`)은 Windows가 드라이브 문자 위치 밖에서 금지하는 문자이므로 식별자 어디에도 쓰지 않는다.

```
docId = "<kickoffHash>/<workflowId|"none">/<stageSlug>/<docType>/<localId>"
```

`stageSlug`는 `planning`, `design`, `implementation`, `review`, `acceptance`, `delivery`, `closure`로 고정하며, **논리 식별자와 참조 검사에만** 쓰고 실제 저장 경로의 디렉터리 이름으로는 쓰지 않는다. 즉 논리 식별자는 항상 `stageSlug`를, 실제 파일 시스템 경로는 항상 폴더 이름을 쓰며, 문서 저장 헬퍼가 두 값을 매핑 테이블로 상호 변환하는 유일한 지점이다. 폴더 이름이 바뀌는 변경(예: 사용자가 한국어 표기를 조정)은 기존 디렉터리를 새 이름으로 옮기는 별도 마이그레이션을 동반해야 하지만, `docId`와 참조 문자열은 `stageSlug`만 담으므로 그 마이그레이션으로 깨지지 않는다.

### 3.6 참조 형식과 스코핑

```
omt-doc:<kickoffHash>/<workflowId|none>/<stageSlug>/<docType>/<localId>@r<revision>
```

스킴 구분자를 `://`가 아니라 `:`(경로 세그먼트 시작 직전 한 번)로 제한하고 그 뒤로는 `/`만 쓰므로, 이 문자열을 파일 경로 세그먼트가 아니라 통째로 문자열 필드에 담는 한 Windows 금지 문자와 충돌하지 않는다. `@r<revision>`의 `@`도 Windows 금지 문자 목록(`< > : " / \ | ? *`)에 없으므로 안전하다. 참조 무결성 검사는 다음을 거부한다(브리프 조건 4).

- 참조 대상 `docId`가 실제로 존재하지 않는 경우
- 참조 문자열의 `kickoffHash`가 참조하는 쪽 문서 자신의 `kickoffId`와 다른 경우(다른 kickoff 참조 금지)
- `workflowId`가 있는데 참조하는 쪽의 `workflowId`와 다른 경우(다른 workflow 참조 금지)
- 참조 대상 문서의 현재 상태가 그 참조가 허용하는 상태 집합에 속하지 않는 경우(예: `03. 구현` 문서는 `resolved` 상태의 `02. 설계` 문서만 참조할 수 있다)

이 검사는 새 저장 함수를 만들지 않고, `saveOrg`의 `expectedRevision` 검사(`core.mjs:1157-1160`)와 review의 `taskHash` 고정(`gates.mjs:404-412`) 패턴을 문서 저장 헬퍼 하나로 통합해 재사용한다.

### 3.7 revision 모델

기존 두 선례를 그대로 계승한다.

1. **append-only revision 파일**: task revision(`tasks/<taskId>/revisions/<revision>.json`, `workflow.mjs:304-313`)과 review/decision(`assert(!fs.existsSync(target))`, `gates.mjs:399-400`)이 보여주는 대로, 문서 갱신은 새 revision 파일을 추가할 뿐 기존 파일을 다시 쓰지 않는다. 경로는 `.../revisions/<n>.json`이다.
2. **포인터 파일의 낙관적 동시성**: `saveOrg`의 `expectedRevision` 검사(`core.mjs:1157-1160`)를 계승해, 각 문서의 `current.json`(최신 `revision` 번호와 그 revision 파일의 `hash`만 담는 포인터다. 5번 항목이 설명하듯 이 설계는 별도의 `committed` 게이트를 두지 않는다)을 갱신할 때 호출자가 넘긴 `expectedRevision`이 현재 값과 다르면 거부한다. 이것이 "오래된 revision으로 덮어쓰지 않는다"(브리프 조건 6)는 요구를 만족시킨다.
3. **동시 갱신**: `withWorkflowUpdate`의 `.lock` 파일(`workflow-store.mjs:65-75`)과 `gates.mjs`의 `gates-write.lock`(`withAsyncFileLock`, `gates.mjs:379-382`)을 계승해, 문서별 디렉터리에 `.lock` 파일을 두고 갱신 임계구역을 감싼다.
4. **부분 실패 후 원자성(문서 저장소 내부)**: `workflow-store.mjs`의 transaction 저널 패턴(`saveWorkflowState`가 `transaction.json`에 `{state, events}`를 먼저 쓰고 `recoverTransaction`이 반영 후 삭제, `workflow-store.mjs:12-27,122-134`)과 같은 구조(먼저-쓰고-반영-후-삭제하는 저널 파일)를 문서 저장에도 적용한다. 다만 `workflow-store.mjs`가 노출하는 `workflowDirectory`/`workflowStateFile`/`recoverTransaction` 함수 자체를 호출하지는 않는다. 이 함수들은 `WORKFLOW_ID_PATTERN`에 맞는 `workflowId`를 필수로 요구하며(`assert(typeof id === "string" && WORKFLOW_ID_PATTERN.test(id))`, `workflow-store.mjs:36-40`), `{state.json, events/}`라는 workflow 전용 레이아웃에 고정되어 있다. 반면 3.2절 공통 봉투는 `workflowId: null`을 허용하고, `01. 기획` 단계 문서(kickoff-brief-ref)는 workflow 생성 이전에 작성되므로 애초에 `workflowId`가 없다. 그러므로 문서 저장 헬퍼는 `workflow-store.mjs`와 **같은 저널 패턴**(임시 저널 파일 → 반영 → 삭제, 재개 시 저널 존재 여부로 미완료 반영을 재개)을 독립적으로 구현하되, `workflowId`가 있는 `03. 구현` 이후 문서는 그 저널을 workflow 디렉터리 안(`.omt/workflows/<id>/documents/...`)에 두어 기존 workflow `.lock`의 보호를 그대로 받고, `workflowId`가 없는 `01. 기획`/`02. 설계` 문서는 kickoff 디렉터리 자신의 `.lock`으로 보호되는 별도의 경량 저널을 둔다. 이는 AGENTS.md가 금지하는 "런타임 로직의 중복 선언"이 아니라 이미 검증된 저널 **구조**를 다른 범위에 다시 적용하는 것이며, 기존 함수를 호출할 수 없는 이유는 위에서 인용한 코드가 보여준다(finding `workflow-journal-not-reusable-for-non-workflow-docs`).
5. **문서와 참조 객체 사이의 원자성**: 4번 항목은 문서 저장소 **내부**(자신의 revision 파일과 `current.json`)의 원자성만 다룬다. 3.2절이 정의하는 모든 `*Ref` 필드(`kickoffEntryRef`, `workflowRef`, `taskRef`, `attemptRefs[]`, `integrationTaskRef`, `reviewFileRef`, `decisionFileRef`, `evidenceRef`, `reportRef`, `directorSignalRef`, `kickoffArchiveRef`, `incidentRefs[]`, `lessonCandidateRefs[]`)는 예외 없이 **문서가 이미 존재하는 기존 객체를 가리키는 단방향**이다. 이 방향은 문서 자신의 append-only 쓰기(1번 항목) 안에서 완결된다. 참조 대상이 실제로 존재하고 3.6절이 요구하는 허용 상태에 있는지는 문서를 쓰기 **전에** 읽기 전용으로 검증하면 되고, 검증에 실패하면 문서 자체를 쓰지 않으므로 어떤 불일치도 남지 않는다. 따라서 이 방향에는 별도의 원자성 계약이 필요 없다.

   이 단방향 원칙만으로는 조건 4를 충족하지 못한다는 것이 `design-independent-review-pl-7`의 판정이다(finding `document-write-reference-update-atomicity-unaddressed`). 문서가 기존 객체를 가리키는 것과 별개로, review/decision·kickoff 등록 항목처럼 문서로 옮겨진 지속 객체 자신도 자기를 문서화한 문서를 향한 검증 가능한 참조를 갖고 있어야 하며, write-once 구조(`gates.mjs:399-400`)는 "이미 쓴 레코드를 다시 쓰지 않는다"는 계약일 뿐 그 요구를 면제하지 않는다는 것이 이사 판정 1)의 핵심이다(pl-7 criterion `revision-integrity-compat`).

   이 설계는 **어떤 기존 객체에도 새 필드를 쓰지 않고** 이 요구를 충족한다. 참조를 **저장**하는 대신 **유도**하는 방법을 쓴다. 3.5절의 `docId`는 `<kickoffHash>/<workflowId|none>/<stageSlug>/<docType>/<localId>` 다섯 세그먼트로 구성되며, 앞 네 세그먼트는 항상 호출 맥락(3.11절의 kickoff-show/workflowStateFile 조회)만으로 결정된다. 마지막 세그먼트 `localId`를 대응하는 기존 객체 자신이 이미 갖고 있는 불변 필드로부터 결정적으로 계산하면, 그 객체는 아무것도 새로 쓰지 않고도 자기 대응 문서의 정확한 위치를 스스로 증명하는 참조를 이미 보존하고 있는 셈이 된다.

   **localId 결정 규칙(조건 4의 일반 해법).**

   | docType | localId | 유도 근거 |
   |---|---|---|
   | kickoff-brief-ref | 고정 상수 `"kickoff"` | 아래 "kickoffHash 재사용 충돌 방지" 문단이 정의하는 `kickoffHash`는 `worktreeId`와 등록 항목의 `createdAt`을 함께 묶으므로, 같은 `worktreeId`를 release 뒤 재등록해도 새 kickoff은 다른 `kickoffHash`를 받는다. 그 `kickoffHash`+workflowId=none 조합 아래에서는 `registerKickoff`의 재등록 거부(`locateEntry`가 기존 항목을 찾으면 예외를 던진다, `kickoff-registry.mjs:340-347`)가 활성 구간 동안 정확히 하나만 존재함을 보장한다 |
   | workflow-task-ref | task 자신의 `id` | task revision 파일 경로 자체가 이미 이 `id`로 문서를 구분한다(`workflow.mjs:304-313`) |
   | integration-ref | 통합 task 자신의 `id` | 하위 task와 겹치지 않는 별도 id가 이미 보장된다(`workflow.mjs:278-279`) |
   | review-ref | review 기록 자신의 `id` | 파일 경로 자체가 이미 이 `id`로 review를 구분한다(`reviewFile(stateDir, id)`, `gates.mjs:38-39`) |
   | acceptance-ref | decision 기록 자신의 `id` | 파일 경로 자체가 이미 이 `id`로 decision을 구분한다(`decisionFile(stateDir, id)`, `gates.mjs:40-41`) |
   | delivery-ref | kickoff 등록 항목의 `delivered.mergeCommit` | `recordDelivery`가 재배달 시도마다 `entry.delivered.head === verified.head`를 확인해 사실상 불변으로 고정한다(`kickoff-registry.mjs:632-644`) |
   | closure-record | 고정 상수 `"closure"` | 위와 같은 이유로 한 `kickoffHash`는 정확히 한 번의 kickoff 종료에만 대응하므로, `releaseKickoff`이 활성 등록부에서 엔트리를 지운 뒤(`fs.unlinkSync`, `kickoff-registry.mjs:720`)에도 closure-record는 이 kickoff 종료 1회에 대응하는 유일한 인스턴스로 남는다 |

   **kickoffHash 재사용 충돌 방지(이사 판정 1, msg_b5d7ae51e67d).** 이전 판(커밋 `1560076`)은 `kickoffHash`를 `entryName(worktreeId) = sha256(worktreeId)`(`kickoff-registry.mjs:106-109`)로만 정의했다. `worktreeId`(`<repoId>::<worktreePath>` 문자열, 3.11절)는 워크트리 **경로**를 식별할 뿐 kickoff **인스턴스**를 식별하지 않으므로, `releaseKickoff`이 활성 등록부에서 엔트리를 지운 뒤(720행) 같은 경로에 새 kickoff을 등록하면 `registerKickoff`의 재등록 거부(340-347행)를 통과해 이전과 동일한 `kickoffHash`를 다시 받는다. `locateEntry`(128-136행)는 활성 등록부만 조회하므로 이 재사용을 막지 못하고, kickoff-brief-ref('kickoff')와 closure-record('closure')의 `docId`가 이전 kickoff의 revision 이력 위에 그대로 이어진다.

   이 설계는 `kickoffHash`를 `sha256(worktreeId + "\u0000" + entry.createdAt)`으로 재정의한다. `createdAt`은 `registerKickoff`이 등록 시점에 한 번만 발급하고(426행) 이후 어떤 함수도 다시 쓰지 않는 필드이며(`writeJSON`으로 엔트리 전체를 덮어쓰는 `bindKickoffRun` 등도 읽은 엔트리의 `createdAt`을 그대로 보존해 쓴다), `validateEntry`가 그 존재를 필수로 검증한다(178행). 같은 `worktreeId`로의 재등록은 반드시 이전 엔트리의 release(unlink)를 거쳐야만 가능하므로(340-347행), 새 등록은 항상 이전과 다른 시각의 `createdAt`을 받아 다른 `kickoffHash`를 만든다. 이는 새 개념이 아니라 `releaseKickoff` 자신이 이미 archive 파일명에 쓰는 계산과 같다(``kickoff-${entryName(worktreeId)}-${entry.createdAt.replace(...)}.json``, 713행): 이 설계는 그 파일명이 이미 쓰는 두 값(`worktreeId`, `createdAt`)으로 `kickoffHash`를 만들 뿐이며, 새 불변 필드를 등록 항목에 추가하지 않는다.

   문서를 새로 쓰는 모든 지점은 아래 `documents.mjs`가 제공하는 `resolveKickoffHash(orgFile, worktreeId)` 하나만 호출해 `kickoffHash`를 얻는다. 이 함수는 `locateEntry`로 활성 등록부를 먼저 찾아 그 `createdAt`을 쓰고, 활성 항목이 없으면(release 직후 closure-record를 쓰는 경우) `history/` 아래에서 파일명이 ``kickoff-${entryName(worktreeId)}-*.json``과 일치하는 항목 가운데 `releasedAt`이 가장 늦은 것을 골라 그 `createdAt`으로 계산한다. `releaseKickoff`이 이미 반환하는 `entry`(721행)를 가진 호출자는 이 조회 없이 그 값을 직접 써도 된다.

   review/decision 레코드는 이 규칙으로 **아무 필드도 새로 쓰지 않는다.** `04. 검토`/`05. 수용` 문서가 review/decision을 가리키는 것(`reviewFileRef`/`decisionFileRef`, 정방향)과, review/decision 레코드 자신의 `id`가 그 문서의 `localId`가 되어 대응 문서를 결정적으로 가리키는 것이 동시에 성립하므로, write-once 구조를 건드리지 않고도 조건 4를 만족한다. kickoff 등록 항목도 `delivered.docRef` 같은 새 필드를 쓰지 않는다. `recordDelivery`가 이미 쓰는 기존 필드 `entry.delivered.mergeCommit`(`kickoff-registry.mjs:636-644`)이 delivery-ref 문서의 `localId`이므로, 그 필드 자체가 이미 검증 가능한 참조다.

   이로써 **문서와 참조 객체 사이에 두 번째 저장소를 갱신하는 쓰기가 이 설계 어디에도 없다.** 이전 판(커밋 `2a4824a`)이 제안한 엔트리 지문 CAS, `intent.json` 저널, "문서 락 → 등록부 락" 커밋 순서는 이 재설계로 전부 불필요해진다. 이사 판정 2)("(3) 이후 (4) 이전 중단 시 원래 입력을 어디서 복구하는지 증명하지 않는다")와 이사 판정 3)("(5) 성공 이후 자기 자신이 만든 지문 변화와 다른 세션의 경쟁 갱신을 하나의 절차로 구분하지 못한다")은 그 대상이 된 두 번째 쓰기 단계 자체가 사라지므로 더 이상 발생하지 않는다. 문서 저장소 내부의 원자성은 1~4번 항목(append-only, `expectedRevision` CAS, `.lock`, transaction 저널)만으로 완결되며, 이번 재설계는 그 위에 어떤 단계도 추가하지 않는다.

   문서가 존재하는지는 `current.json`의 존재 여부만으로 판정한다(3.3절 상태 전이 조회, 3.6절 참조 무결성 검사 모두 동일). 4번 항목의 저널이 revision 파일과 `current.json` 쓰기를 하나의 원자 단위로 묶으므로(`workflow-store.mjs`의 `recoverTransaction`과 같은 패턴으로, 저널이 남아 있으면 다음 접근이 먼저 반영을 완결한 뒤 읽는다), 어떤 판독기도 그 둘 가운데 하나만 반영된 중간 상태를 보지 않는다. 그러므로 이 설계는 이전 판이 두었던 별도의 `committed` 불리언 게이트를 두지 않는다(2번 항목도 이를 반영해 수정했다). 그 게이트는 문서와 참조 객체 사이의 두 번째 저장소 쓰기가 끝나기를 기다리기 위한 장치였는데, 그런 두 번째 쓰기가 이 설계에는 없다.

   **organization과 조건 5.** organization은 이 규칙 어디에도 해당하지 않는다. 이 설계에서 organization을 가리키는 정형 문서가 없기 때문이다(2단계 참조 행렬, "정형 문서 대상: 아니오"). 조건 5는 organization이 문서를 참조해야 한다는 뜻이 아니라, organization을 읽는 역할이 자기 업무에 필요한 문서를 organization 없이도 찾을 수 있어야 한다는 뜻이다. 역할이 문서를 찾는 유일한 경로는 3.11절이 이미 정의한 절차(kickoff 등록부와 workflow 상태)이며, 이 경로 어디에도 organization.json 조회가 끼어들지 않는다. organization.json 자신은 프로젝트마다 정확히 하나만 존재하는 고정 경로(`<project>/.omt/organization.json`, `saveOrg`, `core.mjs:1142`)이므로 "위치"를 찾는 절차가 애초에 필요 없고, `revision`은 파일 자신의 필드(`core.mjs:1157-1160`)로 자기 서술적이다. organization은 조건 5를 이미 사소하게 만족하며, 이를 위해 새 참조 메커니즘을 추가할 필요가 없다.

   **문서 정본 조회 함수 `documentState`와 그 소비자 확장(이사 판정 2·3·4).** `entry.delivered`를 실제로 소비하는 모든 지점을 전수 확인했다(`grep -n "\.delivered\b" plugins/oh-my-teams/scripts/*.mjs`로 재현 가능): `delivery.mjs:193-203`(`deliverKickoff`의 멱등 재배달 확인), `kickoff-registry.mjs:632-635`(`recordDelivery`의 재배달 확인), `kickoff-registry.mjs:702-709`(`releaseKickoff`의 `completed` 종료 조건), `kickoff-registry.mjs:787-794`(`cleanupKickoffBranches`의 branch 삭제 대상 결정). 이 가운데 `releaseKickoff`과 `cleanupKickoffBranches`는 `listKickoffs`를 거치지 않고 `locateEntry`로 엔트리를 직접 읽으며(`releaseKickoff`, `kickoff-registry.mjs:672`), `entry.delivered`의 존재와 `head`/`mergeCommit`만 검사할 뿐 delivery-ref 문서의 커밋 여부를 전혀 조회하지 않는다. "listKickoffs 호출자"로 범위를 한정했던 이전 판이 이 두 함수를 놓친 정확한 원인이 이것이다. 같은 문제가 `gates.mjs`의 `recordReviewLocked`(386-421행)·`acceptOutcomeLocked`(444-493행)에도 있다. 이 둘은 `04. 검토`/`05. 수용` 문서의 존재나 커밋 여부를 전혀 조회하지 않고 review.json/decision.json을 저장하며 gate를 전이시킨다(이사 판정 2). `localId`를 계산할 수 있다는 것(256행)은 review/decision 레코드가 문서 위치를 스스로 증명할 수 있다는 뜻일 뿐, 그 자체로 저장·전이를 거부하는 검사가 아니다.

   이 네 지점 모두, "문서가 `current.json`을 가졌는지" 확인을 각자 다시 구현하지 않고 `documents.mjs`가 제공하는 단일 함수 `documentState(stateDir, docId)`만 호출한다(이사 판정 3, "정본 조회 함수인지 명시"). 계약은 다음과 같다. (1) 문서 디렉터리에 4번 항목이 정의한 저널(임시 저널 파일)이 남아 있으면 `documentState`가 먼저 그 반영을 완결하고 저널을 지운다(`workflow-store.mjs`의 `recoverTransaction`과 같은 "반영 후 삭제" 패턴을 독립 구현한 것으로, 4번 항목이 이미 정의한 그 저널이며 새 메커니즘이 아니다). (2) 그런 뒤 `current.json`의 존재만으로 `{exists: true, revision, hash}` 또는 `{exists: false}`를 반환한다. (1)을 먼저 거치므로 `exists: true`는 항상 완전히 반영된 revision을 가리키며, 이 설계 어디에도 `fs.existsSync`를 직접 호출해 문서 존재를 판정하는 지점을 남기지 않는다.

   런타임 변경 자체는 wave-2 대상이며, 이번 작업 파동은 아래 네 확장의 명세만 정한다.

   - **`releaseKickoff` 확장**: `reason === "completed"`이고 `entry.delivery?.mode === "local-merge"`이고 `entry.delivered?.mergeCommit`이 있으면, 위 표의 규칙으로 유도한 delivery-ref `docId`에 `documentState(stateDir, docId).exists`를 확인하는 조건을 기존 702-709행의 assert 바로 뒤에 추가한다. `force`로 우회할 수 있는 기존 패턴을 그대로 잇는다. `entry.delivered`가 아예 없으면(병합 전) 기존 assert가 이미 막고 있으므로 새 조건은 적용되지 않는다.
   - **`cleanupKickoffBranches` 확장**: 787-794행에서 `deliveryRef`를 확정하기 직전에 같은 방식으로 유도한 `docId`에 `documentState(...).exists`를 확인한다. 존재하지 않으면 `deliveryRef`는 undefined로 남아 기존 "delivery.mode가 none이거나 delivered 기록이 없는 경우"와 같은 경로로 삭제를 skip한다(함수 설명이 이미 "확인할 수 없으면 skip, force하지 않는다"고 명시한다). `force`가 주어지면 기존 정책대로 우회한다.
   - **`gates.mjs`의 `reviewGate`/`matchingApprovedReview`(205-270행) 확장**: `matchingApprovedReview`가 후보 review를 찾은 뒤, 그 review의 `id`로 유도한 review-ref `docId`에 `documentState(stateDir, docId).exists`를 확인하는 조건을 추가한다. 문서가 없으면 그 review는 매칭된 것으로 치지 않아 `reviewGate`의 `missing`에 남고, `review-complete` 게이트는 `pending`을 유지한다. `recordReviewLocked`(386-421행) 자신의 write-once 쓰기 순서는 바꾸지 않는다(`04. 검토` 문서가 review 기록을 가리키는 정방향이므로, review 기록이 문서보다 먼저 존재하는 지금의 순서가 유지된다). `acceptOutcomeLocked`(469-475행)가 이미 `review-complete` 상태를 전제조건으로 확인하므로, 이 확장만으로 "허용되지 않은 상태의 문서를 가리키면 저장 또는 상태 전이가 거부된다"(브리프 조건 4)는 요구가 review-ref 경로에도 review 저장 자체를 막지 않은 채 상태 전이(수용) 단계에서 전파된다.
   - **`gates.mjs`의 `matchingDecision`(272-283행) 확장**: 같은 방식으로 acceptance-ref `docId`에 `documentState(...).exists`를 확인해, 문서가 없으면 그 decision을 매칭에서 제외한다. `gateCheck`의 `outcome-accepted` 게이트(348-351행)는 이미 `matchingDecision`의 반환값 유무로 `passed`/`pending`을 정하므로, decision 저장(`acceptOutcomeLocked`) 자신은 write-once로 그대로 두면서 "acceptance-ref 문서가 없으면 outcome-accepted 게이트가 통과하지 못한다"는 형태로 저장이 아니라 상태 전이를 거부한다.
   - **호출 문맥**: `gates.mjs`의 `recordReview`/`acceptOutcome`/`gateCheck`는 `kickoffHash`/`workflowId`를 이미 인자로 받지 않으므로, 호출자(구현 역할이 review/accept를 요청하는 스크립트)가 이미 알고 있는 두 값을 새 옵션 인자로 전달한다(예: `gateCheck(repo, task, report, stateDir, { kickoffHash, workflowId, ...options })`). `stateDir`는 이미 kickoff 1:1로 범위가 정해져 있으므로(각 kickoff은 자신의 PM 워크트리 `.omt`를 가지며 `documents/`도 그 안에 둔다) 이 값은 재개 절차(3.11절)가 workflow state를 읽을 때 한 번 구해 재사용하는 값과 같다. `documentState`를 부르는 `stateDir`가 이미 그 kickoff으로 범위가 정해져 있으므로, 이 확인이 "다른 kickoff의 문서를 잘못 승인 근거로 삼는" 경로를 열지 않는다.
   - **`history/` 이관 이후**: delivery-ref `docId`는 `kickoffHash`(위에서 재정의한, kickoff 인스턴스마다 고유한 값)와 `mergeCommit`(재배달 시도로도 바뀌지 않는 값)만으로 계산되므로, kickoff이 활성 등록부에 있든 `history/`로 이관됐든 항상 같은 값을 가리킨다. 그러므로 `force`로 문서 미커밋 상태를 우회해 kickoff을 종료해도, delivery-ref 문서는 그 자리에서 나중에라도 독립적으로 완결될 수 있으며 "아카이브 이후 갱신 경로가 없다"는 문제 자체가 생기지 않는다. 다만 종료된 kickoff의 인도 문서가 미완결로 남았다는 사실은 감사 대상이므로, `07. 종료` closure-record의 `outcome` 필드(3.2절, 기존 필드)에 그 사실을 적어 이사가 확인할 수 있게 한다.

   **읽기 시점별 판정 결과.** 두 번째 저장소 쓰기가 없으므로 "쓰다가 중단"되는 지점은 문서 저장소 내부(1~4번 항목)에만 있고, 그 재개 절차는 4번 항목이 이미 규정한 transaction 저널을 그대로 따른다(이 설계가 새로 정의할 것 없음, 브리프 조건 6·7이 요구하는 "등록부와 지속 근거만으로 완료·거부를 판정"도 이 저널만으로 충족된다). 이번 재설계가 새로 다루는 것은 문서가 아직 존재하지 않는 동안 기존 소비자가 무엇을 보는가이며, 이는 "언제 쓰다가 중단됐는가"가 아니라 "지금 읽을 때 어떤 상태인가"로 분기한다. 모든 판정은 위에서 정의한 `documentState(stateDir, docId)` 하나로 통일한다.

   | 시점 | 지속 상태 | `documentState(...)` | `releaseKickoff`(completed 판정) | `cleanupKickoffBranches`(삭제 판정) | 새 세션의 판정 |
   |---|---|---|---|---|---|
   | merge 전 | `entry.delivered` 없음 | 호출 대상 아님(`docId`를 유도할 `mergeCommit`이 없다) | 기존 702-709행 assert가 이미 거부(force 없이는) | `deliveryRef` 미확정, skip | 해당 없음 |
   | merge 완료, 문서 생성 시작 전 | `entry.delivered.mergeCommit` 존재, 문서 디렉터리 없음 | `{exists: false}` | 거부(force 없이는) | `docId` 문서 없음, skip | 문서 생성 절차를 1번 항목의 append-only 쓰기부터 새로 시작 |
   | revision 파일만 쓰임(4번 항목 저널 반영 전) | revision 파일 존재, `current.json` 없음 또는 저널 미반영 | 저널을 먼저 반영한 뒤 재판정(반영되면 `exists: true`, 저널 자체가 미완성이면 `exists: false`) | 위와 동일 기준으로 거부/통과 | 위와 동일 기준으로 skip/진행 | 4번 항목이 이미 정의한 transaction 저널 재개 절차를 그대로 따른다 |
   | `current.json` 존재(문서 커밋 완료) | 문서 완전히 존재 | `{exists: true, revision, hash}` | 이 조건은 통과(다른 조건도 만족해야 최종 허용) | `deliveryRef` 확정, 삭제 진행 | 완료로 판정, 추가 조치 없음 |
   | `force`로 completed 강제 종료(문서 미존재인 채) | kickoff이 `history/`로 이관, `entry.delivered.mergeCommit`은 아카이브 엔트리에도 그대로 보존 | `{exists: false}` 유지(문서는 여전히 완결 가능) | 강제 통과(감사 근거는 closure-record의 `outcome`) | 별도 판단(branch 삭제는 보통 close와 분리된 별도 호출) | `docId`는 이관 여부와 무관하게 그대로 유효, 문서는 독립적으로 나중에 완결 가능 |

   **review-ref/acceptance-ref 소비자(`reviewGate`/`acceptOutcome`)의 읽기 시점별 판정.**

   | 시점 | 지속 상태 | `documentState(...)` | `review-complete`/`outcome-accepted` 게이트 | 새 세션의 판정 |
   |---|---|---|---|---|
   | review/decision 기록만 존재, `04. 검토`/`05. 수용` 문서 없음 | review.json 또는 decision.json 존재, 문서 디렉터리 없음 | `{exists: false}` | `pending`(그 review/decision은 매칭에서 제외) | 배정된 역할이 대응 문서를 작성해 커밋해야 게이트가 진행된다. review/decision 기록 자체는 write-once로 이미 안전하게 보존되어 있으므로 다시 만들 필요는 없다 |
   | 문서까지 커밋 완료 | review.json/decision.json과 대응 문서 모두 존재 | `{exists: true}` | 정상 진행(다른 조건도 만족해야 `passed`) | 완료로 판정 |
   | 문서가 다른 kickoff·workflow를 가리키는 `docId`로 잘못 조립된 경우 | review.json은 있으나 유도한 `docId`가 가리키는 위치에 그 review를 위한 문서가 없음(다른 kickoff의 문서와 우연히 경로가 겹치지 않음, `kickoffHash`가 kickoff 인스턴스마다 고유하므로) | `{exists: false}` | `pending` | 3.6절 참조 무결성 검사가 애초에 그런 문서 생성을 거부하므로 이 상태는 정상 경로에서 발생하지 않는다. 발생하면 배정자에게 보고 |

   **kickoffHash 재사용 시나리오의 판정.** 같은 `worktreeId`가 release된 뒤 재등록되면, 새 kickoff은 새 `createdAt`을 받아 새 `kickoffHash`를 만든다(위 "kickoffHash 재사용 충돌 방지" 문단). 이전 kickoff의 kickoff-brief-ref/closure-record는 이전 `kickoffHash` 아래에 그대로 남고, 새 kickoff의 kickoff-brief-ref는 새 `kickoffHash` 아래에 독립적으로 처음부터(revision 1) 시작한다. `resolveKickoffHash`가 항상 활성 등록부를 먼저 확인하므로, 재등록 이후의 모든 새 문서 쓰기는 새 `kickoffHash`만 얻으며 이전 kickoff의 문서 이력을 참조하거나 덮어쓸 경로가 없다.
6. **작성자·시각·근거·이전 revision·사유**: 3.2절 공통 봉투의 `author`, `createdAt`, `reason`, `basedOnRevision` 필드가 이를 담는다.

### 3.8 product-canonical과 execution-instance 분리

| 구분 | 속하는 것 | 저장 위치 |
|---|---|---|
| product-canonical(저장소 추적) | 문서 JSON 스키마(`schemas/document-*.schema.json`), `stageSlug ↔ 폴더 이름` 매핑 테이블, 문서 저장 헬퍼 모듈, 이 설계 문서 | git 추적 대상 |
| execution-instance(`.omt`, git 제외) | kickoff별 실제 문서 인스턴스, `organization.json` 자체(정책 값은 배포마다 다를 수 있는 실행 상태), workflow/task/review/decision/evidence 등 표 1.2의 모든 파일 | `.omt/`(`.gitignore`로 제외됨을 `git check-ignore -v .omt/organization.json`으로 확인) |

`organization.json`은 그 내용이 조직 전체의 정책을 담고 있어 정본처럼 보이지만, 실제로는 배포된 각 저장소의 `.omt/organization.json`이 로컬 실행 상태이며 git으로 추적되지 않는다. 정본은 그 값의 **형태**를 규정하는 `organization.schema.json`이며, 실제 값 자체는 execution-instance로 분류한다. 이 구분을 명시하지 않으면 "product-canonical vs execution-instance 분리"(브리프 조건)가 organization 객체에서 모호해진다.

### 3.9 macOS/Windows 폴더명 이식성

3.5절이 정한 대로 문서를 실제로 담는 디렉터리 이름은 `01. 기획`부터 `07. 종료`까지의 폴더 이름 그 자체이며, 실체 없는 표시용 계층이 아니다. 이 이름들에는 Windows가 금지하는 문자(`< > : " / \ | ? *`)가 없으므로 파일 시스템 계층에서 그대로 생성할 수 있다. 다만 macOS(APFS)는 파일명을 유니코드 NFD로 정규화해 저장하는 경우가 있어, git에 NFC로 커밋된 매핑 테이블의 문자열과 파일 시스템이 실제로 반환하는 바이트 열이 다를 수 있다. 이 설계는 3.5절에서 논리 식별자(`docId`)를 폴더 이름 문자열과 완전히 분리했으므로(`docId`는 항상 `stageSlug`만 담는다), 정규화 불일치가 생겨도 참조 무결성이나 식별에는 영향을 주지 않는다. 폴더를 실제로 생성·조회하는 코드는 매핑 테이블에서 가져온 폴더 이름을 비교할 때 항상 `String.prototype.normalize("NFC")`로 정규화한 뒤 비교하며, 이 생성·조회는 AGENTS.md가 요구하는 대로 지정된 파일 시스템 어댑터(`writeJSON`류)를 통해서만 수행한다.

### 3.10 호환·이전 정책

기존 `.omt` 상태(review/decision/evidence 등, 이 설계 이전에 이미 생성된 파일)는 삭제하거나 새 문서 체계로 자동 변환하지 않는다. 새 문서 체계는 그 파일들을 가리키는 참조(`docId`가 아닌, 기존 상대 경로를 담는 `legacyRef` 필드)만 만들어 `03. 구현`/`04. 검토`/`05. 수용` 문서에 연결한다. `kickoff-registry.mjs`의 `migrateLegacyLease`(단일 kickoff 시절 `active-kickoff.json` 이전)와 `coordinator/selfCoordinator → pm/selfPm` 키 마이그레이션(신·구 키가 함께 있고 값이 다르면 거부, `kickoff-registry.md:53`)이 이미 같은 원칙, 즉 "호환 경로도 같은 무결성 검사를 통과해야 한다"는 원칙의 선례다. 새 문서 체계도 동일하게, `legacyRef`가 가리키는 파일이 실제로 존재하는지와 그 파일의 `taskId`/`kickoffId`가 문서의 스코프와 일치하는지를 신규 문서와 똑같이 검사하며, 존재를 확인할 수 없는 참조는 신규 검사를 우회해 통과시키지 않고 거부한다.

**"이 설계 이전"의 판정 근거.** 어떤 review/decision/evidence 파일이 legacy인지는 파일의 존재 시각을 추정(mtime 등)하지 않고, organization에 새 필드 `documentSystemActivatedAt`(ISO 시각, wave-2에서 `organization.schema.json`에 추가)을 두어 명시적으로 판정한다. 이 필드가 채워진 뒤에 생성된 review/decision/evidence 파일은 그 kickoff에서 새 문서 체계가 이미 활성 상태였다는 뜻이므로, `legacyRef`로 연결되지 않고 반드시 대응하는 정형 문서(`04. 검토`/`05. 수용`)를 가져야 한다. 이 필드가 채워지기 전에 생성된 파일만 `legacyRef` 대상이 된다. 따라서 "활성화 이후에 만들어졌지만 문서화가 누락된 레코드"는 legacy로 오분류되지 않고, 3.14절의 회귀 테스트가 검증하는 "깨진 참조" 시나리오로 그대로 거부된다.

### 3.11 등록부와 참조만으로 재개하는 절차

`docId`가 `kickoffHash`, `workflowId`, `stageSlug`, `docType`, `localId`로 결정적으로 구성되므로, 재개하는 세션은 다음만으로 필요한 문서를 다시 찾는다.

1. `kickoff-show`로 등록부에서 `pm.worktreeId`를 확인하고, 3.7절 5번 항목이 정의하는 `resolveKickoffHash(orgFile, worktreeId)`로 `kickoffHash`를 얻는다. 이 함수는 활성 등록부의 `createdAt`을 우선 쓰고, 활성 항목이 없으면(release 직후) `history/`에서 그 `worktreeId`의 가장 최근 archive 항목을 찾아 그 `createdAt`으로 계산하므로, 같은 `worktreeId`가 release 뒤 재등록됐더라도 지금 재개하려는 kickoff과 다른 `kickoffHash`를 섞어 얻지 않는다.
2. `workflowStateFile(stateDir, workflowId)`(`workflow-store.mjs:51-53`)로 workflow 상태를 읽어 `workflowId`와 진행 중인 `taskId`를 얻는다.
3. 얻은 값으로 `docId`를 조립해 해당 문서 디렉터리를 결정적으로 찾는다. 별도의 "마지막으로 참조한 문서" 색인을 등록부에 추가하지 않는다.

이는 handoff checkpoint(`checkpoint.md`/`checkpoint.json`)가 부모 대화를 복사하지 않고 워크트리의 파일만으로 재개하는 기존 패턴(`handoff.mjs`)과 kickoff-registry.md가 명시한 "새 세션과 재개된 kickoff가 등록부와 객체 참조만으로 필요한 문서를 다시 찾는다"는 원칙을 그대로 따른 것이다.

### 3.12 Run 생성 후 orchestration 메시지 계약

`references/orca-runtime.md`(전체 415행)와 `references/bluf.md`를 확인한 결과, "메시지 본문에 문서 전문을 복사하지 않고 행동·문서 식별자·경로·기대 revision·필요한 절만 담는다"는 수준의 명시적 스키마는 기존 문서에 없다. `bluf.md`의 "적용하지 않는 출력" 절(36-42행)이 "`worker_done` 같은 Orca 메시지의 구조화된 필드는 그 형식을 그대로 따른다"고만 규정하므로, 이 계약은 이번 설계가 새로 정의해야 하는 부분이다(브리프 조건 10-11).

제안하는 `orchestration send`/`reply`의 구조화 본문 필드:

```json
{
  "action": "read|update|review|accept",
  "docRef": "omt-doc:<kickoffHash>/<workflowId>/<stageSlug>/<docType>/<localId>@r<revision>",
  "expectedRevision": 3,
  "section": "<필요하면 절 이름, 없으면 생략>"
}
```

답변(`orchestration reply`)은 bluf.md의 두괄식 순서(판정과 근거 → 상위가 내릴 결정 → 상세)를 지키되, "상세" 자리에 갱신한 문서의 새 `revision`과 변경 요약만 적고 문서 본문을 붙이지 않는다. 메시지 사본은 어떤 경우에도 문서 정본을 대체하지 않으며, 읽는 쪽은 받은 `docRef`의 revision이 자기 kickoff·workflow에서 조회한 최신 허용 revision과 같은지 먼저 확인한 뒤에만 그 내용을 신뢰한다.

### 3.13 Orca Goal/Run/Task/Dispatch/settlement와의 경계

이 문서 체계는 Orca의 Goal/Run/Task/Dispatch/settlement 상태를 복제하지 않는다. 필요한 연결은 다음 링크 필드만 보존한다.

- kickoff 등록 항목의 `runId`(`kickoff-bind`가 채움, `kickoff-registry.md:13`)
- workflow task의 `id`(Orca Task/Dispatch가 아니라 OMT task v2 계약의 id, 서로 다른 개념임을 문서에 명시)
- `03. 구현` 문서의 `attemptRefs[]`가 가리키는 `attemptId`(`workflow-reserve`가 발급, `WORKFLOW_EXECUTION.md:6`)

Orca 자체의 Goal/Run/Task/Dispatch 판정, 정산 로직은 오케스트레이션 레이어의 소유이며, OMT 정형 문서는 그 판정 결과를 가리키는 식별자만 인용한다.

### 3.14 criterion 9를 위한 회귀 테스트 계획

두 번째 작업 파동에서 `tests/omt-documents.test.mjs`(가칭)를 신설해 다음 일곱 시나리오를 검증한다. 각 시나리오는 브리프 조건 9가 요구한 항목과 1:1로 대응한다.

| 시나리오 | 검증 내용 | 대응 조건 |
|---|---|---|
| 정상 생성·참조·갱신 | `01. 기획` → `07. 종료`까지 정상 흐름으로 문서를 만들고 서로 참조할 때 모두 성공한다 | 기본 동작 |
| 권한 없는 수정 | Junior가 `04. 검토` 문서를, Senior가 자신이 작성한 `02. 설계`를 스스로 승인하는 시도가 거부된다 | 3.4절 |
| 오래된 revision | `expectedRevision`이 현재보다 낮은 값으로 갱신을 시도하면 거부된다 | 3.7절 |
| 깨진 참조 | 존재하지 않는 `docId`를 가리키는 `*Ref`가 저장 시 거부된다 | 3.6절 |
| 다른 kickoff 참조 | 다른 `kickoffHash`의 문서를 가리키는 참조가 거부된다 | 3.6절 |
| 동시 갱신 | 같은 문서를 두 실행이 동시에 갱신할 때 하나만 성공하고 다른 하나는 재시도 안내를 받는다(락 경쟁) | 3.7절 |
| 문서-참조 객체 원자성(인도) | 문서가 아직 커밋되지 않은 동안 `releaseKickoff`/`cleanupKickoffBranches`가 `force` 없이는 완료·삭제를 진행하지 않으며, `force`로 완료된 뒤에도 delivery-ref 문서의 `docId`가 그대로 유효해 나중에 독립적으로 완결할 수 있다 | 3.7.5절 |
| 문서-참조 객체 원자성(검토·수용) | `04. 검토`/`05. 수용` 문서가 아직 커밋되지 않은 review/decision 기록은 `review-complete`/`outcome-accepted` 게이트를 통과시키지 못하고 `acceptOutcome`이 거부된다. 문서를 커밋한 뒤에는 같은 review/decision 기록으로 게이트가 정상 통과한다 | 3.7.5절 |
| kickoffHash 재사용 격리 | 같은 `worktreeId`를 release 뒤 재등록하면 새 kickoff은 이전 kickoff과 다른 `kickoffHash`를 받고, kickoff-brief-ref/closure-record가 revision 1부터 독립적으로 시작해 이전 kickoff의 문서 이력을 잇지 않는다 | 3.7.5절 |
| 재개 | 등록부와 workflow state만으로 문서 디렉터리를 다시 찾아 이전 세션이 쓴 문서를 읽을 수 있다. release 직후(활성 등록부에 엔트리가 없는 상태)에도 `history/`에서 `kickoffHash`를 복원해 같은 문서를 다시 찾을 수 있다 | 3.11절 |

## 해결된 질문

1차 설계에서 이사·PM에게 올렸던 두 질문은 검토(`design-independent-review-pl-2`) 과정에서 다음과 같이 결정되었고, 본문(3.1절, 3.2절, 2단계 참조 행렬)에 반영했다.

- 다중 task workflow의 `integration-task.json`은 `workflow-task-ref`에 합치지 않고 별도 `docType` `integration-ref`로 분리한다(3.1절 "확정된 결정" 참고).
- `incident`/`lesson candidate`는 문서 체계 밖에서 계속 자기 스키마로 관리하되, `07. 종료`의 `closure-record`가 `incidentRefs[]`/`lessonCandidateRefs[]`로 참조만 연결한다(3.2절 "확정된 결정" 참고).

## 열린 질문

이번 재작업 시점에 이사에게 새로 올릴 열린 질문은 없다.

## wave-2 작업 분할안(파일 소유권 포함)

| 작업 | 대상 파일 | 제안 담당 |
|---|---|---|
| 문서 스키마 신설 | `plugins/oh-my-teams/schemas/document-envelope.schema.json` 및 폴더별 스키마(`integration-ref` 포함), `organization.schema.json`에 `documentSystemActivatedAt` 필드 추가 | Senior 1명 |
| 문서 저장·조회·참조 무결성 런타임 모듈 신설 | `plugins/oh-my-teams/scripts/documents.mjs`(신규, `documentState`·`resolveKickoffHash` 포함) | Senior 1명(스키마 담당과 동일인 권장) |
| kickoff 등록부·검토·수용 게이트에 문서 커밋 확인 추가 | `kickoff-registry.mjs`(`releaseKickoff`/`cleanupKickoffBranches`에 `documentState` 훅), `gates.mjs`(`reviewGate`/`matchingApprovedReview`/`matchingDecision`에 `documentState` 훅과 `kickoffHash`/`workflowId` 전달 인자 추가). `workflow.mjs`는 3.7절 5번 항목의 `localId` 유도 규칙이 기존 필드만 쓰므로 변경 불필요 | Senior 1명(다른 인원, 기존 파일 소유권 충돌 방지) |
| orchestration 메시지 계약 구현 | `orchestration send`/`reply` 관련 스크립트, `bluf.md` 갱신 | 위 훅 담당 Senior와 동일인 |
| 역할 스킬 갱신 | `plugins/oh-my-teams/skills/{director,pm,pl,senior,junior}/SKILL.md` | PL이 조율, 각 Senior가 자기 변경분의 스킬 절만 갱신 |
| 회귀 테스트 | `plugins/oh-my-teams/tests/omt-documents.test.mjs`(신규) | Junior 초안 작성 후 담당 Senior가 검증 |
| 사용자 문서 갱신 | `docs/WORKFLOW_EXECUTION.md`, `plugins/oh-my-teams/references/kickoff-registry.md`, `orca-runtime.md` | 각 변경을 만든 Senior가 자기 변경분과 함께 갱신 |

각 담당자는 자신이 갱신하는 파일에서만 `writeJSON`/스키마 변경을 수행하고, 다른 담당자가 소유한 파일은 참조만 추가해 충돌을 줄인다.
