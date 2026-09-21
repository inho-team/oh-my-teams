# 배정·복귀 규칙 코드 맵

기준 커밋은 `184c2de08e175a50e05ac3c93ccf41f63e93ccc4`입니다. 저장소 상대 경로를 직접 열어 `rg -n -C 2 'foldRole|resolveRole|workflow-depth|roleSpec|worker-start|headless-start|callAllowance|maxCalls|maxAttempts|concurrency|maxRunning|reviewRequirements|aggregate|failure-classify|nextOwner|fallback|onExhaustion|gpt-oss|claude' plugins/oh-my-teams/scripts plugins/oh-my-teams/skills/{pm,pl,senior,junior,intern}/SKILL.md`로 후보를 찾고, `nl -ba`로 인용 범위의 줄 번호와 원문을 대조하여 수집했습니다.

| 번호 | 주제 | 저장소 상대 파일 경로 | 시작줄-끝줄 | `인용` | opens 또는 returns 또는 neutral |
| 1 | PM의 감독 worker 배정 | plugins/oh-my-teams/skills/pm/SKILL.md | 19 | `래퍼로만 감독 worker로 시작하고` | opens |
| 2 | PL의 역할별 배정 | plugins/oh-my-teams/skills/pl/SKILL.md | 9-10 | `구체적인 구현 방법은 Senior에게, 기능 구현은 Junior에게, 제한된 실무는 Intern에게 배정한다.` | opens |
| 3 | Junior의 Intern 하네스 위임 | plugins/oh-my-teams/skills/junior/SKILL.md | 17 | `Intern 프로필에 맡긴다. 이 하네스는 비대화 명령이며 Dispatch를 만들지 않는다.` | opens |
| 4 | Intern의 재위임 금지 | plugins/oh-my-teams/skills/intern/SKILL.md | 27 | `다른 에이전트에게 작업을 재위임하지 않는다.` | neutral |
| 5 | 역할 접기의 탐색 | plugins/oh-my-teams/scripts/core.mjs | 111-118 | `for (let index = rank; index >= 0; index -= 1) {` | returns |
| 6 | 조직 기준 역할 해석 | plugins/oh-my-teams/scripts/core.mjs | 121-129 | `export const resolveRole = (org, role) => foldRole(definedRoles(org), role);` | returns |
| 7 | workflow depth의 허용 범위와 동시 실행 | plugins/oh-my-teams/scripts/workflow.mjs | 71-81 | `request.depth >= 1 &&` | neutral |
| 8 | workflow depth 기본값과 사용 역할 | plugins/oh-my-teams/scripts/workflow.mjs | 183-184 | `const depth = request.depth ?? FULL_DEPTH;` | opens |
| 9 | worker 실행의 역할·프로필 해석 | plugins/oh-my-teams/scripts/role-launch.mjs | 223-239 | `const role = foldRole(activeRoles(org, roles), requestedRole);` | returns |
| 10 | roleSpec 머리글 생성의 역할 접기 | plugins/oh-my-teams/scripts/role-launch.mjs | 406-421 | `const role = foldRole(declared, requestedRole);` | returns |
| 11 | worker-start 진입점과 역할 명세 | plugins/oh-my-teams/scripts/teams-org.mjs | 582-586 | `spec: args.spec && roleSpec(org, launch.role, args.spec, run),` | opens |
| 12 | headless-start 진입점의 역할 명령 | plugins/oh-my-teams/scripts/teams-org.mjs | 654-670 | `const command = roleCommand(org, args.role, run);` | opens |
| 13 | work 하네스의 역할 접기 | plugins/oh-my-teams/scripts/worker.mjs | 315-347 | `: resolveRole(org, requestedRole);` | returns |
| 14 | 프로필 fallback 순서 | plugins/oh-my-teams/scripts/worker.mjs | 350-354 | `binding.profile,` | opens |
| 15 | concurrency와 attempts 검증 | plugins/oh-my-teams/scripts/core.mjs | 657-672 | `Number.isInteger(binding.concurrency) &&` | neutral |
| 16 | maxCalls 호출 한도와 attempts 적용 | plugins/oh-my-teams/scripts/worker.mjs | 390-395 | `if (report.calls.length >= org.policy.maxCalls) break profileLoop;` | neutral |
| 17 | onExhaustion의 fallback 처리 | plugins/oh-my-teams/scripts/worker.mjs | 461-463 | `if (response.failureClass === "pool-exhausted" && profile.pool) {` | returns |
| 18 | reviewRequirements 검토 게이트 | plugins/oh-my-teams/scripts/gates.mjs | 237-250 | `const missing = task.reviewRequirements` | returns |
| 19 | aggregate의 blocker와 상태 | plugins/oh-my-teams/scripts/evidence.mjs | 293-328 | `status:` | neutral |
| 20 | failure-classify의 상위 소유자 | plugins/oh-my-teams/scripts/failures.mjs | 18-45 | `return route("scope-too-large", "pl", "split-task", false);` | returns |
| 21 | 검토 실패의 nextOwner | plugins/oh-my-teams/scripts/failures.mjs | 99-110 | `return route("review-rejection", "junior", "resolve-findings", true);` | returns |
| 22 | Agy claude 계열의 실행 경로 | plugins/oh-my-teams/scripts/launch-matrix.mjs | 250-262 | `path: "blocked",` | returns |
| 23 | Agy gpt-oss 계열의 실행 경로 | plugins/oh-my-teams/scripts/launch-matrix.mjs | 295-298 | `const family = normalizeModelFamily(model);` | opens |
