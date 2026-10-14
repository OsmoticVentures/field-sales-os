/**
 * Trackpad pinch zooms a Google map, wherever the pinch arrives from: a
 * ctrl+wheel (desktop browsers), WebKit's gesture events (Safari), or the
 * Mac app's own pinch recognizer, which posts "nativepinch" on window with the
 * scale and the point under the fingers (ios/App/App/SceneDelegate.swift).
 * Returns the cleanup.
 */
type PinchMap = { getZoom(): number | undefined; setZoom(z: number): void };
type NativePinch = { state: "began" | "changed" | "ended"; scale: number; x: number; y: number };

const MIN_ZOOM = 3;
const MAX_ZOOM = 20;
const GAIN = 3;
const clamp = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

export function enablePinchZoom(el: HTMLElement, map: PinchMap): () => void {
  let start = map.getZoom() ?? 10;
  let pinching = false;
  // A trackpad pinch moves the scale far less than fingers on glass, so it is
  // amplified: a level for about every 12% of pinch. Fractional zoom isn't on
  // for these maps, so it steps whole levels.
  const apply = (scale: number) => {
    const next = Math.round(clamp(start + GAIN * Math.log2(scale)));
    if (next !== map.getZoom()) map.setZoom(next);
  };

  let wheel = 0;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    wheel -= e.deltaY;
    if (Math.abs(wheel) < 40) return;
    map.setZoom(clamp((map.getZoom() ?? 10) + Math.sign(wheel)));
    wheel = 0;
  };

  const onGestureStart = (e: Event) => {
    e.preventDefault();
    start = map.getZoom() ?? start;
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
        (window as unknown as { __pinchHit?: boolean }).__pinchHit = true;
      }
      return;
    }
    if (!pinching) return;
    if (d.state === "ended") {
      pinching = false;
      return;
    }
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
