# 모델 카탈로그 조회 계약(catalog-lookup-contract)

작성일: 2026-09-27(1차) · 2026-09-27(2차, 필수 검토 changes-requested 반영) · 2026-09-28(3차, catalog-evidence-revalidation) · 2026-09-28(4차, 브리프 revision 4의 host-default 조건 강화 반영)
상태: 완료 — `scripts/model-catalog.mjs`가 claude·codex·agy를 실제 설치본으로 조회하고, org-draft·adjust·form과의 연결은 이번 task의 비목표라 하지 않았다. 2차 개정에서 `execute` 자체가 reject·throw하는 경우, agy stdout에 형식에 맞지 않는 줄이 섞이는 경우, `validateModelChoice`에 손상된 catalog가 들어오는 경우를 각각 방어했고, Claude의 로컬 모델 카탈로그 캐시를 조사해 배제 근거를 남겼다. 3차 개정에서는 조회 결과에 `fetchedAt`·`executorVersion`·결정적인 `catalogRevision`을 추가하고, 저장 직전 선택을 다시 검증해 receipt를 돌려주는 `revalidateModelChoices`를 새로 공개했다(§2-4~§2-7). 4차 개정에서는 host-default 위임을 구체적 모델 선택과 완전히 분리했다: 위임과 모델이 함께 온 선택은 거부하고, 위임은 `valid`/`changed`와 겹치지 않는 `delegated` 상태로만 표시하며, 저장 허용은 실행기 설치·어댑터 실행 계약 확인 근거가 입력에 모두 있을 때만 참이 되도록 좁혔다(§2-6).
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

**형식에 맞지 않는 줄의 처리(2차 개정).** 1차 조사는 정상 케이스만 실측하고, `agy`가 향후 버전에서 stdout에 배너나 경고를 섞어 내는 상황은 조사하지 않았다. 그런 줄(탭이 아예 없거나, 탭 앞에 id가 비어 있는 줄)이 섞였을 때 이전 구현은 그 줄 전체를 `{id: "<그 줄 전체>", displayName: null}`이라는 모델로 조용히 받아들였다(`filter((model) => model.id)`가 빈 문자열만 걸러낼 뿐 탭 유무는 보지 않았기 때문). 지금은 `parseAgyLine`이 탭이 없거나 id가 빈 줄을 만나면 `null`을 돌려주고, `agyCatalog`는 그 즉시 agy 전체를 `status: "unavailable", reasonCode: "unparseable"`로 보고하며 문제의 줄 일부(최대 120자)를 `reason`에 담는다. 정상 줄 몇 개를 이미 모았더라도 부분 목록으로 내지 않는다: "실패한 실행기에 임의의 항목을 채우지 않는다"는 원칙을 성공(ok) 판정 안에서도 지키기 위해서다.

### 1-3. Claude: 목록 명령이 없다 — `--model`은 별칭 예시만 문서화한다

`claude --help`의 명령 목록(`agents`, `auth`, `doctor`, `mcp`, `plugin`, `project` 등)과 옵션 전체를 `grep -in model`로 훑은 결과, 모델을 나열하는 하위 명령이나 플래그는 없다.

```
--model <model>   Model for the current session. Provide an alias for the
                  latest model (e.g. 'fable', 'opus', or 'sonnet') or a
                  model's full name (e.g. 'claude-fable-5').
```

이 설명은 조회 가능한 목록이 아니라 사용법 예시일 뿐이다(`fable`/`opus`/`sonnet`이 지금 어떤 구체적 모델로 해석되는지조차 이 텍스트만으로는 알 수 없다). `host-defaults.mjs`도 이미 같은 결론으로 "Claude Code decides and this runtime does not assert which model"이라 적어 둔 채 `ANTHROPIC_MODEL` 환경변수와 설정 파일의 `model` 값만 읽고 있었다. 이번 조사는 그 전제를 다시 확인했을 뿐, 새로 읽을 수 있는 범위를 찾지 못했다.

**대신 확인할 수 있는 범위.** `claude --version`으로 설치 여부와 버전만 확인할 수 있다(`2.1.283 (Claude Code)`). 그래서 이 모듈의 claude 조회는 `claude --version`을 실행해 설치 자체는 확인하되, 성공하더라도 카탈로그가 없다는 사실을 `reasonCode: "no-catalog-interface"`로 명시적으로 보고한다. 설치가 안 돼 있으면(`spawn claude ENOENT`) `reasonCode: "not-installed"`로 구분한다.

