import { LAUNCHERS, manifestResponse } from "../../../../lib/core/launchers";

export const dynamic = "force-dynamic";

export function GET() {
  return manifestResponse(LAUNCHERS.EXPENSES);
}
