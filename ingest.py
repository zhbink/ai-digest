#!/usr/bin/env python3
"""
Build data/days/<date>.json from work/seed/<date>/ posts.jsonl (+ users/media maps).
Also fetches simple external article stubs when links look like papers/blogs.
Translations via deep-translator (Google) when text is non-Chinese.
"""
from __future__ import annotations
import argparse, json, re, sys, time, html
from pathlib import Path
from urllib.parse import urlparse
import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
from common import (
    ROOT, DATA, WORK, load_json, save_json, load_sections, passes_heat,
    detect_kinds, primary_kind, KIND_LABELS, short_text, expand_urls,
    strip_media_urls, score_heuristic, is_chinese, best_mp4, now_utc, article_path,
)

UA = {"User-Agent": "Mozilla/5.0 (compatible; ai-digest/1.0)"}

def translate(text: str) -> str | None:
    if not text or is_chinese(text):
        return None
    try:
        from deep_translator import GoogleTranslator
        # chunk
        chunks = []
        buf = text
        while buf:
            part, buf = buf[:4500], buf[4500:]
            chunks.append(GoogleTranslator(source="auto", target="zh-CN").translate(part))
            time.sleep(0.15)
        return "".join(chunks)
    except Exception as e:
        return None

def summarize_zh(text_zh: str, max_sentences=4) -> str:
    if not text_zh:
        return ""
    # naive: first ~280 chars of Chinese
    t = re.sub(r"\s+", " ", text_zh).strip()
    if len(t) <= 160:
        return t
    # cut at sentence
    for sep in ["。", "！", "？", ". ", "\n"]:
        parts = t.split(sep)
        if len(parts) > 1:
            out = ""
            for p in parts:
                if not p.strip():
                    continue
                add = p.strip() + ("。" if sep in "。！？" else sep)
                if len(out) + len(add) > 220:
                    break
                out += add
            if out:
                return out.strip()
    return t[:220].rstrip() + "…"

def media_from_post(post: dict, media_map: dict) -> list[dict]:
    keys = ((post.get("attachments") or {}).get("media_keys")) or []
    out = []
    for k in keys:
        m = media_map.get(k) or {}
        mtype = m.get("type") or "photo"
        item = {"key": k, "type": mtype, "w": m.get("width"), "h": m.get("height")}
        if mtype == "photo":
            item["orig"] = m.get("url")
        else:
            item["orig"] = m.get("preview_image_url") or m.get("url")
            item["mp4"] = best_mp4(m.get("variants"))
            item["duration_ms"] = m.get("duration_ms")
        if item.get("orig"):
            out.append(item)
    return out

def pick_external_url(text: str, entities: dict | None) -> str | None:
    urls = []
    for u in (entities or {}).get("urls") or []:
        exp = u.get("expanded_url") or u.get("url")
        if not exp:
            continue
        if re.search(r"(pic\.x\.com|x\.com/.*/status/.*/(photo|video)|twitter\.com/.*/status/.*/(photo|video))", exp):
            continue
        urls.append(exp)
    for u in urls:
        if "arxiv.org" in u or "github.com" in u:
            return u
    return urls[0] if urls else None

