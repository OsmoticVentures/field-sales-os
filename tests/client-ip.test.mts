// The caller's address behind the PIN hold and the fuel rate limits
// (src/lib/core/client-ip.ts). A client-written X-Forwarded-For prefix must not
// change the key. Run: node --experimental-strip-types tests/client-ip.test.mts
import { clientIp } from "../src/lib/core/client-ip.ts";

let failures = 0;
const t = (name: string, got: string, want: string) => {
  if (got !== want) {
    failures++;
    console.error("FAIL", name, { got, want });
  } else console.log("ok  ", name);
};
const H = (o: Record<string, string>) => new Headers(o);

t("vercel header wins over a spoofed XFF", clientIp(H({ "x-vercel-forwarded-for": "9.9.9.9", "x-forwarded-for": "1.2.3.4, 9.9.9.9" })), "9.9.9.9");
t("x-real-ip next", clientIp(H({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" })), "9.9.9.9");
t("XFF uses the last hop, not the client-written first", clientIp(H({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" })), "9.9.9.9");
t("rotating the spoofed prefix keeps the same key", clientIp(H({ "x-forwarded-for": "8.8.8.8, 9.9.9.9" })), "9.9.9.9");
t("no headers falls back", clientIp(H({}), "local"), "local");
t("blank headers fall back", clientIp(H({ "x-forwarded-for": " ", "x-real-ip": "" })), "unknown");

if (failures) {
  console.error(`${failures} failing`);
  process.exit(1);
}
console.log("client-ip: all pass");