**로컬 캐시 조사와 배제 근거(2차 개정).** 필수 검토에서 이 머신의 `~/.claude/cache/model-catalog/`에 Claude Code 자신이 쓰는 것으로 보이는 캐시가 있다는 지적이 있어, 그 디렉터리를 직접 열어 다음을 확인했다.

- `published-floor.json`: `{"version":1,"sources":{"<해시>":{"version":515,"issuedAt":"2026-09-16T12:53:05Z","recordedAt":<epoch ms>}}}` 형태로, 파일 이름이 아니라 이 파일 안의 필드가 최신 발행본을 가리킨다.
- `published-<해시>.json`(해시는 `published-floor.json`의 `sources` 키): 최상위 필드가 `version`(로컬 캐시 스키마 버전, `2`), `fetchedAt`/`staleAt`(epoch ms), `etag`, `source`(`"hosted"`), `documentBytes`(base64), `sidecar`, `rootId`이다. `documentBytes`를 디코드하면 `{"$schema": "https://downloads.claude.ai/model-catalog/v1/schema.json", "schema_version": 1, "version": 515, "issued_at": "2026-09-16T12:53:05Z", "expires_at": "2026-09-23T12:53:05Z", "key_id": "claude-code-release-signing-key", "surfaces": {...}}`가 나온다. `sidecar`는 `{"schema": 1, "algorithm": "RSASSA-PKCS1-v1_5-SHA512", "signature": "<base64>", "publicKeySha256": "<hex>"}`로, 서명 검증에 쓸 필드는 있지만 이 조사는 서명을 실제로 검증하지는 않았다(공개키를 어디서 신뢰 앵커로 확보하는지는 설치본 도움말 어디에도 문서화돼 있지 않다).
- 만료 판정: 문서 자체의 `expires_at`은 `2026-09-23T12:53:05Z`이고, 이 문서를 작성한 시점(2026-09-27)은 이미 그 뒤다. 로컬 캐시 메타데이터의 `staleAt`(epoch ms)도 `fetchedAt`으로부터 약 1시간 뒤로 찍혀 있어, 두 기준 모두 이 캐시가 이미 지난 문서임을 가리킨다. 즉 이 파일을 지금 읽어도 "지금 쓸 수 있는 모델"이 아니라 "9월 16일에 발행되고 9월 23일에 만료된, 그 이후로 갱신되지 않은 채 남아 있는 문서"를 읽는 것이다.
- `surfaces.cc.model_selector_state`는 배열이고, 그 항목은 `id`, `model`, `thinking`, `thinking_by_model`, `selection_source` 필드를 갖는다(모델 ID 값 자체는 이 문서에 옮기지 않는다). 리뷰가 지적한 대로 이 필드가 실제로 존재하고, 형태로만 보면 "지금 쓸 수 있는 모델"에 대응하는 데이터처럼 보인다.
- 공식 조회 계약 여부: `claude --help`의 전체 하위 명령·옵션을 `model`·`cache`·`catalog` 키워드로 다시 훑었지만 이 캐시를 읽거나 갱신하는 공식 하위 명령·플래그는 없다(`doctor`도 헬프 문구상 설정 파일의 건강 상태만 언급할 뿐 모델 카탈로그를 언급하지 않는다). 이 디렉터리의 존재와 스키마는 Claude Code 실행 파일의 내부 구현 세부사항이지, 이 실행기가 공식적으로 문서화해 외부에 노출한 조회 계약이 아니다.

**배제 원칙과 결론.** 위 네 가지 관찰(①유효기간이 이미 지난 캐시일 수 있다, ②캐시를 읽었다는 사실이 인증·구독 접근 권한을 검증해 주지 않는다, ③서명 필드는 있지만 이 조사가 서명을 검증하지 않았고 신뢰 앵커 확보 경로도 문서화돼 있지 않다, ④설치본 도움말 어디에도 이 캐시를 공식적으로 조회하거나 갱신하는 계약이 없다)에 따라, 이 모듈은 `~/.claude/cache/model-catalog/`를 읽지 않는다. Claude는 계속 `no-catalog-interface`로 남긴다. 이것은 열려 있는 사안이 아니라 확정한 설계 결정이다: 이 캐시를 신뢰할 수 있는 방식으로(만료 판정, 서명 검증, 갱신 실패 처리까지 포함해) 활용하려면 이 실행기가 공식적으로 문서화해 노출한 조회 계약이 있어야 하는데, 지금 설치본에는 그런 계약도 검증된 갱신 경로도 없다. 그 계약이 실제로 생기기 전까지는 다시 제안하지 않는다.

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