def fetch_article(url: str, post_id: str) -> dict | None:
    try:
        if "arxiv.org/abs/" in url:
            abs_id = url.rstrip("/").split("/")[-1]
            html_url = f"https://arxiv.org/abs/{abs_id}"
            r = requests.get(html_url, headers=UA, timeout=30)
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "lxml")
            title = (soup.select_one("h1.title") or soup.title)
            title = title.get_text(" ", strip=True).replace("Title:", "").strip() if title else abs_id
            abstr = soup.select_one("blockquote.abstract")
            abstr_txt = abstr.get_text(" ", strip=True).replace("Abstract:", "").strip() if abstr else ""
            md = f"# {title}\n\n{abstr_txt}\n\nSource: {html_url}\n"
            return {
                "id": post_id, "post_id": post_id, "title": title, "source": html_url,
                "html": f"<h1>{html.escape(title)}</h1><p>{html.escape(abstr_txt)}</p>",
                "markdown": md, "images": [], "kind": "paper",
                "fetched_at": now_utc().isoformat(),
            }
        if "github.com" in url and url.count("/") >= 4:
            r = requests.get(url, headers=UA, timeout=30)
            if r.ok:
                soup = BeautifulSoup(r.text, "lxml")
                title = (soup.select_one("strong[itemprop=name] a") or soup.title)
                title = title.get_text(" ", strip=True) if title else url
                desc = soup.select_one("p.f4") or soup.select_one("meta[name=description]")
                desc_txt = desc.get("content") if desc and desc.name == "meta" else (desc.get_text(" ", strip=True) if desc else "")
                return {
                    "id": post_id, "post_id": post_id, "title": title, "source": url,
                    "html": f"<h1>{html.escape(title)}</h1><p>{html.escape(desc_txt or '')}</p>",
                    "markdown": f"# {title}\n\n{desc_txt}\n", "images": [], "kind": "repo",
                    "fetched_at": now_utc().isoformat(),
                }
    except Exception:
        return None
    return None

def build_post(row: dict, users: dict, media_map: dict, section: str, cfg: dict) -> dict | None:
    p = row["post"]
    pid = str(p["id"])
    author_id = str(p.get("author_id") or "")
    user = users.get(author_id) or {}
    handle = user.get("username") or "unknown"
    metrics_src = p.get("public_metrics") or {}
    metrics = {
        "likes": metrics_src.get("like_count") or 0,
        "reposts": metrics_src.get("retweet_count") or 0,
        "replies": metrics_src.get("reply_count") or 0,
        "bookmarks": metrics_src.get("bookmark_count") or 0,
        "impressions": metrics_src.get("impression_count") or 0,
    }
    if not passes_heat(section, metrics["likes"], metrics["impressions"], handle, cfg):
        return None
    note = p.get("note_tweet") or {}
    note_text = note.get("text") if isinstance(note, dict) else None
    text = note_text or p.get("text") or ""
    entities = (note.get("entities") if isinstance(note, dict) and note.get("entities") else None) or p.get("entities") or {}
    text = strip_media_urls(expand_urls(text, entities))
    media = media_from_post(p, media_map)
    media_types = [m["type"] for m in media]
    article_obj = p.get("article")
    is_article = bool(article_obj) or bool(note_text)
    external_url = pick_external_url(text, entities)
    kinds = detect_kinds(text, media_types, is_article, external_url, len(note_text or ""))
    kind = primary_kind(kinds)
    avatar = (user.get("profile_image_url") or "").replace("_normal.", "_bigger.")
    post = {
        "id": pid,
        "section": section,
        "handle": handle,
        "display_name": user.get("name") or handle,
        "avatar": avatar,
        "text": text,
        "text_short": short_text(text),
        "text_zh": None,
        "summary_zh": None,
        "created_at": p.get("created_at"),
        "metrics": metrics,
        "post_url": p.get("url") or f"https://x.com/{handle}/status/{pid}",
        "entities": entities,
        "media": media,
        "media_types": media_types,
        "kind": kind,
        "kinds": kinds,
        "kind_label": KIND_LABELS.get(kind, "帖子"),
        "kind_override": None,
        "rec_score": 0,
        "recommended": False,
        "rec_reason": "",
        "discussion_summary": "",
        "top_replies": [],
        "replies_fetched_at": None,
        "replies_seen": 0,
        "article_id": None,
        "is_article": is_article,
        "external_url": external_url,
        "note_tweet": note if note else None,
        "x_long": bool(note_text) or bool(article_obj),
    }
    return post

