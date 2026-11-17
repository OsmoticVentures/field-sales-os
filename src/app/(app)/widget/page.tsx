import { Card, PageHead } from "../../../lib/core/ui";
import { requireAccess } from "../../../lib/core/devices";
import { CopyScript } from "./CopyScript";

export const dynamic = "force-dynamic";
export const metadata = { title: "Widget · ClientOS" };

const BASE = `${process.env.NB_PUBLIC_ORIGIN ?? "https://osmoticventures.com"}/nb`;

/** The phone-side loader: holds the bearer, fetches the drawing code. */
function bootstrap(token: string, scriptPath: string): string {
  return [
    "const NB = {",
    `  base: "${BASE}",`,
    `  token: "${token}",`,
    "};",
    `const src = await new Request(NB.base + "${scriptPath}").loadString();`,
    'await new Function("NB", "return (async () => {" + src + "})()")(NB);',
  ].join("\n");
}

function Steps({ code, name }: { code: string; name: string }) {
  return (
    <ol className="flex list-decimal flex-col gap-4 pl-5 text-[14px] leading-snug">
      <li>
        <div className="mb-2.5">Copy the script</div>
        <CopyScript code={code} />
      </li>
      <li>Paste it into a new Scriptable script named {name}</li>
      <li>Add a Scriptable widget, set Script to {name} and When Interacting to Run Script</li>
    </ol>
  );
}

export default async function WidgetPage() {
  // Renders the widget token, so it gates itself.
  await requireAccess();
  const token = process.env.NB_WIDGET_TOKEN;

  return (
    <>
      <PageHead title="Widget" />
      {token ? (
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="mb-3 text-[15px] font-semibold text-[#14201B]">Field Route</h2>
            <Steps code={bootstrap(token, "/api/widget/script")} name="Field Route" />
          </Card>
          <Card>
            <h2 className="mb-3 text-[15px] font-semibold text-[#14201B]">SDR Calls</h2>
            <Steps code={bootstrap(token, "/api/widget/sdr/script")} name="SDR Calls" />
          </Card>
        </div>
      ) : (
        <Card>
          <div className="text-[14px]">The widget token is not set on this deployment.</div>
        </Card>
      )}
    </>
  );
}
