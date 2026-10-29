"""Shared helpers for the ai-digest pipeline."""
from __future__ import annotations
import json, os, re, hashlib, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WORK = ROOT / "work"
CONFIG = ROOT / "config"
SECRETS = ROOT / ".secrets"
WORKSPACE_SECRETS = Path("/workspace/.secrets")

SHANGHAI = timezone(timedelta(hours=8))

KIND_LABELS = {
    "post": "帖子",
    "longpost": "长帖",
    "video": "视频",
    "article": "文章",
    "paper": "论文",
    "repo": "仓库",
    "tutorial": "教程",
}

def load_json(path: Path, default=None):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)

def save_json(path: Path, obj: Any, indent=2):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
        f.write("\n")
    tmp.replace(path)

def load_sections():
    return load_json(CONFIG / "sections.json")

def day_path(date: str) -> Path:
    return DATA / "days" / f"{date}.json"

def article_path(aid: str) -> Path:
    return DATA / "articles" / f"{aid}.json"

def media_dir(post_id: str) -> Path:
    return DATA / "media" / post_id

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def iso(dt: datetime | None = None) -> str:
    dt = dt or now_utc()
    return dt.isoformat().replace("+00:00", "+00:00")

def passes_heat(section: str, likes: int, impressions: int, handle: str, cfg: dict) -> bool:
    heat = (cfg.get("heat") or {}).get(section)
    if heat is None:
        return True
    exempt = {h.lower() for h in (cfg.get("heat_exempt_handles") or [])}
    if handle.lower() in exempt and (likes >= 50 or impressions >= 3000):
        return True
    ml, mi = heat.get("min_likes", 0), heat.get("min_impressions", 0)
    if heat.get("any", True):
        return likes >= ml or impressions >= mi
    return likes >= ml and impressions >= mi

def best_mp4(variants: list[dict] | None) -> str | None:
    if not variants:
        return None
    mp4s = [v for v in variants if v.get("content_type") == "video/mp4" and v.get("url")]
    if not mp4s:
        return None
    mp4s.sort(key=lambda v: v.get("bit_rate") or 0, reverse=True)
    # prefer ~720p class when available
    mid = [v for v in mp4s if 1_500_000 <= (v.get("bit_rate") or 0) <= 3_000_000]
    return (mid[0] if mid else mp4s[0])["url"]

def detect_kinds(text: str, media_types: list[str], is_article: bool, external_url: str | None, note_len: int) -> list[str]:
    kinds = []
    t = text or ""
    low = t.lower()
    if "video" in media_types or "animated_gif" in media_types:
        kinds.append("video")
    if is_article or note_len > 280:
        kinds.append("longpost")
    url = (external_url or "") + " " + t
    if re.search(r"arxiv\.org|papers\.|acl anthology|openreview", url, re.I):
        kinds.append("paper")
    elif re.search(r"github\.com/[\w.-]+/[\w.-]+", url, re.I):
        kinds.append("repo")
    elif re.search(r"https?://", url) and (is_article or "http" in low):
        if not any(k in kinds for k in ("paper", "repo")):
            # blog-like
            if re.search(r"blog|medium\.com|substack|news|http", url, re.I):
                kinds.append("article")
    if re.search(r"tutorial|how[- ]?to|教程|指南|walkthrough", t, re.I):
        kinds.append("tutorial")
    if not kinds:
        kinds.append("post")
    # primary kind preference
    order = ["paper", "repo", "video", "article", "tutorial", "longpost", "post"]
    kinds = sorted(set(kinds), key=lambda k: order.index(k) if k in order else 99)
    return kinds

def primary_kind(kinds: list[str]) -> str:
    return kinds[0] if kinds else "post"

def short_text(text: str, n=180) -> str:
    text = (text or "").strip()
    if len(text) <= n:
        return text
    return text[: n - 1].rstrip() + "…"

def expand_urls(text: str, entities: dict | None) -> str:
    if not text or not entities:
        return text
    urls = entities.get("urls") or []
    out = text
    for u in sorted(urls, key=lambda x: -(x.get("start") or 0)):
        short = u.get("url")
        exp = u.get("expanded_url") or short
        if short and exp and short in out:
            # keep media pic.x.com as-is for later strip
            out = out.replace(short, exp)
    return out

def strip_media_urls(text: str) -> str:
    return re.sub(r"\s*https://(x|twitter)\.com/\w+/status/\d+/(photo|video)/\d+\s*", " ", text or "").strip()

def score_heuristic(post: dict) -> tuple[int, str]:
    """Rough rec_score 0-100 for bootstrap; agent may override."""
    likes = (post.get("metrics") or {}).get("likes") or 0
    imps = (post.get("metrics") or {}).get("impressions") or 0
    bmarks = (post.get("metrics") or {}).get("bookmarks") or 0
    text = (post.get("text") or "") + " " + (post.get("summary_zh") or "")
    kind = post.get("kind") or "post"
    handle = (post.get("handle") or "").lower()
    score = 35
    reason = "一般动态"
    # engagement
    if likes >= 2000 or imps >= 200_000:
        score += 25
    elif likes >= 500 or imps >= 50_000:
        score += 15
    elif likes >= 150 or imps >= 15_000:
        score += 8
    if bmarks >= 200:
        score += 8
    elif bmarks >= 50:
        score += 4
    # content type
    if kind == "paper":
        score += 12
        reason = "论文/研究"
    elif kind == "repo":
        score += 10
        reason = "开源仓库"
    elif kind in ("article", "longpost"):
        score += 6
        reason = "长文/深度"
    elif kind == "video":
        score += 4
        reason = "视频演示"
    # keywords
    boosts = [
        (r"\b(launch|release|announc|发布|开源|SOTA|frontier|API|pricing|降价)\b", 12, "发布/定价/开源"),
        (r"\b(Gemini\s*4|Claude\s*(Opus|Sonnet)|GPT-?\d|Astra|Carbon|Opus\s*5)\b", 15, "旗舰模型动态"),
        (r"\b(agent|MCP|multi-agent|智能体)\b", 6, "Agent 相关"),
        (r"传闻|rumor|leak|据说", -8, "传闻"),
        (r"hiring|we're hiring|招聘|newsletter subscriber", -10, "招聘/运营"),
        (r"wifi|box at the|NYT bestseller|book debut", -15, "非核心资讯"),
    ]
    for pat, delta, why in boosts:
        if re.search(pat, text, re.I):
            score += delta
            if delta > 0:
                reason = why
            elif score < 50:
                reason = why
    # official handles
    if handle in {"openai", "openaidevs", "anthropicai", "googledeepmind"} and score >= 40:
        score += 8
        reason = "官方发布"
    score = max(0, min(100, score))
    return score, reason

def is_chinese(text: str) -> bool:
    if not text:
        return False
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return cjk >= max(8, len(text) * 0.15)
