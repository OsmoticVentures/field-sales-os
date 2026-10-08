/*
 * THE SERVICE WORKER. Generated: scripts/build-sw.mjs fills the three
 * constants below from the build and writes public/sw.js. Edit this
 * template, never public/sw.js. Decision and reasoning: OFFLINE.md.
 *
 * What it does, per request under /nb:
 *  - /_next/static/*     cache first. Every file of the build is fetched at
 *                        install, so the app runs with no signal at all.
 *  - static screens      (Visit, Route, Plan, Expenses, Search, Fuel) paint
 *                        from the cache at once; the network answer, when
 *                        it comes, refreshes the copy for the next open.
 *  - other screens       (Clients, Prospect, an account, Reports) go to the
 *                        network first and fall back to the last copy after
 *                        a few seconds or with no signal. Those copies hold a
 *                        rep's data, so they live in a cache named for the
 *                        rep, and a different rep's answer wipes them.
 *  - /api/*              never touched here. The app keeps its own copy of
 *                        reads in IndexedDB (phone-store.ts) and queues its
 *                        writes (outbox.ts, writeq.ts).
 *
 * BOUNDS. Two builds of static files and screens are kept, older ones are
 * deleted on activate. A rep cache holds at most REP_MAX entries, none older
 * than REP_MAX_AGE_MS.
 */
const BUILD = "__BUILD__";
const ASSETS = __ASSETS__;
const SHELLS = __SHELLS__;

const BASE = "/nb";
const STATIC = `fso-static-${BUILD}`;
const SHELL = `fso-shell-${BUILD}`;
const REP_PREFIX = "fso-rep-";
const META = "fso-meta";
const KEEP_BUILDS = 2;
const REP_MAX = 60;
const REP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NETWORK_WAIT_MS = 3500;
const SHELL_SET = new Set(SHELLS);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

async function metaGet(key) {
  try {
    const c = await caches.open(META);
    const r = await c.match(`${BASE}/__sw/${key}`);
    return r ? await r.json() : null;
  } catch {
    return null;
  }
}

