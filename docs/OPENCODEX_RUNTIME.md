# OpenCodex 런타임 설치 및 관리

## 개요

OpenCodex 2.59.0은 oh my teams의 공통 실행 경로로 제공되는 런타임입니다. 이 문서는 설치, 첫 실행 점검, 진단, 수리 과정을 안내합니다.

2.7.0 이상에서는 설치 시 OpenCodex를 자동으로 준비하며, 기존 설정을 변경하지 않으면서 고정 계정으로 격리된 실행 환경을 운영합니다.

## 설치

### install.sh와 install.ps1의 역할

`install.sh`(macOS·Linux)와 `install.ps1`(Windows)은 Node.js 기반 설치 스크립트의 포장입니다. 두 스크립트는 모든 인자를 `scripts/install.mjs`에 전달하며, 다음을 수행합니다.

- 플러그인 자체를 로컬 마켓으로 등록합니다.
- 기존 설치 상태를 확인하고 필요한 업데이트를 계획합니다.
- 레거시 플러그인(`orca@orca-skills`)의 마이그레이션을 안내합니다.
- OpenCodex 런타임을 설치 경로에 준비합니다.

다음 명령으로 설치를 시작합니다.

```sh
sh install.sh both   # claude | codex | both
```

```powershell
./install.ps1 -HostName both
```

`--dry-run` 옵션은 파일을 변경하지 않고 계획만 표시합니다. `--remove-legacy`를 함께 사용하면 레거시 플러그인을 제거합니다.

## 설치된 OpenCodex와 의존성 확인

### 첫 실행 점검: runtime-doctor

설치 후 또는 환경 변경 후에는 다음 명령으로 런타임 상태를 확인합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org .omt/organization.json \
  --state .omt
```

이 명령은 다음을 검사합니다.

- **Node.js 버전**: 22.13 이상이 필요합니다.
- **Git**: 저장소 관리에 필수입니다.
- **Codex CLI**: 구독별 실행에 필요합니다.
- **OpenCodex 설치**: 공통 경로의 설치 상태와 버전(2.59.0)을 확인합니다.
- **Orca CLI**: workflow 감독에 필요합니다.
- **gh(GitHub CLI)**: pull request 작업에 필요합니다.

doctor 명령은 읽기 전용으로 실행되며 상태를 변경하지 않습니다. JSON 형식 출력은 `--format json`을 추가하면 됩니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org .omt/organization.json \
  --state .omt \
  --format json
```

### OpenCodex를 찾을 수 없는 경우

doctor가 OpenCodex를 찾지 못했을 때는 다음 상태 메시지를 확인합니다.

- `needs-install`: 의존성이 준비되지 않았습니다. `runtime-install`을 실행하십시오.
- `action-required`: 사람이 수행해야 할 조작(로그인 등)이 필요합니다. 메시지의 `nextAction`을 따르십시오.
- `blocked`: 이 환경에서 지원되지 않는 경로입니다. 자세한 내용은 아래 제약을 참고하십시오.

## 설치 및 복구

### runtime-install

의존성이 부족하거나 설치가 불완전한 경우 다음 명령으로 OpenCodex를 준비합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org .omt/organization.json \
  --state .omt
```

이 명령은 다음을 수행합니다.

1. npm lockfile을 기반으로 OpenCodex와 의존성을 설치합니다.
2. 설치된 `ocx --version` 출력을 확인하여 버전 일치를 검증합니다.
3. 기존 활성 런타임은 유지하면서 새 설치를 준비합니다.
4. 검증 성공 시 활성 런타임 포인터를 원자적으로 교체합니다.

`--dry-run`을 추가하면 실제 설치 없이 계획만 표시합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org .omt/organization.json \
  --state .omt \
  --dry-run
```

설치 실패 시에는 다음을 확인하십시오.

- npm 설치 로그에서 오류 메시지를 찾으십시오.
- 디스크 공간과 권한을 확인하십시오.
- `runtime-repair`로 상태를 정리한 후 다시 시도하십시오.

### runtime-repair

손상되었거나 불일치하는 런타임을 정리하고 다시 준비합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-repair \
  --org .omt/organization.json \
  --state .omt
