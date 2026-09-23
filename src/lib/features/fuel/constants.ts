/**
 * Fuel Routing's fixed numbers. Ported unchanged from
 * portfolio/src/app/gas/lib/constants.ts, minus the car-wash rate and the
 * Upside annotation constant: this port scopes to the gas price finder the
 * deck describes (see PORTING.md's m8f note in the field-sales-os plan).
 */

export type Favorite = { id: string; label: string; address: string; lat: number; lng: number };

/* Geocoded once through Places on 2026-09-13; the coordinates are the pin,
   the address is what Apple Maps gets so it resolves to the door, not a lot. */
export const FAVORITES: Favorite[] = [
  { id: "home", label: "Home", address: "1012 9th St, Manhattan Beach, CA 90266", lat: 33.8845071, lng: -118.3977038 },
  { id: "marvista", label: "Mar Vista", address: "3570 S Centinela Ave, Los Angeles, CA 90066", lat: 34.0087142, lng: -118.4371856 },
  { id: "newport", label: "Newport", address: "10 Deerwood Ln, Newport Beach, CA 92660", lat: 33.6268079, lng: -117.8723912 },
];

export const TANK_GALLONS = 16;
export const GALLON_STEP = 0.5;

/** Dollars per minute of detour, per gallon bought. */
export const RATE_CHEAPEST = 0.01;
export const RATE_QUICKEST = 0.03;

/** Miles kept unspent when a typed miles-to-empty number filters out
 *  stations the tank can't actually reach. */
export const RESERVE_MILES = 20;
