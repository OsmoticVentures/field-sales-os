// Error capture: what counts as the same error, and the write throttle.
// Run: node --experimental-strip-types tests/error-capture.test.mts
import { fingerprint, makeAdmitter, normalizeMessage, normalizeRoute, topFrame } from "../src/lib/core/error-fingerprint.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

// Messages: ids and values fold, words do not.
t("numbers fold", normalizeMessage("nb_accounts 4411 not found") === normalizeMessage("nb_accounts 9 not found"));
t("uuids fold", normalizeMessage("row 3f2b1c4e-1111-4222-8333-444455556666 gone") === normalizeMessage("row 00000000-aaaa-4bbb-8ccc-dddddddddddd gone"));
t("quoted values fold", normalizeMessage('No active user "kyle".') === normalizeMessage('No active user "juan".'));
t("different words stay apart", normalizeMessage("HubSpot answered 502") !== normalizeMessage("Supabase answered 502"));

// Routes: ids collapse, the basePath goes.
t("route ids collapse", normalizeRoute("/nb/api/account/12345") === "/api/account/[id]", normalizeRoute("/nb/api/account/12345"));
t("route query drops", normalizeRoute("/visit?x=1") === "/visit");
t("device-style ids collapse", normalizeRoute("/api/x/dev_a1b2c3") === "/api/x/[id]");

// Frames: our own frame, stable across deploys.
const v8 = `TypeError: x is null
    at Channel.publish (node:diagnostics_channel:165:9)
    at node_modules/next/dist/server/foo.js:1:2
    at saveVisit (/var/task/.next/server/chunks/8812-ab12cd34ef56.js:1:2345)
    at async POST (/var/task/.next/server/app/api/visit/log/route.js:3:44)`;
const v8NextDeploy = v8.replace("8812-ab12cd34ef56.js:1:2345", "8812-99ff88ee77dd.js:1:9999");
t("v8 top frame skips internals", topFrame(v8).includes("saveVisit"), topFrame(v8));
t("v8 frame stable across deploys", topFrame(v8) === topFrame(v8NextDeploy), [topFrame(v8), topFrame(v8NextDeploy)]);
const safari = `onSave@https://osmoticventures.com/nb/_next/static/chunks/app/visit/page-0123456789abcdef.js:1:500
@https://osmoticventures.com/nb/_next/static/chunks/4bd1b696-0011223344556677.js:1:2`;
t("safari frame drops origin, hash, position", topFrame(safari) === "onSave@/nb/_next/static/chunks/app/visit/page.js", topFrame(safari));
t("no stack, no frame", topFrame(undefined) === "");
const turbo = "TypeError: x\n    at x (/var/task/.next/server/chunks/[root-of-the-server]__0i~1dvi._.js:1:6514)";
const turboLocal = "TypeError: x\n    at x (/Users/me/app/.next/server/chunks/[root-of-the-server]__0g3bixc._.js:1:99)";
t("turbopack chunk name and absolute path fold", topFrame(turbo) === topFrame(turboLocal) && topFrame(turbo) === "at x (.next/server/chunks/[root-of-the-server].js", [topFrame(turbo), topFrame(turboLocal)]);
t("empty route stays empty", normalizeRoute("") === "");

// Fingerprints.
const a = fingerprint("server", "TypeError: Cannot read 'x' of 12", topFrame(v8), "/api/visit/log");
const b = fingerprint("server", "TypeError: Cannot read 'y' of 99", topFrame(v8NextDeploy), "/nb/api/visit/log");
t("same bug, same fingerprint", a === b, [a, b]);
t("fingerprint is 12 hex", /^[0-9a-f]{12}$/.test(a), a);
t("kind separates", a !== fingerprint("client", "TypeError: Cannot read 'x' of 12", topFrame(v8), "/api/visit/log"));
t("route separates", a !== fingerprint("server", "TypeError: Cannot read 'x' of 12", topFrame(v8), "/api/route/state"));

// Throttle: one write per fingerprint per window, held hits ride the next.
{
  const admit = makeAdmitter(10_000, 4);
  t("first hit writes", admit("f1", 0) === 1);
  t("repeat inside window holds", admit("f1", 1_000) === 0 && admit("f1", 2_000) === 0);
  t("after window, held hits ride along", admit("f1", 11_000) === 3);
  t("other fingerprints write", admit("f2", 11_001) === 1 && admit("f3", 11_002) === 1);
  t("minute cap holds the fourth write", admit("f4", 11_003) === 0);
  t("cap resets next minute", admit("f4", 72_000) === 1);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