async function metaPut(key, value) {
  try {
    const c = await caches.open(META);
    await c.put(`${BASE}/__sw/${key}`, new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
  } catch {
    /* best effort */
  }
}

/** A copy of `res` stamped with when it was kept, for the age bound. */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set("x-sw-at", String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

async function inCache(name, req) {
  try {
    const c = await caches.open(name);
    return (await c.match(req, { ignoreVary: true })) || null;
  } catch {
    return null;
  }
}

/** A kept copy of a build file or a static screen, from any build. Their
 *  keys never appear in a rep cache, so this cannot answer with rep data. */
async function kept(req) {
  try {
    return (await caches.match(req, { ignoreVary: true })) || null;
  } catch {
    return null;
  }
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

const isHtml = (res) => (res.headers.get("content-type") || "").includes("text/html");
const okPage = (res) => res && res.ok && res.type !== "opaqueredirect" && !res.redirected && isHtml(res);
const signedOut = (res) => res && (res.type === "opaqueredirect" || res.redirected || (res.status >= 300 && res.status < 400));

// ---------------------------------------------------------------------------
// the rep: whose data the rep cache holds
// ---------------------------------------------------------------------------

let rep = null;
const repReady = metaGet("rep").then((v) => {
  rep = typeof v === "string" ? v : null;
});

async function dropRepCaches() {
  const names = (await caches.keys()).filter((n) => n.startsWith(REP_PREFIX));
  await Promise.all(names.map((n) => caches.delete(n)));
}

/** A response names its rep (x-nb-rep, set by proxy.ts). A rep that is not
 *  the one whose copies are kept wipes every copy before anything is kept. */
async function noteRep(id) {
  await repReady;
  if (!id || id === rep) return;
  await dropRepCaches();
  rep = id;
  await metaPut("rep", id);
}

async function keepForRep(id, req, res) {
  if (!id) return;
  await noteRep(id);
  const name = REP_PREFIX + id;
  const c = await caches.open(name);
  await c.put(req, await stamped(res));
  await trimRep(name);
}

async function trimRep(name) {
  try {
    const c = await caches.open(name);
    const keys = await c.keys();
    const now = Date.now();
    const dated = [];
    for (const k of keys) {
      const r = await c.match(k);
      const at = Number(r && r.headers.get("x-sw-at")) || 0;
      if (now - at > REP_MAX_AGE_MS) await c.delete(k);
      else dated.push({ k, at });
    }
    dated.sort((a, b) => b.at - a.at);
    for (const { k } of dated.slice(REP_MAX)) await c.delete(k);
  } catch {
    /* the next put trims again */
  }
}

async function fromRep(req) {
  await repReady;
  if (!rep) return null;
  const hit = await inCache(REP_PREFIX + rep, req);
  if (!hit) return null;
  const at = Number(hit.headers.get("x-sw-at")) || 0;
  return Date.now() - at <= REP_MAX_AGE_MS ? hit : null;
}

// ---------------------------------------------------------------------------
// install and activate
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(STATIC);
      // A file an older build already kept is copied, not downloaded again.
      let i = 0;
      const next = async () => {
        while (i < ASSETS.length) {
          const url = ASSETS[i++];
          if (await c.match(url)) continue;
          const old = await kept(url);
          if (old) {
            await c.put(url, old.clone());
            continue;
          }
          try {
            const res = await fetch(url, { credentials: "same-origin" });
            if (res.ok) await c.put(url, res);
          } catch {
            /* a miss is fetched again the first time a screen asks */
          }
        }
      };
      await Promise.all([next(), next(), next(), next()]);

      // The static screens, as this build renders them. Signed out, the
      // proxy answers with the gate instead: nothing is kept.
      const s = await caches.open(SHELL);
      await Promise.all(
        SHELLS.map(async (url) => {
          try {
            const res = await fetch(url, { credentials: "same-origin", redirect: "manual", cache: "no-store" });
            if (okPage(res)) await s.put(url, res);
          } catch {
            /* kept on the first visit instead */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const builds = ((await metaGet("builds")) || []).filter((b) => b !== BUILD);
      builds.unshift(BUILD);
      const keep = builds.slice(0, KEEP_BUILDS);
      await metaPut("builds", keep);
      const allowed = new Set(keep.flatMap((b) => [`fso-static-${b}`, `fso-shell-${b}`]));
      for (const n of await caches.keys()) {
        if ((n.startsWith("fso-static-") || n.startsWith("fso-shell-")) && !allowed.has(n)) await caches.delete(n);
      }
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          /* not supported: plain fetch below */
        }
      }
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// messages from the app
// ---------------------------------------------------------------------------

self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "rep" && typeof d.id === "string") event.waitUntil(noteRep(d.id));
  if (d.type === "clear-rep") {
    event.waitUntil(
      (async () => {
        await dropRepCaches();
        rep = null;
        await metaPut("rep", null);
      })(),
    );
  }
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ClientOS</title><style>
:root{color-scheme:light}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F7F6F1;color:#14201B;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
main{padding:24px;text-align:center}h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 18px}
button{min-height:44px;padding:0 22px;border:0;border-radius:10px;background:#14201B;color:#fff;font:inherit;font-weight:500}
</style></head><body><main><h1>No connection</h1><button onclick="location.reload()">Try again</button></main></body></html>`;

const offlinePage = () => new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });

function isRsc(req, url) {
  return req.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p !== BASE && !p.startsWith(`${BASE}/`)) return;
  if (p === `${BASE}/sw.js` || p.startsWith(`${BASE}/api/`) || p.startsWith(`${BASE}/_next/image`)) return;

  if (p.startsWith(`${BASE}/_next/static/`)) {
    event.respondWith(staticFile(req));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(navigate(event, url));
    return;
  }
  if (isRsc(req, url)) {
    event.respondWith(rsc(event, req));
    return;
  }
  // Icons, manifests: the network, else the last copy.
  event.respondWith(other(event, req));
});

async function staticFile(req) {
  const hit = await kept(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const c = await caches.open(STATIC);
      await c.put(req, res.clone());
    }
    return res;
  } catch {
    return Response.error();
  }
}

/** The page's own network answer: the preload the browser already started,
 *  else a fetch. Redirects come back unfollowed, so the gate is visible. */
async function network(event, url) {
  try {
    const pre = await event.preloadResponse;
    if (pre) return pre;
  } catch {
    /* fall through */
  }
  return fetch(url.href, { credentials: "same-origin", redirect: "manual" });
}

async function navigate(event, url) {
  const p = url.pathname;
  // The root only redirects; answering here saves the round trip on every
  // launch of the app.
  if (p === BASE || p === `${BASE}/`) return Response.redirect(`${BASE}/visit${url.search}`, 302);
  if (p === `${BASE}/gate`) {
    try {
      return await network(event, url);
    } catch {
      return offlinePage();
    }
  }

  if (SHELL_SET.has(p)) {
    const key = p;
    const cached = await kept(key);
    const fresh = network(event, url).then(
      async (res) => {
        if (okPage(res)) {
          const c = await caches.open(SHELL);
          await c.put(key, res.clone());
        } else if (cached && signedOut(res)) {
          // The copy painted, but this browser is signed out: send the
          // screen to the gate rather than leave it on a dead session.
          const client = await self.clients.get(event.resultingClientId || event.clientId);
          if (client) client.postMessage({ type: "signed-out" });
        }
        return res;
      },
      () => null,
    );
    if (cached) {
      event.waitUntil(fresh);
      return cached;
    }
    const res = await fresh;
    return res || offlinePage();
  }

  // A screen that renders a rep's data: the network first, the rep's last
  // copy when the network is slow or gone.
  const fresh = network(event, url).then(
    async (res) => {
      if (okPage(res)) await keepForRep(res.headers.get("x-nb-rep"), url.href, res.clone());
      return res;
    },
    () => null,
  );
  event.waitUntil(fresh);
  const first = await Promise.race([fresh, timeout(NETWORK_WAIT_MS)]);
  if (first) return first;
  const copy = await fromRep(url.href);
  if (copy) return copy;
  const late = await fresh;
  return late || offlinePage();
}

async function rsc(event, req) {
  const prefetch = req.headers.get("Next-Router-Prefetch") === "1";
  try {
    const res = await fetch(req);
    if (res.ok && !prefetch) event.waitUntil(keepForRep(res.headers.get("x-nb-rep"), req, res.clone()));
    return res;
  } catch {
    return (await fromRep(req)) || Response.error();
  }
}

async function other(event, req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
      const c = await caches.open(SHELL);
      event.waitUntil(c.put(req, res.clone()));
    }
    return res;
  } catch {
    return (await inCache(SHELL, req)) || Response.error();
  }
}
