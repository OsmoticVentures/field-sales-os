"use client";

/**
 * The signed-in rep, on the client. Remembered in localStorage so the nav
 * draws the right screens on the first paint, then confirmed from /api/me.
 *
 * A CHANGE OF REP WIPES THE PHONE COPY. The reads kept on disk
 * (phone-store.ts) are the last rep's book; a browser that one rep signed
 * out of and the other signed in to must never paint the first one's data.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { replaceAll } from "./phone-store";

export type Me = { id: string; name: string; features: string[] | null };

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
      const prior = remembered();
      if (prior && prior.id !== me.id) {
        await replaceAll("reads", []).catch(() => false);
        await replaceAll("snap", []).catch(() => false);
      }
      try {
        localStorage.setItem(KEY, JSON.stringify(me));
      } catch {
        // Private mode: the nav simply waits for the network each time.
      }
      return me;
    })
    .catch(() => null);
  return inflight;
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
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
