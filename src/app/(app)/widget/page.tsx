import { Card, PageHead } from "../../../lib/core/ui";
import { CopyScript } from "./CopyScript";

export const dynamic = "force-dynamic";
export const metadata = { title: "Widget · Field Sales OS" };

const BASE = `${process.env.NB_PUBLIC_ORIGIN ?? "https://osmoticventures.com"}/nb`;

export default function WidgetPage() {
  const token = process.env.NB_WIDGET_TOKEN;
  const bootstrap = token
    ? [
        "const NB = {",
        `  base: "${BASE}",`,
        `  token: "${token}",`,
        "};",
        'const src = await new Request(NB.base + "/api/widget/script").loadString();',
        'await new Function("NB", "return (async () => {" + src + "})()")(NB);',
      ].join("\n")
    : null;

  return (
    <>
      <PageHead title="Widget" />
      <Card>
        {bootstrap ? (
          <ol className="flex list-decimal flex-col gap-4 pl-5 text-[14px] leading-snug">
            <li>
              <div className="mb-2.5">Copy the script</div>
              <CopyScript code={bootstrap} />
            </li>
            <li>Paste it into a new Scriptable script named Field Route</li>
            <li>Add a Scriptable widget, set Script to Field Route and When Interacting to Run Script</li>
          </ol>
        ) : (
          <div className="text-[14px]">The widget token is not set on this deployment.</div>
        )}
      </Card>
    </>
  );
}
