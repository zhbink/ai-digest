// Shared export logic for 我的关注 / 导出当日 — ONE source used by the site (static/app.js, as a classic <script>)
// and by the sync Worker (worker/src/index.js imports this file, so `GET /today` returns the same JSON as the site's 导出).
// Pure functions only: no DOM, no localStorage. `base` = the site's base URL (e.g. https://zhbink.github.io/ai-digest/).
(function (root) {
  "use strict";
  const sectionLabel = { agent: "AI Agent", zh: "中文圈", video: "AI 视频", gossip: "花边八卦" };
  const kindLabel = { post: "帖子", longpost: "长帖", article: "文章", paper: "论文", tutorial: "教程", video: "视频", repo: "仓库" };
  const PAPER_RE = /^https?:\/\/(www\.)?(arxiv\.org\/(abs|pdf|html)\/|huggingface\.co\/papers\/|openreview\.net\/|aclanthology\.org\/|(bio|med)rxiv\.org\/|papers\.nips\.cc\/|proceedings\.(mlr\.press|neurips\.cc)\/|dl\.acm\.org\/doi\/|ieeexplore\.ieee\.org\/|alphaxiv\.org\/abs\/)/i;
  const REPO_RE = /^https?:\/\/(www\.)?((github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+\/?($|[?#]|tree\/|blob\/)|huggingface\.co\/(?!papers\/|blog\/|docs\/|learn\/)((spaces|datasets)\/)?[\w.-]+\/[\w.-]+\/?$)/i;
  const TUTORIAL_RE = /(长文|视频|图文|入门|实操|完整|免费|保姆级)教程|教程[：:「“]|手把手|保姆级|分步(教程|指南)|step[- ]by[- ]step|\bhow[- ]to\b|\btutorial\b/i;
  function xLen(t) { let n = 0; for (const c of (t || "").replace(/https?:\/\/\S+/g, "")) n += c.codePointAt(0) > 0x10FF ? 2 : 1; return n; }
  function deriveKinds(p) {
    if (Array.isArray(p.kinds) && p.kinds.length) return p.kinds;
    const urls = [p.external_url, ...((p.entities?.urls) || []).map(u => u.unwound_url || u.expanded_url)].filter(Boolean);
    const text = p.note_tweet?.text || p.text || "";
    const video = (p.media_types || []).some(m => m === "video" || m === "animated_gif");
    const full = p.is_article && !p.article_thin;
    const xArticle = urls.some(u => /\/i\/article\//.test(u));
    const paper = urls.some(u => PAPER_RE.test(u));
    const main = p.external_url || urls.find(u => !/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(u));
    const long = p.x_long != null ? !!p.x_long : xLen(text) > 280;
    const tut = TUTORIAL_RE.test([p.summary_zh, p.article_title_zh, p.article_title, p.article_summary_zh].filter(Boolean).join(" "));
    let k = paper ? "paper" : (main && REPO_RE.test(main)) ? "repo"
      : (full && p.external_url && !/^https?:\/\/(www\.)?(x|twitter)\.com\/(?!i\/article\/)/.test(p.external_url)) || xArticle ? "article"
      : (video && xLen(text) <= 560) ? "video" : long ? "longpost" : "post";
    const sec = tut ? "tutorial" : (k === "paper" && full) ? "article" : (video && k !== "video") ? "video" : null;
    return sec ? [k, sec] : [k];
  }
  const mediaUrl = rel => `data/${rel}`;
  const absUrl = (rel, base) => new URL(rel, base).href;
  function externalLinks(p) {
    const urls = [p.external_url, ...((p.entities?.urls) || []).map(u => u.unwound_url || u.expanded_url)].filter(Boolean);
    return [...new Set(urls)].filter(u => !/^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)\//.test(u));
  }
  function exportMedia(p, base) {
    return (p.media || []).filter(m => m.src || m.poster).map(m => {
      const o = m.type === "photo"
        ? { type: "photo", url: absUrl(mediaUrl(m.src), base), original_url: m.orig || null, width: m.w ?? null, height: m.h ?? null, alt: m.alt || null }
        : { type: m.type, video_url: m.local_mp4 ? absUrl(mediaUrl(m.local_mp4), base) : (m.mp4 || null),
            ...(m.local_mp4 && m.mp4 ? { original_video_url: m.mp4 } : {}),
            poster: absUrl(mediaUrl(m.poster), base), width: m.w ?? null, height: m.h ?? null, duration_ms: m.duration_ms ?? null };
      if (m.from_quote) o.quoted = true;
      return o;
    });
  }
  function exportReplies(p) {
    return (p.top_replies || []).map(r => ({ author: { handle: r.handle, display_name: r.name || r.handle }, text: r.text,
      text_zh: r.text_zh || null, like_count: r.like_count ?? 0, reply_count: r.reply_count ?? 0, url: r.url, created_at: r.created_at || null }));
  }
  function exportAttached(p, base) {
    return (p.attached_posts || []).map(a => ({
      id: a.id, url: a.url,
      author: { handle: a.handle, display_name: a.display_name || a.handle, avatar: a.avatar || null, verified: !!a.verified, followers: a.followers ?? null },
      created_at: a.created_at || null, lang: a.lang || null,
      title: a.summary_zh || "", summary_zh: a.summary_zh || null, relation_zh: a.relation_zh || null,
      text: a.text || null, text_zh: a.text_zh || null,
      metrics: a.metrics || {}, media_types: a.media_types || [], media: exportMedia(a, base),
      links: a.links || [], hashtags: a.hashtags || [], mentions: a.mentions || [],
      quoted_post_url: a.quoted_post_url || null, article_title: a.article_title || null, attached_at: a.attached_at || null,
    }));
  }
  function articleLink(p, date, base) {
    if (!(p.is_article && p.article_id)) return null;
    const u = new URL(base); u.search = ""; u.hash = "";
    if (date) u.searchParams.set("date", date);
    return `${u.href}#/article/${encodeURIComponent(p.article_id)}`;
  }
  // comments as stored ({id,text,created_at,updated_at,…}) → export shape, oldest first
  function exportComments(list) {
    return [...(list || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map(({ id, text, created_at, updated_at }) => ({ id, text, created_at, updated_at }));
  }
  // one 我的关注 item: it = stored follow {id,date,title,handle,display_name,url,article_id,saved_at,updated_at};
  // p = the post from data/days/<it.date>.json (or null if that day/post is missing)
  function enrichFollow(it, p, commentList, base) {
    const comments = exportComments(commentList);
    if (!p) return { ...it, followed: true, followed_at: it.saved_at || null, comments };
    const out = { ...it, followed: true, followed_at: it.saved_at || null,
      section: p.section || null, section_label: sectionLabel[p.section] || p.section || null,
      kinds: deriveKinds(p).map(k => kindLabel[k]),
      author: { handle: p.handle, display_name: p.display_name },
      created_at: p.created_at || null,
      summary_zh: p.summary_zh || it.title || "", text_zh: p.text_zh || null, text: p.text || null,
      rec_score: p.rec_score ?? null, recommended: !!p.recommended, rec_reason: p.rec_reason || null,
      post_url: p.post_url || it.url || null, external_links: externalLinks(p),
      media: exportMedia(p, base), comments,
      discussion_summary: p.discussion_summary || null, top_replies: exportReplies(p), replies_fetched_at: p.replies_fetched_at || null,
      attached_posts: exportAttached(p, base), attached_fetched_at: p.attached_fetched_at || null };
    if (p.is_article && p.article_id) {
      out.article_title_zh = p.article_title_zh || p.article_title || null;
      out.article_summary_zh = p.article_summary_zh || null;
      out.article_link = articleLink(p, it.date || p._date, base);
    }
    return out;
  }
  const sortFollows = list => [...list].sort((a, b) => String(b.saved_at || "").localeCompare(String(a.saved_at || "")));
  const FOLLOWS_VERSION = 7;
  function followsPayload(items, { filter = null, total = items.length, exportedAt = new Date().toISOString() } = {}) {
    return { app: "ai-digest", kind: "follows", version: FOLLOWS_VERSION, exported_at: exportedAt, filter, total_follows: total, items };
  }
  // "今天" = Beijing date if it has a digest, else the latest digest (dates newest first)
  function shanghaiToday(now = new Date()) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
    catch { return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10); }
  }
  function todayDigestDate(dates, now) { const t = shanghaiToday(now); return dates.includes(t) ? t : dates[0] || null; }
  root.DigestExport = { sectionLabel, kindLabel, deriveKinds, xLen, mediaUrl, externalLinks, exportMedia, exportReplies, exportAttached,
    articleLink, exportComments, enrichFollow, sortFollows, followsPayload, FOLLOWS_VERSION, shanghaiToday, todayDigestDate };
})(typeof globalThis !== "undefined" ? globalThis : this);