`reasonCode`는 `CATALOG_FAILURE_REASONS`(`not-installed`·`command-failed`·`unparseable`·`empty-catalog`·`no-catalog-interface`·`execute-error`)의 한 값이며, `reason`은 사람이 읽는 설명에 원본 오류 문구 일부(최대 300자, 초과 시 말줄임)를 담는다. 오래된 내장 목록이나 임의의 기본 모델로 채우는 경로는 없다: 각 provider 함수는 성공을 확인하지 못하면 `models: []`와 함께 실패로만 답한다.

`options`는 테스트가 실제 실행 파일 없이 결과를 재현할 수 있도록 `execute`(기본값 `core.mjs`의 `run`)를 주입받는다. `home`/`codexHome`/`env`는 `host-defaults.mjs`와 같은 뜻으로, Codex 조회에 그대로 전달된다.

**`execute-error`를 별도 사유로 둔 이유(2차 개정).** 필수 검토에서 주입한 `execute`가 스스로 reject하거나 동기 예외를 던지면(core.mjs의 실제 `run`은 spawn 오류를 `child.on("error")`에서 흡수해 항상 resolve하므로 이 경로를 타지 않지만, `execute`는 옵션으로 노출된 공개 계약이라 이 경로도 실제 계약면이다) `fetchModelCatalog`의 `Promise.all` 전체가 그 예외로 reject되어, 이미 성공했을 다른 provider의 결과까지 통째로 사라진다는 결함이 지적됐다. 지금은 `fetchModelCatalog`가 provider마다 `safeCatalog`로 감싸 개별적으로 catch하므로, 한 provider의 `execute` 실패가 다른 provider의 이미 정착된 결과에 영향을 주지 않는다. reasonCode는 기존 `command-failed`에 합치지 않고 `execute-error`를 새로 만들었다: `command-failed`는 "프로세스가 실행은 됐지만 비정상 종료했거나 타임아웃됨"을 뜻하는 반면, 이 경로는 프로세스 실행 결과 자체를 받지 못한 채(주입된 실행기가 계약을 어긴 채) 끝난 것이라 원인의 층위가 다르고, 호출자가 "환경 문제"와 "주입된 실행기 자체의 버그"를 구분해 다르게 대응할 수 있게 하는 편이 낫다고 판단했다.

Codex 조회는 `host-defaults.mjs`가 이미 구현한 `codex debug models` 실행과 JSON 해석을 새로 만들지 않고 그 모듈이 내보내는 `fetchCodexModelCatalog`·`resolveCodexHome`·`codexModelRank`를 그대로 가져와 쓴다. `host-defaults.mjs`의 기존 출력 계약(`resolveHostDefaults`가 반환하는 `codex`/`claude` 필드 모양)은 그대로 유지했고, 이 사실은 `tests/role-dispatch.test.mjs`의 기존 `host defaults` 회귀 테스트를 고치지 않고 통과시키는 것으로 확인했다.

### 2-2. `validateModelChoice(catalog, choice) → {ok, ...}`

사용자가 고른 `"provider:model"` 문자열을 `fetchModelCatalog`의 결과와 대조한다. 이번 task에서는 org-draft·adjust·form 어디에도 연결하지 않았다(비목표). 이후 그 흐름이 저장 전에 호출할 공개 계약으로 이번에 설계만 했다.

- 형식이 `provider:model`이 아니면 `{ok:false, reasonCode:"malformed-choice", reason}`.
- `catalog`가 null이거나 객체가 아니거나 배열이면(즉 `fetchModelCatalog`의 결과일 수 없는 모양이면) `{ok:false, reasonCode:"malformed-catalog", reason}`.
- catalog에 없는 provider면 `{ok:false, reasonCode:"unknown-provider", reason}`.
- catalog에는 있지만 `status !== "ok"`인 provider(unavailable 실행기)를 골랐으면 `{ok:false, reasonCode:"provider-unavailable", reason}`(reason은 그 provider의 unavailable reason을 그대로 전달).
- provider는 `ok`인데 그 항목의 `models`가 배열이 아니면(catalog가 손상된 경우) `{ok:false, reasonCode:"malformed-catalog", reason}`.
- provider는 `ok`고 `models`도 배열이지만 그 안에 해당 `id`의 모델이 없으면(배열 안에 `null`이나 원시값 같은 손상된 항목이 섞여 있어도 예외 없이) `{ok:false, reasonCode:"model-not-in-catalog", reason}`.
- 위 경우를 모두 피하면 `{ok:true, provider, model}`.

