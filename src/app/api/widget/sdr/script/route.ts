/**
 * The SDR Calls widget's drawing code. Public: it carries no secret and no
 * data, the phone's bootstrap supplies the bearer at run time.
 */
import { SDR_WIDGET_SCRIPT } from "../../../../../lib/features/route/sdr-widget-script";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(SDR_WIDGET_SCRIPT, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
  });
}
