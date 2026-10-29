#!/usr/bin/env python3
"""
Apply replies into day JSON.
Modes:
  plan  — write work/plans/<date>-replies.json with post ids needing replies
  apply — merge work/raw/<date>/replies-<id>.json pages into day posts
Agent is expected to fetch conversation replies via X search (conversation_id:ID -is:reply OR is:reply) and save pages.
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, WORK, load_json, save_json, is_chinese

def plan(date: str):
    day = load_json(DATA / "days" / f"{date}.json")
    items = []
    for p in day.get("posts") or []:
        if p.get("top_replies"):
            continue
        items.append({"id": p["id"], "handle": p["handle"], "replies_count": (p.get("metrics") or {}).get("replies") or 0})
    out = WORK / "plans" / f"{date}-replies.json"
    save_json(out, {"date": date, "posts": items})
    print(json.dumps({"plan": str(out), "n": len(items)}))

def apply(date: str):
    day = load_json(DATA / "days" / f"{date}.json")
    raw_dir = WORK / "raw" / date
    by_id = {p["id"]: p for p in day.get("posts") or []}
    with_replies = 0
    with_summary = 0
    for p in day.get("posts") or []:
        path = raw_dir / f"replies-{p['id']}.json"
        if not path.exists():
            # keep empty MVP summary
            if not p.get("discussion_summary"):
                p["discussion_summary"] = "暂无回复。" if not ((p.get("metrics") or {}).get("replies") or 0) else "评论区较活跃，详情见原帖。"
                with_summary += 1
            continue
        page = load_json(path)
        users = {str(u["id"]): u for u in ((page.get("includes") or {}).get("users") or [])}
        replies = []
        for tw in page.get("data") or []:
            # skip the root tweet itself
            if str(tw.get("id")) == str(p["id"]):
                continue
            u = users.get(str(tw.get("author_id"))) or {}
            text = tw.get("text") or ""
            item = {
                "id": str(tw.get("id")),
                "handle": u.get("username") or "",
                "name": u.get("name") or "",
                "verified": bool(u.get("verified")),
                "text": text,
                "lang": tw.get("lang") or "",
                "like_count": (tw.get("public_metrics") or {}).get("like_count") or 0,
                "reply_count": (tw.get("public_metrics") or {}).get("reply_count") or 0,
                "created_at": tw.get("created_at"),
                "url": tw.get("url") or f"https://x.com/{u.get('username')}/status/{tw.get('id')}",
                "direct": True,
                "text_zh": text if is_chinese(text) else None,
            }
            replies.append(item)
        replies.sort(key=lambda r: r["like_count"], reverse=True)
        p["top_replies"] = replies[:5]
        p["replies_seen"] = len(replies)
        p["replies_fetched_at"] = datetime.now(timezone.utc).isoformat()
        if replies:
            with_replies += 1
            # naive discussion summary
            tops = "；".join((r.get("text_zh") or r["text"])[:60] for r in replies[:3])
            p["discussion_summary"] = f"热门评论：{tops}" if tops else "有讨论。"
        else:
            p["discussion_summary"] = p.get("discussion_summary") or "暂无回复。"
        with_summary += 1
    day.setdefault("stats", {})["replies"] = {
        "posts": len(day.get("posts") or []),
        "with_replies": with_replies,
        "with_summary": with_summary,
    }
    save_json(DATA / "days" / f"{date}.json", day)
    print(json.dumps(day["stats"]["replies"], ensure_ascii=False))

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
