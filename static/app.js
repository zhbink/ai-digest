const LS_SORT = "aidigest.sort", LS_FOLLOW = "aidigest.follows";
const state = {
  date: null, section: "", q: "",
  sort: localStorage.getItem(LS_SORT) === "new" ? "new" : "rec",   // 推荐 (rec_score desc) | 最新
  recOnly: false, view: "day", followToday: false,                  // view: day | follow
};
let allDates = [];

// ---- 关注 (bookmarks) in localStorage: {<post id>: {id,date,title,handle,display_name,url,article_id,saved_at}}
const follows = {
  load() {
    try { const o = JSON.parse(localStorage.getItem(LS_FOLLOW) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
    catch { return {}; }
  },
  save(o) { localStorage.setItem(LS_FOLLOW, JSON.stringify(o)); updateFollowUI(); },
  all() { return Object.values(this.load()).sort((a, b) => String(b.saved_at || "").localeCompare(String(a.saved_at || ""))); },
  has(id) { return !!this.load()[id]; },
  add(p, savedAt) {
    const o = this.load();
    o[p.id] = { id: p.id, date: p._date || state.date, title: p.summary_zh || "", handle: p.handle || "",
      display_name: p.display_name || "", url: p.post_url || "", article_id: p.is_article ? p.article_id : null,
      saved_at: savedAt || new Date().toISOString() };
    this.save(o);
  },
  remove(id) { const o = this.load(); delete o[id]; this.save(o); },
  merge(items) {
    const o = this.load(); let n = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const cur = o[it.id];
      // v1 and v2 exports both work; v2's export-only enrichment (media, texts, article link) is not stored
      const { media, text, text_zh, summary_zh, article_title_zh, article_summary_zh, article_link, ...base } = it;
      if (!base.title && summary_zh) base.title = summary_zh;
      if (!cur || String(it.saved_at || "") > String(cur.saved_at || "")) { o[it.id] = { ...cur, ...base, id: String(it.id) }; n++; }
    }
    this.save(o); return n;
  },
};
function followBtn(p) {
  const on = follows.has(p.id);
  return `<button type="button" class="btn ghost follow${on ? " on" : ""}" data-follow="${escapeHtml(p.id)}" aria-pressed="${on}"
    title="${on ? "取消关注" : "加入我的关注"}">${on ? "★ 已关注" : "☆ 关注"}</button>`;
}
function updateFollowUI() {
  const n = Object.keys(follows.load()).length;
  const c = document.getElementById("followCount"); if (c) c.textContent = n;
  document.querySelectorAll("[data-follow]").forEach(b => {
    const on = follows.has(b.dataset.follow);
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    b.textContent = on ? "★ 已关注" : "☆ 关注"; b.title = on ? "取消关注" : "加入我的关注";
  });
}
function findPost(id) {
  for (const d of Object.values(dayCache)) { const p = (d.posts || []).find(x => x.id === id); if (p) return p; }
  return null;
}
function toggleFollow(id) {
  if (follows.has(id)) follows.remove(id);
  else { const p = findPost(id); if (p) follows.add(p); }
  if (state.view === "follow") render();
}
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
  allDates = dates;
  const want = dateFromUrl();
  state.date = dates.includes(want) ? want : dates[0] || null;
  picker = DatePicker(document.getElementById("datePicker"), {
    dates, value: state.date,
    onChange: d => { state.date = d; setDateInUrl(d, d === dates[0]); if (state.view === "config") setView("day"); else loadDay(); },
  });
  const qs = new URLSearchParams(location.search);
  if (qs.get("cal") === "open") setTimeout(() => picker.open(), 0); // debug/screenshot hook
  // demo/screenshot hook: ?demo_follow=id1,id2 adds those posts to 我的关注 (only if not already saved); ?view=follow opens it
  const demo = (qs.get("demo_follow") || "").split(",").map(s => s.trim()).filter(Boolean);
  if (demo.length) {
    await Promise.all(dates.map(d => ensureDay(d).catch(() => null)));
    const base = Date.now();
    demo.forEach((id, i) => { const p = findPost(id); if (p && !follows.has(id)) follows.add(p, new Date(base - i * 60000).toISOString()); });
  }
  const sec = qs.get("section");
  if (["agent", "zh", "video"].includes(sec)) {
    state.section = sec;
    [...document.getElementById("tabs").children].forEach(b => b.classList.toggle("active", b.dataset.section === sec));
  }
  if (qs.get("q")) { state.q = qs.get("q"); document.getElementById("search").value = state.q; }
  if (qs.get("view") === "follow") state.view = "follow";
  if (qs.get("view") === "config") state.view = "config";
  updateFollowUI();
}

