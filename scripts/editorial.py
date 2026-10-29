#!/usr/bin/env python3
"""
Editorial pass: the card headline (summary_zh), 推荐理由 (rec_reason), Chinese
translation (text_zh) and article summary (article_summary_zh) are written by
the agent, not by templates. ingest.py only leaves placeholders.

Modes:
  plan  --date D  -> work/plans/<D>-editorial.json : every post that still needs
                     editorial fields, with full text + quoted/referenced post text
  apply --date D  -> merge work/edits/<D>-editorial.json
                     ({"<post_id>": {"summary_zh": ..., "rec_reason": ...,
                       "text_zh": ..., "article_summary_zh": ...}, ...})
                     into data/days/<D>.json. The edits file is persistent, so
                     ingest.py re-applies it if ingest is re-run.
  check --date D  -> exit 1 if any stub / template / missing field remains
                     (publish.sh runs this and refuses to publish on failure).

Style (match 2026-10-28):
  summary_zh   one specific Chinese sentence: who did what, key number/fact.
               e.g. "Google TPU 将登陆 Oracle 云（OCI），这是 TPU 首次出现在 Google 以外的云平台"
  rec_reason   why it matters / who should care, concrete, != summary_zh.
               e.g. "TPU 外供打破 NVIDIA 在第三方云的垄断，算力采购多了新选择"
  text_zh      full Chinese translation for every non-Chinese post.
  article_summary_zh  3-5 Chinese sentences for X articles / long posts.
Never: "handle：分类", "Agent / 框架 / 工作流动态", "…——值得跟进", category
labels like "一般动态"/"长文/深度", truncated first paragraph, rec_reason == summary_zh.
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, WORK, load_json, save_json, is_chinese

HEURISTIC_LABELS = {"一般动态", "论文/研究", "开源仓库", "长文/深度", "视频演示",
                    "发布/定价/开源", "旗舰模型动态", "Agent 相关", "传闻", "招聘/运营"}
STUB_RE = re.compile(
    r"^[A-Za-z0-9_]{2,20}\s*[：:]"          # "emollick：..."
    r"|工作流动态|相关更新|相关动态|评测/解读|创作分享|工具更新|模型与评测动态"
    r"|——值得跟进|值得跟进$"
)
LONG_KINDS = ("article", "longpost")


def day_path(date): return DATA / "days" / f"{date}.json"
def edits_path(date): return WORK / "edits" / f"{date}-editorial.json"


def problems(p: dict) -> list[str]:
    out = []
    s = (p.get("summary_zh") or "").strip()
    r = (p.get("rec_reason") or "").strip()
    if not s: out.append("summary_zh:empty")
    elif STUB_RE.search(s): out.append("summary_zh:stub")
    elif s.endswith("…") and len(s) > 150: out.append("summary_zh:truncated")
    if not r: out.append("rec_reason:empty")
    elif r in HEURISTIC_LABELS or " / " in r and len(r) < 20: out.append("rec_reason:label")
    elif STUB_RE.search(r): out.append("rec_reason:stub")
    elif r == s: out.append("rec_reason:same_as_summary")
    if p.get("needs_editorial"): out.append("needs_editorial")
    if not is_chinese(p.get("text") or "") and not (p.get("text_zh") or "").strip():
        out.append("text_zh:missing")
    tz = p.get("text_zh") or ""
    if tz and STUB_RE.search(tz) and tz != p.get("text"): out.append("text_zh:stub")
    return out


def _seed_refs(date):
    seed = WORK / "seed" / date
    refs = {}
    rp = seed / "referenced.json"
    if rp.exists():
        refs = load_json(rp) or {}
    ids = {}
    pj = seed / "posts.jsonl"
    if pj.exists():
        for line in pj.read_text(encoding="utf-8").splitlines():
            try:
                post = json.loads(line).get("post") or {}
            except Exception:
                continue
            ids[post.get("id")] = [r.get("id") for r in post.get("referenced_tweets") or []]
    return refs, ids


def plan(date):
    day = load_json(day_path(date))
    refs, ref_ids = _seed_refs(date)
    items = []
    for p in day.get("posts") or []:
        probs = problems(p)
        if not probs:
            continue
        quoted = []
        for rid in ref_ids.get(p["id"], []):
            t = (refs.get(rid) or {}).get("text")
            quoted.append({"id": rid, "text": t})  # text None -> agent fetches via X get_posts_by_ids
        items.append({
            "id": p["id"], "handle": p.get("handle"), "kind": p.get("kind"),
            "url": p.get("url"), "problems": probs, "text": p.get("text"),
            "quoted": quoted,
            "needs": {
                "summary_zh": any(x.startswith("summary_zh") or x == "needs_editorial" for x in probs),
                "rec_reason": any(x.startswith("rec_reason") or x == "needs_editorial" for x in probs),
                "text_zh": any(x.startswith("text_zh") for x in probs),
                "article_summary_zh": p.get("kind") in LONG_KINDS and not p.get("article_summary_zh"),
            },
        })
    out = WORK / "plans" / f"{date}-editorial.json"
    save_json(out, {"date": date, "edits_file": str(edits_path(date)),
                    "style": __doc__.split("Style (match 2026-10-28):")[1].strip(),
                    "posts": items})
    print(json.dumps({"plan": str(out), "n": len(items)}))


FIELDS = ("summary_zh", "rec_reason", "text_zh", "article_summary_zh")


def merge_edits(day: dict, edits: dict) -> int:
    n = 0
    for p in day.get("posts") or []:
        e = edits.get(p["id"])
        if not e:
            continue
        for f in FIELDS:
            if e.get(f):
                p[f] = e[f]
        p.pop("needs_editorial", None)
        n += 1
    day.setdefault("stats", {})["editorial"] = {"source": "agent", "posts": n}
    return n


def apply(date):
    ep = edits_path(date)
    if not ep.exists():
        sys.exit(f"no edits file: {ep}")
    day = load_json(day_path(date))
    n = merge_edits(day, load_json(ep))
    save_json(day_path(date), day)
    print(json.dumps({"applied": n}))


def check(date) -> int:
    day = load_json(day_path(date))
    bad = [(p["id"], p.get("handle"), problems(p)) for p in day.get("posts") or []]
    bad = [b for b in bad if b[2]]
    for b in bad[:40]:
        print("STUB", *b, file=sys.stderr)
    print(json.dumps({"date": date, "posts": len(day.get("posts") or []), "bad": len(bad)}))
    return 1 if bad else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["plan", "apply", "check"])
    ap.add_argument("--date", required=True)
    a = ap.parse_args()
    if a.mode == "plan": plan(a.date)
    elif a.mode == "apply": apply(a.date)
    else: sys.exit(check(a.date))
