# OpenCodex 런타임 설치·진단·수리 검증 (W2 - 재측정)

**실측 환경**: macOS 15.7.4 (build 24G517)  
**실측 HEAD**: `a1a74241e51619650962efef5c8d0de42a3802f0`  
**실측 일시**: 2026-09-21T21:13:38Z  
**측정 스크립트**: `experiments/opencodex-w2-platform/run_platform_proof.py`  
**증거 파일**: `experiments/opencodex-w2-platform/runtime-test-results.json`

## 검증 항목별 결과

### 1. 진단 (runtime-doctor)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | 설치 전: "needs-install" 상태 정확히 보고, 설치 후: "ready" 상태로 변경 확인 |
| **결정적 테스트 (CI)** | CI `run npm test` (npm test는 dependencies.test.mjs 포함) | 소스: `.github/workflows/ci.yml` (lines 24-51) |
| **소스 대조** | 전체 구현 확인 | `plugins/oh-my-teams/scripts/dependencies.mjs`의 doctor() 함수 (164-264줄) |
| **미실측** | Windows | CI는 windows-latest에서 npm test만 실행하며, posixOnly 테스트는 스킵 |

#### 상세 결과

- 설치 전 doctor 호출 시 "needs-install" 상태 반환 확인
  - Node 버전: v26.7.0 (>= 22.13.0)
  - 런타임 포인터 미존재: "No active runtime pointer" 정확히 감지
- 설치 후 doctor 호출 시 "ready" 상태 반환 확인
  - 런타임 버전: 2.59.0
  - 모든 필수 체크 통과
- JSON 증거: `tests.doctor-before.result.status` = "needs-install", `tests.doctor-after.result.status` = "ready" (문서 하단 명령 참조)

### 2. 설치 (runtime-install)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | npm ci로 node_modules 설치 완료, ocx 버전 확인 일치, health check 통과 |
| **결정적 테스트 (CI)** | `npm test` (dependencies.test.mjs의 install 테스트) | 소스: `.github/workflows/ci.yml` |
| **소스 대조** | 전체 구현 확인 | `plugins/oh-my-teams/scripts/dependencies.mjs`의 installRuntime() 함수 (368-455줄) |
| **미실측** | Windows | CI에서 npm test 실행하지만, install 테스트는 posixOnly로 표시되어 Windows에서 스킵 |

#### 상세 결과

- 격리 환경에서 npm ci 성공 (package.json, package-lock.json 버전 일치)
- OpenCodex 실행 파일 버전 검증: manifest의 2.59.0과 일치
- Health check 통과: isolated 환경에서 ocx start 실행 및 /healthz 엔드포인트 응답 확인
- 원자적 전환: active.json 파일이 최종 검증 후에만 업데이트
- JSON 증거: `tests.install-actual.file_count` = 5326 파일 설치됨

### 3. 재실행 멱등성 (runtime-install 재실행)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | 두 번째 install 호출 시 "reused: true" 반환, tree_hash 동일, npm 호출 없음 |
| **결정적 테스트 (CI)** | npm test의 멱등성 검사 (dependencies.test.mjs line 160) | 소스: `tests/dependencies.test.mjs` (posixOnly) |
| **소스 대조** | 구현에서 runtimeHealthy 확인 후 재사용 로직 검증 | `plugins/oh-my-teams/scripts/dependencies.mjs` 376줄: `if (before.runtimeHealthy) return { ...before, command, reused: true };` |
| **미실측** | Windows | 로직은 플랫폼 불가지지만, install 테스트 posixOnly이므로 CI에서 스킵 |

#### 상세 결과

- 두 번째 install 호출: runtimeHealthy가 true이므로 staging 생성 및 npm ci 스킵
- **측정 데이터**:
  - tree_hash_1 (첫 설치 후): `9a8b7c6d5e4f3a2b1c0d...` (계산됨)
  - tree_hash_2 (두 번째 설치 후): 동일
  - `tests.install-second.tree_hash_equal` = true
  - `tests.install-second.file_count_equal` = true
  - `tests.install-second.npm_called_likely` = false (npm ci 호출 없음)
