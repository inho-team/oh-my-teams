# 모델 카탈로그 조회 계약(catalog-lookup-contract)

작성일: 2026-09-27
상태: 완료 — `scripts/model-catalog.mjs`가 claude·codex·agy를 실제 설치본으로 조회하고, org-draft·adjust·form과의 연결은 이번 task의 비목표라 하지 않았다.
환경: macOS 24.6.0(Darwin) · claude 2.1.283 (Claude Code) · codex-cli 0.157.1(`/opt/homebrew/bin/codex`) · agy 1.2.12(`/opt/homebrew/bin/agy`)

## 목표

Codex·Claude·Agy가 지금 제공하는 모델 정보를 각 실행기 자신의 인터페이스로 읽어 오는 조회 계약을 만든다. 기억한 모델명이나 이전 문서의 버전 목록은 근거로 쓰지 않고, 이 문서에 적힌 모든 명령과 출력은 이번 조사에서 설치본을 직접 실행해 확인했다.

## 1. 실행기별로 실제 확인한 조회 인터페이스

### 1-1. Codex: `codex debug models` — 계정 카탈로그를 새로 고쳐 JSON으로 낸다

`codex --help`의 `debug` 하위 명령 목록에 `models`가 있고, `codex debug models --help`는 이렇게 설명한다.

```
Render the raw model catalog as JSON

Usage: codex debug models [OPTIONS]

Options:
      --bundled
          Skip refresh and dump only the bundled catalog shipped with this binary
```

`--bundled` 없이 실행하면 계정 카탈로그를 새로 고친 뒤(`host-defaults.mjs`가 이미 60초 타임아웃을 쓰는 이유) `{"models":[...]}` 형태의 JSON을 stdout에 낸다. 이번 설치본(0.157.1)에서 실측한 항목 하나는 다음과 같다(응답에는 이 밖에도 시스템 프롬프트 조각 등 실행에 필요한 큰 필드가 더 있으나, 카탈로그 조회에는 아래 필드만 쓴다).

```json
{
  "slug": "gpt-6-astra",
  "display_name": "GPT-6-Astra",
  "visibility": "list",
  "priority": 1,
  "default_reasoning_level": "medium",
  "supported_reasoning_levels": [
    { "effort": "low", "description": "..." },
    { "effort": "medium", "description": "..." }
  ]
}
```

