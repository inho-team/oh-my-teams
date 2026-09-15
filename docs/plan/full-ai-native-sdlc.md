# 전체 AI-native SDLC 구현 계획

- 작성일: 2026-09-15
- 상태: S1–S5 구현·전체 회귀·통합 검증 완료
- 통합 브랜치: `feat/full-sdlc-lifecycle`
- 목표: 계획·조사·설계·구현·검증·검토·릴리스·운영 학습을 검증 가능한 산출물과 상태 전이로 연결한다.
- 권한 경계: 릴리스 준비는 결정적으로 판정할 수 있지만, 실제 배포·외부 발송·프로덕션 변경은 범위가 명시된 별도 권한 없이는 실행하지 않는다.

## 1. 현재 기반과 구현 격차

현재 task v2, workflow, evidence, review, PM acceptance, incident와 lesson은 구현돼 있다. 그러나 task v2는 `kind: edit`만 지원하고, 개별 업무 workflow 위에 전체 제품 생명주기를 표현하는 계약은 없다.

이번 구현은 기존 인터페이스를 교체하지 않는다. 기존 task/workflow는 build·verification 구간의 실행 엔진으로 연결하고, 상위 SDLC 계층이 산출물 계보와 단계별 관문을 관리한다.

## 2. 생명주기 단계

| 단계 | 필수 산출물 | 다음 단계 관문 |
|---|---|---|
| intent | 목표, 사용자 가치, 비목표, 제약, 권한 범위 | 필수 질문이 해결되고 책임자가 수용해야 한다. |
| research | 출처, 인용, 관찰, 불확실성 | 모든 핵심 주장이 검증 가능한 출처와 연결돼야 한다. |
| design | 선택안, 대안, 계약, 위험, 되돌리기 | intent와 research revision에 고정되고 필수 설계 검토가 끝나야 한다. |
| plan | task/workflow 그래프, 소유권, 예산, 수용 기준 | 의존성·파일 소유권·검증 명령이 유효해야 한다. |
| build | task report, 변경 source, 실행 receipt | 고정된 계획의 모든 필수 작업이 제출돼야 한다. |
| verification | 기계적 검사와 환경 지문 | 현재 source에 대한 필수 검사가 모두 통과해야 한다. |
| review | 기준별 결론과 finding 이력 | 필수 검토가 독립적으로 완료되고 열린 차단 finding이 없어야 한다. |
| release | release candidate, 변경 목록, provenance, 롤백 계획 | 통합 source·검증·검토·PM 수용이 모두 현재 상태여야 한다. |
| deployment | 대상 환경, 승인, 실행 receipt | 명시적인 배포 권한과 실제 외부 실행 결과가 각각 필요하다. |
| observation | 기간, 지표, 기준선, 관찰 결과 | 관찰 기간 종료 또는 명시적인 중단 결정이 필요하다. |
| incident | 증거, 영향, 진단, 완화 상태 | 중복 제거와 무진전 한도를 적용하고 필요한 새 intent를 만든다. |
| learning | 재현 근거, 적용 후보, 검증 결과 | 검증된 항목만 skill·검사·정책 변경 후보가 된다. |

## 3. 공통 산출물 계약

모든 산출물은 다음 필드를 갖는다.

```json
{
  "schemaVersion": 1,
  "id": "artifact-id",
  "revision": 1,
  "kind": "intent",
  "state": "draft",
  "title": "산출물 제목",
  "content": {},
  "upstream": [
    {"id": "upstream-id", "revision": 1, "sha256": "..."}
  ],
  "evidence": [],
  "owner": {"kind": "role", "id": "pm"},
  "createdAt": "ISO-8601",
  "supersedes": null
}
```

- `id/revision` 조합은 불변이며 같은 경로를 덮어쓰지 않는다.
- upstream은 ID만 참조하지 않고 revision과 canonical hash를 함께 고정한다.
- 외부 receipt는 공급자·대상·실행 ID·관찰 시각을 기록하되 비밀값을 포함하지 않는다.
- hash는 무결성 대조 수단이며 작성자의 신원을 인증한다고 표현하지 않는다.

