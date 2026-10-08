"use client";

/**
 * The signed-in rep, on the client. Remembered in localStorage so the nav
 * draws the right screens on the first paint, then confirmed from /api/me.
 *
 * A CHANGE OF REP WIPES THE PHONE COPY (rep.ts). The reads kept on disk
 * (phone-store.ts) are the last rep's book; a browser that one rep signed
 * out of and the other signed in to must never paint the first one's data,
 * so a change seen here wipes them and reloads the page.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { adoptRep } from "./rep";
import { flagOn } from "./rep-flags";

export type Me = {
  id: string;
  name: string;
  features: string[] | null;
  /** Switches on for this rep (rep-flags.ts with nb_flags laid over it).
   *  Missing on a copy remembered before flags moved to the database. */
  flags?: string[];
};

const KEY = "nb_me";

function remembered(): Me | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

let inflight: Promise<Me | null> | null = null;

function load(): Promise<Me | null> {
  inflight ??= apiFetch("/api/me")
    .then((r) => (r.ok ? r.json() : null))
    .then(async (j: { ok?: boolean; user?: Me } | null) => {
      const me = j?.ok && j.user ? j.user : null;
      if (!me) return null;
      const changed = await adoptRep(me.id);
      try {
        localStorage.setItem(KEY, JSON.stringify(me));
      } catch {
        // Private mode: the nav simply waits for the network each time.
      }
      if (changed) {
        // Memory still holds the last rep's reads: start the page clean.
        window.location.reload();
        return null;
      }
      return me;
    })
    .catch(() => null);
  return inflight;
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    // localStorage exists only in the browser, so the remembered rep loads
    // after hydration; reading it during render would mismatch the server HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMe(remembered());
    let live = true;
    void load().then((m) => {
      if (live && m) setMe(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return me;
}

/** Unknown rep (first paint on a fresh browser) shows everything, which is
 *  Juan's view; the gate refuses anything not theirs regardless. */
export function sees(me: Me | null, screen: string): boolean {
  return !me || me.features === null || me.features.includes(screen);
}

/** A per-rep switch for the signed-in rep, as /api/me last said (rep-flags.ts
 *  with nb_flags over it), or the file alone for a copy remembered before
 *  that list existed. Off until the rep is known, so the first paint is
 *  always the unchanged app. */
export function useFlag(name: string): boolean {
  const me = useMe();
  if (me?.flags) return me.flags.includes(name);
  return flagOn(me?.id, name);
}
