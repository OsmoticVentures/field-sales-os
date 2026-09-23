/**
 * The PIN gate. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/gate/page.tsx). One entry point regardless
 * of which screen sent the request here.
 */
import type { Metadata } from "next";
import { GateForm } from "./GateForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unlock · Field Sales OS",
  robots: { index: false, follow: false },
};

export default function Gate() {
  return <GateForm />;
}