def assign_section(row: dict, users: dict, cfg: dict) -> str | None:
    hint = row.get("section_hint") or ""
    p = row["post"]
    user = users.get(str(p.get("author_id") or "")) or {}
    handle = (user.get("username") or "").lower()
    # map handle -> preferred section (first match in priority)
    priority = ["zh", "video", "coding", "creative", "industry", "models", "agent"]
    handle_map = {}
    for sec, meta in (cfg.get("sections") or {}).items():
        for h in meta.get("handles") or []:
            handle_map.setdefault(h.lower(), []).append(sec)
    if handle in handle_map:
        secs = handle_map[handle]
        if hint and hint in secs:
            return hint
        for pref in priority:
            if pref in secs:
                return pref
        return secs[0]
    return hint or None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--skip-translate", action="store_true")
    ap.add_argument("--skip-articles", action="store_true")
    args = ap.parse_args()
    cfg = load_sections()
    seed = WORK / "seed" / args.date
    users = load_json(seed / "users.json", {}) or {}
    media_map = load_json(seed / "media.json", {}) or {}
    posts_path = seed / "posts.jsonl"
    if not posts_path.exists():
        print("missing seed", posts_path); sys.exit(1)

    seen = set()
    by_section = {s: [] for s in cfg["sections"]}
    raw_rows = []
    with posts_path.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            raw_rows.append(json.loads(line))

    for row in raw_rows:
        pid = str(row["post"]["id"])
        if pid in seen:
            continue
        section = assign_section(row, users, cfg)
        if not section or section not in by_section:
            continue
        post = build_post(row, users, media_map, section, cfg)
        if not post:
            continue
        # drop pure noise
        t = post["text"].lower()
        if re.search(r"\b(wifi completely out|nyt bestseller|book, Co-Existence)\b", post["text"], re.I):
            # keep only if high engagement else skip
            if post["metrics"]["likes"] < 500:
                continue
        seen.add(pid)
        by_section[section].append(post)

    # cap per section by engagement
    caps = cfg.get("caps") or {}
    final = []
    for sec, items in by_section.items():
        items.sort(key=lambda p: (p["metrics"]["likes"] * 2 + p["metrics"]["bookmarks"] * 3 + p["metrics"].get("impressions", 0) / 1000), reverse=True)
        final.extend(items[: caps.get(sec, 15)])

    # translate + summarize + score
    tr_stats = {"posts_done": 0, "posts_cached": 0, "posts_skip": 0, "posts_fail": 0,
                "articles_done": 0, "articles_cached": 0, "articles_skip": 0, "articles_fail": 0}
    articles = 0
    extract_failures = 0
    for post in final:
        text = post["text"]
        if is_chinese(text):
            post["text_zh"] = text
            tr_stats["posts_skip"] += 1
        elif args.skip_translate:
            post["text_zh"] = None
            tr_stats["posts_skip"] += 1
        else:
            zh = translate(text)
            if zh:
                post["text_zh"] = zh
                tr_stats["posts_done"] += 1
            else:
                tr_stats["posts_fail"] += 1
        base = post.get("text_zh") or text
        # Draft only: the real headline / 推荐理由 are written by the agent in the
        # editorial step (scripts/editorial.py). Never ship these as final.
        post["summary_zh"] = summarize_zh(base)
        score, _label = score_heuristic(post)
        post["rec_score"] = score
        post["rec_reason"] = ""          # was a category label like "一般动态"
        post["needs_editorial"] = True
        post["recommended"] = score >= 70

        # articles
        if not args.skip_articles and post.get("external_url") and post["kind"] in ("paper", "repo", "article", "longpost"):
            apath = article_path(post["id"])
            if apath.exists():
                art = load_json(apath)
                tr_stats["articles_cached"] += 1
            else:
                art = fetch_article(post["external_url"], post["id"])
                if art:
                    # translate article
                    if not args.skip_translate and art.get("markdown") and not is_chinese(art["markdown"]):
                        zh = translate(art["markdown"][:8000])
                        if zh:
                            art["html_zh"] = f"<pre>{html.escape(zh)}</pre>"
                            art["summary_zh"] = summarize_zh(zh, 5)
                            art["title_zh"] = translate(art.get("title") or "") or art.get("title")
                            art["translated_at"] = now_utc().isoformat()
                            tr_stats["articles_done"] += 1
                        else:
                            tr_stats["articles_fail"] += 1
                    else:
                        art["summary_zh"] = summarize_zh(art.get("markdown") or "", 5)
                        tr_stats["articles_skip"] += 1
                    save_json(apath, art)
                    articles += 1
                else:
                    extract_failures += 1
                    art = None
            if art:
                post["article_id"] = art["id"]
                if art.get("summary_zh") and len(post.get("summary_zh") or "") < 40:
                    post["summary_zh"] = art["summary_zh"]

    # recommend top band: ensure ~5-12
    recs = [p for p in final if p["recommended"]]
    if len(recs) > 12:
        recs.sort(key=lambda p: p["rec_score"], reverse=True)
        keep = {p["id"] for p in recs[:12]}
        for p in final:
            if p["id"] not in keep:
                p["recommended"] = False
    elif len(recs) < 5:
        for p in sorted(final, key=lambda x: x["rec_score"], reverse=True):
            if not p["recommended"] and p["rec_score"] >= 60:
                p["recommended"] = True
                recs.append(p)
            if len(recs) >= 5:
                break

    final.sort(key=lambda p: (0 if p["recommended"] else 1, -p["rec_score"], -p["metrics"]["likes"]))

    # trend summary placeholder — filled by agent later if present
    trend_path = WORK / "seed" / args.date / "trend_summary.txt"
    trend = trend_path.read_text(encoding="utf-8").strip() if trend_path.exists() else ""
    if not trend:
        tops = [p for p in final if p["recommended"]][:5]
        bits = [p["summary_zh"] or p["text_short"] for p in tops]
        trend = "；".join(bits[:4])[:400] if bits else "今日资讯已更新。"

    by_sec = {}
    by_kind = {}
    for p in final:
        by_sec[p["section"]] = by_sec.get(p["section"], 0) + 1
        by_kind[p["kind"]] = by_kind.get(p["kind"], 0) + 1

    # re-apply agent-written editorial fields if ingest is re-run
    try:
        from editorial import edits_path, merge_edits
        ep = edits_path(args.date)
        if ep.exists():
            _tmp = {"posts": final}
            merge_edits(_tmp, load_json(ep))
    except Exception as e:
        print(f"editorial re-apply skipped: {e}", file=sys.stderr)

    day = {
        "date": args.date,
        "generated_at": now_utc().isoformat(),
        "trend_summary": trend,
        "posts": final,
        "stats": {
            "posts": len(final),
            "articles": articles,
            "extract_failures": extract_failures,
            "by_section": {k: by_sec.get(k, 0) for k in ["agent","models","coding","creative","industry","zh","video","gossip"]},
            "translation": tr_stats,
            "articles_missing_summary": [],
            "media": {"photos": 0, "videos": 0, "gifs": 0, "fail": 0, "skipped": 0},
            "by_kind": by_kind,
            "recommended": sum(1 for p in final if p["recommended"]),
            "rec_missing": [],
            "replies": {"posts": 0, "with_replies": 0, "with_summary": 0},
        },
    }
    out = DATA / "days" / f"{args.date}.json"
    save_json(out, day)
    # update index
    idx = load_json(DATA / "index.json", {"dates": [], "updated_at": None}) or {"dates": []}
    dates = [args.date] + [d for d in idx.get("dates", []) if d != args.date]
    idx["dates"] = dates
    idx["updated_at"] = day["generated_at"]
    save_json(DATA / "index.json", idx)
    print(json.dumps({"date": args.date, "posts": len(final), "recommended": day["stats"]["recommended"], "by_section": day["stats"]["by_section"]}, ensure_ascii=False))

if __name__ == "__main__":
    main()
