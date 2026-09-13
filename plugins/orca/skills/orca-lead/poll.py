#!/usr/bin/env python3
"""orca-lead 폴러 — 코디네이터를 **실제로 깨우는** 감시기.

사용:  python3 poll.py --run <run_id> --handles <handles.txt> [--seen <seen.txt>] [--max-min 20]
       (Claude Code 에서는 Bash run_in_background=true 로 띄운다 — 종료가 곧 알림이다)
  또는 python3 poll.py --run <run_id> --handles <handles.txt> --wake <PL 터미널 핸들> --loop
       (2026-09-12 폴러 역전: PL 워크트리의 POLLER 터미널에서 계속 돌며, 사건이 생기면 PL 터미널에 한 줄을 **보내** 깨운다.
        PL(codex)은 폴러를 부르지 않는다 — 턴이 끝나면 프롬프트에서 멈추는 성질이 그대로 장점이 된다.
        launch-worker.sh 의 codex 분기가 이 모드로 POLLER 를 자동으로 띄운다.)

handles.txt 한 줄 형식:  <워크트리이름>:<term_handle> [(메모)] [done <시각>]   — done 줄은 건너뛴다
종료(=깨움) 조건:  (1) 메일박스에 새 메시지  (2) 열린 PR 집합 변화
                  (3) 워커 터미널에 에이전트 상태줄이 없거나 TUI 메뉴에서 멈춤  (4) max-min 경과
왜 이렇게 하나: nohup 으로 띄운 폴러는 코디네이터를 못 깨운다. 하네스의 백그라운드 명령은 끝나면
코디네이터에게 알림이 간다 — 그래서 "발견하면 종료" 가 곧 "깨운다" 다.
"""
import argparse, json, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--run", required=True)
ap.add_argument("--handles", required=True)
ap.add_argument("--seen", default="/tmp/orca-lead-seen.txt")
ap.add_argument("--interval", type=int, default=60)
ap.add_argument("--max-min", type=int, default=20)
ap.add_argument("--no-pr", action="store_true", help="열린 PR 변화로는 깨우지 않는다(PM 은 PL 의 보고로만 깬다)")
ap.add_argument("--wake", default="", help="사건이 생기면 종료하지 않고 이 터미널(PL)에 한 줄을 보내 깨운다")
ap.add_argument("--loop", action="store_true", help="max-min 이 지나도 끝내지 않고 계속 돈다(--wake 와 함께 쓴다)")
ap.add_argument("--environment", default="", help="orca --environment (원격 PL 일 때)")
ap.add_argument("--bundle-dir", default="/tmp", help="--wake 모드: 메일 본문을 파일로 저장할 곳(PL 은 check JSON 덤프 대신 이 파일만 읽는다)")
a = ap.parse_args()
ENVOPT = ["--environment", a.environment] if a.environment else []

# 에이전트가 살아 있다는 직접 신호(상태줄). 프록시 신호(터미널 running)는 쓰지 않는다.
ALIVE = ("Model:", "bypass permissions",      # Claude Code
         "Gemini", "Antigravity", "shortcuts", # agy(Antigravity CLI)
         "Ask Codex", "gpt-5",                 # codex(orca-lead 리드) — 2026-09-12 실측: 없으면 리드를 죽은 것으로 오판
         "Compacting context", "Working")      # codex 가 컨텍스트 압축 중이면 상태줄이 잠시 사라진다(2026-09-13 실측 거짓 경보)
# 사람 입력을 기다리는 TUI 메뉴 — 워커가 여기서 멈추면 아무것도 안 온다.
MENU = ("Enter to select", "Esc to cancel", "Run this command?", "Navigate", "Do you trust", "Update available",
        "at capacity", "quota reached", "usage limit")  # 모델 한도로 멈춘 것 — 상태줄은 살아 있어 이 문구로만 잡힌다(실측: 두 워커가 한 시간 멈춤)
# agy 만족도 설문("How's the CLI experience") 은 작업을 막지 않는다 — 워커가 계속 돈다. 깨울 일이 아니다.

