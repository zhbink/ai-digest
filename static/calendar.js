// Lightweight popover calendar (no dependencies). window.DatePicker(root, {dates, value, onChange})
(function () {
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`;
  const CHEV = d => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d === "l" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}"/></svg>`;

  function DatePicker(root, opts) {
    const dates = [...(opts.dates || [])].sort();           // ascending
    const has = new Set(dates);
    let value = opts.value || dates[dates.length - 1];
    let view = parse(value || ymd(new Date())); view.setDate(1);
    let focus = value;
    const today = ymd(new Date());
    root.classList.add("dp");
    root.innerHTML = `
      <button type="button" class="dp-step" data-step="-1" aria-label="前一期">${CHEV("l")}</button>
      <button type="button" class="dp-trigger" aria-haspopup="dialog" aria-expanded="false">
        <span class="dp-icon">${ICON}</span><span class="dp-label"></span><span class="dp-caret">▾</span>
      </button>
      <button type="button" class="dp-step" data-step="1" aria-label="后一期">${CHEV("r")}</button>
      <div class="dp-pop" role="dialog" aria-label="选择日期" hidden>
        <div class="dp-head">
          <button type="button" class="dp-nav" data-nav="-1" aria-label="上个月">${CHEV("l")}</button>
          <div class="dp-title" aria-live="polite"></div>
          <button type="button" class="dp-nav" data-nav="1" aria-label="下个月">${CHEV("r")}</button>
        </div>
        <div class="dp-week">${["一", "二", "三", "四", "五", "六", "日"].map(w => `<span>${w}</span>`).join("")}</div>
        <div class="dp-grid" role="grid"></div>
        <div class="dp-foot">
          <span class="dp-legend"><i class="dp-dot"></i>有日报（共 ${dates.length} 期）<i class="dp-dot dp-today-dot"></i>今天</span>
          <button type="button" class="dp-latest">最新一期</button>
        </div>
      </div>`;
    const $ = s => root.querySelector(s);
    const trig = $(".dp-trigger"), pop = $(".dp-pop"), grid = $(".dp-grid");

    function label(s) {
      const d = parse(s);
      const tag = s === today ? "今天" : s === dates[dates.length - 1] ? "最新" : "";
      return `<b>${d.getMonth() + 1}月${d.getDate()}日</b><span class="dp-wd">周${WD[d.getDay()]}</span>${tag ? `<span class="dp-tag">${tag}</span>` : ""}`;
    }
    function syncTrigger() {
      $(".dp-label").innerHTML = value ? label(value) : "暂无日报";
      const i = dates.indexOf(value);
      root.querySelector('[data-step="-1"]').disabled = i <= 0;
      root.querySelector('[data-step="1"]').disabled = i < 0 || i >= dates.length - 1;
    }
    function monthBounds() {
      if (!dates.length) return [null, null];
      const a = parse(dates[0]), b = parse(dates[dates.length - 1]);
      return [new Date(a.getFullYear(), a.getMonth(), 1), new Date(b.getFullYear(), b.getMonth(), 1)];
    }
    function render() {
      $(".dp-title").textContent = `${view.getFullYear()}年${view.getMonth() + 1}月`;
      const [lo, hi] = monthBounds();
      $('[data-nav="-1"]').disabled = !!lo && view <= lo;
      $('[data-nav="1"]').disabled = !!hi && view >= hi;
      const first = new Date(view);
      const offset = (first.getDay() + 6) % 7;              // Monday-first
      const start = new Date(first); start.setDate(1 - offset);
      let html = "";
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const s = ymd(d), inMonth = d.getMonth() === view.getMonth(), ok = has.has(s);
        if (i === 35 && !inMonth) break;                    // drop an all-outside 6th row
        const cls = ["dp-day", inMonth ? "" : "out", ok ? "has" : "none", s === today ? "today" : "",
          s === value ? "sel" : ""].join(" ");
        html += `<button type="button" role="gridcell" class="${cls}" data-date="${s}" ${ok ? "" : 'aria-disabled="true"'}
          tabindex="${s === focus ? 0 : -1}" aria-selected="${s === value}" aria-label="${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}${ok ? "，有日报" : "，无日报"}${s === today ? "，今天" : ""}">
          <span>${d.getDate()}</span>${ok ? '<i class="dp-dot"></i>' : ""}</button>`;
      }
      grid.innerHTML = html;
    }
    function open() {
      focus = value; view = parse(value || today); view.setDate(1);
      render(); pop.hidden = false; trig.setAttribute("aria-expanded", "true"); root.classList.add("open");
      requestAnimationFrame(() => grid.querySelector('[tabindex="0"]')?.focus());
    }
    function close(refocus) {
      if (pop.hidden) return;
      pop.hidden = true; trig.setAttribute("aria-expanded", "false"); root.classList.remove("open");
      if (refocus) trig.focus();
    }
    function pick(s, silent) {
      if (!has.has(s)) return;
      value = s; syncTrigger(); if (!pop.hidden) render();
      if (!silent) opts.onChange?.(s);
    }
    trig.addEventListener("click", () => (pop.hidden ? open() : close(true)));
    root.querySelectorAll(".dp-step").forEach(b => b.addEventListener("click", () => {
      const i = dates.indexOf(value) + Number(b.dataset.step);
      if (dates[i]) pick(dates[i]);
    }));
    root.querySelectorAll(".dp-nav").forEach(b => b.addEventListener("click", () => {
      view.setMonth(view.getMonth() + Number(b.dataset.nav)); render();
    }));
    $(".dp-latest").addEventListener("click", () => { pick(dates[dates.length - 1]); close(true); });
    grid.addEventListener("click", e => {
      const b = e.target.closest(".dp-day"); if (!b || !has.has(b.dataset.date)) return;
      pick(b.dataset.date); close(true);
    });
    grid.addEventListener("keydown", e => {
      const map = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (map[e.key] != null || e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const d = parse(focus || value);
        if (map[e.key] != null) d.setDate(d.getDate() + map[e.key]);
        else d.setMonth(d.getMonth() + (e.key === "PageUp" ? -1 : 1));
        focus = ymd(d);
        if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) { view = new Date(d.getFullYear(), d.getMonth(), 1); }
        render(); grid.querySelector(`[data-date="${focus}"]`)?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        const b = e.target.closest(".dp-day"); if (b && has.has(b.dataset.date)) { e.preventDefault(); pick(b.dataset.date); close(true); }
      } else if (e.key === "Home") { e.preventDefault(); pick(dates[dates.length - 1], true); focus = value; render(); grid.querySelector('[tabindex="0"]')?.focus(); }
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !pop.hidden) { e.preventDefault(); close(true); } });
    document.addEventListener("pointerdown", e => { if (!root.contains(e.target)) close(false); });
    syncTrigger();
    return { open, close, set: s => pick(s, true), get value() { return value; } };
  }
  window.DatePicker = DatePicker;
})();
