/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/**
 * The Marketing screen's two roadmaps, as plain DOM code. Ported whole from
 * the claude.ai artifact it began as (agency resources/artifacts/
 * nutribiotic-marketing-roadmap.html), which already ran on a tested vanilla
 * render loop; rewriting it as React would only re-open what worked. Each
 * board is Next up (priority first, then the matrix), a six-month Gantt you
 * drag and resize, and the effort and yield matrix you place by hand;
 * marketing also carries a budget slider per project.
 *
 * The page hands in `db`, a small adapter over /api/marketing with the
 * artifact database's shape (collection(c).onSnapshot / doc(id).update / set /
 * delete / add), so this file is unchanged in how it writes.
 *
 * THE VIEW STAYS PUT (Juan, 2026-10-08). A Gantt row keeps its place for the
 * life of the page; a drag that moves a project's start never re-sorts the
 * rows under the pointer. The editor opens below the chart or matrix that
 * opened it and never scrolls the page.
 *
 * Cmd+Z undoes the last write (one stack, both boards, 50 deep, gone on
 * reload). Click a Gantt stage to select it; Delete or Backspace removes it.
 */
export function mountRoadmaps(db, writable) {
  const cleanups = [];
  const on = (t, type, fn, opt) => { t.addEventListener(type, fn, opt); cleanups.push(() => t.removeEventListener(type, fn, opt)); };

  const STAGES = [
    ["Plan","--st-plan"],["Build","--st-build"],["Approve","--st-approve"],["Launch","--st-launch"],
    ["Run","--st-run"],["Measure","--st-measure"]
  ];
  const SCOLOR = Object.fromEntries(STAGES);
  const MAX_PROJECTS = 60;
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  const now = new Date(); const TODAY = iso(now);
  /* The Gantt's window, picked per board with the toggle above it and
     remembered in this browser. "6mo" is the month grid from the first of
     this month; "30d" and "60d" run from this week's Monday to that many days
     past today, with a column per week. */
  const VIEWS = [["30d","30 days"],["60d","60 days"],["6mo","6 months"]];
  function windowFor(v){
    if(v === "30d" || v === "60d"){
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (v === "30d" ? 30 : 60) + 1);
      return [start, end];
    }
    return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth()+7, 1)];
  }
  function ticksFor(v, w0, w1){
    const t = [];
    if(v === "6mo"){
      for(let d = new Date(w0); d < w1; d = new Date(d.getFullYear(), d.getMonth()+1, 1))
        t.push({d, label: d.toLocaleDateString("en-US",{month:"short"}) + (d.getMonth()===0 || !t.length ? " "+d.getFullYear() : "")});
    } else {
      for(let d = new Date(w0); d < w1; d = new Date(d.getFullYear(), d.getMonth(), d.getDate()+7))
        t.push({d, label: d.toLocaleDateString("en-US",{month:"short",day:"numeric"})});
    }
    return t;
  }
  const readView = k => { try{ const v = localStorage.getItem("rm-view-" + k); return VIEWS.some(([x]) => x === v) ? v : "6mo"; }catch{ return "6mo"; } };
  const pd = s => new Date(s+"T00:00:00");
  const fmt = s => { const d = pd(s); return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:d.getFullYear()!==now.getFullYear()?"numeric":undefined}); };
  const DAY = 864e5;
  const addDays = (d, n) => { const x = pd(d); x.setDate(x.getDate() + n); return iso(x); };

  /* undo: one stack across both roadmaps, each entry the doc as it was before a write */
  const UNDO = [], UNDO_MAX = 50;
  let SEL = null;
  const snapOf = p => { if(!p) return null; const d = JSON.parse(JSON.stringify(p)); delete d.id; return d; };
  const typing = t => !!(t && t.closest && t.closest("input,textarea,select,[contenteditable]"));
  function remember(e){ UNDO.push(e); if(UNDO.length > UNDO_MAX) UNDO.shift(); }
  async function undo(){
    const u = UNDO.pop(); if(!u) return;
    const ref = u.db.collection(u.col).doc(u.id);
    try{ if(u.before) await ref.set(u.before); else await ref.delete(); u.after(); }
    catch{ u.fail(); }
  }
  on(document, "keydown", e => {
    if((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing(e.target)){ e.preventDefault(); undo(); }
  });
  const legend = STAGES.map(([n,v]) => `<span><i style="background:var(${v})"></i>${n}</span>`).join("") + '<span><i style="background:var(--rust);width:2px"></i>Today</span>';
  if(!document.getElementById("stage-opts")) document.body.insertAdjacentHTML("beforeend", `<datalist id="stage-opts">${STAGES.map(([n]) => `<option value="${n}"></option>`).join("")}</datalist>`);

  function boardHTML(k, withBudget){
    return `
    <section aria-labelledby="${k}-nu-h">
      <h2 id="${k}-nu-h">Next up</h2>
      <div class="next" id="${k}-next"><div class="empty">Loading.</div></div>
    </section>
    <section aria-labelledby="${k}-g-h">
      <div class="sechead"><h2 id="${k}-g-h">What needs to happen</h2>
        <div class="tools"><div class="vt" role="group" aria-label="Gantt view" id="${k}-view">${VIEWS.map(([v,l]) => `<button type="button" data-v="${v}">${l}</button>`).join("")}</div><button class="btn primary" id="${k}-add-btn" type="button">Add project</button></div>
      </div>
      <div class="legend">${legend}</div>
      <div class="status-line" id="${k}-msg" role="status"></div>
      <div class="gantt-scroll"><div class="gantt" id="${k}-gantt"></div></div>
      <div class="editor-slot" id="${k}-editor-gantt"></div>
    </section>
    <section aria-labelledby="${k}-m-h">
      <div class="sechead"><h2 id="${k}-m-h">Effort and yield</h2>
        <div class="tools"><span class="saved" id="${k}-saved">Saved</span><button class="btn primary" id="${k}-add-item" type="button">Add item</button><button class="btn" id="${k}-copy-pos" type="button">Copy positions</button></div>
      </div>
      <div class="matrix-wrap">
        <svg id="${k}-matrix" viewBox="0 0 900 520" role="img" aria-label="Effort and yield matrix, each project draggable">
          <defs>
            <linearGradient id="${k}-pg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18"></stop>
              <stop offset="50%" stop-color="var(--accent)" stop-opacity="0"></stop>
              <stop offset="100%" stop-color="var(--rust)" stop-opacity="0.08"></stop>
            </linearGradient>
          </defs>
          <rect x="90" y="30" width="770" height="420" fill="url(#${k}-pg)"></rect>
          <line x1="90" y1="450" x2="860" y2="450" stroke="var(--ink)" stroke-width="1.5"></line>
          <line x1="90" y1="30" x2="90" y2="450" stroke="var(--ink)" stroke-width="1.5"></line>
          <text class="axis-label" x="475" y="490" text-anchor="middle">EFFORT</text>
          <text class="axis-label" x="-240" y="52" text-anchor="middle" transform="rotate(-90)">YIELD</text>
          <g id="${k}-points"></g>
        </svg>
      </div>
      <div class="editor-slot" id="${k}-editor-matrix"></div>
    </section>
    ${withBudget ? `<section aria-labelledby="${k}-b-h">
      <div class="sechead"><h2 id="${k}-b-h">Budget</h2><span class="btotal" id="${k}-btotal"></span></div>
      <div class="budget" id="${k}-budget"></div>
    </section>` : ""}`;
  }

  function board(k, col, withBudget){
    const root = document.getElementById("board-" + k);
    root.innerHTML = boardHTML(k, withBudget);
    const q = id => document.getElementById(k + "-" + id);
    const canWrite = writable !== false;
    let projects = [], editing = null;
    let rowOrder = null;
    let view = readView(k), W0, W1, WDAYS;
    const setWindow = () => { [W0, W1] = windowFor(view); WDAYS = Math.round((W1 - W0) / DAY); };
    setWindow();
    const pct = s => Math.max(0, Math.min(100, (pd(s) - W0) / (W1 - W0) * 100));

    const stagesOf = p => (Array.isArray(p.stages) ? p.stages : []).filter(s => s && s.end).slice().sort((a,b)=>(a.start||a.end).localeCompare(b.start||b.end));
    function nextMs(p){ return stagesOf(p).find(s => s.end >= TODAY) || null; }
    const isDone = p => !nextMs(p);
    const firstStart = p => { const s = stagesOf(p); return s.length ? (s[0].start || s[0].end) : "9999"; };
    const lastEnd = p => { const s = stagesOf(p); return s.length ? s[s.length-1].end : "9999"; };
    const posOf = p => p.pos || [50,50];
    const score = p => (p.pos ? p.pos[1] - p.pos[0] : -999);
    const prio = p => (+p.priority > 0 ? +p.priority : 99);

    function topThree(){
      return projects.filter(p => !isDone(p)).sort((a,b) => prio(a)-prio(b) || score(b)-score(a) || posOf(b)[1]-posOf(a)[1]).slice(0,3);
    }

    function renderNext(){
      const t = topThree(), box = q("next");
      if(!projects.length){ box.innerHTML = '<div class="empty">No projects yet. Add the first with Add project.</div>'; return; }
      if(!t.length){ box.innerHTML = '<div class="empty">Every project has passed its last milestone.</div>'; return; }
      box.innerHTML = t.map((p,i) => { const m = nextMs(p);
        return `<button type="button" class="nu" data-id="${esc(p.id)}">
          <div class="top"><span class="n">${i+1}</span><h3>${esc(p.title)}</h3></div>
          <div><div class="ms">${esc(m.milestone || m.type+" done")}</div><div class="date">${fmt(m.end)}</div></div>
          <div class="ey"><span class="chip stage" style="background:var(${SCOLOR[m.type]||"--st-measure"})">${esc(m.type)}</span></div>
        </button>`; }).join("");
    }

    const inWindow = p => stagesOf(p).some(s => s.end >= iso(W0) && (s.start||s.end) < iso(W1));
    const sortedRows = () => projects.filter(p => stagesOf(p).length)
        .sort((a,b) => firstStart(a).localeCompare(firstStart(b)) || lastEnd(a).localeCompare(lastEnd(b)));
    /* The staircase order is set once, at the first paint with data; after
       that a row keeps its place, a new project joins at the bottom, and a
       deleted one leaves. Reload for a fresh staircase. The order spans every
       dated project, so switching the view hides rows outside the window
       without reshuffling the ones that stay. */
    function allRows(){
      const fresh = sortedRows();
      if(!rowOrder){ if(projects.length) rowOrder = fresh.map(p => p.id); return fresh; }
      const ids = new Set(fresh.map(p => p.id));
      rowOrder = rowOrder.filter(id => ids.has(id));
      fresh.forEach(p => { if(!rowOrder.includes(p.id)) rowOrder.push(p.id); });
      return rowOrder.map(id => projects.find(p => p.id === id));
    }
    const ganttOrder = () => allRows().filter(inWindow);
    let gdrag = null;

    function renderGantt(){
      const ticks = ticksFor(view, W0, W1);
      const cols = ticks.map((t,i) => ((i+1 < ticks.length ? ticks[i+1].d : W1) - t.d) / (W1 - W0) * 100 + "%").join(" ");
      let h = `<div class="grid-lines" style="grid-template-columns:${cols}">${ticks.map(()=>"<span></span>").join("")}</div>`;
      h += `<div class="g-row axis"><span></span><div class="months" style="grid-template-columns:${cols}">${ticks.map(t=>`<span>${esc(t.label)}</span>`).join("")}</div></div>`;
      const rows = gdrag ? gdrag.order.map(id => projects.find(p => p.id === id)).filter(Boolean) : ganttOrder();
      rows.forEach(p => {
        const live = gdrag && gdrag.pid === p.id;
        const st = live ? gdrag.cur : stagesOf(p), m = st.find(s => s.end >= TODAY) || null;
        let segs = "";
        st.forEach((s,i) => {
          const a = pct(s.start || s.end), b = pct(s.end); if(b <= 0 || a >= 100) return;
          const w = Math.max(b - a, .6), past = s.end < TODAY, act = live ? i === gdrag.idx : !!(SEL && SEL.k === k && SEL.pid === p.id && SEL.idx === i);
          segs += `<span class="seg${i===0?" first":""}${i===st.length-1?" last":""}${past?" past":""}${act?" active":""}" data-pid="${esc(p.id)}" data-i="${i}" style="left:${a}%;width:${w}%;background:var(${SCOLOR[s.type]||"--st-measure"})" title="${esc(s.type+": "+(s.milestone||"")+", "+(s.start?fmt(s.start)+" to ":"")+fmt(s.end))}">${w>7?esc(s.type):""}${canWrite?'<i class="h l"></i><i class="h r"></i>':""}</span>`;
        });
        if(m && pct(m.end) > 0 && pct(m.end) < 100) segs += `<span class="ms-dot" style="left:${pct(m.end)}%" title="${esc((m.milestone||m.type)+", "+fmt(m.end))}"></span>`;
        const sub = live ? (() => { const s = st[gdrag.idx]; return `${s.type}: ${s.start?fmt(s.start)+" to ":""}${fmt(s.end)}`; })()
          : (m ? (m.milestone||m.type+" done")+", "+fmt(m.end) : "Done");
        h += `<div class="g-row"><button type="button" class="g-name" data-id="${esc(p.id)}"><b>${esc(p.title)}</b><span>${esc(sub)}</span></button><div class="g-track">${segs}</div></div>`;
      });
      h += `<div class="today" style="left:calc(266px + (100% - 282px) * ${pct(TODAY)/100})"><b>Today</b></div>`;
      const g = q("gantt");
      g.innerHTML = h;
      g.classList.toggle("dragging", !!(gdrag && gdrag.moved));
      g.classList.toggle("resize", !!(gdrag && gdrag.mode !== "move"));
    }

    const gantt = q("gantt");
    on(gantt, "pointerdown", e => {
      const seg = e.target.closest(".seg"); if(!seg || !canWrite || e.button > 0) return;
      const p = projects.find(x => x.id === seg.dataset.pid); if(!p) return;
      const h = e.target.closest(".h");
      gdrag = { pid:p.id, idx:+seg.dataset.i, mode: h ? (h.classList.contains("l") ? "start" : "end") : "move",
        x0:e.clientX, dayPx: seg.parentElement.getBoundingClientRect().width / WDAYS, days:0, moved:false,
        orig: stagesOf(p).map(s => ({...s})), cur: stagesOf(p).map(s => ({...s})), order: ganttOrder().map(x => x.id) };
      try{ gantt.setPointerCapture(e.pointerId); }catch{}
      e.preventDefault();
    });
    on(gantt, "pointermove", e => {
      if(!gdrag) return;
      const dd = Math.round((e.clientX - gdrag.x0) / gdrag.dayPx);
      if(dd === gdrag.days) return;
      gdrag.days = dd; gdrag.moved = gdrag.moved || dd !== 0;
      const o = gdrag.orig, i = gdrag.idx;
      gdrag.cur = o.map((s,j) => {
        const c = {...s};
        if(gdrag.mode === "move" && j >= i || gdrag.mode === "end" && j > i){ if(c.start) c.start = addDays(c.start, dd); c.end = addDays(c.end, dd); }
        if(gdrag.mode === "end" && j === i){ c.end = addDays(s.end, dd); if(c.start && c.end < c.start) c.end = c.start; }
        if(gdrag.mode === "start" && j === i){ c.start = addDays(s.start || s.end, dd); if(c.start > c.end) c.start = c.end; }
        return c;
      });
      renderGantt();
    });
    async function endGanttDrag(cancel){
      if(!gdrag) return;
      const d = gdrag; gdrag = null;
      if(cancel || !d.moved){ if(!cancel){ SEL = {k, pid:d.pid, idx:d.idx}; const p = projects.find(x => x.id === d.pid); if(p) openEditor(p, {from:"gantt"}); } renderAll(); return; }
      const p = projects.find(x => x.id === d.pid), before = beforeOf(d.pid);
      if(p) p.stages = d.cur;
      render();
      try{ await write(d.pid, {stages: d.cur}, before); setMsg(""); }
      catch{ setMsg("Could not save the new dates. Try again."); }
    }
    on(gantt, "pointerup", () => endGanttDrag(false));
    on(gantt, "pointercancel", () => endGanttDrag(true));

    /* matrix. One drag at a time, tracked on the svg, which holds pointer
       capture for the whole gesture: the bubble is raised to the top before
       capture is taken, since moving a captured node releases its capture
       and that was what froze the old matrix mid-drag. A press that travels
       under 4px is a click and opens the editor. */
    const svg = q("matrix"), layer = q("points"), NS = "http://www.w3.org/2000/svg", X0=90, X1=860, Y0=30, Y1=450;
    const px = p => [X0 + p[0]/100*(X1-X0), Y1 - p[1]/100*(Y1-Y0)];
    const mk = (tag, at) => { const e = document.createElementNS(NS, tag); for(const a in at) e.setAttribute(a, at[a]); return e; };
    const placers = {};
    let mdrag = null;
    function renderMatrix(){
      if(mdrag) return;
      layer.innerHTML = "";
      const top = new Set(topThree().map(p => p.id)), seen = {};
      projects.filter(p => !stagesOf(p).length || !isDone(p)).forEach(p => {
        const key = posOf(p).join(","), dup = seen[key] = (seen[key] ?? -1) + 1;
        const pos = dup ? [posOf(p)[0], Math.max(0, posOf(p)[1] - dup*7)] : posOf(p);
        const g = mk("g", {"class":"pt"+(top.has(p.id)?" top3":"")+(p.placed?"":" draft"), tabindex:"0", "aria-label":p.title, "data-id":p.id});
        const c = mk("circle",{r:"14"}), n = mk("text",{"class":"num"}), l = mk("text",{"class":"lbl"});
        n.textContent = top.has(p.id) ? [...top].indexOf(p.id)+1 : ""; l.textContent = p.title;
        g.append(c,n,l); layer.appendChild(g);
        const place = qq => { const [x,y] = px(qq), right = x > 640;
          c.setAttribute("cx",x); c.setAttribute("cy",y); n.setAttribute("x",x); n.setAttribute("y",y);
          l.setAttribute("x", right ? x-22 : x+22); l.setAttribute("y", y+4.5); l.setAttribute("text-anchor", right?"end":"start"); };
        place(pos);
        placers[p.id] = {g, place, pos};
      });
    }
    on(svg, "pointerdown", e => {
      const g = e.target.closest(".pt"); if(!g || e.button > 0) return;
      const p = projects.find(x => x.id === g.dataset.id); if(!p) return;
      e.preventDefault();
      layer.appendChild(g);
      mdrag = {p, g, x0:e.clientX, y0:e.clientY, cur: placers[p.id].pos.slice(), moved:false};
      try{ svg.setPointerCapture(e.pointerId); }catch{}
    });
    on(svg, "pointermove", e => {
      if(!mdrag || !canWrite) return;
      if(!mdrag.moved && Math.hypot(e.clientX - mdrag.x0, e.clientY - mdrag.y0) < 4) return;
      mdrag.moved = true; mdrag.g.classList.add("dragging");
      mdrag.cur = toPlot(e); placers[mdrag.p.id].place(mdrag.cur);
    });
    const endMatrix = cancel => {
      if(!mdrag) return;
      const d = mdrag; mdrag = null; d.g.classList.remove("dragging");
      if(cancel){ renderMatrix(); return; }
      if(d.moved){ d.p.pos = d.cur; d.p.placed = true; savePos(d.p, d.cur); renderNext(); renderMatrix(); }
      else { renderMatrix(); openEditor(d.p, {from:"matrix"}); }
    };
    on(svg, "pointerup", () => endMatrix(false));
    on(svg, "pointercancel", () => endMatrix(true));
    on(svg, "keydown", e => {
      const g = e.target.closest && e.target.closest(".pt"); if(!g) return;
      const p = projects.find(x => x.id === g.dataset.id); if(!p) return;
      if(e.key === "Enter"){ e.preventDefault(); openEditor(p, {from:"matrix"}); return; }
      const d = {ArrowLeft:[-2,0],ArrowRight:[2,0],ArrowUp:[0,2],ArrowDown:[0,-2]}[e.key]; if(!d || !canWrite) return;
      e.preventDefault();
      const cur = placers[p.id].pos, nx = [Math.max(0,Math.min(100,cur[0]+d[0])), Math.max(0,Math.min(100,cur[1]+d[1]))];
      placers[p.id].pos = nx; placers[p.id].place(nx); savePos(p, nx);
    });
    function toPlot(e){ const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const r = pt.matrixTransform(svg.getScreenCTM().inverse());
      return [Math.max(0,Math.min(100,Math.round((r.x-X0)/(X1-X0)*100))), Math.max(0,Math.min(100,Math.round((Y1-r.y)/(Y1-Y0)*100)))]; }
    const timers = {}, posBefore = {};
    function savePos(p, pos){
      if(!(p.id in posBefore)) posBefore[p.id] = beforeOf(p.id);
      clearTimeout(timers[p.id]);
      timers[p.id] = setTimeout(async () => {
        const before = posBefore[p.id]; delete posBefore[p.id];
        try{ await write(p.id, {pos, placed:true}, before); const s = q("saved"); s.classList.add("on"); setTimeout(()=>s.classList.remove("on"), 1000); }
        catch{ setMsg("Could not save that position. Try again."); }
      }, 400);
    }
    on(svg, "dblclick", e => { if(!canWrite || e.target.closest(".pt")) return; openEditor(null, {from:"matrix", at: toPlot(e)}); });
    q("add-item").onclick = () => openEditor(null, {from:"matrix", at:[50,50], scroll:true});
    q("copy-pos").onclick = async () => {
      const out = Object.fromEntries(projects.map(p => [p.title, p.pos || null]));
      const txt = JSON.stringify(out), b = q("copy-pos");
      try{ await navigator.clipboard.writeText(txt); b.textContent = "Copied"; setTimeout(()=>b.textContent="Copy positions", 1200); }
      catch{ setMsg(txt); }
    };

    function setMsg(t){ q("msg").textContent = t || ""; }
    /* The doc as the database last held it. A matrix drag sets p.pos locally
       before the debounced write, so its "before" comes from the snapshot
       copy kept at load, not the live object. */
    const lastSaved = {};
    const beforeOf = id => snapOf(lastSaved[id] || projects.find(p => p.id === id));
    const undoHooks = id => ({ after: () => { if(editing && editing.id === id) closeEditor(); setMsg(""); }, fail: () => setMsg("Could not undo. Try again.") });
    async function write(id, data, before){
      await db.collection(col).doc(id).update(data);
      remember({db, col, id, before, ...undoHooks(id)});
    }

    /* budget, marketing only. Each slider runs $0 to $40,000 on its own; the
       header is the plain sum. $0 reads green, any other amount ink. */
    const BMAX = 40000, BSTEP = 250;
    const money = n => "$" + Math.round(n).toLocaleString("en-US");
    const tone = (el, v) => el.classList.toggle("zero", !v);
    let bActive = false;
    const budgetBox = q("budget");
    function showTotal(total){ const t = q("btotal"); t.textContent = money(total); tone(t, total); }
    function renderBudget(){
      if(!budgetBox || bActive) return;
      const go = allRows(), list = go.concat(projects.filter(p => !go.includes(p)));
      showTotal(list.reduce((t,p) => t + (+p.budget || 0), 0));
      const have = [...budgetBox.querySelectorAll("input[type=range]")].map(x => x.dataset.id).join("|");
      if(list.length && have === list.map(p => p.id).join("|")){
        list.forEach(p => { const v = +p.budget || 0, r = q("b-" + p.id), a = q("ba-" + p.id);
          if(r !== document.activeElement) r.value = v;
          a.textContent = money(+r.value); tone(a, +r.value);
          r.closest(".b-row").querySelector("b").textContent = p.title; });
        return;
      }
      budgetBox.innerHTML = list.length ? list.map(p => { const v = +p.budget || 0;
        return `<div class="b-row"><b>${esc(p.title)}</b>
          <div class="b-ctl"><input type="range" id="${k}-b-${esc(p.id)}" data-id="${esc(p.id)}" min="0" max="${BMAX}" step="${BSTEP}" value="${v}" aria-label="${esc(p.title)} budget" ${canWrite?"":"disabled"}>
          </div>
          <span class="b-amt${v?"":" zero"}" id="${k}-ba-${esc(p.id)}">${money(v)}</span></div>`; }).join("")
        : '<div class="empty">No projects yet.</div>';
    }
    if(budgetBox){
      on(budgetBox, "input", e => {
        const r = e.target.closest("input[type=range]"); if(!r) return;
        bActive = true;
        const a = q("ba-" + r.dataset.id); a.textContent = money(+r.value); tone(a, +r.value);
        let total = 0; budgetBox.querySelectorAll("input[type=range]").forEach(x => { total += +x.value; });
        showTotal(total);
      });
      on(budgetBox, "change", async e => {
        const r = e.target.closest("input[type=range]"); if(!r) return;
        const p = projects.find(x => x.id === r.dataset.id); bActive = false;
        if(!p) return;
        const before = beforeOf(p.id);
        p.budget = +r.value;
        try{ await write(p.id, {budget: +r.value}, before); }
        catch{ setMsg("Could not save the budget. Try again."); renderBudget(); }
      });
    }

    function render(){ renderNext(); renderGantt(); renderMatrix(); renderBudget(); }

    /* editor */
    function stageRow(s){
      return `<div class="st-row">
        <input aria-label="Stage" class="s-type" list="stage-opts" maxlength="40" value="${esc(s.type||"")}" placeholder="Stage">
        <input aria-label="Milestone" class="s-ms ms-in" maxlength="120" value="${esc(s.milestone||"")}" placeholder="Milestone">
        <input aria-label="Starts" class="s-start" type="date" value="${esc(s.start||"")}">
        <input aria-label="Milestone date" class="s-end" type="date" value="${esc(s.end||"")}">
        <button type="button" class="x" aria-label="Remove stage"><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6"><path d="M3 3l6 6M9 3l-6 6"/></svg></button></div>`;
    }
    let newPos = [50,50], slot = null;
    function openEditor(p, opt = {}){
      if(!canWrite) return;
      newPos = opt.at || [50,50];
      const target = q(opt.from === "matrix" ? "editor-matrix" : "editor-gantt");
      if(slot && slot !== target) slot.innerHTML = "";
      slot = target;
      editing = p ? JSON.parse(JSON.stringify(p)) : {title:"",link:"",stages:[]};
      const pr = +editing.priority > 0 ? +editing.priority : 0;
      slot.innerHTML = `<form class="editor">
        <div class="fgrid">
          <div class="field"><label for="${k}-e-title">Project</label><input id="${k}-e-title" required maxlength="80" value="${esc(editing.title)}"></div>
          <div class="field"><label for="${k}-e-link">Current version link</label><input id="${k}-e-link" type="url" maxlength="400" value="${esc(editing.link||"")}"></div>
          <div class="field"><label for="${k}-e-prio">Priority</label><input id="${k}-e-prio" type="number" min="1" step="1" inputmode="numeric" value="${pr||""}" placeholder="None"></div>
        </div>
        <div class="stages"><div class="st-head"><span>Stage</span><span>Milestone</span><span>Starts</span><span>Milestone date</span><span></span></div>
          <div class="st-list">${stagesOf(editing).concat((editing.stages||[]).filter(s=>!s.end)).map(stageRow).join("")}</div>
          <div><button type="button" class="btn quiet st-add">Add stage</button></div></div>
        <div class="erow"><div class="tools"><button class="btn primary" type="submit">Save</button><button class="btn quiet e-cancel" type="button">Cancel</button>${editing.link?`<a class="btn quiet" href="${esc(editing.link)}" target="_blank" rel="noopener">Open current version</a>`:""}</div>
        ${p?'<button class="btn danger e-del" type="button">Delete</button>':""}</div>
      </form>`;
      const list = slot.querySelector(".st-list");
      list.addEventListener("click", e => { const x = e.target.closest(".x"); if(x) x.closest(".st-row").remove(); });
      slot.querySelector(".st-add").onclick = () => { const rows = list.querySelectorAll(".s-end"); const last = rows.length ? rows[rows.length-1].value : TODAY; list.insertAdjacentHTML("beforeend", stageRow({type:"Build",start:last||TODAY,end:""})); };
      slot.querySelector("form").addEventListener("submit", save);
      slot.querySelector(".e-cancel").onclick = closeEditor;
      const del = slot.querySelector(".e-del"); if(del) del.onclick = () => { if(del.dataset.armed){ remove(); return; } del.dataset.armed = "1"; del.textContent = "Tap again to delete"; setTimeout(()=>{ if(del.isConnected){ delete del.dataset.armed; del.textContent = "Delete"; } }, 3000); };
      if(opt.scroll) slot.scrollIntoView({block:"nearest", behavior:"smooth"});
      if(opt.focus) q("e-title").focus({preventScroll:true});
    }
    function closeEditor(){ editing = null; if(slot) slot.innerHTML = ""; setMsg(""); }
    async function save(e){
      e.preventDefault();
      const stages = [...slot.querySelectorAll(".st-list .st-row")].filter(r => r.querySelector(".s-end").value || r.querySelector(".s-ms").value.trim() || r.querySelector(".s-type").value.trim()).map(r => ({type:r.querySelector(".s-type").value.trim(), milestone:r.querySelector(".s-ms").value.trim(), start:r.querySelector(".s-start").value, end:r.querySelector(".s-end").value}));
      const title = q("e-title").value.trim();
      if(!title){ setMsg("Name the project first."); return; }
      if(stages.some(s => !s.type)){ setMsg("Name every stage."); return; }
      if(stages.some(s => !s.end)){ setMsg("Every stage needs a milestone date."); return; }
      if(stages.some(s => s.start && s.start > s.end)){ setMsg("A stage starts after its milestone date."); return; }
      const pr = parseInt(q("e-prio").value, 10);
      const body = {title, link:q("e-link").value.trim(), stages, priority: pr > 0 ? pr : null};
      try{
        if(editing.id) await write(editing.id, body, beforeOf(editing.id));
        else {
          if(projects.length >= MAX_PROJECTS){ setMsg(`The roadmap holds ${MAX_PROJECTS} projects. Delete a finished one first.`); return; }
          const ref = await db.collection(col).add({...body, pos:newPos, placed:!!(newPos[0]!==50||newPos[1]!==50)});
          remember({db, col, id:ref.id, before:null, ...undoHooks(ref.id)});
        }
        closeEditor();
      }catch{ setMsg("Could not save. Try again."); }
    }
    async function remove(){
      const id = editing.id, before = beforeOf(id);
      try{ await db.collection(col).doc(id).delete(); remember({db, col, id, before, ...undoHooks(id)}); closeEditor(); }
      catch{ setMsg("Could not delete. Try again."); }
    }
    async function removeStage(){
      const p = projects.find(x => x.id === SEL.pid), idx = SEL.idx; SEL = null;
      if(!p || !canWrite){ renderAll(); return; }
      const before = beforeOf(p.id), stages = stagesOf(p).filter((s, i) => i !== idx);
      p.stages = stages;
      if(editing && editing.id === p.id) openEditor(p, {from: slot && slot.id.endsWith("matrix") ? "matrix" : "gantt"});
      render();
      try{ await write(p.id, {stages}, before); }
      catch{ setMsg("Could not delete that stage. Try again."); }
    }

    on(root, "click", e => {
      const el = e.target.closest(".nu,.g-name"); if(!el) return;
      const p = projects.find(x => x.id === el.dataset.id); if(p) openEditor(p, {from:"gantt", scroll: el.classList.contains("nu")});
    });
    on(document, "keydown", e => {
      if(e.key === "Escape"){ if(SEL && SEL.k === k){ SEL = null; renderAll(); } if(editing) closeEditor(); }
      if((e.key === "Delete" || e.key === "Backspace") && SEL && SEL.k === k && !typing(e.target)){ e.preventDefault(); removeStage(); }
    });
    const vt = q("view");
    const paintView = () => vt.querySelectorAll("button").forEach(b => { const on = b.dataset.v === view; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    paintView();
    vt.onclick = e => { const b = e.target.closest("button"); if(!b || b.dataset.v === view) return;
      view = b.dataset.v; try{ localStorage.setItem("rm-view-" + k, view); }catch{ /* private window: the choice lasts this visit */ }
      setWindow(); paintView(); renderGantt(); };
    q("add-btn").onclick = () => openEditor(null, {from:"gantt", scroll:true, focus:true});
    if(!canWrite){ ["add-btn","add-item"].forEach(id => q(id).hidden = true); }
    render();

    const unsub = db.collection(col).onSnapshot(snap => {
      projects = snap.docs.map(d => ({id:d.id, ...d.data()}));
      Object.keys(lastSaved).forEach(id => delete lastSaved[id]);
      projects.forEach(p => { lastSaved[p.id] = JSON.parse(JSON.stringify(p)); });
      if(editing && editing.id && !projects.some(p => p.id === editing.id)) closeEditor();
      render();
    }, () => setMsg("Could not load the roadmap. Reload the page."));
    if(typeof unsub === "function") cleanups.push(unsub);

    return { render: () => renderGantt() };
  }

  const boards = [board("mk", "projects", true), board("sl", "sales", false)];
  function renderAll(){ boards.forEach(b => b.render()); }
  on(document, "pointerdown", e => { if(SEL && !e.target.closest(".seg,.editor-slot")){ SEL = null; renderAll(); } });

  return () => cleanups.forEach(f => f());
}
