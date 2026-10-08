/**
 * The one spring every drag-and-release surface shares (AccountSheet,
 * AccountDrawer). Critically damped, so it never overshoots, and it starts
 * from the live value with the finger's velocity so a release has no seam
 * and a grab mid-flight reverses cleanly. Values are in px, velocity in px/s.
 */

const DECEL = 0.998; // apple-design momentum projection

/** Where a release at this velocity would come to rest, as a distance. */
export const project = (velocity: number): number => ((velocity / 1000) * DECEL) / (1 - DECEL);

/** Progressive resistance past a bound: the further over, the less it follows. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

type SpringArgs = {
  from: number;
  to: number;
  velocity?: number;
  /** Seconds to reach the target, not a duration. */
  response?: number;
  /** End the moment it reaches the target instead of rebounding past it. */
  stopAtTarget?: boolean;
  onFrame: (value: number) => void;
  onDone?: () => void;
};

/** Runs the spring and returns a function that stops it where it is. */
export function runSpring({ from, to, velocity = 0, response = 0.38, stopAtTarget = false, onFrame, onDone }: SpringArgs): () => void {
  const omega = (2 * Math.PI) / response;
  let pos = from;
  let vel = velocity;
  let last = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    const acc = -omega * omega * (pos - to) - 2 * omega * vel;
    vel += acc * dt;
    pos += vel * dt;
    if (stopAtTarget && (pos - to) * (from - to) <= 0) {
      onFrame(to);
      onDone?.();
      return;
    }
    if (Math.abs(pos - to) < 0.4 && Math.abs(vel) < 8) {
      onFrame(to);
      onDone?.();
      return;
    }
    onFrame(pos);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/** A short eased run for reduced motion, where nothing travels. */
export function runFade({
  from,
  to,
  ms = 160,
  onFrame,
  onDone,
}: {
  from: number;
  to: number;
  ms?: number;
  onFrame: (v: number) => void;
  onDone?: () => void;
}): () => void {
  const start = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) * (1 - t);
    onFrame(from + (to - from) * eased);
    if (t < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