`malformed-catalog`는 나머지 네 사유와 성격이 다르다: 나머지는 "사용자가 고른 값"을 정상적인 catalog와 대조해 거부하는 것이고, `malformed-catalog`는 catalog 인자 자체가 `fetchModelCatalog`의 결과가 아닌 경우다(호출자가 캐시하거나 재구성한 catalog를 넘기는 경로에서 생길 수 있는 호출자 쪽 결함). 필수 검토에서 `catalog.codex = {status: "ok"}`(models 키 누락)·`{status: "ok", models: "not-an-array"}`·`{status: "ok", models: null}` 세 변형이 모두 `entry.models.find(...)`에서 TypeError를 던지는 것이 지적돼, 지금은 `Array.isArray(entry.models)`를 먼저 확인하고 배열 안의 각 항목도 `candidate !== null && typeof candidate === "object"`를 확인한 뒤에만 `.id`를 비교한다. provider 이름에 상속된 프로토타입 키(`constructor` 등, 이 모듈의 정규식이 만들 수 있는 소문자 전용 이름 중 유일하게 JS가 예약한 이름)를 주는 경우도 `Object.hasOwn(catalog, provider)`로 직접 확인해, 상속된 속성을 실제 provider 항목으로 착각하지 않는다.

다섯 가지 거부 사유가 서로 다른 `reasonCode`를 가지므로 호출자는 "형식이 잘못됨"과 "카탈로그에 없음"과 "실행기 자체가 불가능함"과 "catalog 인자 자체가 손상됨"을 각각 다른 문구로 사용자에게 보여 줄 수 있다. `"provider:default"`처럼 host-default를 뜻하는 특수 값은 이 함수의 범위 밖이다: host-default 해석은 `host-defaults.mjs`의 책임이고, 이 함수는 카탈로그에 실제로 나열된 모델 ID만 판정한다.

### 2-3. CLI: `teams-org.mjs model-catalog [--codex-home DIR]`

`resolveHostDefaults`를 감싸는 기존 `host-defaults` 명령과 같은 자리에, 같은 방식(옵션 파싱은 `core.mjs`의 경계를 거치지 않고 이미 존재하는 `parseArgs`/`validateArgs`를 그대로 쓰고, 명령 실행은 `fetchModelCatalog`가 내부에서 `core.mjs`의 `run`을 거친다)으로 `model-catalog` 명령을 추가했다. `--codex-home`은 launcher가 자신의 `CODEX_HOME`을 쓸 때만 준다. 이 명령의 실제 출력은 §1에서 인용한 세 실행기 결과 그대로다(이번 조사에서 직접 실행해 확인했고, 잘못된 `--codex-home`을 줬을 때 codex만 unavailable이 되는 것도 실행해 확인했다).

### 2-4. 조회 근거: `fetchedAt`·`executorVersion`·`catalogRevision`

`fetchModelCatalog`의 결과는 이제 최상위에 `fetchedAt`(이 호출의 시각, ISO 문자열)과 전체 `catalogRevision`을 함께 담고, provider별 항목에도 각각 `executorVersion`과 `catalogRevision`을 담는다.

`executorVersion`은 카탈로그 조회 성공 여부와는 독립적으로, 그때그때 best-effort로 확인한다. Codex와 Agy는 각각 `codex --version`·`agy --version`을 카탈로그 조회 명령과 병렬로 실행해서 얻고(이번 조사에서 실측: `codex --version` → `codex-cli 0.157.1`, `agy --version` → `1.2.12`, 둘 다 종료 코드 0에 한 줄짜리 stdout), Claude는 이미 카탈로그 조회 자체가 `claude --version`이므로 그 결과를 그대로 재사용한다(`2.1.283 (Claude Code)`). 이 값을 얻는 과정에서 실행 파일이 없거나 비정상 종료하거나 주입된 `execute`가 reject·throw해도, `catalogRevision`의 `reasonCode`와 별도의 두 번째 실패 사유를 만들지 않고 그냥 `executorVersion: null`로 답한다: 버전 확인은 카탈로그 조회의 성패를 가리는 판정에 끼어들 이유가 없는 부가 정보이기 때문이다.