## 4. 상태 전이

공통 상태는 `draft → ready → active → submitted → accepted → superseded → archived`를 사용한다. 예외 상태는 `blocked`, `failed`, `cancelled`, `invalidated`다.

- 상태 변경은 expected revision과 단기 lock 아래에서 수행한다.
- 전이마다 append-only event를 먼저 원자적으로 기록하고 조회용 state를 materialize한다.
- 허용되지 않은 전이, 누락된 증거와 오래된 upstream은 거부한다.
- `accepted` 결과를 수정하지 않는다. 변경은 새 revision과 새 수용 결정으로 표현한다.
- upstream revision이나 hash가 바뀌면 모든 downstream을 전이 그래프에 따라 재귀적으로 `invalidated`로 만든다.
- 재검증은 원인을 해결한 새 revision에서 수행하며 과거 성공 기록은 보존한다.

## 5. 단계별 관문

결정적 관문은 스키마, 계보, 검사 결과, source fingerprint, 환경, review finding, 권한 범위와 만료를 검사한다. 사람이나 에이전트의 의미 판단은 별도 decision 산출물로 기록한다.

배포 전에는 최소한 다음 조건이 필요하다.

1. release candidate가 현재 integration source를 참조해야 한다.
2. verification과 review가 같은 source와 현재 upstream에 고정돼야 한다.
3. rollback 계획과 관찰 계획이 존재해야 한다.
4. deployment authorization이 action, repository, environment, release ID, source hash와 만료 시각을 포함해야 한다.
5. authorization의 승인 주체가 lifecycle에 고정된 human/policy public key로 canonical payload에 서명해야 한다.
6. deployment receipt도 lifecycle에 고정된 deployment-provider public key의 서명과 authorization 시간 범위를 충족해야 한다.
7. 모델 출력, PM 역할, task의 risk 값과 환경변수만으로 배포 권한이나 실행 receipt를 만들 수 없어야 한다.

권한 검사는 배포 준비를 판정할 뿐 외부 명령을 실행하지 않는다. 실제 배포는 별도 adapter가 기존 사용자 위임을 확인한 뒤 수행하고 receipt를 되돌려준다.

## 6. 저장 구조

```text
.omt/sdlc/<lifecycle-id>/
  request.json
  artifacts/<kind>/<id>/revisions/<revision>.json
  events/<sequence>-<event-id>.json
  decisions/<decision-id>.json
  authorizations/<authorization-id>.json
  receipts/<receipt-id>.json
  state.json
```

state는 event에서 재구성할 수 있는 projection이다. 단일 coordinator 파일 저장소를 첫 구현 범위로 유지하며 다중 호스트 합의를 제공한다고 주장하지 않는다.

## 7. CLI

기존 `teams-org.mjs`에 다음 명령을 추가한다.

- `sdlc-create --request FILE --state DIR`
- `sdlc-status --id ID --state DIR [--json]`
- `artifact-record --id SDLC_ID --artifact FILE --state DIR --revision N --event ID`
- `artifact-transition --id SDLC_ID --transition FILE --state DIR --revision N`
- `artifact-invalidate --id SDLC_ID --artifact-id ID --state DIR --revision N --event ID`
- `release-check --id SDLC_ID --release-id ID --state DIR`
- `deployment-authorize --id SDLC_ID --authorization FILE --state DIR --revision N`
- `deployment-check --id SDLC_ID --deployment-id ID --authorization-id ID --state DIR`
- `deployment-record --id SDLC_ID --deployment-id ID --authorization-id ID --receipt FILE --state DIR --revision N --event ID`
- `observation-record --id SDLC_ID --observation FILE --state DIR --revision N --event ID`
- `incident-to-intent --id SDLC_ID --incident FILE --state DIR --revision N --event ID`

어떤 명령도 push, PR, merge, deploy, publish 또는 외부 발송을 자동 실행하지 않는다.

## 8. 기존 기능 연결

