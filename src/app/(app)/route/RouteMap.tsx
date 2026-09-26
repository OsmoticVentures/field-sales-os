"use client";

/**
 * The day on a map: numbered pins in stop order, the road shape OSRM
 * returned for the drive (the same call that prices the legs), start and
 * end as hollow rings, and the rep's own position when the browser gives
 * it. Vanilla google.maps through lib/shared/google-maps-loader.ts, the
 * same approach as Search's AreaPicker, so no new dependency.
 *
 * Read-only on purpose: reordering, adding and removing happen in the list
 * below it, where the buttons are 44px and readable at a red light. The
 * map is for seeing the shape of the day, not editing it.
 */

import { useEffect, useRef, useState } from "react";
import { Geolocation } from "@capacitor/geolocation";
import { loadGoogleMaps } from "@/lib/shared/google-maps-loader";
import type { RouteEndpoint, RouteStopView } from "@/lib/features/route/types";

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

/* eslint-disable @typescript-eslint/no-explicit-any */
type G = any;

export function RouteMap({
  stops,
  start,
  end,
  coords,
  doneIds,
  focus,
}: {
  stops: RouteStopView[];
  start: RouteEndpoint | null;
  end: RouteEndpoint | null;
  /** OSRM geometry as [lng, lat] pairs; null while loading or unavailable. */
  coords: [number, number][] | null;
  doneIds: Set<string>;
  /** A stop to pan to; `n` changes on every tap so the same stop re-centers. */
  focus?: { id: string; n: number } | null;
}) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<G>(null);
  const markersRef = useRef<G[]>([]);
  const lineRef = useRef<G>(null);
  const meRef = useRef<G>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);

  // Google reports a rejected key (referrer, billing) through this one global
  // hook after the script itself loaded fine; without it the card sits blank.
  useEffect(() => {
    const w = window as unknown as { gm_authFailure?: () => void; __gmAuthFailed?: boolean };
    if (w.__gmAuthFailed) {
      setFailed(true);
      return;
    }
    const prev = w.gm_authFailure;
    w.gm_authFailure = () => {
      w.__gmAuthFailed = true;
      prev?.();
      setFailed(true);
    };
    return () => {
      if (w.gm_authFailure && !w.__gmAuthFailed) w.gm_authFailure = prev;
    };
  }, []);

  useEffect(() => {
    if (!apiKey || !containerRef.current) return;
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        mapRef.current = new g.maps.Map(containerRef.current, {
          center: FALLBACK_CENTER,
          zoom: 10,
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "cooperative",
          keyboardShortcuts: false,
        });
        setLoaded(true);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  useEffect(() => {
    let cancelled = false;
    Geolocation.getCurrentPosition({ timeout: 8000, maximumAge: 600_000 })
      .then((pos) => {
        if (!cancelled) setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Pins, rings and the road shape, redrawn whenever the day changes.
  useEffect(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: G }).google : null;
    const map = mapRef.current;
    if (!g || !map || !loaded) return;

    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = [];
    if (lineRef.current) {
      lineRef.current.setMap(null);
      lineRef.current = null;
    }

    const bounds = new g.maps.LatLngBounds();
    const ring = (p: RouteEndpoint, title: string) => {
      const marker = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        title,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 6, fillColor: "#F7F6F1", fillOpacity: 1, strokeColor: "#14201B", strokeWeight: 2 },
        zIndex: 1,
      });
      markersRef.current.push(marker);
      bounds.extend({ lat: p.lat, lng: p.lng });
    };
    if (start) ring(start, `Start: ${start.label}`);
    if (end && (!start || end.lat !== start.lat || end.lng !== start.lng)) ring(end, `End: ${end.label}`);

    stops.forEach((s, i) => {
      const custom = s.type === "custom";
      const done = doneIds.has(s.id);
      const marker = new g.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        map,
        title: s.type === "account" ? s.account.name : s.custom.label,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor: done ? "#8A928C" : custom ? "#A0762C" : "#14201B",
          fillOpacity: 1,
          strokeColor: "#F7F6F1",
          strokeWeight: 2,
        },
        label: { text: String(i + 1), color: "#F7F6F1", fontSize: "11px", fontWeight: "600" },
        zIndex: 3,
      });
      markersRef.current.push(marker);
      bounds.extend({ lat: s.lat, lng: s.lng });
    });

    if (coords && coords.length > 1) {
      lineRef.current = new g.maps.Polyline({
        path: coords.map(([lng, lat]) => ({ lat, lng })),
        map,
        strokeColor: "#14201B",
        strokeOpacity: 0.7,
        strokeWeight: 3,
        clickable: false,
        zIndex: 2,
      });
    }

    if (!bounds.isEmpty()) {
      if (stops.length + (start ? 1 : 0) + (end ? 1 : 0) === 1) {
        map.setCenter(bounds.getCenter());
        map.setZoom(13);
      } else {
        map.fitBounds(bounds, 36);
      }
    }
  }, [stops, start, end, coords, doneIds, loaded]);

  // The rep's own dot, kept separate so a location fix never refits the view.
  useEffect(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: G }).google : null;
    const map = mapRef.current;
    if (!g || !map || !loaded) return;
    if (meRef.current) {
      meRef.current.setMap(null);
      meRef.current = null;
    }
    if (!me) return;
    meRef.current = new g.maps.Marker({
      position: me,
      map,
      title: "You",
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#2C6A46", fillOpacity: 1, strokeColor: "#F7F6F1", strokeWeight: 2.5 },
      zIndex: 4,
    });
  }, [me, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!focus || !map || !loaded) return;
    const s = stops.find((x) => x.id === focus.id);
    if (!s) return;
    map.panTo({ lat: s.lat, lng: s.lng });
    map.setZoom(15);
    // Only a new tap should move the map, not a re-render of the same stops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, loaded]);

  if (!apiKey || failed) {
    return (
      <div className="flex min-h-11 items-center gap-2 rounded-lg border border-[#E2DFD5] bg-white px-4 py-3 text-[13px] text-[#8A928C]">
        Map unavailable
      </div>
    );
  }

  return (
    <div className="relative h-[220px] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white md:h-[320px]">
      <div ref={containerRef} className="absolute inset-0" />
      {!loaded && <div className="absolute inset-0 animate-pulse bg-[#EDEBE3] motion-reduce:animate-none" />}
    </div>
  );
}