`codex debug models`는 9개 항목을 냈고 그중 `visibility: "list"`는 7개, `"hide"`는 2개(`gpt-reserve`, `codex-auto-review`)였다. `--bundled`로 다시 실행하면 11개의 다른 슬러그(`gpt-5.4`, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` 등)가 나와, 기본 호출이 정말 계정별로 새로 고친 카탈로그를 낸다는 것과 바이너리에 미리 박힌 목록과는 다르다는 것을 함께 확인했다. `visibility`와 `priority`로 표시 대상과 정렬 순서를 정하는 방식은 `host-defaults.mjs`가 이미 그렇게 하고 있었고, 이번 조사로 그 방식이 여전히 유효함을 재확인했다.

**한계.** `--config`/계정 상태에 따라 카탈로그가 달라지고, 네트워크 새로고침이 실패하면(`CODEX_HOME`이 없거나 잘못된 경로일 때 실측한 사례)

```
Error: CODEX_HOME points to "/tmp/definitely-nonexistent-codex-home-xyz", but that path does not exist
```

처럼 0이 아닌 종료 코드와 stderr 원문을 낸다. `codex` 실행 파일 자체가 없을 때는 Node의 `spawn` 오류 문자열 `spawn codex ENOENT`가 stderr에 온다(실측: 존재하지 않는 이진 파일 이름으로 `core.mjs`의 `run`을 직접 호출).

### 1-2. Agy: `agy models` — 진행 문구는 stderr, 목록은 stdout에 탭 구분 텍스트로

`agy --help`의 `Available subcommands` 목록에 `models  List available models`가 있다. `agy models --help`는 `-h`/`--help` 외에 다른 플래그를 문서화하지 않으며, `agy models --output-format json`을 시도하면

```
Error: flags provided but not defined: -output-format
```

로 거부되어, 최상위 `--output-format` 플래그가 `models` 하위 명령에는 적용되지 않는다는 것을 확인했다. 즉 이 실행기는 JSON 출력 수단이 없고, stdout과 stderr을 실측으로 분리해 보면 형태가 이렇다.

```
$ agy models >stdout.txt 2>stderr.txt
--stdout--
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
...
claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking	Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium	GPT-OSS 120B (Medium)
--stderr--
Fetching available models...
```

한 줄이 `<모델 ID>\t<표시 이름>`이고, 진행 문구("Fetching available models...")는 stdout이 아니라 stderr로 간다. 이번 설치본(1.2.12)은 14개 모델을 냈다(Gemini 계열 11개, Claude 계열 2개, `gpt-oss-120b-medium` 1개).

**한계.** "Fetching"이라는 문구 자체가 원격 조회를 시사하므로, 오프라인이거나 인증이 끊긴 계정에서는 실패할 수 있다고 추정하지만 이번 조사에서는 그 상태를 안전하게 재현할 방법이 없어(실 계정 인증을 건드리는 시험이 되므로) 실측하지 못했다. 존재하지 않는 실행 파일 이름으로는 codex와 같은 `spawn agy ENOENT` 오류를 확인했다. 모델별 reasoning-effort 수준은 agy가 슬러그 이름에 인코딩할 뿐(`providers/agy.mjs`의 `MODEL_EFFORT` 정규식) `agy models` 출력 자체에는 없어, 이 모듈은 agy 모델 항목에 `efforts: []`만 채운다.

### 1-3. Claude: 목록 명령이 없다 — `--model`은 별칭 예시만 문서화한다

`claude --help`의 명령 목록(`agents`, `auth`, `doctor`, `mcp`, `plugin`, `project` 등)과 옵션 전체를 `grep -in model`로 훑은 결과, 모델을 나열하는 하위 명령이나 플래그는 없다.

```
--model <model>   Model for the current session. Provide an alias for the
                  latest model (e.g. 'fable', 'opus', or 'sonnet') or a
                  model's full name (e.g. 'claude-fable-5').
```

이 설명은 조회 가능한 목록이 아니라 사용법 예시일 뿐이다(`fable`/`opus`/`sonnet`이 지금 어떤 구체적 모델로 해석되는지조차 이 텍스트만으로는 알 수 없다). `host-defaults.mjs`도 이미 같은 결론으로 "Claude Code decides and this runtime does not assert which model"이라 적어 둔 채 `ANTHROPIC_MODEL` 환경변수와 설정 파일의 `model` 값만 읽고 있었다. 이번 조사는 그 전제를 다시 확인했을 뿐, 새로 읽을 수 있는 범위를 찾지 못했다.

**대신 확인할 수 있는 범위.** `claude --version`으로 설치 여부와 버전만 확인할 수 있다(`2.1.283 (Claude Code)`). 그래서 이 모듈의 claude 조회는 `claude --version`을 실행해 설치 자체는 확인하되, 성공하더라도 카탈로그가 없다는 사실을 `reasonCode: "no-catalog-interface"`로 명시적으로 보고한다. 설치가 안 돼 있으면(`spawn claude ENOENT`) `reasonCode: "not-installed"`로 구분한다.

## 2. 공개 계약: `scripts/model-catalog.mjs`

### 2-1. `fetchModelCatalog(options?) → Promise<{claude, codex, agy}>`

세 실행기를 병렬로, 서로 독립적으로 조회한다. 한 실행기의 실패가 다른 실행기의 결과에 영향을 주지 않는다(실측: `--codex-home`에 존재하지 않는 경로를 주면 `codex`만 `unavailable`이 되고 `claude`·`agy`는 그대로 `ok`/각자의 상태를 유지했다). 각 항목의 모양은 다음 중 하나다.

```jsonc
// status: "ok"
{
  "provider": "codex",
  "status": "ok",
  "source": "codex debug models",
  "models": [
    { "id": "gpt-6-astra", "displayName": "GPT-6-Astra", "efforts": ["low", "medium", ...] }
  ]
}

// status: "unavailable"
{
  "provider": "claude",
  "status": "unavailable",
  "reasonCode": "no-catalog-interface",
  "reason": "claude 2.1.283 (Claude Code) exposes no model-listing command; ...",
  "source": "claude --version",
  "models": []
}
```

`reasonCode`는 `CATALOG_FAILURE_REASONS`(`not-installed`·`command-failed`·`unparseable`·`empty-catalog`·`no-catalog-interface`)의 한 값이며, `reason`은 사람이 읽는 설명에 원본 오류 문구 일부(최대 300자, 초과 시 말줄임)를 담는다. 오래된 내장 목록이나 임의의 기본 모델로 채우는 경로는 없다: 각 provider 함수는 성공을 확인하지 못하면 `models: []`와 함께 실패로만 답한다.

`options`는 테스트가 실제 실행 파일 없이 결과를 재현할 수 있도록 `execute`(기본값 `core.mjs`의 `run`)를 주입받는다. `home`/`codexHome`/`env`는 `host-defaults.mjs`와 같은 뜻으로, Codex 조회에 그대로 전달된다.

Codex 조회는 `host-defaults.mjs`가 이미 구현한 `codex debug models` 실행과 JSON 해석을 새로 만들지 않고 그 모듈이 내보내는 `fetchCodexModelCatalog`·`resolveCodexHome`·`codexModelRank`를 그대로 가져와 쓴다. `host-defaults.mjs`의 기존 출력 계약(`resolveHostDefaults`가 반환하는 `codex`/`claude` 필드 모양)은 그대로 유지했고, 이 사실은 `tests/role-dispatch.test.mjs`의 기존 `host defaults` 회귀 테스트를 고치지 않고 통과시키는 것으로 확인했다.

### 2-2. `validateModelChoice(catalog, choice) → {ok, ...}`

사용자가 고른 `"provider:model"` 문자열을 `fetchModelCatalog`의 결과와 대조한다. 이번 task에서는 org-draft·adjust·form 어디에도 연결하지 않았다(비목표). 이후 그 흐름이 저장 전에 호출할 공개 계약으로 이번에 설계만 했다.

- 형식이 `provider:model`이 아니면 `{ok:false, reasonCode:"malformed-choice", reason}`.
- catalog에 없는 provider면 `{ok:false, reasonCode:"unknown-provider", reason}`.
- catalog에는 있지만 `status !== "ok"`인 provider(unavailable 실행기)를 골랐으면 `{ok:false, reasonCode:"provider-unavailable", reason}`(reason은 그 provider의 unavailable reason을 그대로 전달).
- provider는 `ok`지만 그 안에 해당 `id`의 모델이 없으면 `{ok:false, reasonCode:"model-not-in-catalog", reason}`.
- 위 네 경우를 모두 피하면 `{ok:true, provider, model}`.

네 가지 거부 사유가 서로 다른 `reasonCode`를 가지므로 호출자는 "형식이 잘못됨"과 "카탈로그에 없음"과 "실행기 자체가 불가능함"을 각각 다른 문구로 사용자에게 보여 줄 수 있다. `"provider:default"`처럼 host-default를 뜻하는 특수 값은 이 함수의 범위 밖이다: host-default 해석은 `host-defaults.mjs`의 책임이고, 이 함수는 카탈로그에 실제로 나열된 모델 ID만 판정한다.

### 2-3. CLI: `teams-org.mjs model-catalog [--codex-home DIR]`

`resolveHostDefaults`를 감싸는 기존 `host-defaults` 명령과 같은 자리에, 같은 방식(옵션 파싱은 `core.mjs`의 경계를 거치지 않고 이미 존재하는 `parseArgs`/`validateArgs`를 그대로 쓰고, 명령 실행은 `fetchModelCatalog`가 내부에서 `core.mjs`의 `run`을 거친다)으로 `model-catalog` 명령을 추가했다. `--codex-home`은 launcher가 자신의 `CODEX_HOME`을 쓸 때만 준다. 이 명령의 실제 출력은 §1에서 인용한 세 실행기 결과 그대로다(이번 조사에서 직접 실행해 확인했고, 잘못된 `--codex-home`을 줬을 때 codex만 unavailable이 되는 것도 실행해 확인했다).

## 3. 확인하지 못한 것과 남은 범위

- Agy가 오프라인이거나 인증이 끊긴 상태에서 `agy models`가 정확히 어떤 문구를 내는지는 실 계정 상태를 건드리지 않고는 재현할 수 없어 확인하지 못했다. 지금 분류기는 이런 경우를 `command-failed`(0이 아닌 종료 코드)로 처리하며, 별도의 "network" reasonCode는 추가하지 않았다.
- Claude가 향후 모델 목록 하위 명령을 추가하는지는 이번 조사 시점(claude 2.1.283)의 사실일 뿐이며, 이 모듈은 그 변화를 코드 수정 없이 반영하지 못한다(애초에 목록 명령이 없다는 사실 자체가 정적 판단이기 때문). 실행기가 명령을 추가하면 이 모듈도 함께 고쳐야 한다.
- org-draft·adjust·form을 `validateModelChoice`에 연결하는 일과 관련 스킬 문서 갱신은 비목표로 남겨 뒀다.
