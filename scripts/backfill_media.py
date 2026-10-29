#!/usr/bin/env python3
"""Download media for posts listed in a day JSON or seed; write webp/mp4 under data/media/<id>/."""
from __future__ import annotations
import argparse, io, json, sys, time
from pathlib import Path
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, media_dir, best_mp4

UA = {"User-Agent": "ai-digest-bot/1.0"}

def to_webp(content: bytes, out: Path, max_side=1600) -> tuple[int, int]:
    im = Image.open(io.BytesIO(content))
    im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
    w, h = im.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1:
        im = im.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "WEBP", quality=82, method=4)
    return im.size

def download(url: str, timeout=60) -> bytes:
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    return r.content

def process_post(post: dict, stats: dict):
    pid = str(post["id"])
    media = post.get("media") or []
    if not media:
        return
    d = media_dir(pid)
    d.mkdir(parents=True, exist_ok=True)
    for i, m in enumerate(media):
        mtype = m.get("type") or "photo"
        try:
            if mtype == "photo":
                dest = d / f"{i}.webp"
                if dest.exists() and m.get("src"):
                    stats["skipped"] += 1
                    continue
                content = download(m["orig"])
                w, h = to_webp(content, dest)
                m["w"], m["h"] = w, h
                m["src"] = f"media/{pid}/{i}.webp"
                stats["photos"] += 1
            elif mtype in ("video", "animated_gif"):
                # poster webp
                poster = d / f"{i}.webp"
                thumb = m.get("orig") or m.get("preview")
                if thumb and not poster.exists():
                    content = download(thumb)
                    w, h = to_webp(content, poster)
                    m["w"], m["h"] = w, h
                m["poster"] = f"media/{pid}/{i}.webp"
                # optional local mp4 for short clips (<30s) — keep remote mp4 by default
                if m.get("mp4") and m.get("duration_ms") and m["duration_ms"] <= 20000:
                    mp4_path = d / f"{i}.mp4"
                    if not mp4_path.exists():
                        try:
                            mp4_path.write_bytes(download(m["mp4"], timeout=120))
                            # keep remote URL as canonical; local is cache
                            stats["videos"] += 1
                        except Exception:
                            stats["videos"] += 1  # still count remote
                    else:
                        stats["skipped"] += 1
                else:
                    stats["videos" if mtype == "video" else "gifs"] += 1
            else:
                stats["skipped"] += 1
        except Exception as e:
            stats["fail"] += 1
            m["error"] = str(e)[:120]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    args = ap.parse_args()
    day_file = DATA / "days" / f"{args.date}.json"
    day = load_json(day_file)
    if not day:
        print("missing day", day_file); sys.exit(1)
    stats = {"photos": 0, "videos": 0, "gifs": 0, "fail": 0, "skipped": 0}
    for p in day.get("posts") or []:
        process_post(p, stats)
    day.setdefault("stats", {})["media"] = stats
    save_json(day_file, day)
    print(json.dumps(stats, ensure_ascii=False))

if __name__ == "__main__":
    main()
