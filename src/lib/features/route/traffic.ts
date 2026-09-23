/**
 * What a Southern California drive actually costs, at the hour it happens.
 * Ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/map/traffic.ts). A time-of-day shape, not a
 * traffic feed: labelled a planning estimate everywhere it is shown, never
 * an ETA.
 */

const CONTROL_POINTS: Array<[hour: number, factor: number]> = [
  [0, 1.05],
  [5, 1.08],
  [7, 1.5],
  [8, 1.6],
  [9, 1.45],
  [11, 1.24],
  [13, 1.26],
  [15, 1.5],
  [17, 1.75],
  [18, 1.65],
  [20, 1.18],
  [22, 1.08],
  [24, 1.05],
];

const WEEKEND_FACTOR = 1.15;

export function trafficFactorAt(at: Date): number {
  const day = at.getDay();
  if (day === 0 || day === 6) return WEEKEND_FACTOR;

  const hour = at.getHours() + at.getMinutes() / 60;
  for (let i = 1; i < CONTROL_POINTS.length; i++) {
    const [h0, f0] = CONTROL_POINTS[i - 1];
    const [h1, f1] = CONTROL_POINTS[i];
    if (hour <= h1) {
      const t = h1 === h0 ? 0 : (hour - h0) / (h1 - h0);
      return f0 + (f1 - f0) * t;
    }
  }
  return CONTROL_POINTS[CONTROL_POINTS.length - 1][1];
}

export function likelyDriveMinutes(freeFlowMinutes: number, at: Date): number {
  return Math.round(freeFlowMinutes * trafficFactorAt(at));
}

export type DriveBand = "walk" | "near" | "far" | "haul";

export const WALKABLE_MINUTES = 5;
export const HAUL_MINUTES = 46;

export function driveBand(minutes: number): DriveBand {
  const m = Math.round(minutes);
  if (m <= WALKABLE_MINUTES) return "walk";
  if (m <= 25) return "near";
  if (m <= 45) return "far";
  return "haul";
}

export const BAND_STYLE: Record<DriveBand, { color: string; title: string }> = {
  walk: { color: "#00A852", title: "Walkable, 5 min or less" },
  near: { color: "#C79A1E", title: "6 to 25 min" },
  far: { color: "#B5372A", title: "26 to 45 min" },
  haul: { color: "#5B6560", title: "46 min or more" },
};
