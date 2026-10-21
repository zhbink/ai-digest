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
    o[p.id].updated_at = new Date().toISOString();
    this.save(o);
    sync.enqueue({ op: "follow.put", id: String(p.id), item: o[p.id], at: o[p.id].updated_at });
  },
  remove(id) { const o = this.load(); delete o[id]; this.save(o); sync.enqueue({ op: "follow.del", id: String(id) }); },
  merge(items) {
    const o = this.load(); let n = 0, nc = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const cur = o[it.id];
      // v1–v4 exports all work; comments (v3) merge into the comments store; export-only enrichment (media, texts, article link) is not stored
      if (Array.isArray(it.comments)) nc += comments.merge(String(it.id), it.comments);
      const { media, comments: _c, text, text_zh, summary_zh, followed, followed_at, article_title_zh, article_summary_zh, article_link, ...base } = it;
      if (!base.title && summary_zh) base.title = summary_zh;
      if (!cur || String(it.saved_at || "") > String(cur.saved_at || "")) {
        o[it.id] = { ...cur, ...base, id: String(it.id) }; n++;
        sync.enqueue({ op: "follow.put", id: String(it.id), item: o[it.id], at: o[it.id].updated_at || o[it.id].saved_at });
      }
    }
    this.save(o); this.lastComments = nc; return n;
  },
};
// ---- 评论 (personal notes) in localStorage: {<post id>: [{id,text,created_at,updated_at}]}
const LS_COMMENTS = "aidigest.comments";
const comments = {
  load() {
    try { const o = JSON.parse(localStorage.getItem(LS_COMMENTS) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
    catch { return {}; }
  },
  save(o) { localStorage.setItem(LS_COMMENTS, JSON.stringify(o)); },
  get(pid) { return [...(this.load()[pid] || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))); },
  count(pid) { return (this.load()[pid] || []).length; },
  add(pid, text) {
    const o = this.load(), now = new Date().toISOString();
    const c = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, created_at: now, updated_at: now };
    (o[pid] = o[pid] || []).push(c); this.save(o);
    sync.enqueue({ op: "comment.put", pid: String(pid), cid: c.id, item: c, at: c.updated_at });
    return c;
  },
  update(pid, cid, text) {
    const o = this.load(); const c = (o[pid] || []).find(x => x.id === cid);
    if (c) { c.text = text; c.updated_at = new Date().toISOString(); this.save(o); sync.enqueue({ op: "comment.put", pid: String(pid), cid, item: c, at: c.updated_at }); }
  },
  remove(pid, cid) {
    const o = this.load(); o[pid] = (o[pid] || []).filter(x => x.id !== cid);
    if (!o[pid].length) delete o[pid];
    this.save(o);
    sync.enqueue({ op: "comment.del", pid: String(pid), cid });
  },
  merge(pid, list) {   // import: union by comment id, newer updated_at wins
    if (!Array.isArray(list) || !list.length) return 0;
    const o = this.load(), cur = o[pid] || []; let n = 0;
    for (const c of list) {
      if (!c || typeof c.text !== "string") continue;
      const id = c.id || `c${Date.parse(c.created_at || "") || Date.now()}`;
      const i = cur.findIndex(x => x.id === id);
      const item = { id, text: c.text, created_at: c.created_at || new Date().toISOString(), updated_at: c.updated_at || c.created_at || new Date().toISOString() };
      if (i < 0) { cur.push(item); n++; }
      else if (String(item.updated_at) > String(cur[i].updated_at || "")) { cur[i] = item; n++; }
      else continue;
      sync.enqueue({ op: "comment.put", pid: String(pid), cid: id, item, at: item.updated_at });
    }
    if (cur.length) o[pid] = cur;
    this.save(o); return n;
  },
};
// ---- 访问密码 + 云同步: the page is gated by a password = the Worker's ACCESS_KEY (verified server-side via /health).
// After login the Cloudflare Worker (worker/) is the source of truth; localStorage = offline cache.
// Writes go to a persistent queue (aidigest.syncQueue) and are flushed as /batch ops (last-writer-wins per item on the server).
const SYNC_ENABLED = true;
const SYNC_DEFAULT_URL = "https://ai-digest-sync.zhbink.workers.dev";   // not secret; the password is entered once per browser
const LS_SYNC = "aidigest.sync", LS_SYNCQ = "aidigest.syncQueue", LS_SYNCR = "aidigest.syncRecent";
const syncFeature = SYNC_ENABLED || new URLSearchParams(location.search).get("sync") === "dev" || localStorage.getItem("aidigest.syncDev") === "1";
const sync = {
  status: "syncing", lastError: "", started: false, applying: false, flushing: false, retryMs: 0, timer: 0,
  cfg() { try { const c = JSON.parse(localStorage.getItem(LS_SYNC) || "null"); return c && c.key && c.url ? c : null; } catch { return null; } },
  on() { return syncFeature && !!this.cfg(); },
  _get(k) { try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } },
  queue() { return this._get(LS_SYNCQ); },
  setQueue(q) { localStorage.setItem(LS_SYNCQ, JSON.stringify(q)); },
  enqueue(op) {
    if (!this.on() || this.applying) return;
    op.at = op.at || new Date().toISOString();
    const q = this.queue(); q.push(op); this.setQueue(q);
    this.setStatus("syncing");
    clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 300);
  },
  async req(method, path, body, cfg = this.cfg()) {
    const r = await fetch(cfg.url.replace(/\/+$/, "") + path, { method, cache: "no-store",
      headers: { Authorization: `Bearer ${cfg.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(data?.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
  },
  async flush() {
    if (!this.on() || this.flushing) return;
    let q = this.queue();
    if (!q.length) { if (this.status !== "error") this.setStatus("ok"); return; }
    this.flushing = true; this.setStatus("syncing");
    try {
      while ((q = this.queue()).length) {
        const batch = q.slice(0, 200);
        const r = await this.req("POST", "/batch", { ops: batch });
        const bad = (r.results || []).filter(x => !x.ok);
        if (bad.length) console.warn("sync: rejected ops", bad);
        const sent = Date.now();
        this.setRecent([...this.recent(), ...batch.map(op => ({ op, sent }))]);
        this.setQueue(this.queue().slice(batch.length));
      }
      this.retryMs = 0; this.setStatus("ok");
    } catch (e) { this.fail(e); }
    finally { this.flushing = false; }
  },
  // ops sent in the last 2 min are re-applied after a pull, so KV's eventual consistency can't make fresh edits flicker away
  recent() { const t = Date.now() - 120000; return this._get(LS_SYNCR).filter(x => x.sent > t); },
  setRecent(l) { localStorage.setItem(LS_SYNCR, JSON.stringify(l.slice(-500))); },
  async pull() {
    if (!this.on()) return false;
    this.setStatus("syncing");
    try {
      const s = await this.req("GET", "/state");
      this.applying = true;
      const f = {}; for (const [id, it] of Object.entries(s.follows || {})) f[id] = it;
      const c = {}; for (const [pid, l] of Object.entries(s.comments || {})) c[pid] = l.map(({ id, text, created_at, updated_at }) => ({ id, text, created_at, updated_at }));
      localStorage.setItem(LS_FOLLOW, JSON.stringify(f)); localStorage.setItem(LS_COMMENTS, JSON.stringify(c));
      for (const x of this.recent()) applyLocalOp(x.op);
      for (const op of this.queue()) applyLocalOp(op);
      this.applying = false;
      this.lastPull = Date.now();
      if (!this.queue().length) this.setStatus("ok");
      refreshUserData();
      return true;
    } catch (e) { this.applying = false; this.fail(e); return false; }
  },
  fail(e) {
    if (e.status === 401) { this.logout({ keepCache: true }); showGate("密码已失效，请重新输入"); return; }
    const auth = e.status === 403;
    const prev = this.status;
    this.lastError = auth ? "同步被拒绝（403）" : (navigator.onLine === false || !e.status) ? "网络不可用" : `服务器错误：${e.message}`;
    this.setStatus(auth ? "error" : "offline");
    if (prev !== this.status) flash(auth ? this.lastError : `同步失败：${this.lastError}${this.queue().length ? `，已暂存 ${this.queue().length} 项，稍后自动重试` : ""}`);
    if (!auth) {
      this.retryMs = Math.min(60000, (this.retryMs || 2500) * 2);
      clearTimeout(this.timer); this.timer = setTimeout(() => this.flush().then(() => this.queue().length || this.pull()), this.retryMs);
    }
  },
  setStatus(st) { this.status = st; updateSyncUI(); },
  async connect(url, key) {      // throws (e.status === 401) on a wrong password; only stores the key once verified
    const cfg = { url: url.trim().replace(/\/+$/, ""), key: key.trim() };
    await this.req("GET", "/health", null, cfg);
    localStorage.setItem(LS_SYNC, JSON.stringify(cfg));
    // first connect: migrate this browser's follows + comments (server keeps the newer version of each item)
    const ops = [];
    for (const it of Object.values(follows.load())) ops.push({ op: "follow.put", id: String(it.id), item: it, at: it.updated_at || it.saved_at });
    for (const [pid, l] of Object.entries(comments.load())) for (const c of l) ops.push({ op: "comment.put", pid: String(pid), cid: c.id, item: c, at: c.updated_at || c.created_at });
    this.setQueue([...ops, ...this.queue()]);
    return ops.length;            // caller reveals the app, then init() flushes + pulls
  },
  logout({ keepCache = false } = {}) {
    clearTimeout(this.timer);
    localStorage.removeItem(LS_SYNC);
    if (!keepCache) for (const k of [LS_SYNCQ, LS_SYNCR, LS_FOLLOW, LS_COMMENTS]) localStorage.removeItem(k);   // data lives on the server
    this.status = "syncing"; this.lastError = "";
  },
  init() {
    if (!syncFeature || !this.on()) return;
    this.flush().then(() => this.pull());
    if (this.started) return;
    this.started = true;
    addEventListener("online", () => this.flush().then(() => this.pull()));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - (this.lastPull || 0) > 20000) this.flush().then(() => this.pull()); });
    setInterval(() => { if (document.visibilityState === "visible" && !this.queue().length) this.pull(); }, 90000);
  },
};
function applyLocalOp(op) {   // mirror of the server's LWW rules, applied to the cache
  const at = op.at || "";
  if (op.op === "follow.put" || op.op === "follow.del") {
    const o = follows.load(), cur = o[op.id];
    if (cur && String(cur.updated_at || cur.saved_at || "") > at) return;
    if (op.op === "follow.put") o[op.id] = { ...op.item, id: op.id, updated_at: at }; else delete o[op.id];
    localStorage.setItem(LS_FOLLOW, JSON.stringify(o));
  } else if (op.op === "comment.put" || op.op === "comment.del") {
    const o = comments.load(), l = o[op.pid] || [], i = l.findIndex(x => x.id === op.cid);
    if (i >= 0 && String(l[i].updated_at || "") > at) return;
    if (op.op === "comment.put") { const { id, text, created_at, updated_at } = { ...op.item, id: op.cid }; const it = { id, text, created_at, updated_at: updated_at || at }; if (i >= 0) l[i] = it; else l.push(it); }
    else if (i >= 0) l.splice(i, 1);
    if (l.length) o[op.pid] = l; else delete o[op.pid];
    localStorage.setItem(LS_COMMENTS, JSON.stringify(o));
  }
}
function refreshUserData() {   // after a pull: refresh follow buttons, counts, comment boxes without disturbing open editors
  updateFollowUI();
  if (state.view === "follow") { render(); return; }
  for (const [pid, e] of cmEntries) if (!e.box.querySelector("textarea")) renderComments(e.box, e.post, { focus: false }); else cmChanged(pid);
  const rb = document.getElementById("readerComments");
  if (readerPost && rb && !rb.querySelector("textarea")) renderComments(rb, readerPost, { focus: false });
}
const SYNC_LABEL = { ok: "☁ 已同步", syncing: "☁ 同步中…", offline: "☁ 离线", error: "☁ 同步出错" };
function updateSyncUI() {
  if (!syncFeature) return;
  const st = sync.status, n = sync.queue().length;
  const txt = SYNC_LABEL[st] + (st === "offline" && n ? ` (${n})` : "");
  const title = st === "ok" ? "关注和评论已同步到云端" : st === "error" || st === "offline" ? sync.lastError : "正在同步…";
  for (const el of document.querySelectorAll("[data-sync-status]")) { el.hidden = false; el.textContent = txt; el.dataset.st = st; el.title = title; }
  const dot = document.getElementById("mbMore"); if (dot) dot.dataset.sync = st;
}
function openSyncDialog() {
  const d = document.getElementById("syncDialog"), n = sync.queue().length;
  d.querySelector("#syncMsg").textContent = `${SYNC_LABEL[sync.status]}${sync.lastError && sync.status !== "ok" && sync.status !== "syncing" ? ` · ${sync.lastError}` : ""}${n ? ` · ${n} 项待上传` : ""}`;
  d.hidden = false; d.querySelector("[data-sync-close].btn").focus({ preventScroll: true });
}
// ---- 访问密码页
function showGate(msg = "") {
  for (const id of ["syncDialog", "lightbox", "cmSheet"]) { const el = document.getElementById(id); if (el) el.hidden = true; }
  document.documentElement.classList.add("locked");
  const pw = document.getElementById("gatePw");
  document.getElementById("gateErr").textContent = msg;
  pw.value = ""; setTimeout(() => pw.focus({ preventScroll: true }), 50);
}
function logout() {
  const n = sync.queue().length;
  if (!confirm(n ? `还有 ${n} 项修改未上传到云端，退出后会丢失。确定退出登录？` : "退出登录？下次打开需要重新输入访问密码。")) return;
  sync.logout(); refreshUserData(); showGate();
}
document.getElementById("gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("gatePw"), err = document.getElementById("gateErr"), btn = document.getElementById("gateBtn");
  if (!pw.value.trim()) { err.textContent = "请输入访问密码"; pw.focus(); return; }
  btn.disabled = true; btn.textContent = "验证中…"; err.textContent = "";
  try {
    const n = await sync.connect(SYNC_DEFAULT_URL, pw.value);
    pw.value = "";
    document.documentElement.classList.remove("locked");
    sync.init();
    if (n) flash(`已登录，正在合并上传本机 ${n} 项`);
    scheduleRail();
  } catch (ex) {
    err.textContent = ex.status === 401 ? "密码不正确" : "无法连接验证服务，请稍后重试";
    pw.select();
  } finally { btn.disabled = false; btn.textContent = "进入"; }
});
const exportComments = (pid) => comments.get(pid).map(({ id, text, created_at, updated_at }) => ({ id, text, created_at, updated_at }));
function cmBtnLabel(pid) { const n = comments.count(pid); return `✎<span class="l"> 评论</span>${n ? ` <b class="cm-n">${n}</b>` : ""}`; }
function updateCommentUI(pid) {
  document.querySelectorAll(`[data-cm-btn="${CSS.escape(pid)}"]`).forEach(b => { b.innerHTML = cmBtnLabel(pid); b.classList.toggle("has", comments.count(pid) > 0); });
}
// renders list + (optional) editor into box; post = post object (for auto-follow)
// box.dataset.keep="1": editor always open (mobile sheet); box.dataset.empty="1": show an empty state (reader side panel)
function renderComments(box, post, { editor = false, focus = true } = {}) {
  const pid = post.id, list = comments.get(pid);
  const keep = box.dataset.keep === "1", showEmpty = box.dataset.empty === "1";
  editor = editor || keep;
  box.hidden = !editor && !list.length && !showEmpty;
  box.innerHTML = `
    ${list.length ? `<div class="cm-list">${list.map(c => `
      <div class="cm-item" data-cid="${escapeHtml(c.id)}">
        <div class="cm-meta"><span>✎ ${fmtTime(c.created_at)}${c.updated_at && c.updated_at !== c.created_at ? ` · 已编辑 ${fmtTime(c.updated_at)}` : ""}</span>
          <span class="cm-ops"><button type="button" data-cm-edit>编辑</button><button type="button" data-cm-del>删除</button></span></div>
        <div class="cm-text">${escapeHtml(c.text)}</div>
      </div>`).join("")}</div>` : (keep ? `<div class="cm-list cm-none">还没有评论，写下第一条吧。</div>` : "")}
    ${!list.length && !editor && showEmpty ? `<div class="cm-empty">还没有评论 <button type="button" class="btn ghost sm" data-cm-new>✎ 写评论</button></div>` : ""}
    ${editor ? `<div class="cm-editor">
      <textarea rows="3" placeholder="写下你的评论 / 批注（自动同步到云端）${keep ? "" : "… Ctrl/⌘+Enter 保存"}" aria-label="评论"></textarea>
      <div class="cm-actions"><span class="cm-hint">保存后自动加入我的关注</span>${keep ? "" : `<button type="button" class="btn ghost sm" data-cm-cancel>取消</button>`}<button type="button" class="btn primary sm" data-cm-save>保存</button></div>
    </div>` : ""}`;
  const rerender = (opts) => renderComments(box, post, { focus: false, ...opts });
  box.querySelector("[data-cm-new]")?.addEventListener("click", () => rerender({ editor: true, focus: true }));
  const ta = box.querySelector(".cm-editor textarea");
  if (ta) {
    if (focus) requestAnimationFrame(() => ta.focus({ preventScroll: true }));
    const save = () => {
      const text = ta.value.trim(); if (!text) { ta.focus({ preventScroll: true }); return; }
      comments.add(pid, text);
      if (!follows.has(pid)) { follows.add(post); flash("已保存评论，并加入我的关注"); } else flash("已保存评论");
      rerender({ editor: false });
      if (keep) box.querySelector(".cm-list")?.lastElementChild?.scrollIntoView({ block: "nearest" });
    };
    box.querySelector("[data-cm-save]").onclick = save;
    const cancel = box.querySelector("[data-cm-cancel]"); if (cancel) cancel.onclick = () => rerender({ editor: false });
    ta.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      else if (e.key === "Escape" && !keep) { e.preventDefault(); e.stopPropagation(); rerender({ editor: false }); }
    });
  }
  box.querySelectorAll(".cm-item").forEach(it => {
    const cid = it.dataset.cid;
    it.querySelector("[data-cm-del]").onclick = () => { if (confirm("删除这条评论？")) { comments.remove(pid, cid); rerender({ editor: !!box.querySelector(".cm-editor > textarea[aria-label='评论']") }); flash("已删除评论"); } };
    it.querySelector("[data-cm-edit]").onclick = () => {
      const c = comments.get(pid).find(x => x.id === cid); if (!c) return;
      const t = it.querySelector(".cm-text");
      t.outerHTML = `<div class="cm-editor"><textarea rows="3" aria-label="编辑评论">${escapeHtml(c.text)}</textarea>
        <div class="cm-actions"><span class="spacer"></span><button type="button" class="btn ghost sm" data-cm-cancel>取消</button><button type="button" class="btn primary sm" data-cm-save>保存</button></div></div>`;
      const ta2 = it.querySelector("textarea"); ta2.focus({ preventScroll: true });
      const save = () => { const v = ta2.value.trim(); if (!v) return; comments.update(pid, cid, v); rerender({ editor: false }); flash("已更新评论"); };
      it.querySelector("[data-cm-save]").onclick = save;
      it.querySelector("[data-cm-cancel]").onclick = () => rerender({ editor: false });
      ta2.addEventListener("keydown", e => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); rerender({ editor: false }); }
      });
      cmChanged(pid);
    };
  });
  cmChanged(pid);
}

// ---- comment placement: "side" (margin notes, wide desktop) | "inline" (under the card) | "sheet" (mobile bottom sheet)
const cmMode = () => innerWidth < 700 ? "sheet" : innerWidth >= 1200 ? "side" : "inline";
let curCmMode = null;
const cmEntries = new Map();   // pid -> {box, card, post, note}
function cmChanged(pid) {
  updateCommentUI(pid);
  updateCmPreview(pid);
  const e = cmEntries.get(pid);
  if (e) placeCm(e);
  scheduleRail();
}
function updateCmPreview(pid) {
  const e = cmEntries.get(pid); if (!e) return;
  const el = e.card.querySelector(".cm-preview"); if (!el) return;
  const list = comments.get(pid);
  el.hidden = !list.length;
  if (list.length) el.innerHTML = `<span class="cm-pv-n">✎ ${list.length} 条评论</span><span class="cm-pv-t">${escapeHtml(list[list.length - 1].text.replace(/\s+/g, " "))}</span>`;
}
function placeCm(e) {
  if (curCmMode === "side") {
    if (!e.note) {
      e.note = document.createElement("div");
      e.note.className = "cm-note"; e.note.dataset.pid = e.post.id;
      e.note.innerHTML = `<div class="cm-note-who">@${escapeHtml(e.post.handle || "")} · ${escapeHtml((e.post.summary_zh || "").slice(0, 24))}${(e.post.summary_zh || "").length > 24 ? "…" : ""}</div>`;
      const hl = (on) => { e.card.classList.toggle("cm-hl", on); e.note.classList.toggle("hl", on); };
      e.note.addEventListener("mouseenter", () => hl(true)); e.note.addEventListener("mouseleave", () => hl(false));
      e.note.addEventListener("focusin", () => hl(true)); e.note.addEventListener("focusout", () => hl(false));
      e.card.addEventListener("mouseenter", () => e.note && e.note.classList.add("hl"));
      e.card.addEventListener("mouseleave", () => e.note && e.note.classList.remove("hl"));
      // keep rail order == feed order
      const rail = document.getElementById("cmRail");
      const after = [...cmEntries.values()].slice([...cmEntries.keys()].indexOf(e.post.id) + 1).find(x => x.note && x.note.parentNode === rail);
      rail.insertBefore(e.note, after ? after.note : null);
    }
    if (e.box.parentNode !== e.note) e.note.appendChild(e.box);
    e.note.hidden = e.box.hidden;
  } else {
    if (e.box.parentNode !== e.card) e.card.appendChild(e.box);
    if (e.note) { e.note.remove(); e.note = null; }
  }
}
let railRaf = 0;
function scheduleRail() { if (!railRaf) railRaf = requestAnimationFrame(() => { railRaf = 0; layoutRail(); }); }
function layoutRail() {
  const rail = document.getElementById("cmRail"), wrap = document.getElementById("feedWrap");
  if (curCmMode !== "side") { rail.style.height = ""; wrap.style.minHeight = ""; return; }
  const top0 = wrap.getBoundingClientRect().top;
  let bottom = 0;
  for (const e of cmEntries.values()) {
    if (!e.note || e.note.hidden) continue;
    const want = e.card.getBoundingClientRect().top - top0;
    const top = Math.max(want, bottom ? bottom + 10 : 0);
    e.note.style.top = `${Math.round(top)}px`;
    e.note.classList.toggle("pushed", top - want > 4);
    bottom = top + e.note.offsetHeight;
  }
  rail.style.height = `${Math.ceil(bottom)}px`;
  wrap.style.minHeight = bottom ? `${Math.ceil(bottom)}px` : "";
}
function resetCm() {
  cmEntries.clear();
  const rail = document.getElementById("cmRail"); if (rail) rail.innerHTML = "";
  scheduleRail();
}
function placeTopControls(mobile) {
  const dp = document.getElementById("datePicker"), q = document.getElementById("search");
  const dHome = document.querySelector(".controls .field:first-child"), qHome = document.querySelector(".controls label.field");
  if (mobile) {
    document.getElementById("mbarDate").appendChild(dp);
    document.getElementById("mbarSearch").appendChild(q);
  } else {
    dHome.appendChild(dp); qHome.appendChild(q);
    document.getElementById("mbarSearch").hidden = true; document.getElementById("mbMenu").hidden = true;
  }
}
function applyCmMode(force) {
  const m = cmMode();
  if (m === curCmMode && !force) return;
  if ((m === "sheet") !== (curCmMode === "sheet") || force) placeTopControls(m === "sheet");
  curCmMode = m;
  document.body.classList.remove("cmm-side", "cmm-inline", "cmm-sheet");
  document.body.classList.add(`cmm-${m}`);
  if (m !== "sheet") closeSheet();
  for (const e of cmEntries.values()) placeCm(e);
  if (readerPost) setupReaderComments(readerPost);
  scheduleRail();
}
const railRO = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleRail()) : null;

// ---- mobile bottom sheet
const sheet = { post: null, y: 0 };
function lockBody() {
  sheet.y = window.scrollY;
  Object.assign(document.body.style, { position: "fixed", top: `-${sheet.y}px`, left: "0", right: "0", width: "100%" });
}
function unlockBody() {
  Object.assign(document.body.style, { position: "", top: "", left: "", right: "", width: "" });
  window.scrollTo(0, sheet.y);
}
function openSheet(post, { focus = false } = {}) {
  const el = document.getElementById("cmSheet"), box = document.getElementById("cmSheetBody");
  if (!sheet.post) lockBody();
  sheet.post = post;
  document.getElementById("cmSheetTitle").textContent = post.summary_zh || `@${post.handle}`;
  box.dataset.keep = "1";
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("open"));
  renderComments(box, post, { editor: true, focus });
  const list = box.querySelector(".cm-list"); if (list) list.scrollTop = list.scrollHeight;
  fitSheet();
}
function closeSheet() {
  const el = document.getElementById("cmSheet");
  if (!el || !sheet.post) return;
  const pid = sheet.post.id;
  sheet.post = null;
  el.classList.remove("open");
  document.activeElement?.blur?.();
  document.getElementById("cmSheetBody").innerHTML = "";
  el.hidden = true;
  const panel = el.querySelector(".cm-sheet-panel"); panel.style.transform = "";
  unlockBody();
  cmChanged(pid);
}
function fitSheet() {   // keep the editor above the on-screen keyboard
  const panel = document.querySelector("#cmSheet .cm-sheet-panel"), vv = window.visualViewport;
  if (!panel || !vv) return;
  const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  panel.style.bottom = `${kb}px`;
  panel.style.maxHeight = `${Math.round(vv.height - 12)}px`;
}
window.visualViewport?.addEventListener("resize", fitSheet);
window.visualViewport?.addEventListener("scroll", fitSheet);
function openComments(post, box, { fromButton = true } = {}) {
  if (curCmMode === "sheet") { openSheet(post, { focus: fromButton && !comments.count(post.id) }); return; }
  const open = !!box.querySelector(".cm-editor > textarea[aria-label='评论']");
  renderComments(box, post, { editor: !open });
}

function followBtn(p) {
  const on = follows.has(p.id);
  return `<button type="button" class="btn ghost follow${on ? " on" : ""}" data-follow="${escapeHtml(p.id)}" aria-pressed="${on}"
    title="${on ? "取消关注" : "加入我的关注"}">${on ? `★<span class="l"> 已关注</span>` : `☆<span class="l"> 关注</span>`}</button>`;
}
function updateFollowUI() {
  const n = Object.keys(follows.load()).length;
  const c = document.getElementById("followCount"); if (c) c.textContent = n;
  const mc = document.getElementById("mbFollowCount"); if (mc) mc.textContent = n;
  document.getElementById("mbFollow")?.classList.toggle("on", state.view === "follow");
  document.querySelectorAll("[data-follow]").forEach(b => {
    const on = follows.has(b.dataset.follow);
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    b.innerHTML = on ? `★<span class="l"> 已关注</span>` : `☆<span class="l"> 关注</span>`; b.title = on ? "取消关注" : "加入我的关注";
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
        p.article_summary_zh, p.rec_reason, p.discussion_summary, ...deriveKinds(p).map(k => kindLabel[k])]
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
    : "还没有关注任何内容。点卡片上的「☆ 关注」即可收藏，收藏会同步到云端，所有登录过的设备都能看到。";
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

// 热评 + 讨论观点 (top_replies / discussion_summary, written by scripts/replies.py)
function hasReplies(p) { return !!((p.top_replies && p.top_replies.length) || (p.discussion_summary && !/^暂无回复/.test(p.discussion_summary))); }
function repliesHtml(p, { open = false } = {}) {
  if (!hasReplies(p)) return "";
  const list = p.top_replies || [];
  const items = list.map(r => `<li class="hr-item">
      <div class="hr-meta"><a class="hr-who" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" title="在 X 打开这条回复"><b>${escapeHtml(r.name || r.handle)}</b> <span>@${escapeHtml(r.handle)}</span></a><span class="hr-likes" title="点赞数">♥ ${fmtNum(r.like_count ?? 0)}</span></div>
      <div class="hr-text" data-zh="${r.text_zh ? 1 : 0}">${escapeHtml(r.text_zh || r.text)}</div>
    </li>`).join("");
  const anyZh = list.some(r => r.text_zh);
  return `<section class="hr-box${open ? " open" : ""}" data-hr="${escapeHtml(p.id)}">
    <button type="button" class="hr-head" ${list.length ? "" : "disabled"} aria-expanded="${open}">
      <span class="hr-label">热评 · 讨论观点</span>
      ${list.length ? `<span class="hr-count">${list.length} 条热评<span class="hr-caret">▸</span></span>` : ""}
    </button>
    ${p.discussion_summary ? `<div class="hr-sum">${escapeHtml(p.discussion_summary)}</div>` : ""}
    ${list.length ? `<div class="hr-body"><ol class="hr-list">${items}</ol>
      <div class="hr-foot">${anyZh ? `<button type="button" class="hr-tr" data-tr="zh">查看原文</button>` : ""}<span>按点赞排序 · 已过滤作者自回复与广告</span></div></div>` : ""}
  </section>`;
}
function bindReplies(root, p) {
  const box = root.querySelector(`.hr-box[data-hr="${CSS.escape(p.id)}"]`);
  if (!box) return;
  box.querySelector(".hr-head")?.addEventListener("click", () => {
    const o = box.classList.toggle("open");
    box.querySelector(".hr-head").setAttribute("aria-expanded", o);
    scheduleRail();
  });
  box.querySelector(".hr-tr")?.addEventListener("click", (ev) => {
    const b = ev.currentTarget, toOrig = b.dataset.tr === "zh";
    box.querySelectorAll(".hr-text").forEach((t, i) => { const r = p.top_replies[i]; t.textContent = toOrig ? r.text : (r.text_zh || r.text); });
    b.dataset.tr = toOrig ? "orig" : "zh"; b.textContent = toOrig ? "显示译文" : "查看原文";
  });
}
function exportReplies(p) {
  return (p.top_replies || []).map(r => ({ author: { handle: r.handle, display_name: r.name || r.handle }, text: r.text,
    text_zh: r.text_zh || null, like_count: r.like_count ?? 0, reply_count: r.reply_count ?? 0, url: r.url, created_at: r.created_at || null }));
}
function recChip(p) {
  if (p.rec_score == null) return "";
  return p.recommended
    ? `<span class="rec-chip hot" title="推荐分（创业者视角）">推荐 ${p.rec_score}</span>`
    : `<span class="rec-chip" title="推荐分（创业者视角）">${p.rec_score}</span>`;
}
function renderFeed(posts, opts = {}) {
  const feed = document.getElementById("feed");
  resetCm();
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
      ${p._stub ? "" : repliesHtml(p)}
      <div class="card-foot">
        ${p._stub ? "" : `<span>♥ ${p.metrics?.likes ?? 0}</span>
        <span class="st-rp">↻ ${p.metrics?.reposts ?? 0}</span>
        <span>💬 ${p.metrics?.replies ?? 0}</span>`}
        <span class="spacer"></span>
        ${followBtn(p)}
        <button type="button" class="btn ghost cm-btn${comments.count(p.id) ? " has" : ""}" data-cm-btn="${escapeHtml(p.id)}" title="写评论 / 批注（自动同步到云端）">${cmBtnLabel(p.id)}</button>
        ${p.text_zh && !p.article_summary_zh ? `<button class="btn ghost tr-toggle" data-tr="zh" title="机器翻译 · 点击查看原文"><span class="l">查看原文</span><span class="s">原文</span></button>` : ""}
        ${p.is_article ? `<button class="btn primary" data-article="${escapeHtml(p.article_id)}"><span class="l">阅读全文</span><span class="s">全文</span></button>` : ""}
        <a class="btn ghost x-link" href="${escapeHtml(p.post_url)}" target="_blank" rel="noopener" title="在 X 打开原帖"><span class="l">原帖</span><span class="s">原帖 ↗</span></a>
      </div>
      <button type="button" class="cm-preview" hidden></button>`;
    el.querySelector(".tr-toggle")?.addEventListener("click", (ev) => {
      const b = ev.currentTarget, toOrig = b.dataset.tr === "zh";
      el.querySelector(".body-text").innerHTML = clip(toOrig ? p.text : p.text_zh);
      b.dataset.tr = toOrig ? "orig" : "zh";
      b.innerHTML = toOrig ? `<span class="l">显示译文</span><span class="s">译文</span>` : `<span class="l">查看原文</span><span class="s">原文</span>`;
    });
    bindMedia(el, p);
    bindReplies(el, p);
    el.querySelector(".digest")?.addEventListener("click", (ev) => { if (!getSelection().toString()) ev.currentTarget.classList.toggle("open"); });
    const cmBox = document.createElement("div"); cmBox.className = "cm-box"; cmBox.hidden = true;
    const entry = { box: cmBox, card: el, post: p, note: null };
    cmEntries.set(p.id, entry);
    el.querySelector("[data-cm-btn]").addEventListener("click", () => openComments(p, cmBox));
    el.querySelector(".cm-preview").addEventListener("click", () => openComments(p, cmBox, { fromButton: false }));
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
    renderComments(cmBox, p, { focus: false });
  });
  scheduleRail();
}

let readerPost = null;
// reader comments: right side panel on wide screens, bottom of the article otherwise (mobile: bottom sheet via the button)
function setupReaderComments(post) {
  const rbox = document.getElementById("readerComments");
  const side = curCmMode === "side";
  document.querySelector(".reader-panel").classList.toggle("with-cm", side);
  rbox.dataset.empty = side ? "1" : "";
  renderComments(rbox, post, { focus: false });
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
  readerPost = post || null;
  const rc = document.getElementById("readerCm"), rbox = document.getElementById("readerComments");
  rc.hidden = !post; rbox.hidden = true; rbox.innerHTML = "";
  document.querySelector(".reader-panel").classList.remove("with-cm");
  if (post) {
    rc.dataset.cmBtn = post.id; rc.innerHTML = cmBtnLabel(post.id); rc.classList.toggle("has", comments.count(post.id) > 0);
    setupReaderComments(post);
    rc.onclick = () => {
      if (curCmMode === "sheet") { openSheet(post, { focus: !comments.count(post.id) }); return; }
      renderComments(rbox, post, { editor: true });
      if (curCmMode !== "side") {
        const panel = document.querySelector(".reader-panel");
        panel.scrollTo({ top: rbox.offsetTop - 80, behavior: "smooth" });
      }
    };
  }
  const rr = document.getElementById("readerReplies");
  rr.innerHTML = post ? repliesHtml(post, { open: true }) : ""; rr.hidden = !(post && hasReplies(post));
  if (post) bindReplies(rr, post);
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
  closeSheet(); readerPost = null;
  document.querySelector(".reader-panel").classList.remove("with-cm");
  document.getElementById("reader").hidden = true;
  document.getElementById("readerBody").innerHTML = "";
  const rr = document.getElementById("readerReplies"); rr.innerHTML = ""; rr.hidden = true;
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
  if (e.key !== "Escape" || !document.getElementById("lightbox").hidden) return;
  if (sheet.post) { e.preventDefault(); closeSheet(); return; }
  if (!document.getElementById("reader").hidden) requestCloseReader();
});
// sheet: backdrop / ✕ close, swipe down on the header to close
(() => {
  const el = document.getElementById("cmSheet"); if (!el) return;
  el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
  const panel = el.querySelector(".cm-sheet-panel"), head = el.querySelector(".cm-sheet-head");
  let y0 = null, dy = 0;
  head.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; dy = 0; panel.style.transition = "none"; }, { passive: true });
  head.addEventListener("touchmove", (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = `translateY(${dy}px)`; }, { passive: true });
  head.addEventListener("touchend", () => {
    panel.style.transition = ""; y0 = null;
    if (dy > 80) closeSheet(); else panel.style.transform = "";
  });
})();
window.addEventListener("resize", () => { applyCmMode(); scheduleRail(); });

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
  document.getElementById("mbFollow")?.classList.toggle("on", v === "follow");
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
  if (!p) return { ...it, followed: true, followed_at: it.saved_at || null, comments: exportComments(it.id) };
  const out = { ...it, followed: true, followed_at: it.saved_at || null,
    summary_zh: p.summary_zh || it.title || "", text_zh: p.text_zh || null, text: p.text || null,
    media: exportMedia(p), comments: exportComments(p.id),
    discussion_summary: p.discussion_summary || null, top_replies: exportReplies(p), replies_fetched_at: p.replies_fetched_at || null };
  if (p.is_article && p.article_id) {
    out.article_title_zh = p.article_title_zh || p.article_title || null;
    out.article_summary_zh = p.article_summary_zh || null;
    out.article_link = articleLink(p, it.date || p._date);
  }
  return out;
}
function articleLink(p, date) {
  if (!(p.is_article && p.article_id)) return null;
  const u = new URL(document.baseURI); u.search = ""; u.hash = "";
  if (date) u.searchParams.set("date", date);
  return `${u.href}#/article/${encodeURIComponent(p.article_id)}`;
}
function externalLinks(p) {
  const urls = [p.external_url, ...((p.entities?.urls) || []).map(u => u.unwound_url || u.expanded_url)].filter(Boolean);
  return [...new Set(urls)].filter(u => !/^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)\//.test(u));
}
function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// 导出当日: every post of the selected day (all sections, ignores filters/sort), rec_score desc
document.getElementById("dayExport").addEventListener("click", async () => {
  if (!state.date) return;
  flash("正在导出当日…");
  if (sync.on()) await sync.pull();
  const day = await ensureDay(state.date);
  const fl = follows.load();   // this browser's 我的关注
  const posts = [...(day.posts || [])].sort(byRec).map(p => ({
    id: p.id, section: p.section, section_label: sectionLabel[p.section] || p.section,
    kinds: deriveKinds(p).map(k => kindLabel[k]),
    author: { handle: p.handle, display_name: p.display_name },
    created_at: p.created_at,
    title: p.summary_zh || "",
    summary: (p.is_article && p.article_summary_zh) || p.text_zh || p.text_short || p.text || "",
    text_zh: p.text_zh || null, text: p.text || null,
    rec_score: p.rec_score ?? null, recommended: !!p.recommended, rec_reason: p.rec_reason || null,
    post_url: p.post_url || null,
    article_link: articleLink(p, state.date),
    article_title_zh: p.is_article ? (p.article_title_zh || p.article_title || null) : null,
    external_links: externalLinks(p),
    media: exportMedia(p),
    discussion_summary: p.discussion_summary || null,
    top_replies: exportReplies(p),
    replies_fetched_at: p.replies_fetched_at || null,
    followed: !!fl[p.id],
    comments: exportComments(p.id),
    ...(fl[p.id] ? { followed_at: fl[p.id].saved_at || null } : {}),
  }));
  const bySec = {}; posts.forEach(p => { bySec[p.section] = (bySec[p.section] || 0) + 1; });
  const counts = { posts: posts.length, by_section: bySec, articles: posts.filter(p => p.article_link).length,
    recommended: posts.filter(p => p.recommended).length, followed: posts.filter(p => p.followed).length, commented: posts.filter(p => p.comments.length).length,
    with_replies: posts.filter(p => p.top_replies.length).length, top_replies: posts.reduce((n, p) => n + p.top_replies.length, 0), media: posts.reduce((n, p) => n + p.media.length, 0) };
  downloadJson({ app: "ai-digest", kind: "day", version: 2, date: state.date, trend_summary: day.trend_summary || "",
    exported_at: new Date().toISOString(), counts, posts }, `ai-digest-${state.date}.json`);
  flash(`已导出 ${state.date}：${posts.length} 条（${counts.media} 个图片/视频）`);
});
document.getElementById("followExport").addEventListener("click", async () => {
  flash("正在导出（含图片与视频链接）…");
  if (sync.on()) await sync.pull();
  const items = await Promise.all(follows.all().map(enrichFollow));
  const nMedia = items.reduce((n, it) => n + ((it.media || []).length), 0);
  const payload = { app: "ai-digest", kind: "follows", version: 4, exported_at: new Date().toISOString(), items };
  downloadJson(payload, `ai-digest-follows-${new Date().toISOString().slice(0, 10)}.json`);
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
    flash(`已导入 ${n} 条关注${follows.lastComments ? `、${follows.lastComments} 条评论` : ""}`);
    render();
  } catch (err) { flash("导入失败：文件不是有效的关注导出 JSON"); }
});
document.getElementById("readerFollow").addEventListener("click", (e) => toggleFollow(e.currentTarget.dataset.follow));
window.addEventListener("storage", (e) => { if (e.key === LS_COMMENTS && state.view !== "config") render(); if (e.key === LS_FOLLOW) { updateFollowUI(); if (state.view === "follow") render(); } });
function flash(msg) {
  const el = document.getElementById("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 2600);
}
syncSortUI();

window.addEventListener("hashchange", onHashChange);
applyCmMode(true);
(() => {   // mobile top bar
  const sb = document.getElementById("mbarSearch"), menu = document.getElementById("mbMenu");
  document.getElementById("mbSearch").addEventListener("click", () => {
    sb.hidden = !sb.hidden; menu.hidden = true;
    document.getElementById("mbSearch").classList.toggle("on", !sb.hidden);
    if (!sb.hidden) document.getElementById("search").focus({ preventScroll: true });
  });
  document.getElementById("mbFollow").addEventListener("click", () => document.getElementById("followTab").click());
  document.getElementById("mbMore").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest("#mbMenu")) menu.hidden = true; });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    menu.hidden = true;
    if (b.dataset.act === "config") document.getElementById("configLink").click();
    if (b.dataset.act === "export") document.getElementById(state.view === "follow" ? "followExport" : "dayExport").click();
    if (b.dataset.act === "import") document.getElementById("followImport").click();
    if (b.dataset.act === "sync") openSyncDialog();
    if (b.dataset.act === "logout") logout();
  });
  // 今日趋势: collapsed to 3 lines on mobile with 展开/收起
  const tb = document.getElementById("trendBox"), more = document.createElement("button");
  more.type = "button"; more.className = "trend-more"; more.textContent = "展开";
  more.addEventListener("click", () => { const x = tb.classList.toggle("expanded"); more.textContent = x ? "收起" : "展开"; });
  document.getElementById("trendText").after(more);
})();
if (railRO) { railRO.observe(document.getElementById("feed")); railRO.observe(document.getElementById("cmRail")); }
document.getElementById("feed").addEventListener("load", scheduleRail, true);   // images/posters change card heights

// sync UI wiring
if (syncFeature) {
  document.getElementById("syncChip").addEventListener("click", openSyncDialog);
  const d = document.getElementById("syncDialog");
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-sync-close]")) d.hidden = true; });
  d.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); d.hidden = true; } });
  document.getElementById("syncLogout").addEventListener("click", () => { d.hidden = true; logout(); });
  document.getElementById("syncNow").addEventListener("click", async () => {
    await sync.flush(); await sync.pull(); if (!d.hidden) openSyncDialog();
  });
  if (sync.on()) { sync.setStatus("syncing"); sync.init(); }     // stored key: enter right away (works offline); a 401 brings the gate back
  else showGate();
}

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
