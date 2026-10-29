#!/usr/bin/env python3
"""Guarded one-shot sender to the 小家 bridge. Refuses to send the same (kind, date) twice.
Usage: xiaojia_send.py --kind attached_done --date 2026-10-29 --text "..."  [--force]
Ledger: /workspace/.secrets/xiaojia-sent.json. Never prints notify_url."""
import argparse, json, sys, time
from pathlib import Path
import requests
SEC = Path("/workspace/.secrets/xiaojia-ai-news-hook.json")
LEDGER = Path("/workspace/.secrets/xiaojia-sent.json")
ap = argparse.ArgumentParser()
ap.add_argument("--kind", required=True)   # ack | collected | attached_done
ap.add_argument("--date", required=True)
ap.add_argument("--text", required=True)
ap.add_argument("--force", action="store_true")
a = ap.parse_args()
led = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
key = f"{a.date}:{a.kind}"
if key in led and not a.force:
    print(json.dumps({"ok": True, "skipped": "already_sent", "key": key, "at": led[key]})); sys.exit(0)
url = json.loads(SEC.read_text())["notify_url"]
r = requests.post(url, json={"ok": True, "answer": a.text[:300]}, timeout=30)
if r.ok:
    led[key] = time.strftime("%Y-%m-%d %H:%M:%S")
    LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1)); LEDGER.chmod(0o600)
print(json.dumps({"ok": r.ok, "status": r.status_code, "key": key}))
sys.exit(0 if r.ok else 1)