async function ensureDay(date) {
  if (!dayCache[date]) {
    const d = await api(`data/days/${encodeURIComponent(date)}.json`);
    (d.posts || []).forEach(p => { p._date = d.date || date; });
    dayCache[date] = d;
  }
  return dayCache[date];
}
const byNewest = (a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
const byRec = (a, b) => ((b.rec_score ?? -1) - (a.rec_score ?? -1)) || byNewest(a, b);
function applyFilters(posts) {
  if (state.section) posts = posts.filter(p => p.section === state.section);
  if (state.q) {
    const q = state.q.toLowerCase();
    posts = posts.filter(p => [p.handle, p.display_name, p.summary_zh, p.text, p.text_zh, p.article_title, p.article_title_zh,
        p.article_summary_zh, p.rec_reason, ...deriveKinds(p).map(k => kindLabel[k])]
      .some(v => (v || "").toLowerCase().includes(q)));
  }
  return posts;
}
const loadDay = () => render();
async function render() {
  const isCfg = state.view === "config";
  document.body.classList.toggle("view-config", isCfg);
  document.getElementById("configLink").classList.toggle("active", isCfg);
  document.getElementById("configView").hidden = !isCfg;
  if (isCfg) {
    document.getElementById("feed").innerHTML = "";
    document.getElementById("empty").hidden = true;
    document.getElementById("trendBox").hidden = true;
    return renderConfig();
  }
  document.getElementById("followTab").classList.toggle("active", state.view === "follow");
  document.getElementById("dayTools").hidden = state.view !== "day";
  document.getElementById("followBar").hidden = state.view !== "follow";
  if (state.view === "follow") return renderFollowView();
  if (!state.date) return;
  const day = await ensureDay(state.date);
  let posts = applyFilters((day.posts || []).slice());
  if (state.recOnly) posts = posts.filter(p => p.recommended);
  posts.sort(state.sort === "new" ? byNewest : byRec);
  const trendBox = document.getElementById("trendBox");
  const trendText = document.getElementById("trendText");
  const stats = document.getElementById("stats");
  if (day.trend_summary) {
    trendBox.hidden = false;
    trendText.textContent = day.trend_summary;
  } else trendBox.hidden = true;
  const s = day.stats || {};
  const by = s.by_section || {};
  const nRec = (day.posts || []).filter(p => p.recommended).length;
  stats.innerHTML = `
    <span class="pill">帖子 ${s.posts ?? (day.posts || []).length}</span>
    <span class="pill">全文 ${s.articles ?? 0}</span>
    <span class="pill rec">推荐 ${nRec}</span>
    <span class="pill">Agent ${by.agent ?? 0}</span>
    <span class="pill">中文 ${by.zh ?? 0}</span>
    <span class="pill">视频 ${by.video ?? 0}</span>`;
  document.getElementById("empty").textContent = state.recOnly ? "这一天没有符合条件的推荐内容。" : "这一天还没有内容。";
  renderFeed(posts);
}

async function renderFollowView() {
  document.getElementById("trendBox").hidden = true;
  let items = follows.all();
  const total = items.length;
  if (state.followToday) items = items.filter(it => it.date === state.date);
  await Promise.all([...new Set(items.map(it => it.date).filter(d => allDates.includes(d)))].map(d => ensureDay(d).catch(() => null)));
  let posts = items.map(it => {
    const p = (dayCache[it.date]?.posts || []).find(x => x.id === it.id);
    return p ? { ...p, _saved_at: it.saved_at }
      : { id: it.id, _date: it.date, _stub: true, _saved_at: it.saved_at, handle: it.handle, display_name: it.display_name,
          summary_zh: it.title, post_url: it.url, created_at: null, kinds: [] };
  });
  posts = applyFilters(posts);
  const dLabel = state.date ? `${+state.date.slice(5, 7)}月${+state.date.slice(8)}日` : "";
  document.getElementById("followTitle").innerHTML =
    `我的关注 <b>${total}</b> 条${state.followToday || state.section || state.q ? `<span class="muted"> · 当前显示 ${posts.length} 条</span>` : ""}`;
  document.getElementById("followToday").textContent = `只看 ${dLabel}`;
  document.getElementById("followToday").classList.toggle("on", state.followToday);
  document.getElementById("followToday").setAttribute("aria-pressed", state.followToday);
  document.getElementById("empty").textContent = total
    ? "没有符合条件的关注内容。"
    : "还没有关注任何内容。点卡片上的「☆ 关注」即可收藏，收藏保存在本浏览器，可用「导出」带到别的浏览器。";
  renderFeed(posts, { follow: true });
}

// ---- 配置页 (read-only strategy, data/strategy.json exported from config/strategy.json)
let strategyCache = null;
const fmtNum = n => n == null ? "" : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万` : String(n);
async function renderConfig() {
  const box = document.getElementById("configView");
  if (!strategyCache) {
    box.innerHTML = `<p class="muted">加载中…</p>`;
    try { strategyCache = await api("data/strategy.json"); }
    catch (e) { box.innerHTML = `<p class="muted">配置加载失败：${escapeHtml(e.message)}</p>`; return; }
  }
  const s = strategyCache, by = s.collected?.by_handle || {};
  const nAcc = s.groups.reduce((n, g) => n + g.accounts.length, 0);
  const tracked = new Set(s.groups.flatMap(g => g.accounts.map(a => a.handle.toLowerCase())));
  const fromTracked = Object.entries(by).filter(([h]) => tracked.has(h)).reduce((n, [, c]) => n + c, 0);
  const total = s.collected?.posts ?? 0;
  const li = arr => `<ul class="cfg-list">${arr.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  const acct = a => {
    const c = by[a.handle.toLowerCase()] || 0;
    return `<a class="acct${a.special ? " special" : ""}" href="${escapeHtml(a.url)}" target="_blank" rel="noopener" title="在 X 上打开 @${escapeHtml(a.handle)}">
      ${a.avatar ? `<img class="acct-av" src="${escapeHtml(a.avatar)}" alt="" loading="lazy" />` : `<span class="acct-av"></span>`}
      <span class="acct-main">
        <span class="acct-top"><b class="acct-name">${escapeHtml(a.name || a.handle)}</b>${a.special ? `<span class="acct-flag">特别关注</span>` : ""}</span>
        <span class="acct-handle">@${escapeHtml(a.handle)}${a.followers != null ? ` · ${fmtNum(a.followers)} 粉丝` : ""}</span>
        ${a.desc ? `<span class="acct-desc">${escapeHtml(a.desc)}</span>` : ""}
      </span>
      <span class="acct-count${c ? "" : " zero"}" title="已收录帖子数（全部日期）">${c}<small>条</small></span>
    </a>`;
  };
  const upd = s.updated_at ? new Date(s.updated_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "";
  box.innerHTML = `
    <div class="cfg-head">
      <div>
        <h2>⚙ 信息收集策略</h2>
        <p class="muted">只读 · 当前每日抓取、筛选、处理与推荐评分规则</p>
      </div>
      <button type="button" class="btn ghost sm" id="cfgBack">← 返回日报</button>
    </div>
    <div class="cfg-stats">
      <div class="stat"><b>${nAcc}</b><span>关注账号</span></div>
      <div class="stat"><b>${s.groups.length}</b><span>账号分组</span></div>
      <div class="stat"><b>${s.keywords.length}</b><span>关键词搜索</span></div>
      <div class="stat"><b>${total}</b><span>已收录帖子 · ${s.collected?.days ?? 0} 期</span></div>
    </div>
    <section class="cfg-sec"><h3>更新时间</h3><p>${escapeHtml(s.schedule)}</p></section>
    <section class="cfg-sec">
      <h3>关注账号 <span class="muted">${nAcc} 个 · 右侧数字为已收录帖子数（关注账号 ${fromTracked} 条，其余 ${total - fromTracked} 条来自关键词搜索）</span></h3>
      <p class="cfg-note"><span class="acct-flag">特别关注</span> ${escapeHtml(s.special_note)}
        ${s.special_accounts.map(h => `<a href="https://x.com/${escapeHtml(h)}" target="_blank" rel="noopener">@${escapeHtml(h)}</a>`).join("、")}</p>
      ${s.groups.map((g, i) => `
        <div class="cfg-group">
          <h4><span class="gnum">${i + 1}</span>${escapeHtml(g.name)}<span class="muted"> · ${g.accounts.length} 个</span></h4>
          <div class="acct-grid">${g.accounts.map(acct).join("")}</div>
        </div>`).join("")}
    </section>
    <section class="cfg-sec"><h3>关注主题</h3>
      <div class="topic-row">${s.topics.map(t => `<div class="topic"><b>${escapeHtml(t.name)}</b><span>${escapeHtml(t.detail)}</span></div>`).join("")}</div>
    </section>
    <section class="cfg-sec"><h3>关键词搜索 <span class="muted">（X 搜索语法）</span></h3>
      ${s.keywords.map(k => `<div class="kw"><span class="kw-name">${escapeHtml(k.name)}</span><code>${escapeHtml(k.query)}</code></div>`).join("")}
    </section>
    <div class="cfg-two">
      <section class="cfg-sec"><h3>筛选规则</h3>${li(s.filter_rules)}</section>
      <section class="cfg-sec"><h3>内容处理</h3>${li(s.processing)}</section>
    </div>
    <section class="cfg-sec"><h3>推荐评分 <span class="muted">标准：「${escapeHtml(s.scoring.standard)}」</span></h3>
      <div class="bands">${s.scoring.bands.map((b, i) => `<div class="band b${i}"><span class="band-range">${escapeHtml(b.range)}</span><span>${escapeHtml(b.desc)}</span></div>`).join("")}</div>
      <div class="rule-chips">${s.scoring.rules.map(r => `<span class="rule-chip">${escapeHtml(r)}</span>`).join("")}</div>
    </section>
    <footer class="cfg-foot">
      <p>${escapeHtml(s.footer_note)}</p>
      <p class="muted">最后更新：${escapeHtml(upd)}（北京时间）</p>
    </footer>`;
  document.getElementById("cfgBack").onclick = () => setView("day");
}

// ---- media (photos saved under data/media; videos hot-linked from video.twimg.com, poster local)
const mediaUrl = rel => `data/${rel}`;
function fmtDur(ms) { if (!ms) return ""; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function mediaGrid(p, opts = {}) {
  const lazy = opts.eager ? "eager" : "lazy";
  const ms = (p.media || []).filter(m => m.src || m.poster);
  if (!ms.length) return "";
  const shown = ms.slice(0, 4);
  const quote = ms.every(m => m.from_quote);
  const cells = shown.map((m, i) => {
    const ratio = m.w && m.h ? `${m.w} / ${m.h}` : "16 / 9";
    if (m.type === "photo") {
      return `<button type="button" class="m-cell m-photo" data-lb="${i}" style="--ar:${ratio}" aria-label="查看大图${m.alt ? "：" + escapeHtml(m.alt) : ""}">
        <img src="${escapeHtml(mediaUrl(m.src))}" alt="${escapeHtml(m.alt || "")}" loading="${lazy}" decoding="async" width="${m.w || ""}" height="${m.h || ""}" />
        ${i === 3 && ms.length > 4 ? `<span class="m-more">+${ms.length - 4}</span>` : ""}</button>`;
    }
    const gif = m.type === "animated_gif";
    const src = m.local_mp4 ? mediaUrl(m.local_mp4) : m.mp4;
    if (!src) return posterLink(p, m, ratio);
    return `<div class="m-cell m-video${gif ? " m-gif" : ""}" style="--ar:${ratio}">
      <video ${gif ? "autoplay muted loop" : "controls"} playsinline preload="${gif ? "auto" : "none"}" poster="${escapeHtml(mediaUrl(m.poster))}"
        src="${escapeHtml(src)}" data-fallback="${escapeHtml(p.post_url || "")}"></video>
      ${gif ? `<span class="m-badge">GIF</span>` : m.duration_ms ? `<span class="m-badge">${fmtDur(m.duration_ms)}</span>` : ""}</div>`;
  }).join("");
  return `${quote ? `<div class="m-quote">引用帖中的媒体</div>` : ""}<div class="media n${shown.length}${opts.reader ? " in-reader" : ""}">${cells}</div>`;
}
function posterLink(p, m, ratio) {
  return `<a class="m-cell m-video m-fallback" style="--ar:${ratio}" href="${escapeHtml(p.post_url || "#")}" target="_blank" rel="noopener" title="在 X 上播放">
    <img src="${escapeHtml(mediaUrl(m.poster))}" alt="${escapeHtml(m.alt || "")}" loading="lazy" /><span class="m-play">▶</span></a>`;
}
function bindMedia(root, p) {
  root.querySelectorAll("[data-lb]").forEach(b => b.addEventListener("click", () => openLightbox(p, +b.dataset.lb)));
  root.querySelectorAll("video[data-fallback]").forEach(v => v.addEventListener("error", () => {
    const cell = v.closest(".m-cell"); const m = { poster: v.getAttribute("poster").replace(/^data\//, "") };
    if (cell) cell.outerHTML = posterLink(p, m, getComputedStyle(cell).getPropertyValue("--ar"));
  }, { once: true }));
}
const lb = { items: [], i: 0 };
function openLightbox(p, i) {
  lb.items = (p.media || []).filter(m => m.type === "photo" && m.src);
  const want = (p.media || []).filter(m => m.src || m.poster)[i];
  lb.i = Math.max(0, lb.items.indexOf(want));
  showLb(); document.getElementById("lightbox").hidden = false;
  document.querySelector("#lightbox .lb-close").focus({ preventScroll: true });
}
function showLb() {
  const m = lb.items[lb.i]; if (!m) return;
  document.getElementById("lbImg").src = mediaUrl(m.src);
  document.getElementById("lbImg").alt = m.alt || "";
  document.getElementById("lbCap").textContent = (lb.items.length > 1 ? `${lb.i + 1} / ${lb.items.length}` : "") + (m.alt ? `  ${m.alt}` : "");
  document.querySelectorAll("#lightbox .lb-nav").forEach(b => { b.hidden = lb.items.length < 2; });
}
function closeLb() { document.getElementById("lightbox").hidden = true; document.getElementById("lbImg").src = ""; }
document.getElementById("lightbox").addEventListener("click", (e) => {
  if (e.target.closest(".lb-prev")) { lb.i = (lb.i - 1 + lb.items.length) % lb.items.length; showLb(); }
  else if (e.target.closest(".lb-next")) { lb.i = (lb.i + 1) % lb.items.length; showLb(); }
  else if (!e.target.closest("#lbImg")) closeLb();
});
document.addEventListener("keydown", (e) => {
  if (document.getElementById("lightbox").hidden) return;
  if (e.key === "Escape") { e.stopPropagation(); closeLb(); }
  else if (e.key === "ArrowLeft" && lb.items.length > 1) { lb.i = (lb.i - 1 + lb.items.length) % lb.items.length; showLb(); }
  else if (e.key === "ArrowRight" && lb.items.length > 1) { lb.i = (lb.i + 1) % lb.items.length; showLb(); }
}, true);

function recChip(p) {
  if (p.rec_score == null) return "";
  return p.recommended
    ? `<span class="rec-chip hot" title="推荐分（创业者视角）">推荐 ${p.rec_score}</span>`
    : `<span class="rec-chip" title="推荐分（创业者视角）">${p.rec_score}</span>`;
}
function renderFeed(posts, opts = {}) {
  const feed = document.getElementById("feed");
  const empty = document.getElementById("empty");
  feed.innerHTML = "";
  empty.hidden = posts.length > 0;
  posts.forEach((p, idx) => {
    const el = document.createElement("article");
    el.className = "card";
    const av = avatarUrl(p.avatar);
    el.innerHTML = `
      <div class="card-head">
        ${av ? `<img class="avatar" src="${escapeHtml(av)}" alt="" />` : `<div class="avatar"></div>`}
        <div class="meta">
          <div class="name-row"><span class="name">${escapeHtml(p.display_name || p.handle)}</span><span class="tags">${p._stub ? "" : kindTags(p)}${p.section ? `<span class="badge ${escapeHtml(p.section)}">${sectionLabel[p.section] || p.section}</span>` : ""}${recChip(p)}</span></div>
          <div class="handle">@${escapeHtml(p.handle)} · ${p.created_at ? fmtTime(p.created_at) : escapeHtml(p._date || "")}${opts.follow ? `<span class="saved-at"> · ${escapeHtml((p._date || "").slice(5))} 期${p._saved_at ? ` · 关注于 ${fmtTime(p._saved_at)}` : ""}</span>` : ""}</div>
        </div>
      </div>
      <div class="summary">${escapeHtml(p.summary_zh || "")}</div>
      ${p.rec_reason ? `<div class="rec-reason${p.recommended ? " hot" : ""}"><span class="rec-reason-label">推荐理由</span>${escapeHtml(p.rec_reason)}</div>` : ""}
      ${p._stub ? `<div class="body-text">（该日数据暂不可用，仅显示已保存的信息）</div>` : p.article_summary_zh
        ? `<div class="digest"><div class="digest-label">要点总结</div><div class="digest-text">${escapeHtml(p.article_summary_zh)}</div></div>`
        : `<div class="body-text">${clip(p.text_zh || p.text)}</div>`}
      ${mediaGrid(p, { eager: idx < 4 })}
      <div class="card-foot">
        ${p._stub ? "" : `<span>♥ ${p.metrics?.likes ?? 0}</span>
        <span>↻ ${p.metrics?.reposts ?? 0}</span>
        <span>💬 ${p.metrics?.replies ?? 0}</span>`}
        <span class="spacer"></span>
        ${followBtn(p)}
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
    bindMedia(el, p);
    el.querySelector("[data-follow]").addEventListener("click", (ev) => {
      const id = ev.currentTarget.dataset.follow;
      if (follows.has(id)) follows.remove(id); else follows.add(p);
      if (opts.follow) render();
    });
    el.querySelector("[data-article]")?.addEventListener("click", () => {
      readerState.pushed = true; saveScroll();
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
  kindBox.innerHTML = post ? kindTags(post) + recChip(post) : "";
  kindBox.hidden = !post;
  const rf = document.getElementById("readerFollow");
  rf.hidden = !post;
  if (post) { rf.dataset.follow = post.id; updateFollowUI(); }
  tr.hidden = true;
  body.innerHTML = `<p class="muted">加载中…</p>`;
  saveScroll();
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
      const artHasImg = /<img[\s>]/i.test(html) || (art.images || []).length > 0;
      const pm = post && !artHasImg ? mediaGrid(post, { reader: true }) : "";
      body.innerHTML = hasH1 && pm
        ? note + html.replace(/<\/h1>/i, `</h1>${pm}`)
        : (hasH1 ? "" : `<h1>${escapeHtml(title)}</h1>`) + note + pm + html;
      if (pm && post) bindMedia(body, post);
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

// Keep the feed exactly where it was while the reader is open/closed.
// (Bug was: closing set location.hash = "", and navigating to the empty fragment scrolls the page to the top.)
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const readerState = { y: null, pushed: false };
function saveScroll() { if (readerState.y == null) readerState.y = window.scrollY; }
function restoreScroll() {
  const y = readerState.y; readerState.y = null;
  if (y == null) return;
  window.scrollTo(0, y);
  requestAnimationFrame(() => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y); });
}
function hideReader() {
  document.getElementById("reader").hidden = true;
  document.getElementById("readerBody").innerHTML = "";
  document.body.style.overflow = "";
  restoreScroll();
}
function closeReader() {
  hideReader();
  if (parseArticleHash()) history.replaceState(null, "", location.pathname + location.search);
}
// close via button / Esc / backdrop: pop the history entry we pushed (same as browser back);
// deep-linked articles (no entry pushed by us) just drop the hash without navigating.
function requestCloseReader() {
  if (document.getElementById("reader").hidden) return;
  if (parseArticleHash() && readerState.pushed) { readerState.pushed = false; history.back(); }
  else { readerState.pushed = false; closeReader(); }
}

function onHashChange() {
  const id = parseArticleHash();
  if (id) openArticle(id);
  else { readerState.pushed = false; if (!document.getElementById("reader").hidden) hideReader(); }
}

document.getElementById("closeReader").onclick = requestCloseReader;
document.getElementById("reader").addEventListener("click", (e) => {
  if (e.target.id === "reader") requestCloseReader();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("reader").hidden && document.getElementById("lightbox").hidden) requestCloseReader();
});

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-section]");
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

// sort / filter / follow-view controls
function syncSortUI() {
  document.querySelectorAll("#sortSeg button").forEach(b => {
    const on = b.dataset.sort === state.sort; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on);
  });
  const r = document.getElementById("recOnly"); r.classList.toggle("on", state.recOnly); r.setAttribute("aria-pressed", state.recOnly);
}
document.getElementById("sortSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sort]"); if (!b) return;
  state.sort = b.dataset.sort; localStorage.setItem(LS_SORT, state.sort); syncSortUI(); render();
});
document.getElementById("recOnly").addEventListener("click", () => { state.recOnly = !state.recOnly; syncSortUI(); render(); });
function setView(v) {
  state.view = v;
  const u = new URL(location.href);
  if (v === "day") u.searchParams.delete("view"); else u.searchParams.set("view", v);
  history.replaceState(null, "", u.pathname + u.search + u.hash);
  render(); window.scrollTo({ top: 0 });
}
document.getElementById("followTab").addEventListener("click", () => setView(state.view === "follow" ? "day" : "follow"));
document.getElementById("configLink").addEventListener("click", (e) => { e.preventDefault(); setView(state.view === "config" ? "day" : "config"); });
document.getElementById("followToday").addEventListener("click", () => { state.followToday = !state.followToday; render(); });
// export-time enrichment (source of truth = the day JSON): media with absolute URLs, texts, article link
const absUrl = (rel) => new URL(rel, document.baseURI).href;
function exportMedia(p) {
  return (p.media || []).filter(m => m.src || m.poster).map(m => {
    const o = m.type === "photo"
      ? { type: "photo", url: absUrl(mediaUrl(m.src)), original_url: m.orig || null, width: m.w ?? null, height: m.h ?? null, alt: m.alt || null }
      : { type: m.type, video_url: m.local_mp4 ? absUrl(mediaUrl(m.local_mp4)) : (m.mp4 || null),
          ...(m.local_mp4 && m.mp4 ? { original_video_url: m.mp4 } : {}),
          poster: absUrl(mediaUrl(m.poster)), width: m.w ?? null, height: m.h ?? null, duration_ms: m.duration_ms ?? null };
    if (m.from_quote) o.quoted = true;
    return o;
  });
}
async function enrichFollow(it) {
  let p = findPost(it.id);
  if (!p && it.date) { try { await ensureDay(it.date); p = findPost(it.id); } catch { /* day missing: keep stored fields */ } }
  if (!p) return it;
  const out = { ...it,
    summary_zh: p.summary_zh || it.title || "", text_zh: p.text_zh || null, text: p.text || null,
    media: exportMedia(p) };
  if (p.is_article && p.article_id) {
    out.article_title_zh = p.article_title_zh || p.article_title || null;
    out.article_summary_zh = p.article_summary_zh || null;
    const u = new URL(document.baseURI); u.search = ""; u.hash = "";
    if (it.date || p._date) u.searchParams.set("date", it.date || p._date);
    out.article_link = `${u.href}#/article/${encodeURIComponent(p.article_id)}`;
  }
  return out;
}
document.getElementById("followExport").addEventListener("click", async () => {
  flash("正在导出（含图片与视频链接）…");
  const items = await Promise.all(follows.all().map(enrichFollow));
  const nMedia = items.reduce((n, it) => n + ((it.media || []).length), 0);
  const payload = { app: "ai-digest", kind: "follows", version: 2, exported_at: new Date().toISOString(), items };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ai-digest-follows-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash(`已导出 ${items.length} 条关注（${nMedia} 个图片/视频）`);
});
document.getElementById("followImport").addEventListener("click", () => document.getElementById("followFile").click());
document.getElementById("followFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : Object.values(data || {});
    const n = follows.merge(items.filter(it => it && typeof it === "object" && it.id));
    flash(`已导入 ${n} 条关注`);
    render();
  } catch (err) { flash("导入失败：文件不是有效的关注导出 JSON"); }
});
document.getElementById("readerFollow").addEventListener("click", (e) => toggleFollow(e.currentTarget.dataset.follow));
window.addEventListener("storage", (e) => { if (e.key === LS_FOLLOW) { updateFollowUI(); if (state.view === "follow") render(); } });
function flash(msg) {
  const el = document.getElementById("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 2600);
}
syncSortUI();

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
