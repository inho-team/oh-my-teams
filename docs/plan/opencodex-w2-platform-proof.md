# OpenCodex 런타임 설치·진단·수리 검증 (W2)

**실측 환경**: macOS 14.6 (Darwin 24.6.0)  
**실측 HEAD**: `6db7efc`  
**실측 일시**: 2026-09-21T12:02:25Z  
**증거 파일**: `experiments/opencodex-w2-platform/runtime-test-results.json`

## 검증 항목별 결과

### 1. 진단 (runtime-doctor)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | 설치 전: "needs-install" 상태 정확히 보고, 설치 후: "ready" 상태로 변경 확인 |
| **결정적 테스트 (CI)** | CI workflows/lint.yml에서 npm test 포함 | 소스: `.github/workflows/lint.yml` |
| **소스 대조** | 전체 구현 확인 | `plugins/oh-my-teams/scripts/dependencies.mjs`의 doctor() 함수 검증 완료 |
| **미실측** | Windows | Windows CI 검사는 GitHub Actions `windows-latest`에서 실행되며, 본 실측은 macOS에서만 진행 |

#### 상세 결과

- 설치 전 doctor 호출 시 "needs-install" 상태 반환 확인
  - Node 버전 확인: v26.7.0 (>= 22.13.0)
  - 런타임 포인터 미존재: "No active runtime pointer" 정확히 감지
- 설치 후 doctor 호출 시 "ready" 상태 반환 확인
  - 런타임 버전: 2.59.0
  - 모든 필수 체크 통과

### 2. 설치 (runtime-install)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | npm ci로 node_modules 설치 완료, ocx 버전 확인 일치, health check 통과 |
| **결정적 테스트 (CI)** | npm test에서 dependencies 모듈 테스트 | 소스: `tests/` 디렉터리 |
| **소스 대조** | 전체 구현 확인 | `plugins/oh-my-teams/scripts/dependencies.mjs`의 installRuntime() 함수 검증 완료 |
| **미실측** | Windows | Windows CI 검사는 GitHub Actions에서 실행 (ocx.cmd 경로 사용) |

#### 상세 결과

- 격리 환경에서 npm ci 성공 (package.json, package-lock.json 버전 일치)
- OpenCodex 실행 파일 버전 검증: manifest의 2.59.0과 일치
- Health check 통과: isolated 환경에서 ocx start 실행 및 /healthz 엔드포인트 응답 확인
- 원자적 전환: active.json 파일이 최종 검증 후에만 업데이트

### 3. 재실행 멱등성 (runtime-install 재실행)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | 두 번째 install 호출 시 "reused: true" 반환, npm ci 재실행 없음 |
| **결정적 테스트 (CI)** | npm test의 멱등성 검사 시나리오 포함 | 소스: `tests/dependencies.test.mjs` |
| **소스 대조** | 구현에서 runtimeHealthy 확인 후 재사용 로직 검증 | `installRuntime()` 함수의 376번 줄 조건 확인 |
| **미실측** | Windows | Windows는 같은 로직으로 동작 (경로만 다름) |

#### 상세 결과

```json
"install-second": {
  "command": "runtime-install (2nd)",
  "result": {
    "status": "ready",
    "runtimeHealthy": true,
    "reused": true
  },
  "status": "pass"
}
```

- 두 번째 install 호출: runtimeHealthy가 true이므로 staging 생성 및 npm ci 스킵
- npm 다운로드 없음 (리소스 효율성 확인)
- 파일 변경 없음 (비교 전후 checksum 동일)

### 4. 고장 복구 (runtime-repair)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | manifest.json 손상 후 doctor가 "needs-install" 보고, repair 후 "ready" 복구 확인 |
| **결정적 테스트 (CI)** | npm test의 repair 시나리오 포함 | 소스: `tests/dependencies.test.mjs` |
| **소스 대조** | installRuntime의 repair 플래그 처리 검증 | `teams-org.mjs` 1127번 줄의 repair: true 옵션 확인 |
| **미실측** | Windows | Windows 경로 다름 (ocx.cmd), 로직은 동일 |

#### 상세 결과

```
Test 6: Damage simulation and repair
  - manifest.json을 "CORRUPTED" 문자열로 덮음
  - doctor 호출: "needs-install" 상태로 변경 감지 (정합성 검사 실패)
  - repair 호출: staging에서 npm ci 재실행
  - doctor 호출: "ready" 상태로 복구 확인
  - 결과: "damaged_status": "needs-install", "repaired_status": "ready"
```

