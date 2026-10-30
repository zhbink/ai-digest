#!/usr/bin/env python3
"""
Hot replies + discussion summaries for a day JSON.

Modes:
  plan  — write work/plans/<date>-replies.json with posts that still need a replies fetch
  apply — merge work/raw/<date>/replies-<id>.json into day posts
  check — refuse placeholders / missing coverage (also run by publish.sh)

Rules (hard):
  - NEVER write 「评论区较活跃，详情见原帖。」 or any "see original post" stub.
  - Posts with metrics.replies > 0 MUST have a raw fetch file before apply succeeds
    (unless --allow-incomplete, which still leaves those posts unmarked and check fails).
  - discussion_summary must be a real 1–3 sentence Chinese theme summary written by
    the agent after review, or one of the only allowed empty-ish phrases:
    「暂无回复。」 / 「讨论较少」 (when replies were fetched and truly empty/sparse).
  - Naive concat stubs starting with 「热门评论：」 are treated as unfinished and fail check.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, WORK, load_json, save_json, is_chinese

BANNED_SUMMARY_RES = [
    re.compile(r"详情见原帖"),
    re.compile(r"评论区较活跃"),
    re.compile(r"^热门评论："),
    re.compile(r"^有讨论。?$"),
]
ALLOWED_SPARSE = ("暂无回复。", "讨论较少", "讨论较少。", "暂无回复")


def _replies_count(p: dict) -> int:
    return int(((p.get("metrics") or {}).get("replies") or 0))


def _raw_path(date: str, post_id: str) -> Path:
    return WORK / "raw" / date / f"replies-{post_id}.json"


def _is_banned(summary: str) -> bool:
    s = (summary or "").strip()
    if not s:
        return True
    return any(r.search(s) for r in BANNED_SUMMARY_RES)


def plan(date: str) -> None:
    day = load_json(DATA / "days" / f"{date}.json")
    items = []
    for p in day.get("posts") or []:
        pid = p["id"]
        has_raw = _raw_path(date, pid).exists()
        has_top = bool(p.get("top_replies"))
        # Need fetch if no raw yet, or no top_replies and we expect conversation data
        if has_raw and has_top and not _is_banned(p.get("discussion_summary") or ""):
            continue
        if not has_raw:
            items.append(
                {
                    "id": pid,
                    "handle": p.get("handle"),
                    "replies_count": _replies_count(p),
                    "query": f"conversation_id:{pid} is:reply",
                    "reason": "missing_raw",
                }
            )
        elif _is_banned(p.get("discussion_summary") or "") or not has_top:
            items.append(
                {
                    "id": pid,
                    "handle": p.get("handle"),
                    "replies_count": _replies_count(p),
                    "query": f"conversation_id:{pid} is:reply",
                    "reason": "needs_review_or_empty_top",
                }
            )
    out = WORK / "plans" / f"{date}-replies.json"
    save_json(out, {"date": date, "posts": items})
    print(json.dumps({"plan": str(out), "n": len(items)}, ensure_ascii=False))


def apply(date: str, allow_incomplete: bool = False) -> int:
    day = load_json(DATA / "days" / f"{date}.json")
    missing_raw: list[str] = []
    with_replies = 0
    with_summary = 0

    for p in day.get("posts") or []:
        pid = p["id"]
        path = _raw_path(date, pid)
        if not path.exists():
            if _replies_count(p) > 0:
                missing_raw.append(pid)
                # Do NOT invent a lively placeholder. Leave unmarked for check to catch.
                continue
            # Zero public reply count and no raw: safe empty phrase only.
            if not p.get("discussion_summary") or _is_banned(p.get("discussion_summary") or ""):
                p["discussion_summary"] = "暂无回复。"
                with_summary += 1
            continue

        page = load_json(path)
        users = {str(u["id"]): u for u in ((page.get("includes") or {}).get("users") or [])}
        replies = []
        for tw in page.get("data") or []:
            if str(tw.get("id")) == str(pid):
                continue
            u = users.get(str(tw.get("author_id"))) or {}
            text = tw.get("text") or ""
            replies.append(
                {
                    "id": str(tw.get("id")),
                    "handle": u.get("username") or "",
                    "name": u.get("name") or "",
                    "verified": bool(u.get("verified")),
                    "text": text,
                    "lang": tw.get("lang") or "",
                    "like_count": (tw.get("public_metrics") or {}).get("like_count") or 0,
                    "reply_count": (tw.get("public_metrics") or {}).get("reply_count") or 0,
                    "created_at": tw.get("created_at"),
                    "url": tw.get("url")
                    or f"https://x.com/{u.get('username')}/status/{tw.get('id')}",
                    "direct": True,
                    "text_zh": text if is_chinese(text) else None,
                }
            )
        replies.sort(key=lambda r: r["like_count"], reverse=True)
        p["top_replies"] = replies[:5]
        p["replies_seen"] = len(replies)
        p["replies_fetched_at"] = datetime.now(timezone.utc).isoformat()
        if replies:
            with_replies += 1
            # Keep an existing agent-written thematic summary if it already passes.
            # Otherwise leave a clear unfinished marker that check will reject —
            # the agent must run review and write real discussion_summary.
            cur = (p.get("discussion_summary") or "").strip()
            if not cur or _is_banned(cur) or cur in ALLOWED_SPARSE:
                p["discussion_summary"] = ""  # force review
            with_summary += 1
        else:
            p["discussion_summary"] = "暂无回复。"
            with_summary += 1

    # Load agent review summaries if present
    summaries_path = DATA / "replies" / f"{date}.summaries.json"
    if summaries_path.exists():
        summaries = load_json(summaries_path) or {}
        if isinstance(summaries, dict):
            for p in day.get("posts") or []:
                s = summaries.get(str(p["id"])) or summaries.get(p["id"])
                if isinstance(s, str) and s.strip() and not _is_banned(s):
                    p["discussion_summary"] = s.strip()
                    with_summary += 1

    day.setdefault("stats", {})["replies"] = {
        "posts": len(day.get("posts") or []),
        "with_replies": with_replies,
        "with_summary": sum(1 for p in (day.get("posts") or []) if (p.get("discussion_summary") or "").strip()),
        "missing_raw": missing_raw,
    }
    save_json(DATA / "days" / f"{date}.json", day)
    print(json.dumps(day["stats"]["replies"], ensure_ascii=False))

    if missing_raw and not allow_incomplete:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "missing_raw_replies",
                    "n": len(missing_raw),
                    "ids": missing_raw[:20],
                    "hint": f"Fetch conversation replies for each id into work/raw/{date}/replies-<id>.json then re-apply. Never publish placeholders.",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    return 0


def check(date: str) -> int:
    day = load_json(DATA / "days" / f"{date}.json")
    problems = []
    for p in day.get("posts") or []:
        pid = p["id"]
        summary = (p.get("discussion_summary") or "").strip()
        n_replies = _replies_count(p)
        has_raw = _raw_path(date, pid).exists()
        top = p.get("top_replies") or []

        if _is_banned(summary):
            problems.append({"id": pid, "handle": p.get("handle"), "error": "banned_or_empty_summary", "summary": summary[:80]})
            continue
        if n_replies > 0 and not has_raw and not top:
            problems.append({"id": pid, "handle": p.get("handle"), "error": "replies_metric_but_no_fetch", "replies": n_replies})
            continue
        if n_replies > 0 and not summary:
            problems.append({"id": pid, "handle": p.get("handle"), "error": "missing_discussion_summary"})
            continue
        if not summary:
            problems.append({"id": pid, "handle": p.get("handle"), "error": "empty_discussion_summary"})

    out = {"ok": not problems, "date": date, "bad": len(problems), "problems": problems[:40]}
    print(json.dumps(out, ensure_ascii=False))
    return 0 if not problems else 4


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["plan", "apply", "check"])
    ap.add_argument("--date", required=True)
    ap.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="apply only: write what raw files exist; still leave missing posts unmarked (check will fail)",
    )
    args = ap.parse_args()
    if args.mode == "plan":
        plan(args.date)
        raise SystemExit(0)
    if args.mode == "apply":
        raise SystemExit(apply(args.date, allow_incomplete=args.allow_incomplete))
    raise SystemExit(check(args.date))


if __name__ == "__main__":
    main()
