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
| 35 | OpenCodex 런타임 설치 상태 | `dependencies.mjs:462,465`(스테이징 manifest·lockfile), `:497`(검증 완료 manifest), `:507,509`(`runtimes/<fingerprint>` rename), `:511,516`(`active.json` 교체) | `os.homedir()/.omt/runtime/{active.json, runtimes/<fingerprint>/, locks/<fingerprint>.lock}`(경로 헬퍼 `runtimePaths`, `dependencies.mjs:84-93`; 기준 디렉터리는 `dependencies.mjs:643`) | 없음 | overwrite/rename 기반. **프로젝트 `.omt`가 아니라 사용자 홈 디렉터리의 `.omt/runtime`**이라는 점이 표의 다른 34개 행과 다르다 |

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
| OpenCodex 런타임 설치 상태(표 1.2의 #35) | 프로젝트 `.omt`가 아니라 사용자 홈(`os.homedir()/.omt/runtime`)에 있는 머신 전역 실행 환경 캐시다(`dependencies.mjs:643`). 특정 kickoff·workflow·organization에 속하지 않고 같은 머신의 모든 프로젝트가 공유하며, 어떤 역할도 이를 업무 산출물로 읽거나 참조하지 않고 오직 OpenCodex 기동 전 자동 검증에만 쓰인다 |

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
| review 기록(#12) | 예(`04. 검토`) | PM, Senior(다른 실행), 이사 | 배정된 독립 Senior만 | `seniorEnoughToReview`, 실행 신원 독립성, `taskRevision`/`taskHash` 고정 | 작성 후 불변(append-only) |
| gate 상태(#13) | 아니오(참조만, `04. 검토`/`05. 수용` 문서가 가리킴) | PM, Senior, 이사 | 런타임 자동(review/acceptance 기록 시 재계산) | review/acceptance 기록으로부터 재계산 | task 진행 중 갱신되는 파생 상태, 원본(review/decision)이 정본 |
| acceptance decision(#14) | 예(`05. 수용`) | PM, 이사 | PM(또는 `ACCEPTED_RISK_AUTHORITIES`에 속한 신원) | 모든 필요 review 완료 여부, 기준 충족 여부 | 작성 후 불변 |
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
| `02. 설계` | 구현 전에 계약을 문서로 확정하고 독립 검토를 받는다(이 문서 자체가 그 사례다) | 설계를 배정받은 Senior. `skills/pm/SKILL.md:46`의 "하위 역할이 하나라도 있으면 PM은 최종 산출물을 직접 작성하지 않는다"는 한계에 따라, PM은 이번 실행에 Senior가 없어 폴드-롤로 이어받을 때만 예외적으로 작성한다(3.4절 참고) | 없음(신규 문서 유형) |
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
| PM | `01. 기획`(kickoff 등록), `03. 구현`(workflow request), `05. 수용`. `02. 설계`는 원칙적으로 작성하지 않으며, 이번 실행에 Senior가 한 명도 없어 `foldRole`로 그 일을 이어받을 때만 예외적으로 작성한다(`skills/pm/SKILL.md:46`) | 없음 | 자기가 쓴 문서, `05. 수용`은 PM 전용 | `acceptOutcomeLocked`가 요구하는 대로 모든 필요 review가 끝나야 작성 가능 |
| PL | `03. 구현`(attempt 배정) | 없음(배정만) | 배정 관련 필드만 | Junior/Senior 산출물을 대신 승인하지 않음 |
| Senior | `02. 설계`, `03. 구현`(자기 배정분), `04. 검토`(다른 실행의 산출물) | `04. 검토` | 자기가 작성한 문서만, 검토 문서는 배정된 Senior만 | `senior/SKILL.md`의 "자신이 설계·작성한 변경을 독립 검토로 승인하지 않는다"는 한계를 그대로 반영해, 같은 실행 신원이 작성자이자 검토자인 문서는 거부한다(`implementationExecutionId !== reviewer.executionId` 검사를 문서 계층에도 적용) |
| Junior | `03. 구현`(배정된 구현) | 없음 | 자기가 작성한 문서만 | 검토·수용 문서를 절대 갱신하지 않음(`junior/SKILL.md`의 한계와 동일) |

독립성 검사는 review.schema.json이 이미 요구하는 `reviewer.executionId`와 `implementationExecutionId`의 불일치 검사(`gates.mjs`의 `assertReportBinding`류)를 문서 저장 계층에 그대로 얹는다. 새 판정 로직을 만들지 않고 기존 게이트 함수를 재사용하는 것이 AGENTS.md의 "Orca의 감독 기능을 재구현하지 않는다" 규칙과 일치한다.

#### 3.4.1 호출자 신원 인증의 한계

이 설계의 모든 권한·독립성 검사(`author.executionId`가 실제로 그 역할인지, `reviewer.executionId`가 구현자와 다른지)는 문서를 쓰는 프로세스가 스스로 밝힌 `executionId`가 진짜라는 전제 위에 있다. 이 전제는 새로 만드는 것이 아니라 기존 시스템이 이미 안고 있는 한계를 그대로 물려받는다. `references/orca-runtime.md:212`(「호출자 식별의 한계」 절)는 "호출한 터미널은 환경 변수 `ORCA_TERMINAL_HANDLE`로만 알 수 있고, 이 값이 진짜인지 증명하는 수단은 없다"고 명시하며, "위조를 막는 일은 Orca가 호출자를 인증하는 기능을 제공해야 가능하다"고 밝힌다. `skills/pl/SKILL.md:99`도 검증 캐시에 대해 "해시와 로그는 전송 무결성 확인이며 악의적 로컬 작성자를 인증하지는 않는다"고 같은 한계를 명시한다. 이 설계가 제안하는 문서 저장 계층의 권한 검사도 같은 성격이다. 즉 감독 관계가 없는 실행의 실수(다른 역할 폴더에 잘못 쓰는 시도 등)는 막지만, 같은 머신에서 `executionId`를 일부러 위조하는 프로세스는 막지 못한다. 이 설계는 Orca가 호출자를 인증하는 새 기능을 전제하지 않으며, 그런 기능을 이 kickoff 범위에서 새로 만들지도 않는다.

### 3.5 경로와 독립된 문서 식별자

폴더 이름(`01. 기획` 등)은 사람이 읽기 위한 표시일 뿐이며, 식별자로 쓰지 않는다. 식별자는 workflow id와 같은 패턴(`WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/`, `workflow-store.mjs:7`)을 그대로 계승한 ASCII 슬러그 세그먼트를 `/`로 이어 만든다. 콜론(`:`)은 Windows가 드라이브 문자 위치 밖에서 금지하는 문자이므로 식별자 어디에도 쓰지 않는다.

```
docId = "<kickoffHash>/<workflowId|"none">/<stageSlug>/<docType>/<localId>"
```

이 슬래시 구분 형식은 실제 저장 경로 `.omt/documents/<kickoffHash>/<workflowId|none>/<stageSlug>/<docType>/<localId>/`의 디렉터리 계층과 그대로 대응하므로, 파일 경로에 쓰일 때도 별도의 문자 치환이 필요 없다. `stageSlug`는 폴더 번호가 아니라 의미로 고정한다: `planning`, `design`, `implementation`, `review`, `acceptance`, `delivery`, `closure`. 런타임은 `stageSlug → 폴더 표시 이름`(`01. 기획` 등) 매핑 테이블을 하나만 소유하며, 폴더 표시 이름이 바뀌어도(예: 사용자가 한국어 표기를 조정) 기존 `docId`와 참조는 깨지지 않는다. 이 매핑 테이블은 3.9절의 이식성 요구와 3.8절의 product-canonical 자산에 속한다.

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
2. **포인터 파일의 낙관적 동시성**: `saveOrg`의 `expectedRevision` 검사(`core.mjs:1157-1160`)를 계승해, 각 문서의 `current.json`(최신 revision 번호만 담는 포인터)을 갱신할 때 호출자가 넘긴 `expectedRevision`이 현재 값과 다르면 거부한다. 이것이 "오래된 revision으로 덮어쓰지 않는다"(브리프 조건 6)는 요구를 만족시킨다.
3. **동시 갱신**: `withWorkflowUpdate`의 `.lock` 파일(`workflow-store.mjs:65-75`)과 `gates.mjs`의 `gates-write.lock`(`withAsyncFileLock`, `gates.mjs:379-382`)을 계승해, 문서별 디렉터리에 `.lock` 파일을 두고 갱신 임계구역을 감싼다.
4. **부분 실패 후 원자성(문서 저장소 내부)**: `workflow-store.mjs`의 transaction 저널 패턴(`saveWorkflowState`가 `transaction.json`에 `{state, events}`를 먼저 쓰고 `recoverTransaction`이 반영 후 삭제, `workflow-store.mjs:12-27,122-134`)과 같은 구조(먼저-쓰고-반영-후-삭제하는 저널 파일)를 문서 저장에도 적용한다. 다만 `workflow-store.mjs`가 노출하는 `workflowDirectory`/`workflowStateFile`/`recoverTransaction` 함수 자체를 호출하지는 않는다. 이 함수들은 `WORKFLOW_ID_PATTERN`에 맞는 `workflowId`를 필수로 요구하며(`assert(typeof id === "string" && WORKFLOW_ID_PATTERN.test(id))`, `workflow-store.mjs:36-40`), `{state.json, events/}`라는 workflow 전용 레이아웃에 고정되어 있다. 반면 3.2절 공통 봉투는 `workflowId: null`을 허용하고, `01. 기획` 단계 문서(kickoff-brief-ref)는 workflow 생성 이전에 작성되므로 애초에 `workflowId`가 없다. 그러므로 문서 저장 헬퍼는 `workflow-store.mjs`와 **같은 저널 패턴**(임시 저널 파일 → 반영 → 삭제, 재개 시 저널 존재 여부로 미완료 반영을 재개)을 독립적으로 구현하되, `workflowId`가 있는 `03. 구현` 이후 문서는 그 저널을 workflow 디렉터리 안(`.omt/workflows/<id>/documents/...`)에 두어 기존 workflow `.lock`의 보호를 그대로 받고, `workflowId`가 없는 `01. 기획`/`02. 설계` 문서는 kickoff 디렉터리 자신의 `.lock`으로 보호되는 별도의 경량 저널을 둔다. 이는 AGENTS.md가 금지하는 "런타임 로직의 중복 선언"이 아니라 이미 검증된 저널 **구조**를 다른 범위에 다시 적용하는 것이며, 기존 함수를 호출할 수 없는 이유는 위에서 인용한 코드가 보여준다(finding `workflow-journal-not-reusable-for-non-workflow-docs`).
5. **문서와 참조 객체 사이의 원자성**: 4번 항목은 문서 저장소 **내부**(자신의 revision 파일과 `current.json`)의 원자성만 다룬다. 그러나 문서는 kickoff 등록 항목(`kickoff-registry.mjs`)이나 review/gate 레코드(`gates.mjs`)처럼 **이미 존재하는 별도 저장소**의 참조 필드에서도 인용된다. 예를 들어 `04. 검토` 문서가 만들어진 뒤 `gates.mjs`의 review 레코드가 그 `docId`를 참조 필드에 적어야 한다면, 두 저장소는 서로 다른 파일이므로 단일 트랜잭션으로 묶을 수 없다. 이 설계는 완전한 2단계 커밋을 새로 만들지 않고 다음 두 규칙으로 이 틈을 좁힌다. 첫째, 쓰기 순서를 고정한다: 항상 문서(참조되는 쪽)를 먼저 쓰고, 참조하는 기존 객체(kickoff 등록 항목, review/gate 레코드)를 그다음에 갱신한다. 그러면 중간 실패는 "문서는 있는데 아직 참조되지 않음"이라는, 다시 시도해도 안전한 상태만 남긴다("참조는 있는데 문서가 없음"이라는 깨진 상태는 발생하지 않는다). 둘째, 참조 갱신을 멱등하게 만든다: 참조하는 객체를 갱신하는 호출은 같은 `docId`를 다시 적어도 오류 없이 그대로 성공하도록 만들어, 실패 후 재시도가 항상 안전하게 한다. 참조가 실제로 반영되었는지 의심스러우면, 참조하는 쪽 객체를 다시 읽지 않고도 문서 디렉터리를 스캔해 재구성(reconciliation)할 수 있다는 점이 3.11절의 재개 절차와 같은 원리다.
6. **작성자·시각·근거·이전 revision·사유**: 3.2절 공통 봉투의 `author`, `createdAt`, `reason`, `basedOnRevision` 필드가 이를 담는다.

### 3.8 product-canonical과 execution-instance 분리

| 구분 | 속하는 것 | 저장 위치 |
|---|---|---|
| product-canonical(저장소 추적) | 문서 JSON 스키마(`schemas/document-*.schema.json`), `stageSlug ↔ 폴더 표시 이름` 매핑 테이블, 문서 저장 헬퍼 모듈, 이 설계 문서 | git 추적 대상 |
| execution-instance(`.omt`, git 제외) | kickoff별 실제 문서 인스턴스, `organization.json` 자체(정책 값은 배포마다 다를 수 있는 실행 상태), workflow/task/review/decision/evidence 등 표 1.2의 모든 파일 | `.omt/`(`.gitignore`로 제외됨을 `git check-ignore -v .omt/organization.json`으로 확인) |

`organization.json`은 그 내용이 조직 전체의 정책을 담고 있어 정본처럼 보이지만, 실제로는 배포된 각 저장소의 `.omt/organization.json`이 로컬 실행 상태이며 git으로 추적되지 않는다. 정본은 그 값의 **형태**를 규정하는 `organization.schema.json`이며, 실제 값 자체는 execution-instance로 분류한다. 이 구분을 명시하지 않으면 "product-canonical vs execution-instance 분리"(브리프 조건)가 organization 객체에서 모호해진다.

### 3.9 macOS/Windows 폴더명 이식성

`01. 기획`과 같은 표시 이름에는 Windows가 금지하는 문자(`< > : " / \ | ? *`)가 없으므로 파일 시스템 계층에서는 그대로 생성할 수 있다. 다만 macOS(APFS)는 파일명을 유니코드 NFD로 정규화해 저장하는 경우가 있어, git에 NFC로 커밋된 문자열과 파일 시스템이 반환하는 바이트 열이 다를 수 있다. 이 설계는 3.5절에서 식별자(`docId`)를 폴더 표시 이름 문자열과 완전히 분리했으므로, 정규화 불일치가 생겨도 참조 무결성이나 식별에는 영향을 주지 않는다. 폴더를 실제로 생성·조회하는 코드는 표시 이름을 비교할 때 항상 `String.prototype.normalize("NFC")`로 정규화한 뒤 비교하며, 이 생성·조회는 AGENTS.md가 요구하는 대로 지정된 파일 시스템 어댑터(`writeJSON`류)를 통해서만 수행한다.

### 3.10 호환·이전 정책

기존 `.omt` 상태(review/decision/evidence 등, 이 설계 이전에 이미 생성된 파일)는 삭제하거나 새 문서 체계로 자동 변환하지 않는다. 새 문서 체계는 그 파일들을 가리키는 참조(`docId`가 아닌, 기존 상대 경로를 담는 `legacyRef` 필드)만 만들어 `03. 구현`/`04. 검토`/`05. 수용` 문서에 연결한다. `kickoff-registry.mjs`의 `migrateLegacyLease`(단일 kickoff 시절 `active-kickoff.json` 이전)와 `coordinator/selfCoordinator → pm/selfPm` 키 마이그레이션(신·구 키가 함께 있고 값이 다르면 거부, `kickoff-registry.md:53`)이 이미 같은 원칙, 즉 "호환 경로도 같은 무결성 검사를 통과해야 한다"는 원칙의 선례다. 새 문서 체계도 동일하게, `legacyRef`가 가리키는 파일이 실제로 존재하는지와 그 파일의 `taskId`/`kickoffId`가 문서의 스코프와 일치하는지를 신규 문서와 똑같이 검사하며, 존재를 확인할 수 없는 참조는 신규 검사를 우회해 통과시키지 않고 거부한다.

**"이 설계 이전"의 판정 근거.** 어떤 review/decision/evidence 파일이 legacy인지는 파일의 존재 시각을 추정(mtime 등)하지 않고, organization에 새 필드 `documentSystemActivatedAt`(ISO 시각, wave-2에서 `organization.schema.json`에 추가)을 두어 명시적으로 판정한다. 이 필드가 채워진 뒤에 생성된 review/decision/evidence 파일은 그 kickoff에서 새 문서 체계가 이미 활성 상태였다는 뜻이므로, `legacyRef`로 연결되지 않고 반드시 대응하는 정형 문서(`04. 검토`/`05. 수용`)를 가져야 한다. 이 필드가 채워지기 전에 생성된 파일만 `legacyRef` 대상이 된다. 따라서 "활성화 이후에 만들어졌지만 문서화가 누락된 레코드"는 legacy로 오분류되지 않고, 3.14절의 회귀 테스트가 검증하는 "깨진 참조" 시나리오로 그대로 거부된다.

### 3.11 등록부와 참조만으로 재개하는 절차

`docId`가 `kickoffHash`, `workflowId`, `stageSlug`, `docType`, `localId`로 결정적으로 구성되므로, 재개하는 세션은 다음만으로 필요한 문서를 다시 찾는다.

1. `kickoff-show`로 등록부에서 `kickoffHash`(또는 `pm.worktreeId`)를 확인한다.
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
| 문서-참조 객체 원자성 | 문서 쓰기 직후 참조하는 쪽(kickoff 등록 항목/review 레코드) 갱신이 중단되어도, 재시도가 중복 오류 없이 참조를 완성하고 문서를 다시 만들지 않는다 | 3.7.5절 |
| 재개 | 등록부와 workflow state만으로 문서 디렉터리를 다시 찾아 이전 세션이 쓴 문서를 읽을 수 있다 | 3.11절 |

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
| 문서 저장·조회·참조 무결성 런타임 모듈 신설 | `plugins/oh-my-teams/scripts/documents.mjs`(신규) | Senior 1명(스키마 담당과 동일인 권장) |
| 기존 workflow/task/gates/kickoff-registry에 참조 필드 연결 | `workflow.mjs`, `gates.mjs`, `kickoff-registry.mjs`(각각 최소 훅만 추가) | Senior 1명(다른 인원, 기존 파일 소유권 충돌 방지) |
| orchestration 메시지 계약 구현 | `orchestration send`/`reply` 관련 스크립트, `bluf.md` 갱신 | 위 훅 담당 Senior와 동일인 |
| 역할 스킬 갱신 | `plugins/oh-my-teams/skills/{director,pm,pl,senior,junior}/SKILL.md` | PL이 조율, 각 Senior가 자기 변경분의 스킬 절만 갱신 |
| 회귀 테스트 | `plugins/oh-my-teams/tests/omt-documents.test.mjs`(신규) | Junior 초안 작성 후 담당 Senior가 검증 |
| 사용자 문서 갱신 | `docs/WORKFLOW_EXECUTION.md`, `plugins/oh-my-teams/references/kickoff-registry.md`, `orca-runtime.md` | 각 변경을 만든 Senior가 자기 변경분과 함께 갱신 |

각 담당자는 자신이 갱신하는 파일에서만 `writeJSON`/스키마 변경을 수행하고, 다른 담당자가 소유한 파일은 참조만 추가해 충돌을 줄인다.
