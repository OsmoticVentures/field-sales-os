"use client";
/** The named people on the rep's accounts, from the same cached book read the
 *  Search tab uses. One fetch per session, searched locally afterwards. */
import { useEffect, useState } from "react";
import { getJson, peekJson } from "@/lib/core/api";
import { groupPeople } from "./account-search";

type Book = { ok: boolean; results?: { kind?: string; id: string; name: string }[] };

export function useBookPeople(): Map<string, string[]> {
  const [people, setPeople] = useState(() => groupPeople(peekJson<Book>("/api/search/book")?.results ?? []));
  useEffect(() => {
    let live = true;
    getJson<Book>("/api/search/book")
      .then((j) => {
        if (live && j.ok) setPeople(groupPeople(j.results ?? []));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return people;
}