`catalogRevision`은 provider별로, 그 provider가 지금 제공하는 선택 가능한 값(모델 `id`와 그 `efforts` 집합)만을 대상으로 계산한 SHA-256 해시다. 해시에 넣기 전에 모델을 `id`로, 각 모델의 `efforts`를 알파벳으로 각각 정렬해서(`canonicalModels`), provider가 같은 목록을 어떤 순서로 내든 같은 해시가 나오게 만든다. 조회 시각과 사람이 읽는 `reason` 원문은 일부러 해시 입력에서 뺐다: 그래야 실제로 고를 수 있는 모델·effort 집합이 그대로인 두 번의 조회가 항상 같은 리비전을 내고, 반대로 그 집합이 하나라도 달라지면 (시각이나 오류 문구가 우연히 같아도) 리비전이 반드시 달라진다. 전체 `catalogRevision`은 세 provider의 리비전을 `CATALOG_PROVIDERS`가 정한 고정 순서로 다시 해시한 값이라, provider 하나만 바뀌어도 전체 리비전이 함께 바뀐다. 이 결정성은 회귀 테스트(`tests/model-catalog.test.mjs`의 "catalogRevision (per-provider and overall) is unchanged by fetch time, error text, or output order, and changes only with the models/efforts on offer")로 직접 확인했다.

### 2-5. `validateModelChoice`에 `effort` 검사 추가

`validateModelChoice(catalog, choice, effort)`의 세 번째 인자로 reasoning effort를 함께 넘기면, 매칭된 모델의 `efforts` 배열과 대조한다. 그 모델이 지원 effort 목록을 실제로 내는 provider(Codex)라면 목록에 없는 effort를 거부 사유 `effort-not-supported`로 되돌리고, 목록에 있으면 `effortChecked: true`와 함께 통과시킨다. 반면 그 provider의 카탈로그 자체가 effort 정보를 전혀 내지 않는 경우(Agy가 지금 그렇다, `agy models` 출력에 effort가 없다)는 임의의 허용 목록을 지어내지 않고 그냥 통과시키되 `effortChecked: false`로 "이 값은 검증되지 않았다"는 사실을 그대로 드러낸다. `effort`를 아예 넘기지 않은 기존 호출은 이 검사를 전혀 거치지 않아 기존 반환 모양(`{ok, provider, model}`)이 그대로 유지된다.

### 2-6. `revalidateModelChoices(catalog, selections, options?) → receipt`

org-draft·adjust·form이 아직 이 함수를 호출하지는 않지만(연결은 여전히 비목표), 그 흐름이 저장 직전에 호출할 공개 계약을 이번 task에서 만들었다. 호출자가 `fetchModelCatalog`로 새로 조회한 `catalog`와, 사용자가 지금 화면에서 들고 있는 선택 목록(`selections`)을 함께 넘기면, 선택마다 독립적으로 판정한 receipt를 돌려준다.

선택 하나의 판정은 `REVALIDATION_STATUSES`(`valid`·`changed`·`invalid`·`unavailable`·`delegated`) 중 하나다. `valid`와 `changed`는 둘 다 지금 카탈로그를 통과했다는 뜻이고, 선택을 마지막으로 본 시점의 `catalogRevision`을 호출자가 함께 넘겼을 때 그 값이 provider의 지금 리비전과 다르면(또는 아예 넘기지 않았으면) `changed`로, 같으면 `valid`로 구분한다. `invalid`는 지금 카탈로그가 그 선택을 거부한 경우(`validateModelChoice`가 실패하거나 provider 이름 자체를 모르는 경우, host-default가 구체적인 모델과 함께 온 경우)다. `unavailable`은 그 provider의 이번 조회 자체가 실패해서 판정할 수 없었던 경우다. `delegated`는 host-default 위임을 아래에서 별도로 설명한다. 이 다섯 값은 서로 겹치지 않고, 한 provider의 조회 실패가 다른 provider를 겨냥한 선택의 판정을 바꾸지 않는다(`revalidateOne`이 각 선택을 오직 자신의 `provider` 항목만 보고 판정하기 때문이며, 이 성질은 "revalidateModelChoices preserves an untouched selection whose own provider's lookup failed, without touching other providers' selections"와 "a provider lookup failure never turns an explicit model selection into a host-default delegation" 두 테스트로 확인했다).

