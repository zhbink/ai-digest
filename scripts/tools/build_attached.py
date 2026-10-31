#!/usr/bin/env python3
"""Build work/raw/<date>/attached-<parent_id>.json from X API-ish post dicts + zh fields.

Usage:
  python3 scripts/tools/build_attached.py --date 2026-10-31 --parent ID --picks picks.json
where picks.json is {"attached_posts":[ {...already shaped...} ]} OR
  {"picks":[{"id":"...","summary_zh":"...","relation_zh":"...","raw":{X post}}, ...]}

Also accepts a raw X get_posts / search page via --from-x-page and --pick-ids.
"""
from __future__ import annotations
import argparse, json, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

def media_from_includes(post, includes):
    media_list = []
    types = []
    mid_list = (post.get("attachments") or {}).get("media_keys") or []
    by_key = {m.get("media_key"): m for m in (includes or {}).get("media") or []}
    for mk in mid_list:
        m = by_key.get(mk) or {}
        t = m.get("type") or "photo"
        types.append(t)
        entry = {"type": t, "w": m.get("width"), "h": m.get("height"), "alt": m.get("alt_text")}
        if t == "photo":
            entry["orig"] = m.get("url")
            entry["src"] = None
        else:
            entry["mp4"] = None
            variants = (m.get("variants") or [])
            mp4s = [v for v in variants if v.get("content_type") == "video/mp4" and v.get("url")]
            mp4s.sort(key=lambda v: v.get("bit_rate") or 0, reverse=True)
            if mp4s:
                entry["mp4"] = mp4s[0]["url"]
            entry["poster"] = m.get("preview_image_url")
            entry["duration_ms"] = m.get("duration_ms")
        media_list.append(entry)
    return media_list, types

def user_for(post, includes):
    users = {u["id"]: u for u in (includes or {}).get("users") or []}
    return users.get(post.get("author_id")) or {}

def shape_post(post, includes, summary_zh, relation_zh, attached_at=None):
    u = user_for(post, includes)
    media, mtypes = media_from_includes(post, includes)
    pm = post.get("public_metrics") or {}
    ents = post.get("entities") or {}
    links = []
    for url in ents.get("urls") or []:
        links.append(url.get("unwound_url") or url.get("expanded_url") or url.get("url"))
    links = [x for x in links if x]
    hashtags = [h.get("tag") for h in ents.get("hashtags") or [] if h.get("tag")]
    mentions = [m.get("username") for m in ents.get("mentions") or [] if m.get("username")]
    quoted = None
    for ref in post.get("referenced_tweets") or []:
        if ref.get("type") == "quoted":
            quoted = f"https://x.com/i/status/{ref['id']}"
            break
    handle = u.get("username") or "unknown"
    pid = post["id"]
    return {
        "id": pid,
        "url": f"https://x.com/{handle}/status/{pid}",
        "handle": handle,
        "display_name": u.get("name") or handle,
        "avatar": (u.get("profile_image_url") or "").replace("_normal", "_normal"),
        "verified": bool(u.get("verified") or u.get("verified_type")),
        "followers": (u.get("public_metrics") or {}).get("followers_count"),
        "created_at": post.get("created_at"),
        "lang": post.get("lang"),
        "text": post.get("text") or post.get("note_tweet", {}).get("text") or "",
        "text_zh": None,
        "summary_zh": summary_zh,
        "relation_zh": relation_zh,
        "metrics": {
            "likes": pm.get("like_count") or 0,
            "retweets": pm.get("retweet_count") or 0,
            "replies": pm.get("reply_count") or 0,
            "quotes": pm.get("quote_count") or 0,
            "bookmarks": pm.get("bookmark_count") or 0,
            "views": pm.get("impression_count") or 0,
        },
        "media": media,
        "media_types": mtypes,
        "links": links,
        "hashtags": hashtags,
        "mentions": mentions,
        "quoted_post_url": quoted,
        "article_title": None,
        "attached_at": attached_at or datetime.now(timezone.utc).isoformat(),
    }

def media_rank(p):
    mt = set(p.get("media_types") or [])
    if "video" in mt or "animated_gif" in mt:
        return 0
    if "photo" in mt:
        return 1
    return 2

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--parent", required=True)
    ap.add_argument("--picks")  # json file with attached_posts already shaped, or picks with raw
    ap.add_argument("--from-x-page")
    ap.add_argument("--pick-meta")  # json {id: {summary_zh, relation_zh}}
    args = ap.parse_args()
    out_dir = ROOT / "work" / "raw" / args.date
    out_dir.mkdir(parents=True, exist_ok=True)
    attached = []
    if args.picks:
        payload = json.load(open(args.picks))
        if "attached_posts" in payload:
            attached = payload["attached_posts"]
        else:
            page = payload.get("x_page") or {}
            includes = page.get("includes") or payload.get("includes") or {}
            by_id = {t["id"]: t for t in (page.get("data") or payload.get("data") or [])}
            # also include referenced tweets if present as list
            for t in (includes.get("tweets") or includes.get("posts") or []):
                by_id.setdefault(t["id"], t)
            for pick in payload.get("picks") or []:
                if "url" in pick and "summary_zh" in pick and "id" in pick and "metrics" in pick:
                    attached.append(pick)
                    continue
                raw = pick.get("raw") or by_id.get(pick["id"])
                if not raw:
                    raise SystemExit(f"missing raw for {pick.get('id')}")
                attached.append(shape_post(raw, includes, pick["summary_zh"], pick["relation_zh"]))
    elif args.from_x_page and args.pick_meta:
        page = json.load(open(args.from_x_page))
        meta = json.load(open(args.pick_meta))
        includes = page.get("includes") or {}
        by_id = {}
        data = page.get("data")
        if isinstance(data, dict):
            by_id[data["id"]] = data
        else:
            for t in data or []:
                by_id[t["id"]] = t
        for t in (includes.get("tweets") or includes.get("posts") or []):
            by_id.setdefault(t["id"], t)
        for pid, m in meta.items():
            raw = by_id.get(pid)
            if not raw:
                raise SystemExit(f"id {pid} not in page")
            attached.append(shape_post(raw, includes, m["summary_zh"], m["relation_zh"]))
    else:
        raise SystemExit("need --picks or --from-x-page + --pick-meta")
    # prefer video>image>text order already; stable sort by media then keep order
    attached = sorted(attached, key=media_rank)
    path = out_dir / f"attached-{args.parent}.json"
    json.dump({"attached_posts": attached}, path.open("w"), ensure_ascii=False, indent=2)
    path.write_text(path.read_text() + ("" if path.read_text().endswith("\n") else "\n"))
    print(json.dumps({"ok": True, "path": str(path), "n": len(attached), "ids": [a["id"] for a in attached]}, ensure_ascii=False))

if __name__ == "__main__":
    main()
