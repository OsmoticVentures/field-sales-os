"use client";

/**
 * A tiny script-tag loader for the Google Maps JavaScript API, shared by
 * Search's AreaPicker and Route's RouteMap. The source app used the
 * @react-google-maps/api npm wrapper; this loads the same SDK (vanilla
 * google.maps.Map/Marker/Polygon/Polyline) with zero new npm dependencies.
 * One script tag per page, one promise, whichever feature asks first.
 */

/** Untyped on purpose: this repo carries no @types/google.maps package (see
 *  this module's own header comment), so the SDK's surface is `any` at this
 *  one boundary. Everything above this line in a caller stays typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GoogleNamespace = any;

let loadPromise: Promise<GoogleNamespace> | null = null;

export function loadGoogleMaps(apiKey: string): Promise<GoogleNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window."));
  const w = window as unknown as { google?: GoogleNamespace };
  if (w.google?.maps) return Promise.resolve(w.google);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById("google-maps-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve((window as unknown as { google: GoogleNamespace }).google));
      existing.addEventListener("error", () => reject(new Error("Google Maps failed to load.")));
      return;
    }
    const script = document.createElement("script");
    script.id = "google-maps-js";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async`;
    script.async = true;
    script.onload = () => resolve((window as unknown as { google: GoogleNamespace }).google);
    script.onerror = () => reject(new Error("Google Maps failed to load."));
    document.head.appendChild(script);
  });

  return loadPromise;
}
