/**
 * The SDR Calls widget's drawing code, served at /nb/api/widget/sdr/script.
 * PUBLIC on purpose: no token, no customer data. The bootstrap on the phone
 * holds the bearer and passes it in as `NB`; every fact is fetched at render
 * time from /nb/api/widget/sdr. Same family as the Field Route widget
 * (widget-script.ts): same colors, same type, same bootstrap.
 *
 * The body is a Scriptable script, kept in one String.raw so there is a
 * single source. It therefore uses NO backticks and NO ${} interpolation.
 */
export const SDR_WIDGET_SCRIPT = String.raw`
// SDR Calls widget (Scriptable / WidgetKit). Expects NB.base and NB.token.
const INK = Color.dynamic(new Color("#14201B"), new Color("#F2F1EA"));
const MUTED = Color.dynamic(new Color("#5B6560"), new Color("#A7AFA9"));
const FAINT = Color.dynamic(new Color("#8A928C"), new Color("#78817B"));
const PAPER = Color.dynamic(new Color("#F7F6F1"), new Color("#121815"));
const RULE = Color.dynamic(new Color("#E2DFD5"), new Color("#2A332E"));
const GREEN = Color.dynamic(new Color("#2C6A46"), new Color("#63A57E"));
const RED = new Color("#B5372A");
const PILL = Color.dynamic(new Color("#ECEAE1"), new Color("#232C27"));
const SELF = encodeURIComponent(Script.name());

const RESULTS = [
  ["Reached", "reached"],
  ["No answer", "no_answer"],
  ["No decision maker", "no_decision_maker"],
  ["Declined", "declined"],
  ["Call back tomorrow", "call_back_tomorrow"],
  ["Call back next week", "call_back_next_week"],
];

function txt(on, s, o) {
  o = o || {};
  const t = on.addText(s);
  t.font = o.bold ? Font.semiboldSystemFont(o.size || 12) : Font.systemFont(o.size || 12);
  t.textColor = o.color || INK;
  t.lineLimit = o.lines || 1;
  return t;
}
function qs(o) {
  return Object.keys(o).map(function (k) { return k + "=" + encodeURIComponent(o[k]); }).join("&");
}
function runUrl(o) {
  return "scriptable:///run/" + SELF + "?" + qs(o);
}

function header(w, data, compact) {
  const row = w.addStack();
  row.centerAlignContent();
  txt(row, "SDR calls", { size: compact ? 11 : 12, bold: true, color: MUTED });
  row.addSpacer();
  txt(row, data.done + " of " + data.target, { size: compact ? 11 : 12, bold: true, color: data.done >= data.target ? GREEN : INK });
}

/* One segment per call in the day's target, filled as calls are made. */
function progress(w, data, width) {
  const bar = w.addStack();
  bar.centerAlignContent();
  const gap = 3;
  const seg = Math.floor((width - gap * (data.target - 1)) / data.target);
  for (let i = 0; i < data.target; i++) {
    const s = bar.addStack();
    s.size = new Size(seg, 4);
    s.cornerRadius = 2;
    s.backgroundColor = i < data.done ? GREEN : RULE;
    if (i < data.target - 1) bar.addSpacer(gap);
  }
}

function divider(w) {
  const d = w.addStack();
  d.size = new Size(0, 1);
  d.backgroundColor = RULE;
  d.addSpacer();
}

function callPill(on, c, compact) {
  const b = on.addStack();
  b.url = c.tel_url;
  b.centerAlignContent();
  b.setPadding(compact ? 4 : 6, compact ? 9 : 11, compact ? 4 : 6, compact ? 9 : 11);
  b.cornerRadius = 7;
  b.backgroundColor = GREEN;
  const img = b.addImage(SFSymbol.named("phone.fill").image);
  img.imageSize = new Size(compact ? 10 : 11, compact ? 10 : 11);
  img.tintColor = new Color("#FFFFFF");
  b.addSpacer(4);
  const t = b.addText("Call");
  t.font = Font.semiboldSystemFont(compact ? 10.5 : 11.5);
  t.textColor = new Color("#FFFFFF");
}

function callRow(w, c, sizes) {
  const row = w.addStack();
  row.centerAlignContent();
  const col = row.addStack();
  col.layoutVertically();
  col.url = runUrl({ pick: c.id });
  txt(col, c.name, { size: sizes.name, bold: true });
  const line = c.reason || c.buying;
  if (line) txt(col, line, { size: sizes.sub, color: MUTED });
  row.addSpacer(8);
  if (c.tel_url) callPill(row, c, sizes.compact);
}

function footer(w, data) {
  const row = w.addStack();
  row.centerAlignContent();
  const left = row.addStack();
  left.url = runUrl({ refresh: 1 });
  const at = new Date(data.generated_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  txt(left, "as of " + at, { size: 9.5, color: FAINT });
  row.addSpacer();
  txt(row, data.reached_week + " reached this week", { size: 9.5, color: FAINT });
}

function finished(w, data, size) {
  w.addSpacer();
  if (data.done >= data.target) txt(w, "Done for the day", { size: size, bold: true, color: GREEN });
  else if (data.done > 0) txt(w, "No more calls queued", { size: size, bold: true });
  else txt(w, "No calls today", { size: size, bold: true });
  w.addSpacer();
}

function renderSmall(w, data) {
  header(w, data, true);
  w.addSpacer(6);
  progress(w, data, 128);
  const c = data.calls[0];
  if (!c) return finished(w, data, 15);
  w.addSpacer(8);
  txt(w, c.name, { size: 15, bold: true, lines: 2 });
  const line = c.reason || c.buying;
  if (line) txt(w, line, { size: 10.5, color: MUTED, lines: 2 });
  w.addSpacer();
  if (data.calls.length > 1) txt(w, "then " + (data.calls.length - 1) + " more", { size: 10, color: FAINT });
  w.url = runUrl({ pick: c.id });
}

function renderList(w, data, max, sizes) {
  header(w, data, false);
  w.addSpacer(6);
  progress(w, data, 300);
  if (data.calls.length === 0) {
    finished(w, data, 16);
    if (sizes.footer) footer(w, data);
    return;
  }
  w.addSpacer(8);
  data.calls.slice(0, max).forEach(function (c, i) {
    if (i > 0) {
      w.addSpacer(sizes.gap);
      divider(w);
      w.addSpacer(sizes.gap);
    }
    callRow(w, c, sizes);
  });
  w.addSpacer();
  if (sizes.footer) footer(w, data);
  w.url = data.prospect_url;
}

function renderAccessory(w, data) {
  const c = data.calls[0];
  txt(w, data.done + " of " + data.target + " calls", { size: 13, bold: true });
  if (c) {
    txt(w, c.name, { size: 11 });
    w.url = runUrl({ pick: c.id });
  }
}

function renderError(w, message) {
  txt(w, "Calls unavailable", { size: 14, bold: true, color: RED });
  txt(w, message, { size: 11, color: MUTED, lines: 3 });
}

async function fetchCalls() {
  const req = new Request(NB.base + "/api/widget/sdr");
  req.headers = { Authorization: "Bearer " + NB.token };
  req.timeoutInterval = 20;
  const data = await req.loadJSON();
  if (!data || data.ok !== true) throw new Error((data && data.error) || "Bad response");
  return data;
}

async function post(path, body) {
  try {
    const req = new Request(NB.base + path);
    req.method = "POST";
    req.headers = { Authorization: "Bearer " + NB.token, "Content-Type": "application/json" };
    req.body = JSON.stringify(body);
    req.timeoutInterval = 30;
    return await req.loadJSON();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function dial(c) {
  Safari.open(c.tel_url);
}

/* After a result, the next call is one tap away. */
async function offerNext(fresh) {
  const next = fresh.calls[0];
  const a = new Alert();
  a.title = fresh.done + " of " + fresh.target + " today";
  if (!next) {
    a.message = fresh.reached_week + " reached this week";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }
  a.message = "Next: " + next.name;
  if (next.tel_url) a.addAction("Call");
  a.addCancelAction("Later");
  const pick = await a.presentAlert();
  if (pick === 0 && next.tel_url) dial(next);
}

/* One call: dial it, or file what happened. */
async function pick(id, data) {
  const c = data.calls.filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  const a = new Alert();
  a.title = c.name;
  const line = c.reason || c.buying;
  if (line) a.message = line;
  const actions = [];
  if (c.tel_url) {
    a.addAction("Call");
    actions.push("call");
  }
  RESULTS.forEach(function (r) {
    a.addAction(r[0]);
    actions.push(r[1]);
  });
  if (c.account_url) {
    a.addAction("Open account");
    actions.push("open");
  }
  a.addCancelAction("Cancel");
  const i = await a.presentSheet();
  const act = actions[i];
  if (!act) return;
  if (act === "call") return dial(c);
  if (act === "open") return Safari.open(c.account_url);
  const res = await post("/api/widget/act", { action: "call_result", id: id, result: act });
  if (!res || !res.ok) {
    const err = new Alert();
    err.title = "Not saved";
    err.message = (res && res.error) || "Try again.";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }
  await offerNext(await fetchCalls());
}

const family = config.widgetFamily || "medium";
const accessory = family.indexOf("accessory") === 0;
const widget = new ListWidget();
if (!accessory) {
  widget.backgroundColor = PAPER;
  widget.setPadding(13, 14, 13, 14);
}
widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

try {
  const data = await fetchCalls();
  const q = args.queryParameters || {};
  if (!config.runsInWidget && (q.pick || q.refresh)) {
    if (q.pick) await pick(q.pick, data);
    Script.complete();
    return;
  }
  if (accessory) renderAccessory(widget, data);
  else if (family === "small") renderSmall(widget, data);
  else if (family === "large" || family === "extraLarge") renderList(widget, data, 5, { name: 13.5, sub: 10.5, gap: 6, compact: true, footer: true });
  else renderList(widget, data, 3, { name: 13, sub: 10, gap: 3, compact: true, footer: false });
} catch (e) {
  renderError(widget, String(e.message || e));
}

if (config.runsInWidget) Script.setWidget(widget);
else if (family === "small") await widget.presentSmall();
else if (family === "large") await widget.presentLarge();
else await widget.presentMedium();
Script.complete();
`;
