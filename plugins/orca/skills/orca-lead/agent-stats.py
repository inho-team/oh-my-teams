#!/usr/bin/env python3
"""에이전트 세션 로그에서 부담 지표를 뽑는다 — PM 이 조각마다 백로그에 적는 숫자. (2026-09-13)

사용:  python3 agent-stats.py <워크트리 이름>...        # codex 로그(~/.codex/sessions)에서 그 워크트리를 쓴 세션을 찾는다
       python3 agent-stats.py --file <rollout.jsonl>

지표: 입력(브리프+깨움) 건수와 종류, 셸 호출 수, 그중 기다리기(tail/sleep 찔러보기), 턴 수, 누적 입력·캐시·출력 토큰, 마지막 턴 컨텍스트.
codex 형식(rollout-*.jsonl)만 안다. agy 로그 형식은 아직 안 봤다 — 필요하면 여기에 붙인다.
"""
import sys, json, re, glob, os

def find_logs(names):
    out = []
    for f in sorted(glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl")), key=os.path.getmtime, reverse=True):
        try:
            head = open(f, encoding="utf-8").read(200000)
        except Exception:
            continue
        if any(n in head for n in names):
            out.append(f)
    return out

def stats(f):
    rows = [json.loads(l) for l in open(f, encoding="utf-8") if l.strip()]
    inputs, calls, tok = [], [], []
    for d in rows:
        p = d.get("payload") or {}; ts = d.get("timestamp", "")[11:19]
        if p.get("type") == "message" and p.get("role") == "user":
            c = p.get("content"); txt = " ".join(x.get("text", "") for x in c) if isinstance(c, list) else str(c)
            if "environment_context" in txt or "user_instructions" in txt: continue
            inputs.append((ts, txt[:80].replace("\n", " ")))
        if p.get("type") in ("function_call", "custom_tool_call"):
            a = p.get("arguments") or p.get("input") or ""
            try: a = json.loads(a) if isinstance(a, str) else a
            except Exception: pass
            calls.append(str(a.get("command") if isinstance(a, dict) else a))
        if p.get("type") == "token_count" and (p.get("info") or {}).get("total_token_usage"):
            tok.append(p["info"])
    kinds = {"브리프": 0, "폴러": 0, "verify": 0, "PM/PL 답신": 0, "기타": 0}
    for _, m in inputs:
        k = "브리프" if m.startswith("이 워크트리") else "폴러" if m.startswith("[폴러") else "verify" if m.startswith("[verify") else "PM/PL 답신" if "답신" in m else "기타"
        kinds[k] += 1
    waits = sum(1 for c in calls if re.search(r"tail -\d+ /tmp/verify|for i in .*tail|sleep \d+;", c))
    t = tok[-1]["total_token_usage"] if tok else {}; l = tok[-1].get("last_token_usage", {}) if tok else {}
    print("로그: %s" % f)
    print("입력 %d건 %s" % (len(inputs), {k: v for k, v in kinds.items() if v}))
    print("셸 호출 %d건 · 그중 기다리기(tail/sleep 찔러보기) %d건" % (len(calls), waits))
    if tok:
        print("턴 %d · 누적 입력 %.2fM(캐시 %.2fM) · 출력 %.1fK · 마지막 턴 컨텍스트 %.0fK" % (
            len(tok), t.get("input_tokens", 0) / 1e6, t.get("cached_input_tokens", 0) / 1e6, t.get("output_tokens", 0) / 1e3, l.get("input_tokens", 0) / 1e3))
    print("백로그 한 줄: 입력 %d(폴러 %d) · 셸 %d(기다림 %d) · 턴 %d · 컨텍스트 %.0fK" % (
        len(inputs), kinds["폴러"], len(calls), waits, len(tok), (l.get("input_tokens", 0) / 1e3) if tok else 0))

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: print(__doc__); sys.exit(1)
    files = [a[1]] if a[0] == "--file" else find_logs(a)
    if not files: print("로그를 못 찾았다:", a); sys.exit(1)
    for f in files[:3]: stats(f); print()
