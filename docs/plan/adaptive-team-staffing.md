# 적응형 팀 편성 첫 파동 설계 (Adaptive Staffing Design Wave 1)

## 1. 현행 파일 근거
- **조직 스키마**: `plugins/oh-my-teams/schemas/organization.schema.json`
- **역할 결속 (Role Binding)**: `plugins/oh-my-teams/scripts/core.mjs`, `plugins/oh-my-teams/scripts/org-draft.mjs`, `plugins/oh-my-teams/scripts/teams-org.mjs`
- **역할 권한과 실행 깊이**: `plugins/oh-my-teams/skills/director/SKILL.md`, `pm/SKILL.md`, `pl/SKILL.md`, `senior/SKILL.md`, `junior/SKILL.md`
- **Kickoff Snapshot & Workflow**: `plugins/oh-my-teams/references/kickoff-registry.md`, `plugins/oh-my-teams/scripts/workflow-store.mjs`, workflow 스키마
- **조직 정본 (정적 예시)**: `/Users/jinsungkim/orca/oh-my-teams/.omt/organization.json` (revision 16에 `gpt-6-sol/low`, `gpt-5.6-terra`, `gemini-3.1-pro-high`, `gemini-3.8-flash-medium` 고정 모델 할당 상태)

## 2. 14개 수용 기준별 변경 지점
1. **상설 조직 역할별 고정 모델 제거**: `organization.schema.json`에서 `assistants`/`advisors`나 `roles`의 `profile`을 정적으로 바인딩하지 않고 사용 가능한 pool, 허용 정책, 동시 실행 한도, 보고 관계로 조직 정의를 재설계한다.
2. **카탈로그 기반 조직 결성**: `teams-org.mjs`의 `form` 및 조직 결성 로직에서 카탈로그 조회를 거쳐 사용 가능한 구독 자원만 확인하도록 변경 (내장 목록 fallback 제거).
3. **이사의 PM 선택**: `director` 스킬과 kickoff 관련 워크플로에 이사가 브리프 복잡도, 위험도에 기반하여 PM 프로필과 추론 강도를 결정하고 선택 기록을 남기는 책임을 추가.
4. **PM의 하위 역할 선택**: `pm` 스킬 및 워크플로 스토어에 PM이 task마다 필요한 실행 깊이와 PL, Senior, Junior의 프로필을 동적으로 선택하도록 지정.
5. **감사 독립성 유지**: `director` 또는 시스템이 감사를 직접 배정하며, PM이 감사 신원, 주 프로필, 판정 권한을 조작할 수 없도록 스키마와 런타임 제약 추가.
6. **지능형 모델 승격/선택**: 모델 선택 로직에 단순 비용뿐 아니라 예상 재작업, 데이터 형식 위험 등을 고려하여 상위 프로필을 선택할 수 있는 판단 기준과 근거 기록(log) 추가.
7. **PM 승격 관문**: PM이 승인 자원 이상의 프로필이나 새 실행기로 승격할 때 이사(`director`)의 명시적 승인 프로세스(`ask`/`escalation`) 구현.
8. **Kickoff/Workflow 스냅샷 보존**: `workflow-store.mjs`에서 kickoff/task 생성 시점의 카탈로그 스냅샷과 프로필 결정 근거를 병합 저장하여, 조직 변경이나 재개 시 불변성을 유지.
9. **실질 토큰 효율 측정**: `core.mjs` 및 워크플로 분석 도구에 입력/출력 토큰, 캐시 적중, 재작업 여부, Agy 대화형 측정 불가량을 포함한 실제 효율성 측정 방식 적용. 문서 참조형 orchestration 메시지 활용 강제.
10. **구형 조직 호환 이전**: 런타임에서 revision 16과 같은 기존 정적 프로필을 포함한 `organization.json`을 읽을 때 호환 계층을 두어 새 모델 선택 정책으로 자연스럽게 이전 (fallback 및 권한 유지).
11. **회귀 테스트**: 정상 선택, 모델 생략, 위험 상승, 권한 위반(PM 자기 승격), 독립성 위반, 카탈로그 장애, 스냅샷 유지 여부를 검증하는 테스트 케이스 (`tests/`) 추가.
12. **스킬 문서/사용자 문서 갱신**: `director`, `pm` 등의 `SKILL.md`와 사용자 문서에 새 계약을 설명하되, 런타임 강제 사항은 문서 내 스크립트 중복 구현 방지.
13. **Eval 평가 근거**: 토큰만 줄인 것이 아니라 재작업 횟수, 해결 품질 등을 비교하는 `evals/` 시나리오 및 측정 스크립트 작성.
14. **코드 품질 및 리소스 관리**: 런타임 무거운 검사(eval, test) 전 자원 슬롯 확보 체계 적용 및 `npm run format`, `sync`, `lint`, `test` 통과 보장.