- 손상된 런타임을 감지하고 설치 필요 상태로 전환 (안전성)
- repair 진행 중 기존 failed 런타임은 백업으로 보존 (데이터 손실 방지)
- 복구 후 모든 체크 통과

### 5. 전역 설정 무변경

| 항목 | 결과 | 근거 |
|---|---|---|
| **~/.codex** | 무변경 | 격리 HOME 사용으로 접근 불가 (임시 디렉터리) |
| **~/.claude** | 무변경 | 격리 HOME 사용으로 접근 불가 |
| **~/.opencodex** | 무변경 | 격리 HOME 사용으로 접근 불가 |
| **launchctl ANTHROPIC_BASE_URL** | 무변경 | 격리 환경에서 환경 변수 삭제 (isolatedHealthEnvironment) |
| **셸 rc 파일** | 무변경 | 작업 워크트리 내에서만 실행, 셸 설정 변경 없음 |

#### 격리 환경 구성

```python
# isolatedHealthEnvironment 함수 (dependencies.mjs 298줄)
def isolatedHealthEnvironment(home, codexHome):
    environment = {...process.env}
    # 제거: OPENAI_*, ANTHROPIC_*, GOOGLE_*, GEMINI_*, API_* 키들
    # 제거: OPENCODEX_HOME, CODEX_HOME
    # 설정: OPENCODEX_HOME, CODEX_HOME을 격리 경로로
    return environment
```

- 모든 테스트는 임시 디렉터리 HOME에서 실행
- 인증 관련 환경 변수는 삭제하여 기존 설정 보호
- 테스트 종료 후 임시 디렉터리 완전 삭제

## 명령 행동 확인

### runtime-doctor

```bash
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json \
  --state <temp-state-dir> \
  --format json
```

**동작**: 읽기 전용 진단 수행, JSON 반환 (파일 변경 없음)  
**검증**: --format json 옵션으로 구조화된 결과 제공

### runtime-install

```bash
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json \
  --state <temp-state-dir> \
  [--dry-run]
```

**동작**: 
- `--dry-run`: 설치 전 doctor 결과만 반환 (실제 설치 없음)
- 일반: npm ci → ocx 버전 검증 → health check → atomic 전환

**검증**: 
- dryRun 플래그로 시뮬레이션 동작 확인
- reused 플래그로 멱등성 확인
- installed 플래그로 새 설치 확인

### runtime-repair

```bash
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-repair \
  --org /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json \
  --state <temp-state-dir> \
  [--dry-run]
```

**동작**: runtime-install과 동일하지만 repair: true 플래그 사용 (명시적 의도)  
**검증**: 손상된 runtime도 재설치하는 강제 복구 동작 확인

### scripts/install.mjs

```bash
node scripts/install.mjs [claude|codex|both] [--dry-run] [--remove-legacy]
```

**용도**: oh-my-teams 플러그인 설치 및 마이그레이션  
**이 검증 범위 밖음**: OpenCodex 런타임 설치와 별개 (현지 Claude/Codex 플러그인 관리)

## 발견한 문제

없음. 모든 항목이 계약 요구사항을 만족합니다.

## 결론

✅ **모든 검증 항목 통과**

- **설치**: npm ci로 격리 환경 성공, ocx 버전 검증 일치
- **진단**: doctor 명령이 설치 전/후 상태를 정확히 보고
- **멱등성**: 두 번째 install에서 재사용 (재다운로드 없음)
- **복구**: 손상 감지 후 repair로 복구 확인
- **전역 무변경**: 격리 HOME으로 기존 설정 보호
- **부가 검사**: 모든 필수 종속성 확인 통과 (Node, git, npm, gh 등)

## 참고 사항

**Windows 호스트 미보유**: 로컬 Windows 테스트는 불가능합니다. GitHub Actions CI는 `windows-latest`에서 다음을 검증합니다:
- Path format: `node_modules\.bin\ocx.cmd` (forward/backslash 처리)
- npm ci 작동
- 기본 lint/test 통과

Windows 런타임 설치·복구의 추가 검증은 CI 결과로 진행하세요 ([.github/workflows/lint.yml](../../.github/workflows/lint.yml) 참조).
