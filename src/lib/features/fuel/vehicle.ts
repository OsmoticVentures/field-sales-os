/**
 * Each rep's car and saved places. Server-side only: the places are home
 * addresses, so they reach a phone through /api/fuel/vehicle for the rep who
 * owns them and never sit in the shared client bundle.
 *
 * rangeMiles, when known, lets Fuel estimate miles to empty from the tank
 * gauge when the rep has not typed the dashboard's number.
 */
import "server-only";
import { currentUserId } from "../../core/user";
import type { Favorite } from "./constants";

export type Vehicle = { tankGallons: number; rangeMiles: number | null; favorites: Favorite[] };

/* Geocoded once through Places on 2026-09-13; the coordinates are the pin,
   the address is what Apple Maps gets so it resolves to the door, not a lot. */
const VEHICLES: Record<string, Vehicle> = {
  juan: {
    tankGallons: 16,
    rangeMiles: null,
    favorites: [
      { id: "home", label: "Home", address: "1012 9th St, Manhattan Beach, CA 90266", lat: 33.8845071, lng: -118.3977038 },
      { id: "marvista", label: "Mar Vista", address: "3570 S Centinela Ave, Los Angeles, CA 90066", lat: 34.0087142, lng: -118.4371856 },
      { id: "newport", label: "Newport", address: "10 Deerwood Ln, Newport Beach, CA 92660", lat: 33.6268079, lng: -117.8723912 },
    ],
  },
  // Kyle's car, per Juan 2026-10-07: 13 gallon tank, 400 mile range.
  kyle: { tankGallons: 13, rangeMiles: 400, favorites: [] },
};

const FALLBACK: Vehicle = { tankGallons: 16, rangeMiles: null, favorites: [] };

export async function myVehicle(): Promise<Vehicle> {
  return VEHICLES[await currentUserId()] ?? FALLBACK;
}
