#!/usr/bin/env python3
"""Merge one X search_posts_all (or get_users_posts) JSON page into work/seed/<date>.jsonl and users/media maps."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import WORK, save_json, load_json

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page_json")
    ap.add_argument("--date", required=True)
    ap.add_argument("--section", default="")
    ap.add_argument("--source", default="search")
    args = ap.parse_args()
    page = json.loads(Path(args.page_json).read_text(encoding="utf-8"))
    # unwrap MCP envelope if present
    if isinstance(page, dict) and "data" not in page and "result" in page:
        page = page["result"]
    seed_dir = WORK / "seed" / args.date
    seed_dir.mkdir(parents=True, exist_ok=True)
    out = seed_dir / "posts.jsonl"
    users_path = seed_dir / "users.json"
    media_path = seed_dir / "media.json"
    users = load_json(users_path, {}) or {}
    media = load_json(media_path, {}) or {}
    includes = page.get("includes") or {}
    for u in includes.get("users") or []:
        users[str(u.get("id"))] = u
    for m in includes.get("media") or []:
        media[m.get("media_key")] = m
    # also index included tweets
    tweets_extra = {str(t["id"]): t for t in (includes.get("tweets") or []) if t.get("id")}
    n = 0
    with out.open("a", encoding="utf-8") as f:
        for p in page.get("data") or []:
            row = {
                "section_hint": args.section,
                "source": args.source,
                "post": p,
                "included_tweet_ids": [r.get("id") for r in (p.get("referenced_tweets") or [])],
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
        for tid, t in tweets_extra.items():
            # store referenced for later enrichment only if not already primary
            pass
    save_json(users_path, users)
    save_json(media_path, media)
    # save referenced tweets map
    ref_path = seed_dir / "referenced.json"
    refs = load_json(ref_path, {}) or {}
    refs.update(tweets_extra)
    save_json(ref_path, refs)
    meta = load_json(seed_dir / "meta.json", {"pages": 0, "posts": 0}) or {"pages": 0, "posts": 0}
    meta["pages"] = meta.get("pages", 0) + 1
    meta["posts"] = meta.get("posts", 0) + n
    meta["last_source"] = args.source
    save_json(seed_dir / "meta.json", meta)
    print(json.dumps({"merged": n, "users": len(users), "media": len(media), "total_posts": meta["posts"]}, ensure_ascii=False))

if __name__ == "__main__":
    main()
