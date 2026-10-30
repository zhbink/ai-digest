#!/usr/bin/env python3
"""Guarded one-shot sender to the 小家 bridge. Refuses to send the same (kind, date) twice.

Usage: xiaojia_send.py --kind attached_done --date 2026-10-29 --text "..."  [--force]
Ledger: /workspace/.secrets/xiaojia-sent.json. Never prints notify_url.

Order rules (hard):
  - kind=ack|collected: text MUST NOT contain HANDOFF (handoff only after attached work is live)
  - kind=attached_done: last non-empty line MUST be exactly "HANDOFF: research"
"""
import argparse, json, sys, time
from pathlib import Path
import requests

SEC = Path("/workspace/.secrets/xiaojia-ai-news-hook.json")
LEDGER = Path("/workspace/.secrets/xiaojia-sent.json")
HANDOFF_LINE = "HANDOFF: research"
ALLOWED = {"ack", "collected", "attached_done"}

ap = argparse.ArgumentParser()
ap.add_argument("--kind", required=True)
ap.add_argument("--date", required=True)
ap.add_argument("--text", required=True)
ap.add_argument("--force", action="store_true")
a = ap.parse_args()

if a.kind not in ALLOWED:
    print(json.dumps({"ok": False, "error": "bad_kind", "allowed": sorted(ALLOWED)}), file=sys.stderr)
    sys.exit(2)

text = (a.text or "").strip()
lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
has_handoff = any("HANDOFF" in ln.upper() for ln in lines) or ("HANDOFF" in text.upper())

if a.kind in ("ack", "collected") and has_handoff:
    print(
        json.dumps(
            {
                "ok": False,
                "error": "handoff_forbidden_on_ack",
                "hint": "ack/collected must not include HANDOFF. Finish attached_posts + merge to main + verify live, then --kind attached_done with last line HANDOFF: research.",
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
    )
    sys.exit(3)

if a.kind == "attached_done":
    if not lines or lines[-1] != HANDOFF_LINE:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "attached_done_requires_handoff_last_line",
                    "hint": f'Last line of --text must be exactly "{HANDOFF_LINE}" (after live attached_posts).',
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        sys.exit(4)

led = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
key = f"{a.date}:{a.kind}"
if key in led and not a.force:
    print(json.dumps({"ok": True, "skipped": "already_sent", "key": key, "at": led[key]}))
    sys.exit(0)

url = json.loads(SEC.read_text())["notify_url"]
payload = text
if len(payload) > 300:
    if a.kind == "attached_done":
        body = "\n".join(lines[:-1])
        keep = HANDOFF_LINE
        budget = 300 - len(keep) - 1
        payload = (body[:budget].rstrip() + "\n" + keep) if budget > 0 else keep
    else:
        payload = payload[:300]

r = requests.post(url, json={"ok": True, "answer": payload}, timeout=30)
if r.ok:
    led[key] = time.strftime("%Y-%m-%d %H:%M:%S")
    LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))
    LEDGER.chmod(0o600)
print(json.dumps({"ok": r.ok, "status": r.status_code, "key": key}))
sys.exit(0 if r.ok else 1)
