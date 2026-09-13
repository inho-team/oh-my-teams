#!/usr/bin/env python3
"""인용 대조기 — 사원(gpt-oss)이 낸 {file, line, quote} 인용을 실제 파일과 대조한다. (2026-09-13)

사용:  cite-check.py <저장소 루트> <입력.json | ->      # JSON: [{"file":..,"line":N,"quote":"..", ...}] 또는 그 배열을 담은 텍스트(첫 [...] 블록)
출력:  stdout 에 검증된 항목만 JSON 으로(각 항목에 "verified": true, 실제 줄 번호 보정), stderr 에 떨어진 항목과 이유.
규칙:  파일이 있어야 하고, quote(공백 정규화)가 line 의 ±3줄 안에 부분 문자열로 있어야 한다. 있으면 line 을 실제 줄로 고친다.
왜:    사원의 말은 주장이다. 인용이 실제 파일과 맞을 때만 상위 자리(과장·대리·부장)에 올린다 — 요약을 믿는 대신 근거를 대조한다.
"""
import sys, json, os, re

def norm(s): return re.sub(r"\s+", " ", (s or "")).strip()

def load(arg):
    txt = sys.stdin.read() if arg == "-" else open(arg, encoding="utf-8", errors="replace").read()
    try:
        return json.loads(txt)
    except Exception:
        pass
    # 모델 출력에는 JSON 앞뒤로 말이 붙는다 — 첫 '[' 부터 완전한 배열 하나만 읽는다(코드 펜스 안이어도)
    dec = json.JSONDecoder()
    for m in re.finditer(r"\[", txt):
        try:
            obj, _ = dec.raw_decode(txt[m.start():])
            if isinstance(obj, list): return obj
        except Exception:
            continue
    raise SystemExit("🔴 JSON 배열을 찾지 못했다")

def check(root, items, tol=3):
    ok, bad = [], []
    for it in items:
        f = it.get("file") or ""; q = norm(it.get("quote"))
        try: ln = int(it.get("line") or 0)
        except Exception: ln = 0
        if f in ("-", "", None) and it.get("observation"):   # 인용 없는 '해당 없음' 행은 대조 대상이 아니다 — 그대로 통과(verified=False 표시)
            it = dict(it); it["verified"] = False; ok.append(it); continue
        p = f if os.path.isabs(f) else os.path.join(root, f)
        if not os.path.isfile(p): bad.append((it, "파일 없음")); continue
        if not q: bad.append((it, "quote 없음")); continue
        lines = open(p, encoding="utf-8", errors="replace").read().split("\n")
        hit = None
        cand = list(range(max(1, ln - tol), min(len(lines), ln + tol) + 1)) if ln else []
        for i in cand + [i for i in range(1, len(lines) + 1) if i not in cand]:
            if q in norm(lines[i - 1]) or (len(q) > 20 and norm(lines[i - 1]) in q and len(norm(lines[i - 1])) > 10):
                hit = i; break
        if hit is None: bad.append((it, "quote 가 파일에 없음")); continue
        if ln and abs(hit - ln) > tol: bad.append((it, "quote 는 있으나 %d행(주장 %d행)" % (hit, ln))); continue
        it = dict(it); it["line"] = hit; it["verified"] = True; ok.append(it)
    return ok, bad

if __name__ == "__main__":
    if len(sys.argv) < 3: print(__doc__); sys.exit(2)
    root, src = sys.argv[1], sys.argv[2]
    items = load(src)
    if isinstance(items, dict): items = items.get("items") or items.get("citations") or [items]
    ok, bad = check(root, items)
    for it, why in bad:
        print("❌ %s:%s — %s | %s" % (it.get("file"), it.get("line"), why, norm(it.get("quote"))[:80]), file=sys.stderr)
    print(json.dumps(ok, ensure_ascii=False, indent=1))
    print("검증 %d / 탈락 %d" % (len(ok), len(bad)), file=sys.stderr)
    sys.exit(0 if ok else 1)
