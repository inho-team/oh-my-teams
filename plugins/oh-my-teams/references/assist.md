# 보조 도구 호출 계약

역할이 GPT-OSS 프로필을 보조 도구로 호출하는 규칙이다. 이 문서가 정본이며 역할 스킬은 여기를 참조한다.

## 런타임이 강제하는 것

`scripts/worker.mjs`의 `assist`는 다음을 순서대로 검사하고, 하나라도 어긋나면 결과를 저장하지 않고 실패한다.

1. 호출한 역할이 조직에 존재해야 한다.
2. 조직의 `assistants.<role>` 허용 목록에 프로필이 있어야 한다. **목록이 비어 있거나 역할이 빠져 있으면 그 역할의 호출은 전부 거부된다.** 목록은 `form`에서 정하며 나중에 `adjust`로 바꾼다.
3. 선택된 프로필의 모델이 `gpt-oss-120b-medium`이어야 한다.
4. `kind`가 `research`, `checklist`, `edit` 중 하나여야 한다.
5. 공유 조정자 상태 디렉터리가 있어야 한다.

```text
node <runtime> assist --org <organization.json> --task <task.json> --repo <worktree> --state <shared-state> --role <role> --kind <kind> [--profile <profile>]
```

여섯 인수가 모두 필수이고 `--profile`만 선택이다. `--profile`을 생략하면 허용 목록의 첫 항목을 쓴다.

## 역할별 사용 범위

**런타임은 역할에 따라 `kind`를 제한하지 않는다.** 세 값 모두 어느 역할에게나 허용되므로, 아래 구분은 코드가 막아 주는 경계가 아니라 지켜야 할 운영 관례다.

| 역할 | 쓰는 `kind` | 맡기는 일 |
|---|---|---|
| `pm` | `research`, `checklist` | 자료 정리와 반론 수집 |
| `pl` | `research`, `checklist` | 분할 근거 조사와 점검 목록 초안 |
| `senior` | `research`, `checklist` | 위치 탐색과 검토 항목 초안 |
| `junior` | `research`, `checklist`, `edit` | 위 항목과 좁은 범위의 편집 |
| `intern` | `research`, `checklist`, `edit` | 위 항목과 좁은 범위의 편집 |

`kind: edit`는 제한 편집 하네스를 그대로 거치므로 파일 해시, 허용 범위, 검사와 보고 관문이 `work`와 같다.

## 결과를 다루는 방법

보조 호출은 재위임이 아니라 제한된 하네스 호출이다. **호출한 역할이 결과를 검증하고 최종 판단을 책임진다.** 보조가 내놓은 결론은 승인이나 수용 결정을 대신하지 않는다.

읽기 전용 호출은 인용을 실제 파일과 대조한 뒤에만 성공한다. 인용이 하나도 없거나 대조에 실패한 인용이 하나라도 있으면 결과가 저장되지 않고 명령이 실패하므로, 그런 경우에는 파일 범위를 좁혀 다시 호출한다. 감사 기록은 공유 상태의 `assists` 아래에 남는다.

`draft --kind citations|checklist`도 같은 인용 대조를 거친다. 초안은 통과나 반려 판단을 대신하지 않는다.
