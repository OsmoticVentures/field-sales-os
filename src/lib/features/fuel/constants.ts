/**
 * Fuel Routing's fixed numbers. Ported unchanged from
 * portfolio/src/app/gas/lib/constants.ts, minus the car-wash rate and the
 * Upside annotation constant: this port scopes to the gas price finder the
 * deck describes (see PORTING.md's m8f note in the field-sales-os plan).
 * The car and its saved places are per rep and live server-side, in
 * vehicle.ts, so one rep's addresses never reach the other's phone.
 */

export type Favorite = { id: string; label: string; address: string; lat: number; lng: number };


export const GALLON_STEP = 0.5;

/** Dollars per minute of detour, per gallon bought. */
export const RATE_CHEAPEST = 0.01;
export const RATE_QUICKEST = 0.03;

