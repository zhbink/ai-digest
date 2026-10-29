#!/usr/bin/env python3
"""Backup follows/comments from Cloudflare Worker using CF_DIGEST_ACCESS_KEY."""
from __future__ import annotations
import json, os, sys
from pathlib import Path
from datetime import datetime, timezone
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, WORK, SECRETS, WORKSPACE_SECRETS, save_json, load_json

BASE = "https://ai-digest-sync.zhbink.workers.dev"

def load_key() -> str | None:
    for p in [SECRETS / "sync.json", WORKSPACE_SECRETS / "sync.json", ROOT / ".secrets" / "sync.json"]:
        if p.exists():
            d = load_json(p) or {}
            return d.get("CF_DIGEST_ACCESS_KEY") or d.get("access_key")
    return os.environ.get("CF_DIGEST_ACCESS_KEY")

def main():
    key = load_key()
    if not key:
        print(json.dumps({"ok": False, "error": "missing_CF_DIGEST_ACCESS_KEY", "hint": "put key in /workspace/ai-digest-app/.secrets/sync.json"}))
        sys.exit(2)
    headers = {"Authorization": f"Bearer {key}", "User-Agent": "Mozilla/5.0 ai-digest-backup", "Accept": "application/json", "Origin": "https://zhbink.github.io", "Referer": "https://zhbink.github.io/ai-digest/"}
    # try common endpoints
    for path in ["/today", "/state", "/api/follows", "/follows", "/backup", "/api/backup"]:
        try:
            r = requests.get(BASE + path, headers=headers, timeout=60)
            if r.status_code == 404:
                continue
            r.raise_for_status()
            data = r.json()
            out_dir = WORK / "follows"
            out_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            save_json(out_dir / f"backup-{ts}.json", data)
            save_json(out_dir / "latest.json", data)
            print(json.dumps({"ok": True, "path": path, "saved": str(out_dir / "latest.json")}))
            return
        except Exception as e:
            last = str(e)
            continue
    print(json.dumps({"ok": False, "error": "all_endpoints_failed", "last": last if "last" in dir() else None}))
    sys.exit(1)

if __name__ == "__main__":
    main()
