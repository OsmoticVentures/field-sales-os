// Runs before the app hydrates (Next's file convention), so an error during
// the very first render is still caught. See lib/core/client-errors.ts.
import { installClientErrorCapture } from "./lib/core/client-errors";

installClientErrorCapture();
