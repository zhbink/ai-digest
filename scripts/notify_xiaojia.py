#!/usr/bin/env python3
"""POST short Chinese digest notice to 小家 bridge. Never prints notify_url."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, WORKSPACE_SECRETS, load_json

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    sec = load_json(WORKSPACE_SECRETS / "xiaojia-ai-news-hook.json")
    if not sec or not sec.get("notify_url"):
        print(json.dumps({"ok": False, "error": "missing_notify_url"})); sys.exit(2)
    day = load_json(DATA / "days" / f"{args.date}.json")
    if not day or not day.get("posts"):
        print(json.dumps({"ok": True, "skipped": "no_posts"})); return
    stats = day.get("stats") or {}
    by = stats.get("by_section") or {}
    n = stats.get("posts") or len(day["posts"])
    rec = stats.get("recommended") or 0
    # direction from sections with most posts
    labels = {"agent":"Agent","models":"模型","coding":"编程","creative":"创意","industry":"算力融资","zh":"中文圈","video":"视频"}
    tops = sorted(((labels.get(k,k), v) for k,v in by.items() if v), key=lambda x: -x[1])[:3]
    direction = "、".join(f"{k}{v}条" for k,v in tops) if tops else "综合"
    trend = (day.get("trend_summary") or "")[:80]
    answer = (
        f"【AI日报 {args.date}】今日收录 {n} 条（推荐 {rec}）。主要方向：{direction}。"
        f"{trend}"
        f" 请打开 AI 日报挑收藏；收藏完在群里 @Grok 资讯员 说一声。"
    )
    answer = answer[:300]
    body = {"ok": True, "answer": answer}
    if args.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "answer": answer}, ensure_ascii=False)); return
    r = requests.post(sec["notify_url"], json=body, timeout=30)
    print(json.dumps({"ok": r.ok, "status": r.status_code, "answer_len": len(answer)}, ensure_ascii=False))
    if not r.ok:
        sys.exit(1)

if __name__ == "__main__":
    main()
