"use client";

/**
 * THE AREA SELECTOR: drop as many pins as you want, and the search happens
 * inside that shape and nowhere else. Ported from
 * portfolio/src/app/nutribiotic/search/AreaPicker.tsx.
 *
 * WHY A POLYGON AND NOT A RADIUS (Juan, 2026-09-09). A circle is the wrong
 * shape for a sales territory. A retail strip is a mile of one boulevard; a
 * business district stops at a freeway; the good half of a neighbourhood is
 * the half on one side of the hill. Every circle big enough to contain the
 * strip also contains ground Juan will never call, and those results are not
 * free: Google returns at most 60 per query, so junk inside the circle is
 * enumeration he does not get.
 *
 * THE SHAPE IS NOT THE FILTER, IT IS THE INSTRUCTION. What is drawn here goes
 * to the server as a vertex list; the ray-cast that decides what is inside
 * the shape runs on the Mac, in places_search_ingest.point_in_polygon.
 * Nothing in this file decides what is inside.
 *
 * VANILLA google.maps, NOT @react-google-maps/api. The source app uses that
 * npm wrapper; it is not yet a dependency of this repo, and a feature port
 * does not add one on its own (see PORTING.md's concurrency rules and this
 * port's report). This loads the same Google Maps JavaScript API directly
 * via lib/features/search/google-maps-loader.ts, which needs no package.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIco } from "../../../lib/features/search/icons";
import { loadGoogleMaps } from "../../../lib/features/search/google-maps-loader";

export type Pin = { lat: number; lng: number };

/** One found place, plotted as a read-only pin once a search has run. */
export type ResultPin = {
  key: string;
  lat: number | null;
  lng: number | null;
  name: string | null;
  address: string | null;
  placesId: string | null;
};

