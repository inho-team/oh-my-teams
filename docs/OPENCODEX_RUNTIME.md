# OpenCodex 런타임 설치 및 관리

## 개요

OpenCodex는 특정 조직 프로필에서 고정 계정을 사용한 실행을 지원하는 런타임입니다. 이 문서는 설치, 첫 실행 점검, 진단, 수리 과정을 안내합니다.

고정 계정 모드는 선택입니다. 조직 파일의 프로필에서 `runner` 필드를 명시적으로 설정한 프로필만 OpenCodex를 사용하며, 다른 프로필은 계속 기존 실행 경로를 사용합니다.

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

`--dry-run` 옵션은 파일을 변경하지 않고 설치 계획만 표시합니다. `--remove-legacy`를 함께 사용하면 레거시 플러그인을 제거합니다.

설치 실패 시에는 installer가 "install-failed" 상태로 끝나고 0이 아닌 종료 코드를 반환합니다. 이 경우 `runtime-repair` 명령으로 상태를 정리한 후 다시 설치해야 합니다.

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
- **OpenCodex 설치**: 설치 경로의 설치 상태와 버전을 확인합니다.
- **Orca CLI**: workflow 감독에 필요합니다.
- **gh(GitHub CLI)**: pull request 작업에 필요합니다.

doctor 명령은 읽기 전용으로 실행되며 상태를 변경하지 않습니다. 모든 검사 결과가 포함된 JSON 객체를 표준 출력에 쓰므로 JSON 파싱이 필요한 경우 `--format json`을 명시할 수 있습니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-doctor \
  --org .omt/organization.json \
  --state .omt \
  --format json
```

### doctor 결과 해석

doctor 명령은 다음 상태 중 하나를 반환합니다.

- `ready`: 모든 검사가 통과했습니다. 런타임이 준비되었습니다.
- `needs-install`: 의존성이 부족합니다. `runtime-install`을 실행하십시오.
- `action-required`: OpenCodex를 사용하려면 사람이 수행해야 할 조작이 있습니다. `nextAction` 필드에 안내 문구가 있습니다.
- `blocked`: 이 환경에서 OpenCodex 사용이 지원되지 않습니다. 아래 제약을 참고하십시오.

## 설치 및 복구

### runtime-install

의존성이 부족하거나 설치가 불완전한 경우 다음 명령으로 OpenCodex를 준비합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-install \
  --org .omt/organization.json \
  --state .omt
```

이 명령은 다음을 수행합니다.

1. npm lockfile을 기반으로 OpenCodex를 설치합니다. Node.js, Git, Codex, Orca, gh 등 다른 의존성은 설치하지 않습니다.
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

설치 실패 시에는 다음 오류 코드가 나타날 수 있습니다.

- `runtime-npm-install-failed`: npm install 과정에서 오류가 발생했습니다. 디스크 공간과 권한을 확인하십시오.
- `runtime-version-mismatch`: 설치된 ocx의 버전이 package.json과 일치하지 않습니다.
- `runtime-bun-unavailable`: Bun 네이티브 바이너리가 준비되지 않았습니다. 플랫폼 호환성을 확인하십시오.
- `runtime-health-check-failed`: 설치 후 기동 점검에 실패했습니다.

실패 후에는 `runtime-repair`로 상태를 정리한 후 다시 시도하십시오.

### runtime-repair

손상되었거나 불일치하는 런타임을 정리하고 다시 준비합니다.

```sh
node plugins/oh-my-teams/scripts/teams-org.mjs runtime-repair \
  --org .omt/organization.json \
  --state .omt
```

이 명령은 다음을 수행합니다.

1. 기존 활성 런타임의 일치성을 재검증합니다.
2. 건강한 런타임이 있으면 그것을 계속 사용하고, 실패한 런타임만 교체합니다.
3. 검증 실패 시 임시 디렉터리에서 새 설치를 준비합니다.
4. 중단되거나 부분적인 설치를 `<fingerprint>.failed-<timestamp>` 이름으로 보관합니다.

`--dry-run`을 추가하면 정리 계획만 표시합니다.

## OpenCodex 고정 계정 설정

