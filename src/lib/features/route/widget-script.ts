/**
 * The home-screen widget's drawing code, served at /nb/api/widget/script.
 * PUBLIC on purpose: no token, no customer data. The bootstrap on the phone
 * holds the bearer and passes it in as `NB`; every fact is fetched at render
 * time from /nb/api/widget. Changing the widget is a deploy, never a paste.
 *
 * The body is a Scriptable script, kept in one String.raw so there is a
 * single source. It therefore uses NO backticks and NO ${} interpolation.
 */
export const WIDGET_SCRIPT = String.raw`
// Field Route widget (Scriptable / WidgetKit). Expects NB.base and NB.token.
const INK = Color.dynamic(new Color("#14201B"), new Color("#F2F1EA"));
const MUTED = Color.dynamic(new Color("#5B6560"), new Color("#A7AFA9"));
const FAINT = Color.dynamic(new Color("#8A928C"), new Color("#78817B"));
const PAPER = Color.dynamic(new Color("#F7F6F1"), new Color("#121815"));
const RULE = Color.dynamic(new Color("#E2DFD5"), new Color("#2A332E"));
const GREEN = Color.dynamic(new Color("#2C6A46"), new Color("#63A57E"));
const AMBER = Color.dynamic(new Color("#A0762C"), new Color("#C9A24B"));
const RED = new Color("#B5372A");
const PILL = Color.dynamic(new Color("#ECEAE1"), new Color("#232C27"));
const PILL_GREEN = Color.dynamic(new Color("#E3EEE7"), new Color("#1C2A22"));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SELF = encodeURIComponent(Script.name());

function usd(n) {
  if (n === null || n === undefined) return null;
  if (n >= 10000) return "$" + Math.round(n / 1000) + "k";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function monthYear(iso) {
  if (!iso) return null;
  const p = iso.split("-");
  const name = MONTHS[Number(p[1]) - 1];
  return name ? name + " " + p[0] : iso;
}
function txt(on, s, o) {
  o = o || {};
  const t = on.addText(s);
  t.font = o.bold ? Font.semiboldSystemFont(o.size || 12) : Font.systemFont(o.size || 12);
  t.textColor = o.color || INK;
  t.lineLimit = o.lines || 1;
  if (o.opacity !== undefined) t.textOpacity = o.opacity;
  return t;
}
function chip(on, stop, size) {
  const box = on.addStack();
  box.size = new Size(size, size);
  box.cornerRadius = stop.type === "custom" ? size * 0.28 : size / 2;
  box.backgroundColor = stop.type === "custom" ? AMBER : INK;
  box.centerAlignContent();
  const t = box.addText(String(stop.n));
  t.font = Font.semiboldSystemFont(size * 0.52);
  t.textColor = PAPER;
}
function moneyLine(stop) {
  const bits = [stop.last_order_at ? monthYear(stop.last_order_at) : "never ordered"];
  if (stop.trailing_12m_revenue) bits.push("12m " + usd(stop.trailing_12m_revenue));
  else if (stop.lifetime_revenue) bits.push("life " + usd(stop.lifetime_revenue));
  return bits.join("  ·  ");
}
function tierLabel(stop) {
  if (stop.type === "custom") return (stop.kind || "stop").toUpperCase();
  return stop.tier ? "TIER " + stop.tier : null;
}
function qs(o) {
  return Object.keys(o).map(function (k) { return k + "=" + encodeURIComponent(o[k]); }).join("&");
}
function runUrl(o) {
  return "scriptable:///run/" + SELF + "?" + qs(o);
}
function sleep(ms) {
  return new Promise(function (r) { Timer.schedule(ms, false, r); });
}

/* GO opens Maps directly. Until the start odometer is on record for the day,
   it goes through this script first, once, then on to Maps. */
function goUrl(s, data) {
  if (data.day_state === "not_started") return runUrl({ go: s.id, day: data.day });
  return s.maps_url;
}

function actionRow(on, s, data, compact) {
  const row = on.addStack();
  row.centerAlignContent();
  const gap = compact ? 5 : 6;
  const pill = function (label, url, filled) {
    const b = row.addStack();
    b.url = url;
    b.centerAlignContent();
    b.setPadding(compact ? 4 : 6, compact ? 8 : 10, compact ? 4 : 6, compact ? 8 : 10);
    b.cornerRadius = 7;
    b.backgroundColor = filled ? GREEN : PILL;
    const t = b.addText(label);
    t.font = Font.semiboldSystemFont(compact ? 10.5 : 11.5);
    t.textColor = filled ? new Color("#FFFFFF") : INK;
    row.addSpacer(gap);
  };
  pill("GO", goUrl(s, data), true);
  if (s.call_url) pill("Call", s.call_url, false);
  if (s.type === "account") {
    if (s.account_url) pill("Account", s.account_url, false);
    pill("SDR", runUrl({ sdr: s.id, day: data.day }), false);
  }
  row.addSpacer();
  /* The done check, at the right-most edge of the row. */
  const c = row.addStack();
  c.url = runUrl({ done: s.id, day: data.day });
  c.size = new Size(compact ? 30 : 34, compact ? 23 : 27);
  c.cornerRadius = 7;
  c.backgroundColor = PILL_GREEN;
  c.centerAlignContent();
  const img = c.addImage(SFSymbol.named("checkmark").image);
  img.imageSize = new Size(12, 12);
  img.tintColor = GREEN;
}

function stamp(w, data, extra) {
  const at = new Date(data.generated_at);
  const t = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const row = w.addStack();
  row.centerAlignContent();
  const left = row.addStack();
  left.url = runUrl({ refresh: 1, day: data.day });
  txt(left, "as of " + t + " · tap to update", { size: 9.5, color: FAINT });
  row.addSpacer();
  if (extra) txt(row, extra, { size: 9.5, color: FAINT });
}

function header(w, rows, compact) {
  const row = w.addStack();
  row.centerAlignContent();
  txt(row, "ROUTE", { size: compact ? 9 : 10, color: FAINT, bold: true });
  row.addSpacer();
  if (rows.length === 0) return;
  let right = rows.length + " stop" + (rows.length === 1 ? "" : "s");
  let mi = 0;
  rows.slice(1).forEach(function (r) { mi += r.straight_line_miles_from_prev || 0; });
  if (mi > 0) right += " · " + Math.round(mi) + " mi";
  txt(row, right, { size: compact ? 9 : 10, color: FAINT });
}

function divider(w) {
  const d = w.addStack();
  d.size = new Size(0, 1);
  d.backgroundColor = RULE;
  d.addSpacer();
}

function nameBlock(col, s, sizes, dim) {
  const nameRow = col.addStack();
  nameRow.centerAlignContent();
  txt(nameRow, s.name, { size: sizes.name, bold: true, opacity: dim ? 0.45 : undefined });
  const tier = tierLabel(s);
  if (tier) {
    nameRow.addSpacer(5);
    txt(nameRow, tier, { size: sizes.tier, color: s.type === "custom" ? AMBER : GREEN, bold: true });
  }
  const sub = [s.address, s.city].filter(Boolean).join(", ");
  if (sub) txt(col, sub, { size: sizes.sub, color: MUTED });
  if (s.type === "account") txt(col, moneyLine(s), { size: sizes.sub, color: FAINT });
}

/* Nothing left to drive to. The face is the next thing to do, or a plain end. */
function renderFinished(w, data) {
  w.addSpacer();
  if (data.day_state === "ready_to_end") {
    txt(w, "End odometer", { size: 16, bold: true });
    w.url = runUrl({ end: 1, day: data.day });
  } else if (data.count > 0 || (data.visited_count || 0) > 0) {
    txt(w, "Done for the day", { size: 16, bold: true, color: GREEN });
  } else {
    txt(w, "No stops", { size: 16, bold: true });
  }
  w.addSpacer();
  stamp(w, data);
}

function renderSmall(w, data, rows) {
  header(w, rows, true);
  w.addSpacer(6);
  if (rows.length === 0) return renderFinished(w, data);
  const s = rows[0];
  const top = w.addStack();
  top.centerAlignContent();
  chip(top, s, 20);
  top.addSpacer(6);
  const tier = tierLabel(s);
  if (tier) txt(top, tier, { size: 9, color: s.type === "custom" ? AMBER : GREEN, bold: true });
  w.addSpacer(5);
  txt(w, s.name, { size: 15, bold: true, lines: 2 });
  const where = s.city || s.address;
  if (where) txt(w, where, { size: 11, color: MUTED });
  w.addSpacer();
  if (rows.length > 1) txt(w, "then " + (rows.length - 1) + " more", { size: 10, color: FAINT });
  stamp(w, data);
  w.url = goUrl(s, data);
}

function renderMedium(w, data, rows) {
  header(w, rows, false);
  if (rows.length === 0) return renderFinished(w, data);
  w.addSpacer(7);
  const s = rows[0];
  const top = w.addStack();
  top.topAlignContent();
  chip(top, s, 22);
  top.addSpacer(8);
  const col = top.addStack();
  col.layoutVertically();
  nameBlock(col, s, { name: 15, tier: 9, sub: 10.5 }, false);
  top.addSpacer();
  w.addSpacer(7);
  actionRow(w, s, data, false);
  w.addSpacer();
  stamp(w, data, rows.length > 1 ? "+" + (rows.length - 1) + " more" : null);
  w.url = data.route_url;
}

function renderLarge(w, data, rows) {
  header(w, rows, false);
  if (rows.length === 0) return renderFinished(w, data);
  w.addSpacer(6);
  const shown = rows.slice(0, 4);
  shown.forEach(function (s, i) {
    if (i > 0) {
      w.addSpacer(4);
      divider(w);
      w.addSpacer(4);
    }
    const row = w.addStack();
    row.topAlignContent();
    chip(row, s, 18);
    row.addSpacer(7);
    const col = row.addStack();
    col.layoutVertically();
    nameBlock(col, s, { name: 12.5, tier: 8.5, sub: 9.5 }, false);
    row.addSpacer();
    if (i > 0 && s.straight_line_miles_from_prev !== null) {
      txt(row, s.straight_line_miles_from_prev + " mi", { size: 9.5, color: FAINT });
    }
    w.addSpacer(5);
    const actions = w.addStack();
    actions.addSpacer(25);
    actionRow(actions, s, data, true);
  });
  w.addSpacer();
  stamp(w, data, rows.length > shown.length ? "+" + (rows.length - shown.length) + " more" : null);
  w.url = data.route_url;
}

function renderAccessory(w, data, rows) {
  const s = rows[0];
  if (!s) {
    txt(w, "No stops", { size: 13, bold: true });
    return;
  }
  txt(w, s.n + ". " + s.name, { size: 13, bold: true });
  const sub = s.city || s.address;
  if (sub) txt(w, sub, { size: 11, opacity: 0.7 });
  if (rows.length > 1) txt(w, "+" + (rows.length - 1) + " more", { size: 11, opacity: 0.6 });
  w.url = goUrl(s, data);
}

function renderError(w, message) {
  txt(w, "Route unavailable", { size: 14, bold: true, color: RED });
  txt(w, message, { size: 11, color: MUTED, lines: 3 });
}

async function fetchRoute() {
  const req = new Request(NB.base + "/api/widget");
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
    req.timeoutInterval = 20;
    return await req.loadJSON();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function shrink(img) {
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.size.width, img.size.height));
  if (scale >= 1) return img;
  const w = Math.round(img.size.width * scale);
  const h = Math.round(img.size.height * scale);
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = true;
  dc.respectScreenScale = false;
  dc.drawImageInRect(img, new Rect(0, 0, w, h));
  return dc.getImage();
}

async function sendMileage(kind, day, photo) {
  try {
    const req = new Request(NB.base + "/api/widget/mileage");
    req.method = "POST";
    req.headers = { Authorization: "Bearer " + NB.token };
    req.timeoutInterval = 60;
    req.addParameterToMultipart("kind", kind);
    req.addParameterToMultipart("day", day);
    if (photo) req.addFileDataToMultipart(Data.fromJPEG(photo), "image/jpeg", "photo", kind + ".jpg");
    else req.addParameterToMultipart("bypass", "1");
    const r = await req.loadJSON();
    return Boolean(r && r.ok);
  } catch (e) {
    return false;
  }
}

/* The odometer, once per side per day. One alert, two buttons. A cancelled
   camera or a failed upload falls back to a bypass so the day still moves on
   and this never asks a second time. */
async function recordMileage(kind, day) {
  const a = new Alert();
  a.title = kind === "end" ? "End odometer" : "Start odometer";
  a.addAction("Take photo");
  a.addAction("Bypass");
  const pick = await a.presentAlert();
  if (pick === 0) {
    let photo = null;
    try { photo = await Photos.fromCamera(); } catch (e) { photo = null; }
    if (photo && (await sendMileage(kind, day, shrink(photo)))) return;
  }
  await sendMileage(kind, day, null);
}

async function reportLocation() {
  try {
    Location.setAccuracyToTenMeters();
    const loc = await Location.current();
    await post("/api/location", { lat: loc.latitude, lng: loc.longitude });
  } catch (e) {}
}

async function queueSdr(id, data) {
  const s = data.stops.filter(function (x) { return x.id === id; })[0];
  const a = new Alert();
  a.title = "Add to SDR";
  if (s) a.message = s.name;
  a.addAction("High");
  a.addAction("Mid");
  a.addAction("Low");
  a.addCancelAction("Cancel");
  const pick = await a.presentAlert();
  if (pick < 0 || pick > 2) return;
  const res = await post("/api/widget/act", { action: "sdr", id: id, priority: ["high", "mid", "low"][pick] });
  const done = new Alert();
  if (res && res.ok) {
    const p = res.scheduled_date.split("-").map(Number);
    const wd = new Date(p[0], p[1] - 1, p[2]).toLocaleDateString("en-US", { weekday: "long" });
    done.title = "In the SDR queue";
    done.message = wd;
  } else {
    done.title = "Not queued";
    done.message = (res && res.error) || "Try again.";
  }
  done.addAction("OK");
  await done.presentAlert();
}

async function handle(q, data) {
  const day = q.day || data.day;
  if (q.refresh) {
    await Promise.race([reportLocation(), sleep(2500)]);
    return;
  }
  if (q.sdr) {
    await queueSdr(q.sdr, data);
    return;
  }
  if (q.done) {
    await post("/api/widget/act", { action: "done", day: day, id: q.done });
    const fresh = await fetchRoute();
    if (fresh.day_state === "ready_to_end") await recordMileage("end", fresh.day);
    return;
  }
  if (q.end) {
    if (data.day_state !== "ended") await recordMileage("end", day);
    return;
  }
  if (q.go) {
    const s = data.stops.filter(function (x) { return x.id === q.go; })[0];
    if (data.day_state === "not_started") await recordMileage("start", day);
    if (s) Safari.open(s.maps_url.replace("https://maps.apple.com/", "maps://"));
  }
}

const family = config.widgetFamily || "medium";
const accessory = family.indexOf("accessory") === 0;
const widget = new ListWidget();
if (!accessory) {
  widget.backgroundColor = PAPER;
  widget.setPadding(13, 14, 13, 14);
}
widget.refreshAfterDate = new Date(Date.now() + 60 * 1000);

try {
  const data = await fetchRoute();
  const q = args.queryParameters || {};
  const acted = q.go || q.done || q.sdr || q.end || q.refresh;
  if (!config.runsInWidget && acted) {
    await handle(q, data);
    Script.complete();
    return;
  }
  const rows = data.stops.filter(function (s) { return !s.done; });
  if (accessory) renderAccessory(widget, data, rows);
  else if (family === "small") renderSmall(widget, data, rows);
  else if (family === "large" || family === "extraLarge") renderLarge(widget, data, rows);
  else renderMedium(widget, data, rows);
} catch (e) {
  renderError(widget, String(e.message || e));
}

if (config.runsInWidget) Script.setWidget(widget);
else if (family === "small") await widget.presentSmall();
else if (family === "large") await widget.presentLarge();
else await widget.presentMedium();
Script.complete();
`;
