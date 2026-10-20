const state = { date: null, section: "", q: "" };
const sectionLabel = { agent: "AI Agent", zh: "中文圈", video: "AI 视频" };
const kindLabel = { post: "帖子", longpost: "长帖", article: "文章", paper: "论文", tutorial: "教程", video: "视频", repo: "仓库" };

// Content-type tags. Ingest stores p.kinds (see kinds.py); this mirrors the rules for older data.
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
function kindTags(p, cls = "") {
  return deriveKinds(p).map((k, i) =>
    `<span class="kind-tag k-${escapeHtml(k)}${i ? " sub" : ""} ${cls}">${kindLabel[k] || escapeHtml(k)}</span>`).join("");
}

// Static data (relative paths; works under any subpath, e.g. /ai-digest/)
const dayCache = {};
async function api(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function clip(t) {
  t = t || "";
  return escapeHtml(t.slice(0, 420)) + (t.length > 420 ? "…" : "");
}

function avatarUrl(url) {
  if (!url) return "";
  return url.replace("_normal.", "_bigger.");
}

function parseArticleHash() {
  const m = (location.hash || "").match(/^#\/?article\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

// selected date lives in ?date=YYYY-MM-DD (hash stays free for #/article/<id> deep links)
function dateFromUrl() {
  const d = new URLSearchParams(location.search).get("date");
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
function setDateInUrl(d, latest) {
  const u = new URL(location.href);
  if (latest) u.searchParams.delete("date"); else u.searchParams.set("date", d);
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}
let picker = null;
async function loadDays() {
  const data = await api("data/index.json");
  const dates = data.dates || [];                 // newest first
  const want = dateFromUrl();
  state.date = dates.includes(want) ? want : dates[0] || null;
  picker = DatePicker(document.getElementById("datePicker"), {
    dates, value: state.date,
    onChange: d => { state.date = d; setDateInUrl(d, d === dates[0]); loadDay(); },
  });
  if (new URLSearchParams(location.search).get("cal") === "open") setTimeout(() => picker.open(), 0); // debug/screenshot hook
}

async function loadDay() {
  if (!state.date) return;
  if (!dayCache[state.date]) dayCache[state.date] = await api(`data/days/${encodeURIComponent(state.date)}.json`);
  const day = dayCache[state.date];
  let posts = (day.posts || []).slice().sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  if (state.section) posts = posts.filter(p => p.section === state.section);
  if (state.q) {
    const q = state.q.toLowerCase();
    posts = posts.filter(p => [p.handle, p.display_name, p.summary_zh, p.text, p.text_zh, p.article_title, p.article_title_zh, p.article_summary_zh,
        ...deriveKinds(p).map(k => kindLabel[k])]
      .some(v => (v || "").toLowerCase().includes(q)));
  }
  const trendBox = document.getElementById("trendBox");
  const trendText = document.getElementById("trendText");
  const stats = document.getElementById("stats");
  if (day.trend_summary) {
    trendBox.hidden = false;
    trendText.textContent = day.trend_summary;
  } else trendBox.hidden = true;
  const s = day.stats || {};
  const by = s.by_section || {};
  stats.innerHTML = `
    <span class="pill">帖子 ${s.posts ?? (day.posts || []).length}</span>
    <span class="pill">全文 ${s.articles ?? 0}</span>
    <span class="pill">Agent ${by.agent ?? 0}</span>
    <span class="pill">中文 ${by.zh ?? 0}</span>
    <span class="pill">视频 ${by.video ?? 0}</span>`;
  renderFeed(posts);
}

function renderFeed(posts) {
  const feed = document.getElementById("feed");
  const empty = document.getElementById("empty");
  feed.innerHTML = "";
  empty.hidden = posts.length > 0;
  posts.forEach(p => {
    const el = document.createElement("article");
    el.className = "card";
    const av = avatarUrl(p.avatar);
    el.innerHTML = `
      <div class="card-head">
        ${av ? `<img class="avatar" src="${escapeHtml(av)}" alt="" />` : `<div class="avatar"></div>`}
        <div class="meta">
          <div class="name-row"><span class="name">${escapeHtml(p.display_name || p.handle)}</span><span class="tags">${kindTags(p)}<span class="badge ${escapeHtml(p.section)}">${sectionLabel[p.section] || p.section}</span></span></div>
          <div class="handle">@${escapeHtml(p.handle)} · ${fmtTime(p.created_at)}</div>
        </div>
      </div>
      <div class="summary">${escapeHtml(p.summary_zh || "")}</div>
      ${p.article_summary_zh
        ? `<div class="digest"><div class="digest-label">要点总结</div><div class="digest-text">${escapeHtml(p.article_summary_zh)}</div></div>`
        : `<div class="body-text">${clip(p.text_zh || p.text)}</div>`}
      <div class="card-foot">
        <span>♥ ${p.metrics?.likes ?? 0}</span>
        <span>↻ ${p.metrics?.reposts ?? 0}</span>
        <span>💬 ${p.metrics?.replies ?? 0}</span>
        <span class="spacer"></span>
        ${p.text_zh && !p.article_summary_zh ? `<button class="btn ghost tr-toggle" data-tr="zh" title="机器翻译">查看原文</button>` : ""}
        ${p.is_article ? `<button class="btn primary" data-article="${escapeHtml(p.article_id)}">阅读全文</button>` : ""}
        <a class="btn ghost" href="${escapeHtml(p.post_url)}" target="_blank" rel="noopener">原帖</a>
      </div>`;
    el.querySelector(".tr-toggle")?.addEventListener("click", (ev) => {
      const b = ev.currentTarget, toOrig = b.dataset.tr === "zh";
      el.querySelector(".body-text").innerHTML = clip(toOrig ? p.text : p.text_zh);
      b.dataset.tr = toOrig ? "orig" : "zh";
      b.textContent = toOrig ? "显示译文" : "查看原文";
    });
    el.querySelector("[data-article]")?.addEventListener("click", () => {
      location.hash = `#/article/${p.article_id}`;
    });
    feed.appendChild(el);
  });
}

async function openArticle(id, fallbackUrl) {
  const reader = document.getElementById("reader");
  const body = document.getElementById("readerBody");
  const src = document.getElementById("readerSource");
  const tr = document.getElementById("readerTr");
  const kindBox = document.getElementById("readerKind");
  const post = Object.values(dayCache).flatMap(d => d.posts || []).find(p => p.article_id === id);
  kindBox.innerHTML = post ? kindTags(post) : "";
  kindBox.hidden = !post;
  tr.hidden = true;
  body.innerHTML = `<p class="muted">加载中…</p>`;
  reader.hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const art = await api(`data/articles/${encodeURIComponent(id)}.json`);
    const hasZh = !!(art.html_zh || art.title_zh);
    const render = (zh) => {
      const title = (zh && art.title_zh) || art.title || "";
      // article.html often already starts with <h1>; avoid duplicate
      const html = (zh && art.html_zh) || art.html || "";
      const hasH1 = /<h1[\s>]/i.test(html);
      const note = hasZh ? `<p class="tr-note">${zh ? "以下为机器翻译" : "原文"}</p>` : "";
      body.innerHTML = (hasH1 ? "" : `<h1>${escapeHtml(title)}</h1>`) + note + html;
      if (!html && title) body.innerHTML = `<h1>${escapeHtml(title)}</h1><p>（无正文）</p>`;
      tr.textContent = zh ? "查看原文" : "显示译文";
      tr.dataset.tr = zh ? "zh" : "orig";
    };
    tr.hidden = !hasZh;
    tr.onclick = () => { render(tr.dataset.tr !== "zh"); document.querySelector(".reader-panel").scrollTop = 0; };
    render(true);
    src.href = art.source || fallbackUrl || "#";
    src.hidden = false;
  } catch (err) {
    body.innerHTML = `<h1>无法打开文章</h1><p>${escapeHtml(err.message || String(err))}</p>`;
    src.href = fallbackUrl || "#";
  }
}

function closeReader() {
  const reader = document.getElementById("reader");
  reader.hidden = true;
  document.getElementById("readerBody").innerHTML = "";
  document.body.style.overflow = "";
  if (parseArticleHash()) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function onHashChange() {
  const id = parseArticleHash();
  if (id) openArticle(id);
  else closeReaderKeepHash();
}

function closeReaderKeepHash() {
  // close without rewriting hash (hash already empty)
  const reader = document.getElementById("reader");
  reader.hidden = true;
  document.getElementById("readerBody").innerHTML = "";
  document.body.style.overflow = "";
}

document.getElementById("closeReader").onclick = () => {
  if (parseArticleHash()) location.hash = "";
  else closeReader();
};
document.getElementById("reader").addEventListener("click", (e) => {
  if (e.target.id === "reader") {
    if (parseArticleHash()) location.hash = "";
    else closeReader();
  }
});

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  [...document.getElementById("tabs").children].forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.section = btn.dataset.section || "";
  loadDay();
});

let t = null;
document.getElementById("search").addEventListener("input", (e) => {
  clearTimeout(t);
  t = setTimeout(() => { state.q = e.target.value.trim(); loadDay(); }, 200);
});

window.addEventListener("hashchange", onHashChange);

loadDays()
  .then(loadDay)
  .then(() => {
    // deep-link after feed is ready
    const id = parseArticleHash();
    if (id) return openArticle(id);
  })
  .catch(err => {
    document.getElementById("empty").hidden = false;
    document.getElementById("empty").textContent = "加载失败：" + err.message;
  });
