#!/usr/bin/env python3
"""
Attached-posts MVP for followed items.
Modes: plan | apply
plan — given follows export or CF backup, list posts needing attached_posts
apply — merge work/raw/<date>/attached-<id>.json picks into day JSON and/or follows export
Full search/pick still agent-driven (video>image>text, ~3 related).
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, WORK, load_json, save_json, SECRETS, WORKSPACE_SECRETS

def plan(date: str):
    # Prefer local follows snapshot if present
    follows = None
    for p in [WORK / "follows" / "latest.json", DATA / "follows-backup.json"]:
        if p.exists():
            follows = load_json(p)
            break
    items = []
    if follows and isinstance(follows, dict):
        for it in follows.get("items") or []:
            if it.get("date") == date and not it.get("attached_posts"):
                items.append({"id": it["id"], "handle": it.get("handle"), "title": it.get("title") or it.get("summary_zh")})
    out = WORK / "plans" / f"{date}-attached.json"
    save_json(out, {"date": date, "items": items, "note": "Agent: search related posts, prefer video>image>text, ~3 each, save raw then apply"})
    print(json.dumps({"plan": str(out), "n": len(items)}))

def apply(date: str):
    day_path = DATA / "days" / f"{date}.json"
    day = load_json(day_path)
    if not day:
        print("no day"); sys.exit(1)
    by_id = {p["id"]: p for p in day.get("posts") or []}
    raw_dir = WORK / "raw" / date
    n = 0
    for path in sorted(raw_dir.glob("attached-*.json")):
        pid = path.stem.replace("attached-", "")
        payload = load_json(path)
        picks = payload.get("attached_posts") or payload.get("picks") or []
        if pid in by_id:
            by_id[pid]["attached_posts"] = picks
            n += 1
    save_json(day_path, day)
    print(json.dumps({"applied": n}))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["plan", "apply"])
    ap.add_argument("--date", required=True)
    args = ap.parse_args()
    if args.mode == "plan":
        plan(args.date)
    else:
        apply(args.date)

if __name__ == "__main__":
    main()