선택마다 `touched`(기본값 `true`)를 함께 넘길 수 있다. `touched: true`는 "지금 사용자가 새로 고르거나 바꾸는 값"이라는 뜻이라, 검증을 통과해야만 `savable: true`가 된다. `touched: false`는 "이번에 손대지 않은, 기존에 저장돼 있던 선택"이라는 뜻이라, 그 provider가 하필 지금 조회에 실패해도 곧바로 거부하지 않고 `preserved: true`와 함께 `savable: true`를 돌려준다(다른 provider의 실패 때문에 사용자가 건드리지 않은 기존 프로필이 통째로 사라지거나 `model: null`이 되는 것을 막기 위해서다). 다만 `preserved: true`인 선택도 `status`는 `unavailable`이고 `catalogVerified: false`로 남는다: 저장을 막지 않았을 뿐, 지금 조회로 실제 확인된 값이라는 뜻은 아니기 때문이다. `touched`의 기본값을 `false`가 아니라 `true`로 둔 것도 같은 이유다: 호출자가 이 필드를 빠뜨렸을 때, 깨진 기존 선택을 조용히 보존해 버리기보다 최신 조회로 검증하라고 요구하는 쪽이 더 안전하다.

**host-default 위임(브리프 revision 4에 따라 엄격화).** `hostDefault: true`인 선택은 구체적인 모델을 카탈로그와 대조하지 않는다: `model`이 함께 오면(빈 문자열이 아닌 값) 조용히 버리고 위임으로 넘기지 않고 즉시 `status: "invalid"`, `reasonCode: "host-default-with-model"`로 거부한다(위임과 구체적 모델 선택을 뒤섞지 않는다는 원칙을 코드로 강제한다). `model`을 실제로 비운 위임만 판정을 계속하며, 이때의 상태는 `valid`·`changed`가 아니라 항상 `delegated`다: 이 값은 카탈로그의 구체적인 모델과 대조를 통과한 적이 없으므로, 새 모델 선택이 통과했다는 뜻과 절대 같은 값으로 표시하지 않는다.

`delegated` 선택이 `savable: true`가 되려면 다음 세 근거가 모두 있어야 하고, 그 상태를 `delegationGrounds`에 그대로 남긴다. 이 세 근거는 성격이 서로 다르다는 점을 receipt 구조 자체로 드러낸다: `explicitRequest`와 `adapterContractConfirmed`는 호출자가 이 모듈에 넘긴 주장이고, `executorInstalled`만 이 모듈이 직접 관찰해 확인한 증거다. 이 모듈은 호출자의 주장을 검증 성공으로 승격하지 않는다.

(1) `explicitRequest`: `hostDefault: true` 자체가 사용자가 명시적으로 위임을 요청했다는 호출자의 주장이다.

(2) `executorInstalled`: `EXECUTOR_INSTALL_STATES`(`installed`·`not-installed`·`unknown`) 중 하나이며, 이 모듈이 직접 관찰한 증거로만 판정한다 — 카탈로그 조회의 성공(`status: "ok"`) 여부나, `reasonCode`가 `"not-installed"`가 아니라는 사실만으로는 판정하지 않는다. `installed`는 `status: "ok"`이거나, 확인된 `executorVersion` 문자열이 있거나, 실행기가 카탈로그 나열 명령이 구조적으로 없다고 실제로 응답한 경우(`reasonCode: "no-catalog-interface"`)에만 쓴다. 이 마지막 경로 덕분에 Claude는 구조적으로 항상 `status: "unavailable"`이면서도(카탈로그 나열 명령 자체가 없다, §1-3) `installed`로 판정된다(host-default 위임이 원래 필요한 대상이 Claude이기 때문이며, `status === "ok"`로만 좁혀 판정했다가 Claude를 매번 잘못 거부하는 문제를 이번 task 안에서 발견해 고쳤다). `not-installed`는 `reasonCode`가 정확히 `"not-installed"`(프로세스 자체를 실행할 수 없었다)일 때만 쓴다. 그 사이, 즉 확인된 버전도 없고 명확한 미설치 근거도 없는 경우 — `execute-error`(주입된 `execute` 자체가 던지거나 reject해서 프로세스 응답이 전혀 없었던 경우)나 근거 없는 `command-failed`·`unparseable`·`empty-catalog` — 는 `unknown`으로 둔다: 조회가 실패했다는 사실만으로 설치 여부를 어느 쪽으로도 추정하지 않기 때문이다. `unknown`은 `not-installed`와 같은 취급으로 `status: "unavailable"`이 되고, 지금 사용자가 새로 요청한 위임(`touched: true`)이면 `savable: false`, 이번에 손대지 않은 기존 위임(`touched: false`)이면 다른 provider의 판정과 같은 `preserved`/`savable` 규칙을 그대로 적용한다.