- plan 산출물은 기존 task v2와 workflow 파일의 hash를 참조한다.
- build 산출물은 worker report와 Orca Dispatch/worktree receipt를 참조한다.
- verification은 기존 evidence cache를 재사용하되 현재 artifact lineage도 cache key에 포함한다.
- review는 기존 review finding 이력을 사용하고 lifecycle artifact를 대상에 추가한다.
- release는 기존 workflow 전체 수용 이후에만 준비될 수 있다.
- incident는 기존 kill switch·dedupe·관찰·무진전 정책을 유지한다.
- learning은 기존 lesson 후보를 참조하며 자동 skill 수정 금지를 유지한다.

## 9. 구현 단계

### S1. 계약과 저장 엔진

- lifecycle artifact와 deployment authorization 스키마를 추가한다.
- canonical hash, immutable revision, event journal과 projection을 구현한다.
- 전이 검사와 재귀 invalidation을 구현한다.

### S2. 기존 실행·증거 연결

- task/workflow report를 build artifact로 연결한다.
- evidence/review/acceptance를 verification·review artifact에 연결한다.
- source 또는 upstream 변경 시 관련 수용을 무효화한다.

### S3. 릴리스와 권한 경계

- release candidate와 rollback·observation 관문을 구현한다.
- 범위·대상·환경·action·만료가 고정된 authorization을 구현한다.
- authorization 없이 배포 receipt를 기록하거나 deployed 상태가 되는 경로를 차단한다.

### S4. 운영 피드백

- observation과 incident를 release/deployment 계보에 연결한다.
- incident에서 새 intent를 결정적으로 생성하고 중복을 제거한다.
- learning 후보의 검증·채택 이력을 기록한다.

### S5. CLI·상태·문서·eval

- 전체 CLI를 연결하고 JSON 출력 계약을 고정한다.
- 시작부터 운영 학습까지의 통합 테스트와 중단 복구 테스트를 추가한다.
- README, 실행 문서, 계획 상태와 역할 skill을 실제 지원 범위에 맞춘다.

## 10. 구현 기록

2026-09-15에 artifact·authorization·deployment receipt 스키마와 `scripts/sdlc.mjs`를 추가했다. 모든 상태 변경은 불변 revision과 append-only event로 저장하며, transaction journal이 event와 materialized state를 함께 복구한다. 현재 upstream의 accepted revision/hash를 강제하고 상위 변경 시 downstream을 재귀적으로 무효화한다.

plan·build·verification·review·release에는 기존 task/workflow report, evidence, 독립 review, acceptance와 동일 source hash를 연결한다. release는 rollback·observation 계획을 요구한다. deployment는 lifecycle에 미리 고정된 human/policy public key로 검증한 authorization과 범위·시간이 일치하는 성공 receipt가 모두 있어야 accepted가 된다. 이 과정은 외부 배포 명령을 실행하지 않는다.

observation·incident·learning의 의미 관문과 incident fingerprint 기반의 중복 없는 새 intent 생성을 구현했다. 계획에 명시한 SDLC CLI를 `teams-org.mjs`에 연결했고, intent부터 learning까지의 전체 경로와 배포 권한 실패 변형을 `tests/sdlc.test.mjs`에서 검증한다.

## 11. 완료 증거

- 모든 산출물 kind의 유효·무효 스키마 fixture가 존재해야 한다.
- 정상 전체 흐름이 intent부터 learning까지 이어져야 한다.
- 단계를 건너뛰거나 오래된 upstream으로 전이할 수 없어야 한다.
- upstream 변경이 모든 관련 downstream을 재귀적으로 무효화해야 한다.
- 프로세스 중단 뒤 journal에서 동일 state를 복구해야 한다.
- 배포 권한의 누락·위조된 주체·다른 환경·다른 source·만료를 모두 거부해야 한다.
- 권한이 유효해도 외부 배포를 실행하지 않고 준비 상태만 반환해야 한다.
- deployment receipt가 승인 범위와 일치해야만 deployed 상태를 기록해야 한다.
- incident가 원래 deployment와 새 intent의 계보를 연결해야 한다.
- 전체 81개 테스트와 SDLC 통합 경로·조직 eval이 모두 통과해야 한다.