### 조직 파일에서 runner 필드 설정

OpenCodex를 사용하려면 조직 파일에서 프로필의 `runner` 필드를 명시적으로 설정해야 합니다.

```json
{
  "profiles": [
    {
      "name": "codex-fixed",
      "provider": "codex",
      "account": "codex-chatgpt",
      "subscription": "codex-openai",
      "model": "gpt-6-astra",
      "runner": {
        "kind": "opencodex",
        "mode": "fixed-account",
        "accountHomeRef": "codex-chatgpt",
        "runtimeFingerprint": "<runtime doctor의 runtime.prefixFingerprint>"
      }
    }
  ]
}
```

runner 필드가 없는 프로필은 계속 기존 provider adapter를 사용합니다.

### 계정 준비 및 로그인

고정 계정 모드에서는 ChatGPT(OpenAI) 또는 Codex 계정만 지원됩니다. Claude와 Agy는 이 모드에서 작동하지 않습니다.

1. **격리 디렉터리 준비**: 로그인 전에 별도의 홈 디렉터리를 준비합니다. 예를 들어 `~/.omt/opencodex-home-chatgpt/`입니다.

2. **사람의 로그인 수행**: 다음 명령으로 계정을 추가합니다(자동화되지 않음).

   ```sh
   OPENCODEX_HOME=~/.omt/opencodex-home-chatgpt ocx account login openai
   ```

   Codex 계정의 경우:

   ```sh
   OPENCODEX_HOME=~/.omt/opencodex-home-codex ocx account login openai
   ```

3. **계정 확인**: 로그인 후 다음으로 계정 목록을 확인합니다.

   ```sh
   OPENCODEX_HOME=~/.omt/opencodex-home-chatgpt ocx account list
   ```

### 환경변수 설정

workflow 실행 시, 고정 계정 모드는 다음 환경변수를 설정해야 합니다.

- `OMT_OPENCODEX_<REF>_HOME`: 계정 홈 경로(로그인한 디렉터리, `~/.omt/opencodex-home-chatgpt` 등)
- `OMT_OPENCODEX_<REF>_LABEL`: 계정의 비밀 정보를 제외한 표식(예: 로그인 시 출력되는 계정 ID의 해시)
- `OMT_OPENCODEX_SESSION_HOME`: OpenCodex 프록시의 세션 홈

이 환경변수들이 설정되지 않으면 실행이 실패하고 `opencodex-action-required` 오류가 발생합니다.

### 계정 홈 검증

고정 계정 홈은 다음 조건을 모두 만족해야 합니다.

- 정확히 하나의 고정 계정(pinned account)을 포함해야 합니다.
- 계정이 OpenAI(ChatGPT) 또는 Codex 계정이어야 합니다.
- `config.json`의 `providers.openai.codexAccountMode`가 `pool`이어야 합니다.
- `clientIntegrations.codex`가 `false`여야 합니다.
- `runtimeRole`이 `hub`여야 합니다.
- `claudeCode.enabled`가 `false`이거나, `systemEnv`와 `injectAgents`가 모두 `false`여야 합니다.

이 조건을 만족하지 않으면 실행이 실패하고 `opencodex-global-change-blocked` 또는 `opencodex-binding-unverified` 오류가 발생합니다.

### 전역 상태 보호

설치 및 실행 과정 중에는 다음이 변경되지 않습니다.

- 사용자의 `OPENCODEX_HOME`(`~/.opencodex`)
- 기존 Codex 설정(`~/.codex/config.toml`)
- 기존 Claude 설정(`~/.claude/settings.json`)
- 기존 조직 파일(`~/.omt/organization.json` 등)

고정 계정 홈은 격리되어 있으므로, 로그인 과정에서 기존 전역 설정이 영향을 받지 않습니다.

## 제약 사항

### 지원 범위

고정 계정 모드는 다음만 지원합니다.

- **계정**: ChatGPT(OpenAI) 또는 Codex 계정(고정 모드에서만). Claude와 Agy 계정은 지원되지 않습니다.
- **플랫폼**: macOS 및 Linux만 지원합니다. Windows는 지원되지 않으며, 시도하면 `opencodex-proxy-ownership-unverifiable` 오류가 발생합니다.

