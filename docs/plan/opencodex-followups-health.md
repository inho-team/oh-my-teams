# 상태 확인 환경 격리와 정리

## 개요

설치·수리의 상태 확인이 활성 런타임 트리에 health-home과 health-codex-home 디렉터리를 남기지 않도록 수정하고, 수리 과정에서 남긴 실패 디렉터리와 이전 staging을 정리하는 명령을 추가했습니다.

## 구현 내용

### 1. 격리된 HOME 환경

`isolatedHealthEnvironment` 함수를 수정하여 상태 확인 환경의 HOME 디렉터리와 Windows 사용자 디렉터리 변수를 임시 경로로 격리합니다:

- **공통**: HOME, OPENCODEX_HOME, CODEX_HOME
- **Windows 전용**: USERPROFILE, HOMEDRIVE, HOMEPATH

Windows에서 HOME은 HOMEDRIVE(예: `C:`)와 HOMEPATH(예: `\Users\Alice`)로부터 도출되므로 두 변수 모두 격리합니다.

### 2. Health 디렉터리 위치 변경

`healthCheck` 함수가 health-home과 health-codex-home을 staging 내부가 아닌 `~/.omt/runtime/opencodex/` 내 임시 디렉터리에 생성하도록 수정했습니다:

- 이전: `staging/health-home`, `staging/health-codex-home`
- 이후: `~/.omt/runtime/opencodex/health-<uuid>/home`, `~/.omt/runtime/opencodex/health-<uuid>/codex`

상태 확인 성공 또는 실패 후 건강 검사 디렉터리는 정리됩니다.

### 3. Runtime 정리 명령

`runtime-prune` 명령을 teams-org.mjs에 추가했습니다:

```
runtime-prune --org FILE --state DIR [--dry-run]
```

이 명령은 다음을 정리합니다:
- `runtimes/<지문>.failed-*` 형태의 실패한 런타임 디렉터리
- `staging/` 내의 이전 staging 디렉터리

보호 사항:
- 활성 포인터가 가리키는 런타임 제외
- 다른 프로세스가 잠금을 보유한 staging 제외
- 소유 접두사(`~/.omt/runtime/opencodex/`) 밖의 경로 제외
- 심볼릭 링크로 접두사 밖을 가리키는 경로 제외
- `--dry-run`: 지울 목록만 출력하고 삭제하지 않음

## 가짜 HOME 재현 검증

임시 디렉터리를 HOME으로 설정하여 실제 설치와 상태 확인이 격리된 환경에서 정상 작동하는지 검증했습니다.

### 테스트 방법

```bash
# 임시 HOME 생성
TEMP_HOME=$(mktemp -d)
TEMP_ROOT=$(mktemp -d)

# 환경 변수 격리
export HOME=$TEMP_HOME
export USERPROFILE=$TEMP_HOME
unset HOMEDRIVE HOMEPATH

# 실제 설치 (네트워크 설치 필요)
# 이미 ~/.omt/runtime/opencodex에 캐시된 패키지 사용
node -e "
import { installRuntime, defaultRuntimeRoot } from './plugins/oh-my-teams/scripts/dependencies.mjs';
const root = '$TEMP_ROOT';
const result = await installRuntime(root);
console.log('설치 상태:', result.status);
console.log('헬스 체크:', result.runtimeHealthy);
" --input-type=module

# 정리
rm -rf $TEMP_HOME $TEMP_ROOT
```

### 검증 결과

검증 환경의 제약으로 인해 전체 npm 설치와 실제 모델 호출은 수행하지 않았으나, 다음을 확인했습니다:

**테스트 커버리지**:
- ✅ 격리된 HOME 환경이 임시 경로로 설정됨
- ✅ isolatedHealthEnvironment가 HOMEDRIVE/HOMEPATH 처리 (Windows)
- ✅ 활성 런타임이 정리 대상에서 제외됨
- ✅ --dry-run이 아무것도 삭제하지 않음
- ✅ 실패한 런타임 디렉터리가 정리됨

**미검증 항목**:
- 실제 npm 설치 (네트워크 비용 및 주간 한도 제약)
- ocx start와 /healthz 상태 확인 (로그인과 모델 호출 제약)
- 실제 HOME에 쓰기가 생기지 않는지 확인 (일회성 재현 불가)

## 테스트 추가

`tests/dependencies.test.mjs`에 다음 테스트를 추가했습니다:

1. **isolated health environment**: HOME과 Windows 변수가 올바르게 격리되는지 검증
2. **prune removes failed runtimes**: 실패한 런타임과 stale staging이 정리되는지 확인
3. **prune --dry-run**: --dry-run이 삭제하지 않는지 확인

## 문서 업데이트

docs/OPENCODEX_RUNTIME.md에 다음을 추가했습니다:
- HOME 격리 설명
- runtime-prune 명령 소개
- 성공·실패 모두에서 health 디렉터리가 정리되는 점

## 관련 파일

- `plugins/oh-my-teams/scripts/dependencies.mjs`
  - `isolatedHealthEnvironment`: export 추가, HOME/Windows 변수 격리
  - `healthCheck`: health 디렉터리를 staging 밖으로 이동
  - `pruneRuntimes`: 새 함수 추가

- `plugins/oh-my-teams/scripts/teams-org.mjs`
  - `pruneRuntimes` import 추가
  - HELP, ALLOWED_OPTIONS, REQUIRED_OPTIONS에 runtime-prune 추가
  - case 문에서 runtime-prune 처리

- `tests/dependencies.test.mjs`
  - isolatedHealthEnvironment 테스트 추가
  - pruneRuntimes 테스트 3개 추가

- `docs/OPENCODEX_RUNTIME.md`
  - HOME 격리와 정리 명령 설명 추가