(3) `adapterContractConfirmed`: 호출자가 명시적으로 `true`를 넘겨서, 기존 어댑터(`host-defaults.mjs`)의 해당 실행 계약을 이미 확인했다고 스스로 밝힌 경우에만 참이다. 이 모듈은 그 계약을 대신 검증하지 않고, 필드가 없거나 `false`인 입력을 위임 증거로 추정하지도 않는다: 확인되지 않았을 뿐 확인해 봤더니 실패했다는 뜻이 아니므로, `reasonCode: "adapter-contract-not-confirmed"`로 "아직 확인되지 않았다"는 사실만 구분해 남기고 `savable: false`로 저장을 막는다.

세 근거가 모두 있으면(`executorInstalled: "installed"`이고 `adapterContractConfirmed: true`) `reasonCode`는 `null`이고 `savable: true`다. 어느 경로든 `delegated`·`unavailable` 선택의 `catalogVerified`는 항상 `false`이며, 이를 카탈로그 검증 성공이나 인증·구독 권한 확인으로 표시하지 않는다. `validateModelChoice` 자체에는 host-default 해석을 넣지 않았다: 그 함수는 카탈로그에 실제로 나열된 `provider:model` 값만 판정하는 좁은 계약으로 유지하고, host-default 판정은 `revalidateModelChoices`(그리고 그 위임의 실제 실행 계약을 아는 `host-defaults.mjs`)의 몫으로 남겨, 두 계약의 책임을 섞지 않았다.

malformed한 selection(문자열이어야 할 `key`·`provider`가 없거나, host-default가 아닌데 `model`이 없는 경우)은 예외를 던지지 않고 `status: "invalid"`, `reasonCode: "malformed-selection"`으로 답한다(기존 `validateModelChoice`의 "절대 던지지 않는다" 관례를 그대로 잇는다). 새로 추가한 `reasonCode`들(`malformed-selection`·`catalog-revision-changed`·`effort-not-supported`·`host-default-with-model`·`adapter-contract-not-confirmed`)은 `CHOICE_REJECTION_REASONS`나 `CATALOG_FAILURE_REASONS`에 합치지 않고 그때그때 결과 객체에만 실었다: 앞의 두 배열은 각각 `validateModelChoice`와 provider 조회 자체의 실패 사유만 다루는 좁은 계약이고, 이들은 그중 어디에도 속하지 않는 `revalidateOne`만의 판정 사유(선택 자체의 구조적 결함, provider는 통과했지만 리비전이 달라졌다는 사실, effort 부적합, 위임과 모델의 충돌, 위임 근거 미확인)라 기존 배열의 뜻을 흐리지 않기 위해 분리했다.

`selections` 인자 자체가 배열이 아니면(호출자 쪽 결함) `malformed: true`와 함께 `savable: false`를 돌려준다. 반면 모델 선택과 무관한 조정(정책·인원 변경 등)처럼 실제로 검증할 선택이 하나도 없는 정상적인 빈 배열 `[]`은 `malformed: false`, `savable: true`로 구분한다: 검증할 것이 없다는 사실과 입력 자체가 잘못됐다는 사실은 다른 문제이고, 후자를 전자로 조용히 넘겨서 `savable: true`를 잘못 돌려주면 안 되기 때문이다.

receipt 전체에는 이번 검증에 쓴 `catalogRevision`(전체)과 `providerRevisions`(provider별), 검증 시각 `verifiedAt`, `malformed`, 그리고 `savable`(`malformed`가 거짓이고 모든 선택의 `savable`이 참일 때만 참)을 함께 담는다. 이 함수는 스스로 아무것도 조회하지 않는다: 호출자가 `fetchModelCatalog`로 새로 조회한 `catalog`를 넘겨야 하고, 그래서 오래된 캐시나 내장 목록이 이 경로로 대신 들어올 수 없다.

### 2-7. CLI: `teams-org.mjs model-catalog-revalidate --selections FILE [--codex-home DIR]`

`FILE`은 §2-6의 `selections` 배열을 JSON으로 담은 파일이다. 이 명령은 카탈로그를 새로 조회하고 그 배열을 검증만 할 뿐, 아무것도 저장하지 않는다(검증 전용). 실제 설치본(codex-cli 0.157.1, agy 1.2.12, claude 2.1.283)에 대고 확인한 경로는 §2-6에 적힌 세 경로(신선한 codex 선택, `adapterContractConfirmed`가 있고 없는 claude 대상 host-default 위임, 위임과 모델이 함께 온 codex 선택)이며, 각각 `changed`·`delegated`(savable 참/거짓)·`invalid`(`host-default-with-model`)로 나온 실제 출력을 이번 task의 검증에서 직접 확인했다.