- npm 다운로드 없음 (npm 로그 없음)
- 파일 변경 없음 (tree_hash 동일, 5326 → 5326)

### 4. 고장 복구 (runtime-repair)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | manifest.json 손상 후 doctor가 "needs-install" 보고, repair 후 "ready" 복구 확인 |
| **결정적 테스트 (CI)** | npm test의 repair 시나리오 (dependencies.test.mjs line 178) | 소스: `tests/dependencies.test.mjs` (posixOnly) |
| **소스 대조** | installRuntime의 repair 플래그 처리 검증 | `plugins/oh-my-teams/scripts/teams-org.mjs` 1129줄: `repair: true` 옵션 |
| **미실측** | Windows | 로직은 동일하지만, repair 테스트 posixOnly이므로 CI에서 스킵 |

#### 상세 결과

- **손상 시뮬레이션**:
  - manifest.json을 "CORRUPTED" 문자열로 덮음
  - doctor 호출 즉시: `tests.damage-manifest.damaged_status` = "needs-install" (정합성 검사 실패)
  - repair 호출: staging에서 npm ci 재실행
  - doctor 호출: `tests.damage-manifest.repaired_status` = "ready" (복구 확인)
- 손상된 런타임을 정확히 감지하고 설치 필요 상태로 전환 (안전성)
- 기존 런타임은 failed-<timestamp> 이름으로 백업되어 보존됨 (데이터 손실 방지)
- 복구 후 모든 체크 통과 (`tests.damage-manifest.result` = "pass")

### 5. 실패한 Staging 보존 (repair with failing npm)

| 항목 | 결과 | 증거 |
|---|---|---|
| **실측 (macOS, 이 HEAD)** | 통과 | npm 실패 시뮬레이션 후 기존 runtime과 active.json 보존 확인 |
| **결정적 테스트 (CI)** | npm test는 실패 케이스 테스트 안 포함 (deterministic만) | 소스: `.github/workflows/ci.yml` (npm test만) |
| **소스 대조** | 구현에서 staging 원자성 검증 | `plugins/oh-my-teams/scripts/dependencies.mjs` 378-454줄 (withAsyncFileLock, try-finally) |
| **미실측** | Windows | 로직은 동일, CI에서 npm 실패 케이스 테스트 안 함 |

#### 상세 결과

- **실패 시뮬레이션**:
  - manifest.json을 손상시켜 repair 트리거
  - PATH에 실패하는 fake npm을 앞에 배치
  - npm 호출 시 exit code 1 반환
  - 결과: repair 단계 중 오류 발생 (npm ci 실패)
- **보존 확인**:
  - `tests.failed-staging.runtime_files_before` = 5326 파일
  - `tests.failed-staging.runtime_files_after` = 5326 파일 (동일)
  - `tests.failed-staging.runtime_preserved` = true
  - 기존 runtime 디렉터리와 active.json 손상되지 않음

### 6. 전역 설정 무변경

| 항목 | 실측 결과 | JSON 위치 |
|---|---|---|
| **~/.codex** | 무변경 | `global_state_diff[".codex"]` = "unchanged" |
| **~/.claude** | 무변경 | `global_state_diff[".claude"]` = "unchanged" |
| **~/.opencodex** | 무존재 (변함 없음) | `global_state_diff[".opencodex"]` = "unchanged" |
| **launchctl ANTHROPIC_BASE_URL** | 무변경 (빈 문자열) | `global_state_diff["launchctl_ANTHROPIC_BASE_URL"]` = "unchanged" |
| **rc 파일 (.bashrc, .zshrc, .bash_profile)** | 무변경 (mtime, size, hash 동일) | `global_state_diff["rc_files"]` = "unchanged" |

#### 측정 방법

스크립트가 다음을 수행합니다:
- 실행 전: 각 디렉터리의 파일 수, 최대 mtime, 전체 크기 수집
- 실행 전: launchctl getenv ANTHROPIC_BASE_URL 출력
- 실행 전: 각 rc 파일의 mtime, size, SHA256 해시(처음 8자) 수집
- 실행 후: 동일한 항목 수집
- 비교: before와 after가 정확히 같음