## 3. 호환 이전 (Compatible Migration)
- 기존 정적인 `profiles` 바인딩을 가지고 있는 `organization.json` (revision 16 이하)은 `core.mjs`의 `validateOrg` 및 파싱 단계에서 임시 호환 레이어(Migration Adapter)를 거쳐 새 구조인 **"가용 자원 Pool + 역할 권한(Role Definition)"** 형태로 변환해 사용한다.
- 기존 진행 중인 kickoff 스냅샷은 생성 당시의 모델 바인딩과 스냅샷을 우선적으로 적용하여, 파이프라인 중간에 모델이 바뀌거나 권한/fallback이 약화되지 않게 한다. 새로운 kickoff에 대해서만 새로운 적응형 편성 체계를 적용한다.

## 4. 승격 권한 (Promotion Authority)
- PM은 최초 이사에게 할당된 자원(Pool) 범위 내에서만 하위 워크플로 및 프로필을 편성할 수 있다.
- 만약 작업 난이도가 높아 할당된 풀 밖의 모델이나 더 비싼 프로필(예: `xhigh` 추론 강도)로 승격이 필요할 경우, PM은 `escalation` 메시지를 통해 이사(Director)에게 승격을 요청한다.
- 이사의 결재(승인 기록)가 `workflow-store`에 저장되어야만 해당 승격된 프로필이 실제로 실행 가능해진다.

## 5. 감사 독립성 (Audit Independence)
- 이슈 #139에서 확립된 감사 독립성을 침해하지 않기 위해, PM의 모델 편성은 "실행을 담당하는 역할 (PL, Senior, Junior)"에 국한된다.
- 검토(Review)와 감사(Audit)를 맡는 에이전트의 신원, 주 프로필, 판정 권한은 PM의 선택 영역 밖에 있으며, 오직 이사(Director) 또는 검증된 독립 정책에 의해 별도로 런타임에서 주입 및 고정된다.

## 6. 측정·eval 계획
- **토큰 효율 지표**: 단순 "역할 호출 제외 수"가 아닌 실제 인/아웃 토큰 사용량, 호출 빈도, 캐시(Prompt caching) 활용 여부를 로깅. 
- **재작업 추적**: 동일한 Task/Criterion 내에서 `review` 반복에 따른 재작업 비용을 추적하여 "값싼 모델을 사용하여 재작업이 늘어난 경우"를 잡아낸다.
- **Agy 등 대화형 사용량 보완**: 측정 불가한 대화 세션도 최소 가중치를 부여하거나 별도 "대화 시도 횟수"로 측정에 포함한다.
- **Eval 기준**: 구현 전과 후의 대표 워크플로(Task 수행 성공까지)를 비교 측정하여, 단순히 토큰 수치만 낮추고 해결 품질(Security, Bug rate)이 떨어지는 결과를 수용하지 않도록 한다.

## 7. 카탈로그 및 정형 문서 선행 계약 의존성
- **동적 모델 카탈로그**: `/Users/jinsungkim/orca/oh-my-teams/.omt/briefs/dynamic-model-catalogs-2026-09-27.md`를 바탕으로 한 카탈로그 조회 및 스냅샷 기능 구현이 2파동 전에 `main`에 통합되어 있어야 함. (이 파동에서는 런타임 카탈로그 관련 조회/구현 편집을 하지 않음)
- **정형 문서 계약**: `/Users/jinsungkim/orca/oh-my-teams/.omt/briefs/structured-omt-documents-2026-09-27.md`의 `.omt` 문서 식별자 및 revision 계약이 확정되어야 3파동에서의 동적 편성 스냅샷 저장을 해당 포맷으로 완전하게 이전 가능함.
