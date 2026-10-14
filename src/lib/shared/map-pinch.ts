/**
 * Trackpad pinch zooms a Google map, wherever the pinch arrives from: a
 * ctrl+wheel (desktop browsers), WebKit's gesture events (Safari), or the
 * Mac app's own pinch recognizer, which posts "nativepinch" on window with the
 * scale and the point under the fingers (ios/App/App/SceneDelegate.swift).
 * The place under the fingers stays under the fingers as the zoom changes.
 * Returns the cleanup.
 */
type XY = { x: number; y: number };
type LatLng = unknown;
type Projection = { fromLatLngToPoint(ll: LatLng): XY | null; fromPointToLatLng(p: XY): LatLng | null };
type PinchMap = {
  getZoom(): number | undefined;
  setZoom(z: number): void;
  getCenter(): LatLng | undefined;
  getProjection(): Projection | undefined | null;
  moveCamera(o: { center: LatLng; zoom: number }): void;
};
type NativePinch = { state: "began" | "changed" | "ended"; scale: number; x: number; y: number };

const MIN_ZOOM = 3;
const MAX_ZOOM = 20;
const GAIN = 3;
const clamp = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

export function enablePinchZoom(el: HTMLElement, map: PinchMap): () => void {
  let start = map.getZoom() ?? 10;
  let pinching = false;
  // The world point (zoom 0 pixels) under the fingers when the pinch began.
  let anchor: XY | null = null;
  let at: XY = { x: 0, y: 0 };

  const offset = (x: number, y: number): XY => {
    const r = el.getBoundingClientRect();
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  };
  const anchorAt = (x: number, y: number) => {
    at = { x, y };
    const proj = map.getProjection();
    const c = map.getCenter();
    const w = proj && c ? proj.fromLatLngToPoint(c) : null;
    if (!proj || !w) return void (anchor = null);
    const k = 2 ** (map.getZoom() ?? start);
    const o = offset(x, y);
    anchor = { x: w.x + o.x / k, y: w.y + o.y / k };
  };
  // Zoom so the anchored place sits under the fingers' current point.
  const zoomTo = (z: number) => {
    const proj = map.getProjection();
    if (!anchor || !proj) return map.setZoom(z);
    const k = 2 ** z;
    const o = offset(at.x, at.y);
    const center = proj.fromPointToLatLng({ x: anchor.x - o.x / k, y: anchor.y - o.y / k });
    if (center) map.moveCamera({ center, zoom: z });
    else map.setZoom(z);
  };
  // A trackpad pinch moves the scale far less than fingers on glass, so it is
  // amplified: a level for about every 12% of pinch. Fractional zoom isn't on
  // for these maps, so it steps whole levels.
  const apply = (scale: number) => {
    const next = Math.round(clamp(start + GAIN * Math.log2(scale)));
    if (next !== map.getZoom()) zoomTo(next);
  };

  let wheel = 0;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    wheel -= e.deltaY;
    if (Math.abs(wheel) < 40) return;
    anchorAt(e.clientX, e.clientY);
    zoomTo(clamp((map.getZoom() ?? 10) + Math.sign(wheel)));
    wheel = 0;
  };

  const onGestureStart = (e: Event) => {
    e.preventDefault();
    start = map.getZoom() ?? start;
    const g = e as Event & { clientX: number; clientY: number };
    anchorAt(g.clientX, g.clientY);
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    apply((e as Event & { scale: number }).scale);
  };

  // UIKit reports the scale back at 1 when the fingers lift, so the end only
  // releases the pinch; applying it would snap the map back to where it began.
  const onNative = (e: Event) => {
    const d = (e as CustomEvent<NativePinch>).detail;
    if (d.state === "began") {
      const r = el.getBoundingClientRect();
      pinching = d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom;
      if (pinching) {
        start = map.getZoom() ?? start;
        anchorAt(d.x, d.y);
        (window as unknown as { __pinchHit?: boolean }).__pinchHit = true;
      }
      return;
    }
    if (!pinching) return;
    if (d.state === "ended") {
      pinching = false;
      return;
    }
    at = { x: d.x, y: d.y };
    apply(d.scale);
  };

  el.addEventListener("wheel", onWheel, { passive: false, capture: true });
  el.addEventListener("gesturestart", onGestureStart);
  el.addEventListener("gesturechange", onGestureChange);
  window.addEventListener("nativepinch", onNative);
  return () => {
    el.removeEventListener("wheel", onWheel, { capture: true });
    el.removeEventListener("gesturestart", onGestureStart);
    el.removeEventListener("gesturechange", onGestureChange);
    window.removeEventListener("nativepinch", onNative);
  };
}