## 3. 확인하지 못한 것과 남은 범위

- Agy가 오프라인이거나 인증이 끊긴 상태에서 `agy models`가 정확히 어떤 문구를 내는지는 실 계정 상태를 건드리지 않고는 재현할 수 없어 확인하지 못했다. 지금 분류기는 이런 경우를 `command-failed`(0이 아닌 종료 코드)로 처리하며, 별도의 "network" reasonCode는 추가하지 않았다.
- Claude가 향후 모델 목록 하위 명령을 추가하는지는 이번 조사 시점(claude 2.1.283)의 사실일 뿐이며, 이 모듈은 그 변화를 코드 수정 없이 반영하지 못한다(애초에 목록 명령이 없다는 사실 자체가 정적 판단이기 때문). 실행기가 명령을 추가하면 이 모듈도 함께 고쳐야 한다.
- org-draft·adjust·form을 `validateModelChoice`·`revalidateModelChoices`에 실제로 연결하는 일과 관련 스킬 문서 갱신은 여전히 비목표로 남겨 뒀다(적응형 팀 편성 kickoff와 다음 파동의 몫).
- `fetchModelCatalog`의 각 provider 항목에 조회 시각(`fetchedAt`)과 결정적인 `catalogRevision`을 추가하고, 저장 직전 선택을 다시 검증하는 `revalidateModelChoices`를 공개해 이전 개정에서 남겨 뒀던 freshness·revision 여백을 이번 task에서 닫았다(§2-4·§2-6). "사용자가 고른 시점의 catalog"와 "저장 직전 재조회한 catalog"가 같은 조회인지는 `catalogRevision`의 일치 여부로 판정하고, 일부 provider만 재조회에 실패했을 때 이미 고른 다른 provider의 선택을 그대로 보존하는지는 `touched`/`preserved` 필드로 구분한다.
- Claude의 로컬 모델 카탈로그 캐시(`~/.claude/cache/model-catalog/`)는 §1-3에서 조사했고, 신뢰할 수 있는 방식으로 활용하지 않는 쪽으로 이미 결론지었다(§1-3의 배제 원칙과 결론 참고). 이는 다음 파동에서 다시 열어야 할 사안이 아니라, 이 실행기가 공식 조회 계약을 실제로 내놓기 전까지 유효한 확정된 결정이다.
- Agy가 오프라인이거나 실행 파일이 없는 것과 달리 "host-default 위임 대상 provider가 진짜로 응답하지 못하는" 경우(§2-6)는 이번 task에서 `codex debug models`의 ENOENT를 주입해 확인했을 뿐, Codex·Agy가 계정 인증만 끊긴 채로 남는 경우까지는 실 계정 상태를 건드리지 않고는 재현하지 못했다.
- `revalidateModelChoices`의 `adapterContractConfirmed`는 호출자가 스스로 확인했다고 밝히는 값이며, 이 모듈이 `host-defaults.mjs`의 실행 계약을 대신 열어 검증하지는 않는다(비목표: 어댑터 경계를 중복 구현하지 않는다). 그 확인을 실제로 어디서, 어떻게 수행할지는 org-draft·adjust·form을 이 함수에 연결할 다음 파동이 `host-defaults.mjs`를 근거로 정할 사안이다.
- `delegationGrounds`의 세 근거는 출처가 서로 다르다: `explicitRequest`·`adapterContractConfirmed`는 호출자가 이 모듈에 넘긴 주장이고, `executorInstalled`만 이 모듈이 직접 관찰한 증거다(§2-6). 처음 구현은 `executorInstalled`를 `reasonCode !== "not-installed"`인 boolean으로만 판정해서, 주입된 `execute` 자체가 던지거나 reject해 프로세스 응답이 전혀 없었던 `execute-error`나 근거 없는 `command-failed`까지도 "설치됨"으로 잘못 추정하는 결함이 있었다. 이번 task에서 `EXECUTOR_INSTALL_STATES`(`installed`·`not-installed`·`unknown`)로 재구성해, 확인된 `executorVersion`이나 실제로 응답한 `no-catalog-interface`처럼 이 모듈이 직접 관찰한 긍정 근거가 있을 때만 `installed`로 판정하고, 그런 근거가 전혀 없는 실패는 `unknown`으로 남겨 `savable`을 막도록 닫았다.
