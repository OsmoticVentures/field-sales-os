/**
 * Home Screen launchers: one web app manifest per screen Juan actually adds
 * to his Home Screen, ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/launchers.ts). Since iOS 16.4, Safari
 * launches whatever `start_url` a page's linked manifest names, not the page
 * that was open when the tile was added, so each launchable screen needs its
 * own manifest with its own `id` (two manifests sharing an `id` are one
 * installed app, not two).
 *
 * Add an entry here per feature as it's ported; each new port adds its own
 * `Launcher` to `LAUNCHERS` and its own `manifest.webmanifest/route.ts`
 * calling `manifestResponse`, same shape as expenses/manifest.webmanifest.
 */
import type { MetadataRoute } from "next";

type Launcher = {
  href: string;
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  icon: string;
};

const EXPENSES: Launcher = {
  href: "/expenses/manifest.webmanifest",
  id: "/expenses",
  name: "Field Sales OS Expenses",
  short_name: "Expenses",
  description: "Clock in and out, log a break, and drop in a receipt or odometer photo.",
  start_url: "/expenses",
  icon: "/expenses/apple-icon.png",
};

export const LAUNCHERS = { EXPENSES };

export function manifestFor(l: Launcher): MetadataRoute.Manifest {
  return {
    id: l.id,
    name: l.name,
    short_name: l.short_name,
    description: l.description,
    start_url: l.start_url,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FAF9F5",
    theme_color: "#14201B",
    icons: [{ src: l.icon, sizes: "180x180", type: "image/png", purpose: "any" }],
  };
}

/** One shape for every manifest route handler. Public: iOS fetches a
 *  manifest while installing a tile, sometimes with no cookie, and a
 *  manifest that redirects to the PIN gate installs a tile that opens the
 *  gate. There is no data here, only names and colors. */
export function manifestResponse(l: Launcher): Response {
  return Response.json(manifestFor(l), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