```

이 명령은 다음을 수행합니다.

1. 기존 활성 런타임의 일치성을 재검증합니다.
2. 검증 실패 시 임시 디렉터리에서 새 설치를 준비합니다.
3. 중단되거나 부분적인 설치를 정리합니다.
4. doctor에서 실패한 점검을 다시 수행합니다.

`--dry-run`을 추가하면 정리 계획만 표시합니다. 실패한 상태로 남은 임시 파일은 수동으로 제거해야 할 수도 있습니다.

## OpenCodex 로그인과 계정 격리

### 계정 준비 및 로그인

OpenCodex는 ChatGPT, Claude, 그리고 Agy(Antigravity) 세 구독을 지원합니다. 사용할 구독에 대해 격리된 계정을 준비해야 합니다.

1. **격리 디렉터리 준비**: 로그인 전에 별도의 홈 디렉터리를 준비합니다. 기본값은 `.omt/opencodex-runtime` 아래입니다.

2. **사람의 로그인 수행**: 다음 명령으로 계정을 추가합니다(자동화되지 않음).

   ```sh
   OPENCODEX_HOME=/path/to/isolated/home ocx account login openai
   ```

   또는 Claude 신규 계정의 경우:

   ```sh
   OPENCODEX_HOME=/path/to/isolated/home ocx account login anthropic
   ```

   Agy의 경우:

   ```sh
   OPENCODEX_HOME=/path/to/isolated/home ocx account login google-antigravity
   ```

3. **계정 확인**: 로그인 후 다음으로 계정 목록을 확인합니다.

   ```sh
   OPENCODEX_HOME=/path/to/isolated/home ocx account list
   ```

### 고정 계정 모드와 OPENCODEX_HOME

oh my teams의 runner는 **고정 계정 모드**로 운영됩니다. 다음을 의미합니다.

- 각 역할(PM, PL, Senior, Junior)은 정해진 하나의 계정 홈을 사용합니다.
- 런타임 중에 계정을 전환하지 않습니다.
- `OPENCODEX_HOME` 환경변수는 로그인이나 초기 설정에만 사용되며, workflow 실행 중에는 조직 파일에 기록된 계정 경로를 사용합니다.

workflow 시작 시 `OPENCODEX_HOME`을 명시적으로 설정할 필요는 없습니다. 대신 조직 파일의 계정 참조가 사용됩니다.

### 전역 상태 보호

설치 과정 중에는 다음이 변경되지 않습니다.

- `~/.codex/config.toml`의 기본 모델 및 설정.
- `~/.claude/settings.json`의 플러그인 목록.
- Claude Code 또는 Codex의 기본 자격 증명 저장소.
- 기존 조직 파일(`~/.omt/organization.json` 등).

이를 확보하기 위해 OpenCodex의 자동 통합 설정과 글로벌 선택 동기화를 비활성화합니다.

## 제약 사항

### 선언 풀(Multiple-account pool)이 차단된 이유

W1 조사에서는 고정 계정 모드만 완전히 검증되었습니다. 다음 이유로 다계정 풀은 지원되지 않습니다.

- **요청 전환 기록 미흡**: 429 회복(rate limit) 상황에서 계정 전환을 한 번 관측했으나, 요청별 전환 순서와 실제 계정 귀속을 완벽하게 추적하지 못했습니다.
- **취소(cancellation) 미검증**: 상위 요청 진행 중에 하위 요청을 취소했을 때의 동작이 불명확합니다.
- **불완전한 격리**: 기존 전역 자격 증명 저장소를 완전히 격리하려면 OpenCodex 설정뿐 아니라 추가 샌드박싱이 필요합니다.

따라서 다계정 풀을 시도하지 마시고, 각 역할이 정해진 계정 하나를 사용하도록 조직 파일을 설정하십시오.

### Windows 지원

이 설치 안내는 macOS에서만 확인되었습니다. Windows에 대해서는 다음을 안내합니다.

- **설치 스크립트**: `install.ps1`은 동일한 Node.js 설치기를 호출하므로 기본 설치는 가능합니다.
- **경로 형식**: Windows의 경로는 백슬래시 또는 환경변수 형식으로 지정하십시오.
- **환경변수**: PowerShell에서는 `$env:OPENCODEX_HOME` 형식을 사용합니다.

실제 Windows 환경에서는 `runtime-doctor`를 실행하여 의존성을 확인한 후 진행하십시오. 실측 없이는 완전한 지원을 선언할 수 없습니다.

### 기존 설치와의 호환성

이미 다른 방식으로 OpenCodex를 설치했거나 사용 중이라면 다음을 확인하십시오.

- oh my teams의 `runtime-install` 명령은 자신의 영속 설치 경로에만 쓰므로 기존 설치와 충돌하지 않습니다.
- 로그인이나 계정 홈도 격리되어 있으므로 기존 계정에 영향을 주지 않습니다.
- 기존 전역 설정(`~/.opencodex/config.json`, `~/.codex/config.toml` 등)은 변경되지 않습니다.

## 기존 조직과 진행 중 workflow의 유지

oh my teams 2.6.0 이상에서는 provider나 runner의 변경이 기존 조직 파일과 workflow에 자동으로 적용되지 않습니다.

- **기존 조직 파일**: 새 runner 필드가 없으면 현재 provider adapter로 계속 해석됩니다.
- **진행 중 workflow**: workflow 시작 시의 조직 스냅샷이 유지되므로 런타임을 업데이트했어도 진행 중인 작업은 원래 실행 경로를 계속 사용합니다.
- **workflow 완료 후**: 새 workflow는 최신 조직 설정을 사용합니다.

따라서 런타임 변경 후에도 진행 중인 작업의 실행 환경이 갑자기 바뀌지 않습니다.

## 오류 진단 및 재실행

### 흔한 오류와 대응

#### OpenCodex를 찾을 수 없음

```
runtime-doctor: blocked (runtime-unavailable)
```

**원인**: OpenCodex가 설치되지 않았거나 경로 이상이 있습니다.

**대응**:

1. `runtime-install --dry-run`으로 설치 계획을 확인합니다.
2. 디스크 공간과 쓰기 권한을 확인합니다.
3. `runtime-install`을 실행합니다.

#### npm 설치 실패

```
runtime-install: failed (npm-error)
```

**원인**: npm 의존성 설치 중 오류가 발생했습니다.

**대응**:

1. 설치 로그에서 오류 메시지를 찾습니다.
2. 인터넷 연결을 확인합니다.
3. npm 캐시를 정리합니다: `npm cache clean --force`
4. `runtime-repair`를 실행합니다.

#### Bun 실행 불가

```
runtime-install: failed (bun-unavailable)
```

**원인**: OpenCodex 의존성인 Bun이 준비되지 않았습니다.

**대응**:

1. `ocx --version`을 직접 실행하여 실행 가능성을 확인합니다.
2. Bun 네이티브 바이너리의 플랫폼 호환성을 확인합니다.
3. `runtime-repair`를 실행합니다.

### 재실행

오류 후에는 상태를 정리하고 다시 시도합니다.

```sh
# 상태 정리
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-repair \
  --org .omt/organization.json \
  --state .omt

# 상태 재확인
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org .omt/organization.json \
  --state .omt

# 필요하면 다시 설치
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org .omt/organization.json \
  --state .omt
```

repair 후에도 문제가 지속되면 다음을 시도합니다.

1. npm 전체 캐시 정리: `npm cache clean --force`
2. `runtime-repair --dry-run`으로 계획을 재확인합니다.
3. `.omt` 디렉터리의 런타임 캐시를 수동으로 확인합니다: `ls -la .omt/opencodex/`

## 버전 정보

- **oh my teams**: 2.7.0
- **OpenCodex**: 2.59.0
- **필수 Node.js**: 22.13 이상

버전 불일치는 다음 위치에서 확인합니다.

- Package 정본: `package.json`의 `@bitkyc08/opencodex` 버전
- Lockfile: `package-lock.json`의 `@bitkyc08/opencodex` 해시
- 설치 검증: `runtime-doctor`의 `runtime.version`

## 더 알아보기

- 공식 설치 가이드: https://opencodex.me/getting-started/for-agents/
- 공식 Providers 문서: https://opencodex.me/guides/providers/
- 오류 분류: `node plugins/oh-my-teams/scripts/teams-org.mjs failure-classify`로 구체적인 오류 카테고리를 확인할 수 있습니다.