/** The exact link format Google documents for opening one place by id. */
export function mapsUrl(r: { name: string | null; address: string | null; placesId: string | null }): string {
  const query = encodeURIComponent(r.name || r.address || "place");
  return r.placesId
    ? `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(r.placesId)}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

const FALLBACK_CENTER = { lat: 34.0195, lng: -118.4912 };

const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#f3f1ea" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8a928c" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f7f6f1" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#d8d4c8" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f3f1ea" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#ede9dc" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#dde4e0" }] },
];

const toolBtn =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#E2DFD5] bg-white px-3 py-2 " +
  "text-[13px] font-medium text-[#3D4A44] transition-colors hover:bg-[#FAF9F5] " +
  "disabled:cursor-not-allowed disabled:opacity-35";

/** Metres between two points, for the "N km across" readout. A label on the
 *  shape, never a filter. */
function metres(a: Pin, b: Pin): number {
  const R = 6371008.8;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function AreaPicker({
  pins,
  onChange,
  disabled,
  results = [],
}: {
  pins: Pin[];
  onChange: (next: Pin[]) => void;
  disabled: boolean;
  results?: ResultPin[];
}) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pinMarkersRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resultMarkersRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shapeRef = useRef<any>(null);
  const centred = useRef(false);
  const pinsRef = useRef(pins);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  pinsRef.current = pins;
  disabledRef.current = disabled;
  onChangeRef.current = onChange;

  const path = useMemo(() => pins.map((p) => ({ lat: p.lat, lng: p.lng })), [pins]);

  const span = useMemo(() => {
    if (pins.length < 2) return null;
    const lats = pins.map((p) => p.lat);
    const lngs = pins.map((p) => p.lng);
    return (
      metres(
        { lat: Math.min(...lats), lng: Math.min(...lngs) },
        { lat: Math.max(...lats), lng: Math.max(...lngs) },
      ) / 1000
    );
  }, [pins]);

  // Load the SDK and create the map once.
  useEffect(() => {
    if (!apiKey || !containerRef.current) return;
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        const map = new g.maps.Map(containerRef.current, {
          center: FALLBACK_CENTER,
          zoom: 11,
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
          streetViewControl: false,
          fullscreenControl: true,
          keyboardShortcuts: false,
        });
        mapRef.current = map;
        map.addListener("click", (e: { latLng: { lat: () => number; lng: () => number } | null }) => {
          if (disabledRef.current || !e.latLng) return;
          onChangeRef.current([...pinsRef.current, { lat: e.latLng.lat(), lng: e.latLng.lng() }]);
        });

        if (!centred.current && typeof navigator !== "undefined" && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (centred.current) return;
              centred.current = true;
              map.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
              map.setZoom(14);
            },
            () => {},
            { timeout: 8000, maximumAge: 600_000 },
          );
        }
        setLoaded(true);
      })
      .catch(() => setLoadFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Keep the cursor honest: crosshair while drawing, default while busy.
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setOptions({ draggableCursor: disabled ? "default" : "crosshair" });
  }, [disabled, loaded]);

  // Redraw pins + shape whenever they change.
  useEffect(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: any }).google : null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const map = mapRef.current;
    if (!g || !map) return;

    for (const m of pinMarkersRef.current) m.setMap(null);
    pinMarkersRef.current = [];
    if (shapeRef.current) {
      shapeRef.current.setMap(null);
      shapeRef.current = null;
    }

    if (pins.length >= 3) {
      shapeRef.current = new g.maps.Polygon({
        paths: path,
        map,
        fillColor: "#14201B",
        fillOpacity: 0.08,
        strokeColor: "#14201B",
        strokeOpacity: 0.85,
        strokeWeight: 1.75,
        clickable: false,
        zIndex: 1,
      });
    } else if (pins.length === 2) {
      shapeRef.current = new g.maps.Polyline({
        path,
        map,
        strokeColor: "#14201B",
        strokeOpacity: 0.6,
        strokeWeight: 1.75,
      });
    }

    pins.forEach((p, i) => {
      const marker = new g.maps.Marker({
        position: p,
        map,
        draggable: !disabled,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: "#14201B",
          fillOpacity: 1,
          strokeColor: "#F7F6F1",
          strokeWeight: 2,
        },
        label: { text: String(i + 1), color: "#F7F6F1", fontSize: "10px", fontWeight: "600" },
        title: `Pin ${i + 1}. Drag to move it, click to remove it.`,
      });
      marker.addListener("dragend", (e: { latLng: { lat: () => number; lng: () => number } }) => {
        const next = [...pinsRef.current];
        next[i] = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        onChangeRef.current(next);
      });
      marker.addListener("click", () => {
        if (disabledRef.current) return;
        onChangeRef.current(pinsRef.current.filter((_, j) => j !== i));
      });
      pinMarkersRef.current.push(marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, path, loaded, disabled]);

  // Redraw result pins whenever they change.
  useEffect(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: any }).google : null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const map = mapRef.current;
    if (!g || !map) return;

    for (const m of resultMarkersRef.current) m.setMap(null);
    resultMarkersRef.current = [];

    for (const r of results) {
      if (r.lat == null || r.lng == null) continue;
      const marker = new g.maps.Marker({
        position: { lat: r.lat, lng: r.lng },
        map,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: "#A0762C",
          fillOpacity: 1,
          strokeColor: "#F7F6F1",
          strokeWeight: 1.5,
        },
        title: `${r.name ?? "Open in Google Maps"}`,
        zIndex: 2,
      });
      marker.addListener("click", () => window.open(mapsUrl(r), "_blank", "noopener,noreferrer"));
      resultMarkersRef.current.push(marker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, loaded]);

  if (!apiKey) {
    return (
      <Frame>
        <p className="max-w-[52ch] text-center text-[13px] leading-relaxed text-[#5B6560]">
          No map key configured, so there is no map to draw an area on.
        </p>
      </Frame>
    );
  }
  if (loadFailed) {
    return (
      <Frame>
        <p className="text-[13px] text-[#A0762C]">The map failed to load.</p>
      </Frame>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-[#E2DFD5] bg-white">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-[#E2DFD5] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onChange(pins.slice(0, -1))}
            disabled={disabled || pins.length === 0}
            className={toolBtn}
            title="Remove the last pin"
          >
            <SearchIco name="close" size={12} />
            Undo pin
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={disabled || pins.length === 0}
            className={toolBtn}
            title="Remove every pin and start the area again"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-white">
            <span className="text-[13px] text-[#8A928C]">Loading map...</span>
          </div>
        )}

        {loaded && pins.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-[#E2DFD5] bg-white/95 px-3 py-2 text-[12.5px] text-[#5B6560]">
            Tap the map to drop pins around the area to work. Three pins close it.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[#E2DFD5] px-3 py-2 text-[12px] text-[#8A928C]">
        <span className="tabular-nums">
          <span className="font-medium text-[#14201B]">{pins.length}</span> pin
          {pins.length === 1 ? "" : "s"}
          {span != null && <> · {span.toFixed(1)} km across</>}
          {results.length > 0 && (
            <>
              {" "}
              · <span className="font-medium text-[#A0762C]">{results.length}</span> found, tap a
              dot for Google Maps
            </>
          )}
        </span>
        {pins.length > 0 && pins.length < 3 && <span>{3 - pins.length} more to close the area.</span>}
      </div>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-[#E2DFD5] bg-white p-8">
      {children}
    </div>
  );
}
