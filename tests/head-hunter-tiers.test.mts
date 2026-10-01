import { distillReviews } from "../src/lib/features/enrich/review-owners.ts";
import { personFromAccountName } from "../src/lib/features/enrich/named-practitioner.ts";
import { verifyCited } from "../src/lib/features/enrich/people-guard.ts";
const t = (n: string, ok: boolean) => { if (!ok) { console.error("FAIL", n); process.exitCode = 1; } };
const rv = (text: string, author = "Pat Smith") => ({ text: { text }, authorAttribution: { displayName: author } });
const names = (...texts: string[]) => distillReviews(texts.map((x) => rv(x))).map((p) => `${p.name}|${p.role}|${p.mentions}`);
const eq = (n: string, got: unknown, want: unknown) => t(n, JSON.stringify(got) === JSON.stringify(want));

eq("owner after name", names("Maria, the owner, helped me pick a probiotic."), ["Maria|owner|1"]);
eq("owner then Dr name", names("The owner, Dr. Lee Chang, is wonderful."), ["Lee Chang|owner|1"]);
eq("pronoun role", names("Ask for Tom Reyes, he is the manager."), ["Tom Reyes|manager|1"]);
eq("no role", names("Great store. Friendly staff."), []);
eq("two reviews", names("Maria the owner was great.", "Maria (owner) remembered my name."), ["Maria|owner|2"]);
eq("previous owner", names("The previous owner Bob sold it last year."), []);
eq("imperative", names("When I asked to speak with a manager, she said Call the manager yourself."), []);
eq("self-named reviewer", distillReviews([rv("Maria the owner here, thanks!", "Maria")]), []);

eq("named practitioner", personFromAccountName("BETTY CIUCHTA, D.C.")?.name, "Betty Ciuchta");
eq("hyphen", personFromAccountName("BARBARA PAUL-BLUME, PhD")?.name, "Barbara Paul-Blume");
eq("brand is not a person", personFromAccountName("Weinzoff Chiropractic & Wellness Center"), null);
eq("by-name brand", personFromAccountName("Skin by Alanna Silva"), null);

const cited = [{ url: "https://www.bbb.org/x", text: "Bettina Rasmussen, Owner" }];
t("cited passage admits", verifyCited({ name: "Bettina Rasmussen", title: "Owner" }, cited).ok);
t("name not cited", !verifyCited({ name: "Ana Ruiz", title: "Owner" }, cited).ok);
t("title not cited", !verifyCited({ name: "Bettina Rasmussen", title: "Founder" }, cited).ok);
t("http source refused", !verifyCited({ name: "Bettina Rasmussen", title: "Owner" }, [{ url: "http://x.com", text: "Bettina Rasmussen, Owner" }]).ok);
t("founded by is founder", verifyCited({ name: "Todd Donohoe", title: "Founder" }, [{ url: "https://x.com", text: "Founded by Dr. Todd Donohoe in 1999" }]).ok);
if (!process.exitCode) console.log("head-hunter tiers: all cases pass");