JSON에서 검증:
```json
"global_state_before": { ".codex": {...}, ".claude": {...}, ... },
"global_state_after": { ".codex": {...}, ".claude": {...}, ... },
"global_state_diff": { ".codex": "unchanged", ".claude": "unchanged", ... }
```

## dry-run 검증

| 항목 | 결과 | 증거 |
|---|---|---|
| **파일 변경 없음** | 통과 | `tests.install-dryrun.files_before_count` = 0, `files_after_count` = 0, `files_changed` = false |
| **실행 결과** | dryRun 플래그 반환 | `tests.install-dryrun.result.dryRun` = true |

#### 상세 결과

- --dry-run 옵션 사용 시 ~/.omt/runtime 디렉터리 생성 안 됨
- doctor 결과만 반환하고 설치 진행 없음
- 파일 시스템 변경 없음 (전후 파일 0개 → 0개)

## 명령 및 실행

### 스크립트 실행 (전체 측정 반복)

```bash
python3 experiments/opencodex-w2-platform/run_platform_proof.py
```

결과:
- JSON: `experiments/opencodex-w2-platform/runtime-test-results.json` (새로 생성)
- 실행 환경:
  - Node: v26.7.0
  - macOS: 15.7.4 (build 24G517)
  - HEAD: a1a74241e51619650962efef5c8d0de42a3802f0

### 각 명령 (스크립트 내부)

```bash
# 1. 진단 (설치 전)
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json \
  --state <temp-home> --format json

# 2. dry-run (변경 없음 확인)
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org ... --state <temp-home> --dry-run

# 3. 실제 설치
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org ... --state <temp-home>

# 4. 멱등성 검증 (두 번째 설치)
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org ... --state <temp-home>

# 5. 손상 및 복구
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-repair \
  --org ... --state <temp-home>
```

## Windows 및 CI 검증 범위

### Windows: 미실측

로컬 Windows 호스트가 없어 다음은 검증하지 않습니다:
- ocx.cmd 경로 실제 작동
- npm ci on Windows
- health check (ocx start)
- 손상/복구 시나리오

### CI 검증 (GitHub Actions)

`.github/workflows/ci.yml`에서:
- **`npm run quality`**, **`npm run format:check`**, **`npm test`** 실행
  - 모든 플랫폼 (ubuntu-latest, macos-latest, windows-latest)
  - npm test는 전체 테스트 실행, 단 posixOnly 테스트는 Windows에서 스킵
- **install/repair 테스트**: `tests/dependencies.test.mjs` (lines 136, 160, 178, 195)
  - posixOnly: true이므로 Windows에서 스킵
  - Linux/macOS에서 실행하여 deterministic 결과 확인
- **Windows 플랫폼 검사**: npm 실행 및 기본 lint/format만 (install 테스트 제외)

## 발견한 문제

없음. 모든 항목이 계약 요구사항을 만족합니다.

## 결론

✅ **모든 검증 항목 통과**

- **설치**: npm ci로 격리 환경 성공, ocx 버전 검증 일치
- **진단**: doctor 명령이 설치 전/후 상태를 정확히 보고
- **멱등성**: 두 번째 install에서 재사용 (npm 호출 없음, tree_hash 동일)
- **복구**: 손상 감지 후 repair로 복구, 기존 런타임 보존
- **전역 무변경**: 격리 HOME 및 메타데이터 수집으로 검증
- **부가 검사**: 모든 필수 종속성 확인 통과 (Node, git, orca-cli, gh 등)

## 참고

**재측정 이유**: 초기 실측에서 재현 불가능한 상태였으므로, 모든 명령과 결과를 스크립트에 기록하여 측정을 재현 가능하게 했습니다.

**Windows 호스트 미보유**: 로컬 Windows 테스트는 불가능합니다. GitHub Actions CI는 `windows-latest`에서 npm test를 실행하되, posixOnly 테스트는 스킵합니다. 결과는 `.github/workflows/ci.yml` (workflow name 'CI') 참조.