### 풀 모드(Multiple-account pool)가 차단된 이유

다계정 풀 모드는 지원되지 않습니다. 다음 이유로 인합니다.

- **요청별 계정 전환 추적 미흡**: OpenCodex의 request-history에는 각 요청의 시도 순서와 정확한 전환 시각이 기록되지 않습니다.
- **상위 요청 취소 미검증**: 상위 streaming 요청 진행 중에 하위 요청을 취소했을 때의 동작이 검증되지 않았습니다.

따라서 다계정 풀을 시도하지 마시고, 각 역할이 정해진 계정 하나를 사용하도록 조직 파일을 설정하십시오.

풀 모드를 시도하면 `opencodex-pool-unverified` 오류가 발생합니다.

## 기존 조직과 진행 중 workflow의 유지

oh my teams에서는 provider나 runner의 변경이 기존 조직 파일과 workflow에 자동으로 적용되지 않습니다.

- **기존 조직 파일**: runner 필드가 없는 프로필은 현재 provider adapter로 계속 해석됩니다.
- **진행 중 workflow**: workflow 시작 시의 조직 스냅샷이 유지되므로 런타임을 업데이트했어도 진행 중인 작업은 원래 실행 경로를 계속 사용합니다.
- **workflow 완료 후**: 새 workflow는 최신 조직 설정을 사용합니다.

따라서 런타임 변경 후에도 진행 중인 작업의 실행 환경이 갑자기 바뀌지 않습니다.

## 오류 진단 및 재실행

### 흔한 오류와 대응

#### OpenCodex를 찾을 수 없음

doctor가 다음 상태를 반환했습니다.

```json
{
  "status": "blocked",
  "checks": [{"id": "runtime-install", "status": "fail"}]
}
```

**원인**: OpenCodex가 설치되지 않았거나 경로 이상이 있습니다.

**대응**:

1. `runtime-install --dry-run`으로 설치 계획을 확인합니다.
2. 디스크 공간과 쓰기 권한을 확인합니다.
3. `runtime-install`을 실행합니다.

#### npm 설치 실패

installer나 runtime-install이 다음 오류를 반환했습니다.

```
runtime-npm-install-failed: <npm stderr>
```

**원인**: npm 의존성 설치 중 오류가 발생했습니다.

**대응**:

1. 오류 메시지에서 구체적인 npm 오류를 찾습니다.
2. 인터넷 연결을 확인합니다.
3. npm 캐시를 정리합니다: `npm cache clean --force`
4. `runtime-repair`를 실행합니다.

#### Bun 실행 불가

installer나 runtime-install이 다음 오류를 반환했습니다.

```
runtime-bun-unavailable
```

**원인**: OpenCodex 의존성인 Bun이 준비되지 않았습니다.

**대응**:

1. `ocx --version`을 직접 실행하여 실행 가능성을 확인합니다.
2. Bun 네이티브 바이너리의 플랫폼 호환성을 확인합니다.
3. `runtime-repair`를 실행합니다.

#### 계정 홈 검증 실패

worker가 다음 오류를 반환했습니다.

```
opencodex-global-change-blocked: account home lacks runtimeRole 'hub'
```

또는:

```
opencodex-binding-unverified
```

**원인**: 계정 홈이 필수 조건을 만족하지 않습니다.

**대응**:

1. 계정 홈의 `config.json`을 확인합니다.
2. 위의 "계정 홈 검증" 섹션의 조건을 모두 만족하도록 설정합니다.
3. 필요하면 새 격리 홈으로 다시 로그인합니다.

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
3. `~/.omt/runtime/opencodex/` 디렉터리의 내용을 확인합니다.

## 더 알아보기

- 공식 설치 가이드: https://opencodex.me/getting-started/for-agents/
- 공식 Providers 문서: https://opencodex.me/guides/providers/
- 조직 파일 스키마: `plugins/oh-my-teams/schemas/organization.schema.json`
- 의존성 설정: `plugins/oh-my-teams/resources/runtime-dependencies.json`