def sh(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return ""

PENDING = []      # --wake 모드: 60초 안에 모인 사건을 한 번에 보낸다(실측: 메일+PR 변화가 11초 간격으로 두 번 깨웠다)
PENDING_AT = 0.0
DEBOUNCE = 60

def wake(reason, lines=()):
    """사건을 PL 에게 알린다. --wake 가 없으면 종료(=하네스 알림), 있으면 모아 두었다가 PL 터미널에 한 줄을 보내고 계속 돈다.
    PL 이 턴 중이면 TUI 가 입력을 큐에 넣는다(codex·claude 둘 다) — 잃어버리지 않는다."""
    global PENDING_AT
    print("[폴러] " + reason + " — 깨운다", flush=True)
    for l in lines:
        print("  ·", l, flush=True)
    if not a.wake:
        sys.exit(0)
    if not PENDING:
        PENDING_AT = time.time()
    PENDING.append(reason + (" / " + "; ".join(lines) if lines else ""))

def flush_wake():
    """모인 사건이 있고 DEBOUNCE 가 지났으면 한 줄로 보낸다."""
    global PENDING
    if not PENDING or time.time() - PENDING_AT < DEBOUNCE:
        return
    body = "[폴러 %s] %s. 메일 본문은 위 파일을 읽어라(check --json 덤프를 읽지 마라). 답신은 orca orchestration reply --run %s --id <id> --body \"$(cat 파일)\". 처리 뒤 프롬프트에서 멈춰도 된다 — 다음 사건은 폴러가 다시 깨운다." % (
        time.strftime("%H:%M"), " || ".join(PENDING), a.run)
    PENDING = []
    out = subprocess.run(["orca", "terminal", "send"] + ENVOPT + ["--terminal", a.wake, "--text", body, "--enter", "--json"],
                         capture_output=True, text=True, timeout=60).stdout
    if '"ok": true' not in out:
        print("[폴러] 🔴 PL 터미널에 보내기 실패 — 종료해서 PM 을 깨운다:", out[:300], flush=True)
        sys.exit(1)

def seen_ids():
    try:
        return set(x.strip() for x in open(a.seen) if x.strip())
    except Exception:
        return set()

def remember(ids):
    # 덧붙이기만 한다 — 다시 쓰다가 읽기가 한 번 실패하면 기록이 통째로 사라진다(실측: 56건이 다시 "새 것" 이 됐다).
    with open(a.seen, "a") as f:
        for i in ids:
            f.write(i + "\n")

def mailbox():
    """새 메시지만. --ack 이 읽음 표시를 안 하는 경우가 있어 본 id 를 파일로 기억한다.
    `check --run` 은 그 Run 의 코디네이터 터미널에서만 된다 — 다른 터미널(POLLER)에서는 consumer_fenced(실측 2026-09-12).
    그때는 `inbox --json`(수신자 무관, run_id 필드 있음)으로 run_id 를 걸러 읽는다."""
    out = sh(["orca", "orchestration", "check", "--run", a.run, "--peek", "--json"])
    ms = None
    try:
        d = json.loads(out)
        if d.get("ok"):
            ms = (d.get("result") or {}).get("messages") or []
    except Exception:
        pass
    if ms is None:
        out = sh(["orca", "orchestration", "inbox", "--limit", "200", "--json"])
        try:
            d = json.loads(out); r = d.get("result") or {}
            ms = [m for m in (r.get("messages") or r.get("items") or []) if m.get("run_id") == a.run]
        except Exception:
            return []
    fresh = [m for m in ms if m.get("id") not in seen_ids()]
    if fresh:
        remember(m.get("id") for m in fresh)
    return fresh

def open_prs():
    out = sh(["gh", "pr", "list", "--state", "open", "--json", "number", "--limit", "50"])
    try:
        return sorted(p["number"] for p in json.loads(out))
    except Exception:
        return None

def handles():
    hs = []
    try:
        lines = list(open(a.handles))
    except Exception as e:
        print("[폴러] 핸들 파일 읽기 실패:", e); return hs
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or " done " in line:
            continue  # finish-worker.sh 가 내린 워커(done 표기)는 감시하지 않는다
        name, rest = line.split(":", 1)
        h = rest.split()[0].strip()
        if not h.startswith("term_"):
            continue  # 인턴(intern-run.sh)은 터미널이 없다 — 상태줄 검사 대상이 아니다
        hs.append((name.strip(), h))
    return hs

def terminals_alive():
    bad = []
    for name, h in handles():
        out = sh(["orca", "terminal", "read"] + ENVOPT + ["--terminal", h, "--screen", "--json"])
        try:
            t = "\n".join(json.loads(out)["result"]["terminal"].get("tail") or [])
        except Exception:
            bad.append((name, "터미널 읽기 실패")); continue
        if "screen-unavailable" in out or not t.strip():
            continue  # 렌더 화면을 못 받은 것 — 부재의 증거가 아니다(도는 중에도 난다)
        # 안내 문구 오탐 제외(실측 2026-09-13): codex 의 "You have 1 usage limit reset available. Run /usage" 는 막힘이 아니다
        t_menu = "\n".join(l for l in t.split("\n") if "reset available" not in l)
        if not any(k in t for k in ALIVE):
            bad.append((name, "에이전트 상태줄이 없다 — 빈 셸이거나 죽었다"))
        elif any(k in t_menu for k in MENU):
            bad.append((name, "TUI 메뉴에서 사람 입력을 기다린다"))
    return bad

import traceback
base = open_prs()
print("[폴러] 시작 — run=%s 열린 PR 기준선: %s 워커 %d" % (a.run, base, len(handles())), flush=True)
deadline = time.time() + a.max_min * 60
tick = 0; last_bad = []
if a.loop and not a.wake:
    print("[폴러] --loop 는 --wake 와 함께 써야 한다(깨울 곳이 없으면 무한 루프가 된다)"); sys.exit(2)
while a.loop or time.time() < deadline:
    try:
        ms = mailbox()
        if ms:
            # 2026-09-13: PL 컨텍스트 다이어트 — 본문을 파일로 저장하고 경로 + ✅/🔴 집계만 알린다.
            # (실측: PL 이 check --json 덤프를 통째로 읽어 턴당 100K 가 됐다)
            lines = []
            for m in ms:
                body = m.get("body") or ""
                path = "%s/bundle-%s-%s.md" % (a.bundle_dir, a.run, (m.get("id") or "x")[-8:])
                try:
                    with open(path, "w", encoding="utf-8") as f:
                        f.write("# %s\n(type=%s from=%s id=%s)\n\n%s" % (m.get("subject") or "", m.get("type"), m.get("from_handle"), m.get("id"), body))
                except Exception:
                    path = "(저장 실패)"
                tally = "✅%d 🔴%d ⚠️%d" % (body.count("✅"), body.count("🔴"), body.count("⚠️"))
                lines.append("%s | %s | id=%s | %s | 본문 %s" % (m.get("type"), (m.get("subject") or "")[:70], m.get("id"), tally, path))
            wake("메일박스 %d건" % len(ms), lines)
        prs = None if a.no_pr else open_prs()
        if prs is not None and base is not None and prs != base:
            new = [n for n in prs if n not in base]
            if new:   # 새로 열린 것만 사건이다. 닫힘은 남의 PR 머지·PM 의 머지라 PL 이 할 일이 없다(실측: 무관한 깨움 2건)
                wake("새 PR: %s (전체 %s)" % (new, prs))
            base = prs
        tick += 1
        if tick % 2 == 0:
            bad = terminals_alive()
            if bad and bad != last_bad:   # 같은 워커·같은 이유로는 한 번만 깨운다(--wake 모드에서 매 틱 반복 방지)
                wake("🔴 손봐야 할 워커", ["%s — %s" % (n, why) for n, why in bad])
            last_bad = bad
        if a.loop and time.time() >= deadline:
            if handles():   # 살아 있는 워커가 없으면(전부 done) 조용한 게 정상이다 — 깨우지 않는다(실측: 보고 뒤에 한 번 더 깨웠다)
                wake("%d분 조용했다 — 워커 화면(read --screen)을 직접 봐라: 상태줄은 살아 있는데 '확인해 주세요' 하고 기다리는 것은 폴러가 못 잡는다" % a.max_min)
            deadline = time.time() + a.max_min * 60
        flush_wake()
    except SystemExit:
        raise
    except Exception:
        print("[폴러] 🔴 폴러 자체 오류:\n" + traceback.format_exc()[-800:], flush=True)
        if not a.wake:
            sys.exit(0)
    time.sleep(a.interval)
print("[폴러] %d분 조용했다 — 워커 화면을 직접 보고 다시 띄워라" % a.max_min)
