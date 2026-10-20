const state = { date: null, section: "", q: "" };
const sectionLabel = { agent: "AI Agent", zh: "中文圈", video: "AI 视频" };

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

function avatarUrl(url) {
  if (!url) return "";
  return url.replace("_normal.", "_bigger.");
}

function parseArticleHash() {
  const m = (location.hash || "").match(/^#\/?article\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

async function loadDays() {
  const data = await api("data/index.json");
  const sel = document.getElementById("daySelect");
  sel.innerHTML = "";
  (data.dates || []).forEach(d => {
    const opt = document.createElement("option");
    opt.value = d; opt.textContent = d;
    sel.appendChild(opt);
  });
  if (data.dates?.length) {
    state.date = data.dates[0];
    sel.value = state.date;
  }
  sel.onchange = () => { state.date = sel.value; loadDay(); };
}

async function loadDay() {
  if (!state.date) return;
  if (!dayCache[state.date]) dayCache[state.date] = await api(`data/days/${encodeURIComponent(state.date)}.json`);
  const day = dayCache[state.date];
  let posts = (day.posts || []).slice().sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  if (state.section) posts = posts.filter(p => p.section === state.section);
  if (state.q) {
    const q = state.q.toLowerCase();
    posts = posts.filter(p => [p.handle, p.display_name, p.summary_zh, p.text]
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
          <div class="name">${escapeHtml(p.display_name || p.handle)}</div>
          <div class="handle">@${escapeHtml(p.handle)} · ${fmtTime(p.created_at)}</div>
        </div>
        <span class="badge ${escapeHtml(p.section)}">${sectionLabel[p.section] || p.section}</span>
      </div>
      <div class="summary">${escapeHtml(p.summary_zh || "")}</div>
      <div class="body-text">${escapeHtml((p.text || "").slice(0, 420))}${(p.text||"").length>420?"…":""}</div>
      <div class="card-foot">
        <span>♥ ${p.metrics?.likes ?? 0}</span>
        <span>↻ ${p.metrics?.reposts ?? 0}</span>
        <span>💬 ${p.metrics?.replies ?? 0}</span>
        <span class="spacer"></span>
        ${p.is_article ? `<button class="btn primary" data-article="${escapeHtml(p.article_id)}">阅读全文</button>` : ""}
        <a class="btn ghost" href="${escapeHtml(p.post_url)}" target="_blank" rel="noopener">原帖</a>
      </div>`;
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
  body.innerHTML = `<p class="muted">加载中…</p>`;
  reader.hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const art = await api(`data/articles/${encodeURIComponent(id)}.json`);
    const title = art.title || "";
    // article.html often already starts with <h1>; avoid duplicate
    let html = art.html || "";
    const hasH1 = /<h1[\s>]/i.test(html);
    body.innerHTML = (hasH1 ? "" : `<h1>${escapeHtml(title)}</h1>`) + html;
    if (!html && title) {
      body.innerHTML = `<h1>${escapeHtml(title)}</h1><p>（无正文）</p>`;
    }
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
