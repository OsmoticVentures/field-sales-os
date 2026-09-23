"use client";

/**
 * The prospecting console: draw an area, search it, pick what to look
 * further into, pick what to put on the cold-call queue. Ported from
 * portfolio/src/app/nutribiotic/search/SearchClient.tsx.
 *
 * THREE ACTIONS, THREE DECISIONS, IN ONE PLACE (Juan, 2026-09-09):
 *
 *   Search this area   Google + the book. A list. Nothing fetched, nothing written.
 *   Look further       ONLY the ticked rows get their websites read. A preview.
 *   Add to SDR          ONLY the ticked rows become prospects and calls, reading
 *                       the site first for any row "Look further" hasn't already
 *                       covered.
 *
 * THE PIPELINE IS bridges/nutribiotic/places_search_ingest.py, unchanged by
 * this port. This screen is its console: it computes no counts of its own,
 * never fills a blank, and does not decide what is inside the drawn area
 * (the server's ray-cast does). A candidate with no about-us line or no named
 * human renders with that cell EMPTY, never "unknown".
 *
 * EVERY ACTION IS A QUEUED JOB, NOT A REQUEST THAT WAITS. The pipeline runs
 * on Juan's Mac; Vercel has no Python. Each button posts a job, gets an id
 * back, and polls it. "Pending" is a real, recoverable state, not a failure.
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico, SuccessNote } from "../../../lib/core/ui";
import { rankMatches } from "../../../lib/features/search/search-match";
import { AreaPicker, mapsUrl, type Pin } from "./AreaPicker";

/* ------------------------------------------------------------------ *
 * one shared set of surface tokens, so the console reads as one tool  *
 * ------------------------------------------------------------------ */
const inputCls =
  "w-full min-h-11 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-2.5 py-2 text-base text-[#14201B] " +
  "placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none";
const labelCls = "mb-1 block text-[11px] uppercase tracking-[0.1em] text-[#8A928C]";
const primaryBtn =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#14201B] px-3.5 py-2.5 text-[14px] font-medium " +
  "text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100 disabled:opacity-30";
const secondaryBtn =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#14201B] bg-white px-3 py-2.5 text-[14px] " +
  "font-medium text-[#14201B] transition-transform active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100 " +
  "disabled:border-[#E2DFD5] disabled:text-[#A9AFA9]";
const panel = "rounded-lg border border-[#E2DFD5] bg-white";
const th = "whitespace-nowrap px-3 py-2 text-left font-medium";
const td = "px-3 py-2 align-top";

export type Candidate = {
  key: string;
  name: string | null;
  city: string | null;
  street: string | null;
  address: string | null;
  postal: string | null;
  area: string | null;
  phone: string | null;
  website: string | null;
  website_raw: string | null;
  places_id: string | null;
  lat: number | null;
  lng: number | null;
  hours_today: string | null;
  places_rating: number | null;
  places_rating_count: number | null;
  triage_score: number;
  triage_parts: Record<string, number>;
  enriched: boolean;
  about: string | null;
  about_url: string | null;
  about_basis: string | null;
  decision_maker_candidate: string | null;
  decision_maker_found_by: string | null;
  fit_tags: string[];
  catalog_terms: string[];
  pages_read: string[];
  site_failures: string[];
  /** Set by the land stage, and only by it. Its presence is what makes a row
   *  a real prospect on screen. */
  id?: string;
};

type StageReply = {
  ok: boolean;
  stage?: string;
  job?: string;
  status?: string;
  errors?: string[];
  error?: string;
  written?: boolean;
  candidates?: Candidate[];
  stages?: {
    search?: { distinct_places?: number; live_calls?: number; hit_google_ceiling?: string[] };
    triage?: {
      considered?: number;
      survivors?: number;
      capped_off?: number;
      dropped?: Record<string, number>;
      book_size?: number;
    };
    enrich?: {
      attempted?: number;
      with_about?: number;
      with_person?: number;
      with_fit?: number;
      failed?: number;
    };
    land?: {
      accounts?: number;
      sdr_calls?: number;
      first_sdr_day?: string;
      inserted_accounts?: number;
      inserted_sdr?: number;
      skipped?: { name: string | null; why: string }[];
    };
  };
};

type Busy = null | "search" | "enrich" | "land";
type SortKey = "triage" | "name" | "rating" | "reviews";

type Progress = { stage: Exclude<Busy, null>; status: "pending" | "running"; elapsedMs: number };

const POLL_MS = 1500;
const WAITING_AFTER_MS = 20_000;
const GIVE_UP_MS = 180_000;

const RUNNING_LINE: Record<Exclude<Busy, null>, string> = {
  search: "Searching Google from your Mac",
  enrich: "Reading their websites from your Mac",
  land: "Adding them from your Mac",
};

/** Sunday-first, matching Google's own period.open.day and JS Date.getDay(). */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A drop reason off the worker is a precise, internal string. This turns it
 *  into the one plain sentence Juan needs. Unrecognized reasons still show,
 *  capitalized, rather than disappearing. */
function humanizeDropReason(key: string): string {
  if (key === "permanently closed") return "Permanently closed on Google";
  if (key === "already a customer") return "Already a customer";
  if (key.startsWith("already in the book")) return "Already in your book";
  const excludedCategory = key.match(/^excluded category \((.+)\)$/);
  if (excludedCategory) return `Excluded category: ${excludedCategory[1]}`;
  const excludedChain = key.match(/^excluded chain \((.+)\)$/);
  if (excludedChain) return `Excluded chain: ${excludedChain[1]}`;
  if (key.startsWith("state ")) return "Outside California";
  if (key === "city outside the territory areas") return "Outside your territory";
  if (key.includes("coordinates")) return "No location on file";
  if (key === "inside the bounding box, outside the drawn area") return "Outside the area you drew";
  if (/^outside the .*radius$/.test(key)) return "Outside the radius";
  if (key === "no phone (require_phone)") return "No phone number listed";
  if (key === "no website (require_website)") return "No website listed";
  const underReviews = key.match(/^under (\d+) reviews$/);
  if (underReviews) return `Fewer than ${underReviews[1]} reviews`;
  const underPhotos = key.match(/^under (\d+) photo/);
  if (underPhotos) return `Fewer than ${underPhotos[1]} photos`;
  if (key === "no rating (min_rating)") return "No rating on Google";
  const underStars = key.match(/^under ([\d.]+) stars$/);
  if (underStars) return `Under ${underStars[1]} stars`;
  const triage = key.match(/^triage < (.+)$/);
  if (triage) return `Low score (under ${triage[1]})`;
  if (key === "hours not listed on Google") return "Hours not listed on Google";
  if (key.startsWith("closed at ")) return key.charAt(0).toUpperCase() + key.slice(1);
  if (/^thinned, over \d+ per sq mi$/.test(key)) return "Too many similar places nearby";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Builds the landed-run success line from only the fields the worker sent.
 *  A field it left off stays absent, never a fabricated 0 or an empty day. */
function landedTitle(landMeta: StageReply): string {
  const land = landMeta.stages?.land;
  const parts: string[] = [];
  if (land?.inserted_accounts != null) {
    parts.push(`${land.inserted_accounts} prospect${land.inserted_accounts === 1 ? "" : "s"} added`);
  }
  if (land?.inserted_sdr != null) {
    const day = land.first_sdr_day ? ` from ${land.first_sdr_day}` : "";
    parts.push(`${land.inserted_sdr} call${land.inserted_sdr === 1 ? "" : "s"} queued${day}`);
  }
  return parts.length > 0 ? `${parts.join(", ")}.` : "Added.";
}

export function SearchClient() {
  const [pins, setPins] = useState<Pin[]>([]);
  const [query, setQuery] = useState("medical spa");

  const [minReviews, setMinReviews] = useState("30");
  const [minRating, setMinRating] = useState("4.0");
  const [minTriage, setMinTriage] = useState("45");
  const [requirePhone, setRequirePhone] = useState(true);
  const [requireWebsite, setRequireWebsite] = useState(true);
  const [narrowType, setNarrowType] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [excludeCategories, setExcludeCategories] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState("");
  const [suggestions, setSuggestions] = useState<{ category: string; why: string }[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const [chainExclude, setChainExclude] = useState(false);
  const [chainNames, setChainNames] = useState<string[]>([]);
  const [chainInput, setChainInput] = useState("");
  const [minPhotos, setMinPhotos] = useState("");
  const [maxPerSqMile, setMaxPerSqMile] = useState("");

  const [openDay, setOpenDay] = useState<"" | "today" | number>("");
  const [openTime, setOpenTime] = useState("18:00");
  const [deepRun, setDeepRun] = useState(false);

  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("triage");

  const [meta, setMeta] = useState<StageReply | null>(null);
  const [enrichMeta, setEnrichMeta] = useState<StageReply["stages"] | null>(null);
  const [landMeta, setLandMeta] = useState<StageReply | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const canSearch = pins.length >= 3 && query.trim().length > 0 && busy === null;

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (minReviews !== "30") n++;
    if (minRating !== "4.0") n++;
    if (minTriage !== "45") n++;
    if (!requirePhone) n++;
    if (!requireWebsite) n++;
    if (!narrowType) n++;
    if (excludeCategories.length > 0) n++;
    if (chainExclude) n++;
    if (minPhotos.trim()) n++;
    if (maxPerSqMile.trim()) n++;
    if (openDay !== "") n++;
    return n;
  }, [
    minReviews,
    minRating,
    minTriage,
    requirePhone,
    requireWebsite,
    narrowType,
    excludeCategories,
    chainExclude,
    minPhotos,
    maxPerSqMile,
    openDay,
  ]);

  /**
   * Queue one stage and wait for the Mac to answer it. POST is one insert
   * and carries a fresh Idempotency-Key per click; everything after it is
   * polling one row, which is safe to miss a beat on since the run itself
   * lives on the Mac, unaffected by a dropped poll from this tab.
   */
  const post = useCallback(
    async (stage: Exclude<Busy, null>, payload: Record<string, unknown>): Promise<StageReply | null> => {
      let job: string;
      try {
        const res = await apiFetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ ...payload, stage }),
        });
        const json = (await res.json()) as StageReply & { job?: string };
        if (!res.ok || !json.ok || !json.job) {
          setFailure(json.error || "The run was not queued.");
          return null;
        }
        job = json.job;
      } catch {
        setFailure("Could not reach the OS. Nothing ran.");
        return null;
      }

      const since = Date.now();
      setProgress({ stage, status: "pending", elapsedMs: 0 });
      let last: "pending" | "running" = "pending";

      for (;;) {
        await sleep(POLL_MS);

        let json: (StageReply & { status?: string }) | null = null;
        try {
          const res = await apiFetch(`/api/search?job=${encodeURIComponent(job)}`, { cache: "no-store" });
          json = (await res.json()) as StageReply & { status?: string };
        } catch {
          json = null; // a dropped poll, not a dropped run
        }

        if (json && (json.status === "pending" || json.status === "running")) {
          last = json.status;
        }
        setProgress({ stage, status: last, elapsedMs: Date.now() - since });

        if (json && json.status && json.status !== "pending" && json.status !== "running") {
          setProgress(null);
          if (!json.ok && (json.errors ?? []).length > 0) {
            setFailure(json.errors!.join("\n"));
            return null;
          }
          if (!json.ok) {
            setFailure(json.error || "The run failed.");
            return null;
          }
          return json;
        }

        if (Date.now() - since > GIVE_UP_MS) {
          setProgress(null);
          setFailure(
            last === "running"
              ? "This started on your Mac and has not finished in three minutes. It is still running there."
              : "Your Mac has not picked this up in three minutes. It stays queued and will start once it is awake.",
          );
          return null;
        }
      }
    },
    [],
  );

  function addExclude(raw: string) {
    const v = raw.trim();
    if (!v) return;
    setExcludeCategories((cur) => (cur.some((c) => c.toLowerCase() === v.toLowerCase()) ? cur : [...cur, v]));
    setSuggestions((cur) => cur.filter((s) => s.category.toLowerCase() !== v.toLowerCase()));
  }
  function removeExclude(v: string) {
    setExcludeCategories((cur) => cur.filter((c) => c !== v));
  }
  function addChain(raw: string) {
    const v = raw.trim();
    if (!v) return;
    setChainNames((cur) => (cur.some((c) => c.toLowerCase() === v.toLowerCase()) ? cur : [...cur, v]));
  }
  function removeChain(v: string) {
    setChainNames((cur) => cur.filter((c) => c !== v));
  }

  async function suggestCategories() {
    const category = query.trim();
    if (!category || suggestBusy) return;
    setSuggestBusy(true);
    setSuggestError(null);
    try {
      const res = await apiFetch("/api/search/suggest-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, exclude_categories: excludeCategories }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        suggestions?: { category: string; why: string }[];
      };
      if (!res.ok || !json.ok) {
        setSuggestError(json.error || "Could not suggest categories.");
      } else {
        setSuggestions(json.suggestions ?? []);
      }
    } catch {
      setSuggestError("Could not reach the suggestion service.");
    }
    setSuggestBusy(false);
  }

  async function runSearch(deep = false) {
    setBusy("search");
    setDeepRun(deep);
    setFailure(null);
    setLandMeta(null);
    setEnrichMeta(null);
    const day = openDay === "" ? null : openDay === "today" ? new Date().getDay() : openDay;
    const reply = await post("search", {
      category: query.trim(),
      polygon: pins,
      min_review_count: Number.parseInt(minReviews, 10),
      min_rating: Number.parseFloat(minRating),
      min_triage_score: Number.parseFloat(minTriage),
      require_phone: requirePhone,
      require_website: requireWebsite,
      included_type: narrowType ? "auto" : "",
      exclude_categories: excludeCategories,
      chain_exclude: chainExclude,
      chain_names: chainNames,
      min_photos: minPhotos.trim() ? Number.parseInt(minPhotos, 10) : 0,
      max_per_sq_mile: maxPerSqMile.trim() ? Number.parseInt(maxPerSqMile, 10) : 0,
      open_day: day,
      open_time: day == null ? null : openTime,
      deep,
    });
    if (reply) {
      setMeta(reply);
      setRows(reply.candidates ?? []);
      setSelected(new Set());
      setExpanded(new Set());
    }
    setBusy(null);
  }

  async function runEnrich() {
    if (!rows) return;
    setBusy("enrich");
    setFailure(null);
    const picked = rows.filter((r) => selected.has(r.key));
    const reply = await post("enrich", { candidates: picked });
    if (reply) {
      const byKey = new Map((reply.candidates ?? []).map((c) => [c.key, c]));
      setRows(rows.map((r) => byKey.get(r.key) ?? r));
      setEnrichMeta(reply.stages ?? null);
    }
    setBusy(null);
  }

  async function runLand() {
    if (!rows) return;
    setBusy("land");
    setFailure(null);
    let working = rows;
    const toEnrich = working.filter((r) => selected.has(r.key) && !r.id && !r.enriched);
    if (toEnrich.length > 0) {
      const enrichReply = await post("enrich", { candidates: toEnrich });
      if (!enrichReply) {
        setBusy(null);
        return;
      }
      const byKey = new Map((enrichReply.candidates ?? []).map((c) => [c.key, c]));
      working = working.map((r) => byKey.get(r.key) ?? r);
      setRows(working);
      setEnrichMeta(enrichReply.stages ?? null);
    }
    const picked = working.filter((r) => selected.has(r.key) && !r.id);
    const reply = await post("land", {
      category: query.trim(),
      candidates: picked,
      write: true,
    });
    if (reply) {
      const byKey = new Map((reply.candidates ?? []).map((c) => [c.key, c]));
      setRows(working.map((r) => (byKey.has(r.key) ? { ...r, id: byKey.get(r.key)!.id } : r)));
      setLandMeta(reply);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const k of byKey.keys()) next.delete(k);
        return next;
      });
    }
    setBusy(null);
  }

  const sorted = useMemo(() => {
    if (!rows) return [];
    const copy = [...rows];
    copy.sort((a, b) => {
      if (sort === "name") return (a.name ?? "").localeCompare(b.name ?? "");
      if (sort === "rating") return (b.places_rating ?? 0) - (a.places_rating ?? 0);
      if (sort === "reviews") return (b.places_rating_count ?? 0) - (a.places_rating_count ?? 0);
      return b.triage_score - a.triage_score;
    });
    return copy;
  }, [rows, sort]);

  const selectable = sorted.filter((r) => !r.id);
  const selectedRows = sorted.filter((r) => selected.has(r.key));
  const selectedUnlanded = selectedRows.filter((r) => !r.id);
  const selectedEnriched = selectedUnlanded.filter((r) => r.enriched).length;
  const anyEnriched = sorted.some((r) => r.enriched);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size >= selectable.length ? new Set() : new Set(selectable.map((r) => r.key)),
    );
  }

  const resultPins = useMemo(
    () =>
      sorted.map((r) => ({
        key: r.key,
        lat: r.lat,
        lng: r.lng,
        name: r.name,
        address: r.address,
        placesId: r.places_id,
      })),
    [sorted],
  );

  return (
    <div className="flex flex-col gap-4 pb-24 lg:pb-0">
      <BookSearch />

      <div className={`${panel} hidden p-3 lg:block`}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8A928C]">
              <Ico name="search" size={15} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSearch) runSearch();
              }}
              placeholder="What kind of business?"
              aria-label="What kind of business to search for"
              className="min-h-11 w-full rounded-md border border-[#E2DFD5] bg-[#FAF9F5] py-2.5 pl-9 pr-3 text-base text-[#14201B] placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none"
            />
          </div>
          <button type="button" onClick={() => runSearch()} disabled={!canSearch} className={primaryBtn}>
            {busy === "search" && !deepRun ? "Searching..." : "Search this area"}
          </button>
          <button
            type="button"
            onClick={() => runSearch(true)}
            disabled={!canSearch}
            className={secondaryBtn}
            title="Keeps splitting any part of the area still at Google's cap until none of it is, for a complete list"
          >
            <Ico name="search" size={13} />
            {busy === "search" && deepRun ? "Finding everything..." : "Find all"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="h-[420px] lg:h-[520px]">
          <AreaPicker pins={pins} onChange={setPins} disabled={busy !== null} results={resultPins} />
        </div>

        <div className={`${panel} flex h-fit flex-col`}>
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className="flex min-h-11 items-center justify-between gap-2 border-b border-[#E2DFD5] px-3 py-2.5 text-left"
          >
            <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
              Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
            </span>
            <Ico name={filtersOpen ? "chevron-up" : "chevron-down"} size={13} />
          </button>

          <div className={filtersOpen ? "flex flex-col gap-3 p-3" : "hidden"}>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls} htmlFor="min-reviews">
                  Min reviews
                </label>
                <input
                  id="min-reviews"
                  className={inputCls}
                  inputMode="numeric"
                  value={minReviews}
                  onChange={(e) => setMinReviews(e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="min-rating">
                  Min rating
                </label>
                <input
                  id="min-rating"
                  className={inputCls}
                  inputMode="decimal"
                  value={minRating}
                  onChange={(e) => setMinRating(e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="min-triage">
                  Min score
                </label>
                <input
                  id="min-triage"
                  className={inputCls}
                  inputMode="numeric"
                  value={minTriage}
                  onChange={(e) => setMinTriage(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-[#EFEDE5] pt-3">
              <Check checked={requirePhone} onChange={setRequirePhone} label="Must have a phone" />
              <Check checked={requireWebsite} onChange={setRequireWebsite} label="Must have a website" />
              <Check checked={narrowType} onChange={setNarrowType} label="Let Google filter the category" />
            </div>

            <div className="flex flex-col gap-2 border-t border-[#EFEDE5] pt-3">
              <label className={labelCls}>Open at</label>
              <div className="flex gap-1.5">
                <select
                  className={inputCls}
                  value={openDay}
                  onChange={(e) =>
                    setOpenDay(
                      e.target.value === ""
                        ? ""
                        : e.target.value === "today"
                          ? "today"
                          : Number(e.target.value),
                    )
                  }
                >
                  <option value="">Any day</option>
                  <option value="today">Today</option>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  className={inputCls}
                  value={openTime}
                  onChange={(e) => setOpenTime(e.target.value)}
                  disabled={openDay === ""}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-[#EFEDE5] pt-3">
              <label className={labelCls}>Exclude categories</label>
              {excludeCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {excludeCategories.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => removeExclude(c)}
                      className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#E2DFD5] bg-[#F2F0E8] px-2.5 py-1.5 text-[11px] text-[#3D4A44] hover:bg-[#EFEDE5]"
                    >
                      {c}
                      <Ico name="close" size={10} />
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-1.5">
                <input
                  className={inputCls}
                  placeholder="e.g. nail salon"
                  value={excludeInput}
                  onChange={(e) => setExcludeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addExclude(excludeInput);
                      setExcludeInput("");
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    addExclude(excludeInput);
                    setExcludeInput("");
                  }}
                  className={`${secondaryBtn} px-2.5`}
                  aria-label="Add excluded category"
                >
                  <Ico name="plus" size={13} />
                </button>
              </div>
              <button
                type="button"
                onClick={suggestCategories}
                disabled={suggestBusy || !query.trim()}
                className="inline-flex min-h-11 items-center gap-1.5 self-start text-[13px] font-medium text-[#3D6B4A] disabled:cursor-not-allowed disabled:text-[#A9AFA9]"
              >
                {suggestBusy ? "Thinking..." : "Suggest categories to exclude"}
              </button>
              {suggestError && <span className="text-[12.5px] text-[#8A928C]">{suggestError}</span>}
              {suggestions.length > 0 && (
                <div className="flex flex-col gap-1">
                  {suggestions.map((s) => (
                    <button
                      key={s.category}
                      type="button"
                      onClick={() => addExclude(s.category)}
                      title={s.why}
                      className="flex items-center justify-between gap-2 rounded-md border border-dashed border-[#B9C7BC] bg-white px-2 py-1.5 text-left text-[12.5px] text-[#3D4A44] hover:bg-[#F2F0E8]"
                    >
                      <span>
                        <span className="font-medium">{s.category}</span>
                        <span className="ml-1 text-[#8A928C]">{s.why}</span>
                      </span>
                      <Ico name="plus" size={11} />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t border-[#EFEDE5] pt-3">
              <Check checked={chainExclude} onChange={setChainExclude} label="Exclude known chains" />
              {chainExclude && (
                <>
                  {chainNames.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {chainNames.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => removeChain(c)}
                          className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#E2DFD5] bg-[#F2F0E8] px-2.5 py-1.5 text-[11px] text-[#3D4A44] hover:bg-[#EFEDE5]"
                        >
                          {c}
                          <Ico name="close" size={10} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      className={inputCls}
                      placeholder="e.g. Massage Envy"
                      value={chainInput}
                      onChange={(e) => setChainInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addChain(chainInput);
                          setChainInput("");
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        addChain(chainInput);
                        setChainInput("");
                      }}
                      className={`${secondaryBtn} px-2.5`}
                      aria-label="Add chain name"
                    >
                      <Ico name="plus" size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-[#EFEDE5] pt-3">
              <div>
                <label className={labelCls} htmlFor="min-photos">
                  Min photos
                </label>
                <input
                  id="min-photos"
                  className={inputCls}
                  inputMode="numeric"
                  placeholder="Off"
                  value={minPhotos}
                  onChange={(e) => setMinPhotos(e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="max-per-sq-mile">
                  Max per sq mi
                </label>
                <input
                  id="max-per-sq-mile"
                  className={inputCls}
                  inputMode="numeric"
                  placeholder="Off"
                  value={maxPerSqMile}
                  onChange={(e) => setMaxPerSqMile(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {progress && <ProgressLine progress={progress} />}

      {failure && (
        <div className={`${panel} px-3.5 py-2.5`}>
          <span className="whitespace-pre-wrap text-[13px] text-[#3D4A44]">{failure}</span>
        </div>
      )}

      {meta && <RunBar meta={meta} enrich={enrichMeta} rows={sorted.length} />}

      {landMeta?.written && <SuccessNote title={landedTitle(landMeta)} detail="Not in HubSpot yet." />}

      {(landMeta?.stages?.land?.skipped ?? []).length > 0 && (
        <div className={`${panel} p-3 text-[12.5px] text-[#A0762C]`}>
          Not added, already in the book:{" "}
          {(landMeta!.stages!.land!.skipped ?? []).map((s) => s.name).join(", ")}
        </div>
      )}

      {rows && (
        <ResultsTable
          rows={sorted}
          selected={selected}
          expanded={expanded}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onExpand={(k) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(k)) next.delete(k);
              else next.add(k);
              return next;
            })
          }
          sort={sort}
          onSort={setSort}
          selectableCount={selectable.length}
          anyEnriched={anyEnriched}
        />
      )}

      {selectedUnlanded.length > 0 && (
        <SelectionBar
          count={selectedUnlanded.length}
          enrichedCount={selectedEnriched}
          busy={busy}
          onEnrich={runEnrich}
          onLand={runLand}
        />
      )}

      <MobileSearchBar query={query} onQueryChange={setQuery} onSearch={() => runSearch()} canSearch={canSearch} busy={busy} />
    </div>
  );
}

/** The mobile-only search action, pinned to the bottom of the viewport so it
 *  stays reachable regardless of scroll. The full query + Find all bar above
 *  stays desktop-only. */
function MobileSearchBar({
  query,
  onQueryChange,
  onSearch,
  canSearch,
  busy,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  onSearch: () => void;
  canSearch: boolean;
  busy: Busy;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[#E2DFD5] bg-white/95 px-3 pt-2 backdrop-blur lg:hidden"
      style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8A928C]">
            <Ico name="search" size={15} />
          </span>
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSearch) onSearch();
            }}
            placeholder="What kind of business?"
            aria-label="What kind of business to search for"
            className="min-h-11 w-full rounded-md border border-[#E2DFD5] bg-[#FAF9F5] py-2.5 pl-9 pr-3 text-base text-[#14201B] placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none"
          />
        </div>
        <button type="button" onClick={onSearch} disabled={!canSearch} className={`${primaryBtn} shrink-0`}>
          {busy === "search" ? "Searching..." : "Search"}
        </button>
      </div>
    </div>
  );
}

/** The selection action bar. Rises into place with a spring-like ease rather
 *  than popping in, and clears the mobile search bar and its safe area. */
function SelectionBar({
  count,
  enrichedCount,
  busy,
  onEnrich,
  onLand,
}: {
  count: number;
  enrichedCount: number;
  busy: Busy;
  onEnrich: () => void;
  onLand: () => void;
}) {
  const [risen, setRisen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRisen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={`sticky bottom-[calc(6rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center gap-2 rounded-lg border border-[#14201B] bg-white px-3 py-2.5 shadow-[0_8px_24px_rgba(20,32,27,0.12)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-opacity motion-reduce:duration-150 lg:bottom-4 ${
        risen ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0 motion-reduce:translate-y-0"
      }`}
    >
      <span className="text-[13px] font-medium tabular-nums text-[#14201B]">{count} selected</span>
      <span className="text-[12px] text-[#8A928C]">{enrichedCount} already looked into</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onEnrich}
          disabled={busy !== null}
          className={secondaryBtn}
          title="Read these businesses' own websites for an about line, a named decision maker and category fit"
        >
          <Ico name="globe" size={13} />
          {busy === "enrich" ? "Reading their sites..." : `Look further into ${count}`}
        </button>
        <button
          type="button"
          onClick={onLand}
          disabled={busy !== null}
          className={primaryBtn}
          title="Reads any un-enriched site first, then adds these as prospects and queues a call for each"
        >
          <Ico name="phone-arrow" size={13} />
          {busy === "land" ? "Adding..." : `Queue ${count} for calls`}
        </button>
      </div>
    </div>
  );
}

type BookResult = {
  id: string;
  name: string;
  area: string | null;
  tier: string | null;
  city: string | null;
  state: string | null;
};

const BOOK_RESULT_LIMIT = 5;

/**
 * "Search our book": find an account already in the book, by name, without
 * needing an exact spelling. Read-only.
 *
 * A match opens the Prospect screen focused on that account (the call card,
 * the Angle panel, the contacts). The source app's account-detail modal
 * (lib/modal.tsx) leans on its route context, outbound composer, touchpoint
 * UI and Server Actions, none of which exist here, so Prospect's own focus
 * view is the door in.
 */
function BookSearch() {
  const [book, setBook] = useState<BookResult[]>([]);
  const [q, setQ] = useState("");
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/search/book")
      .then((res) => res.json())
      .then((json: { ok: boolean; results?: BookResult[] }) => {
        if (!cancelled && json.ok) setBook(json.results ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    if (q.trim().length < 2) return [];
    return rankMatches(q, book, (r) => ({ name: r.name || "", also: [r.city, r.state, r.area] }), BOOK_RESULT_LIMIT);
  }, [book, q]);

  return (
    <div className={`${panel} relative p-3`}>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8A928C]">
          <Ico name="search" size={15} />
        </span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShow(true);
          }}
          onFocus={() => setShow(true)}
          onBlur={() => setTimeout(() => setShow(false), 150)}
          placeholder="Search the book by name"
          aria-label="Search accounts already in the book"
          className="min-h-11 w-full rounded-md border border-[#E2DFD5] bg-[#FAF9F5] py-2.5 pl-9 pr-3 text-base text-[#14201B] placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none"
        />
      </div>

      {show && q.trim().length >= 2 && (
        <div className="absolute inset-x-3 top-full z-20 mt-1 overflow-hidden rounded-md border border-[#E2DFD5] bg-white shadow-lg">
          {results.length === 0 && (
            <div className="px-3 py-2.5 text-[12.5px] text-[#8A928C]">Nothing in the book matches.</div>
          )}
          {results.map((r) => (
            <Link
              key={r.id}
              href={{ pathname: "/prospect", query: { account: r.id } }}
              onMouseDown={(e) => e.preventDefault()}
              className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#FAF9F5]"
            >
              <span className="truncate font-medium text-[#14201B]">{r.name}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-[#8A928C]">
                {r.city ?? r.area}
                <Ico name="external" size={12} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressLine({ progress }: { progress: Progress }) {
  const elapsed = Math.max(0, Math.round(progress.elapsedMs / 1000));
  const waiting = progress.status === "pending" && progress.elapsedMs > WAITING_AFTER_MS;
  const label =
    progress.status === "running"
      ? RUNNING_LINE[progress.stage]
      : waiting
        ? "Waiting on your Mac. This starts as soon as it is awake."
        : "Queued";

  return (
    <div className={`${panel} flex items-center justify-between gap-3 px-3.5 py-2.5`}>
      <span className="text-[12.5px] text-[#8A928C]">{label}</span>
      <span className="text-[12.5px] tabular-nums text-[#A9AFA9]">{elapsed}s</span>
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#14201B]"
      />
      <span className="text-[13px] text-[#3D4A44]">{label}</span>
    </label>
  );
}

function RunBar({
  meta,
  enrich,
  rows,
}: {
  meta: StageReply;
  enrich: StageReply["stages"] | null;
  rows: number;
}) {
  const search = meta.stages?.search ?? {};
  const triage = meta.stages?.triage ?? {};
  const dropped = useMemo(() => {
    const byLabel = new Map<string, number>();
    for (const [why, n] of Object.entries(triage.dropped ?? {})) {
      const label = humanizeDropReason(why);
      byLabel.set(label, (byLabel.get(label) ?? 0) + n);
    }
    return [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
  }, [triage.dropped]);
  const ceiling = (search.hit_google_ceiling ?? []).length > 0;
  const [open, setOpen] = useState(false);
  const e = enrich?.enrich;

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3.5 py-2.5">
        <Stat label="Returned by Google" value={search.distinct_places} />
        <Stat label="Passed the filters" value={triage.survivors} />
        <Stat label="On this list" value={rows} />
        {e && <Stat label="Sites read" value={e.attempted} />}
        <div className="ml-auto flex items-center gap-3 text-[12px] text-[#8A928C]">
          {search.live_calls != null && (
            <span className="tabular-nums">
              {search.live_calls} live Places call{search.live_calls === 1 ? "" : "s"}
            </span>
          )}
          {triage.book_size != null && (
            <span className="tabular-nums">{triage.book_size} already in the book</span>
          )}
          {dropped.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-[#3D4A44] underline-offset-2 hover:underline"
            >
              <Ico name={open ? "chevron-up" : "chevron-down"} size={12} />
              Dropped, and why
            </button>
          )}
        </div>
      </div>

      {ceiling && (
        <div className="border-t border-[#EFEDE5] px-3.5 py-2 text-[12.5px] text-[#8A928C]">
          Google hit its own limit in part of this area.
        </div>
      )}

      {(triage.capped_off ?? 0) > 0 && (
        <div className="border-t border-[#EFEDE5] px-3.5 py-2 text-[12.5px] text-[#8A928C]">
          {triage.capped_off} more passed the filters than shown.
        </div>
      )}

      {e && (
        <div className="border-t border-[#EFEDE5] px-3.5 py-2 text-[12.5px] text-[#5B6560]">
          {e.attempted != null && (
            <>
              Read {e.attempted} site{e.attempted === 1 ? "" : "s"}
              {e.failed != null && e.failed > 0 ? `, ${e.failed} would not load` : ""}.
            </>
          )}
        </div>
      )}

      {open && dropped.length > 0 && (
        <div className="grid gap-x-8 gap-y-1 border-t border-[#EFEDE5] px-3.5 py-2.5 sm:grid-cols-2">
          {dropped.map(([why, n]) => (
            <div key={why} className="flex items-baseline gap-2 text-[12.5px] text-[#5B6560]">
              <span className="w-8 shrink-0 text-right font-medium tabular-nums text-[#14201B]">{n}</span>
              <span>{why}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return null;
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-[#8A928C]">{label}</div>
      <div className="text-[20px] leading-none font-semibold tabular-nums tracking-tight">{value}</div>
    </div>
  );
}

function ResultsTable({
  rows,
  selected,
  expanded,
  onToggle,
  onToggleAll,
  onExpand,
  sort,
  onSort,
  selectableCount,
  anyEnriched,
}: {
  rows: Candidate[];
  selected: Set<string>;
  expanded: Set<string>;
  onToggle: (k: string) => void;
  onToggleAll: () => void;
  onExpand: (k: string) => void;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  selectableCount: number;
  anyEnriched: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className={`${panel} p-5 text-[13.5px] leading-relaxed text-[#5B6560]`}>
        Nothing in that area passed these filters.
      </div>
    );
  }

  return (
    <div className={`${panel} overflow-hidden`}>
      <div className="sm:hidden">
        {selectableCount > 0 && (
          <button
            type="button"
            onClick={onToggleAll}
            className="flex min-h-11 w-full items-center justify-between border-b border-[#E2DFD5] bg-[#FAF9F5] px-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[#8A928C]"
          >
            <span>{selected.size >= selectableCount ? "Deselect all" : "Select all"}</span>
            <span className="tabular-nums">{selected.size} of {selectableCount}</span>
          </button>
        )}
        <div className="divide-y divide-[#EDEBE3]">
          {rows.map((r) => (
            <MobileRow key={r.key} row={r} selected={selected.has(r.key)} onToggle={() => onToggle(r.key)} />
          ))}
        </div>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[1080px] text-[13px]">
          <thead>
            <tr className="border-b border-[#E2DFD5] bg-[#FAF9F5] text-[11px] uppercase tracking-[0.1em] text-[#8A928C]">
              <th className="w-9 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select every row"
                  checked={selectableCount > 0 && selected.size >= selectableCount}
                  onChange={onToggleAll}
                  className="h-4 w-4 accent-[#14201B]"
                />
              </th>
              <SortTh label="Business" k="name" sort={sort} onSort={onSort} />
              <th className={th}>Address</th>
              <th className={th}>Phone</th>
              <SortTh label="Rating" k="rating" sort={sort} onSort={onSort} align="right" />
              <SortTh label="Reviews" k="reviews" sort={sort} onSort={onSort} align="right" />
              <th className={th}>Website</th>
              <SortTh label="Score" k="triage" sort={sort} onSort={onSort} align="right" />
              {anyEnriched && <th className={th}>Decision maker</th>}
              {anyEnriched && <th className={th}>Fit</th>}
              {anyEnriched && <th className={th}>About</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EDEBE3]">
            {rows.map((r) => {
              const isOpen = expanded.has(r.key);
              const cols = 8 + (anyEnriched ? 3 : 0);
              return (
                <Fragment key={r.key}>
                  <tr
                    className={`transition-colors hover:bg-[#FAF9F5] ${
                      selected.has(r.key) ? "bg-[#F4F2EA]" : ""
                    }`}
                  >
                    <td className="px-3 py-2 align-top">
                      {r.id ? (
                        <span title="Already added as a prospect" className="text-[#3D6B4A]">
                          <Ico name="check" size={14} />
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name ?? "this business"}`}
                          checked={selected.has(r.key)}
                          onChange={() => onToggle(r.key)}
                          className="h-4 w-4 accent-[#14201B]"
                        />
                      )}
                    </td>
                    <td className={td}>
                      <div className="font-medium text-[#14201B]">{r.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[#8A928C]">
                        {r.city}
                        {r.id && (
                          <span className="rounded-full bg-[#E7EDE4] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#3D6B4A]">
                            Queued
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={`${td} max-w-[230px] text-[12.5px] text-[#5B6560]`}>
                      <div className="flex items-start justify-between gap-1.5">
                        <span>{r.address}</span>
                        {(r.lat != null || r.places_id) && (
                          <a
                            href={mapsUrl({ name: r.name, address: r.address, placesId: r.places_id })}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open in Google Maps"
                            className="shrink-0 text-[#8A928C] hover:text-[#14201B]"
                          >
                            <Ico name="external" size={11} />
                          </a>
                        )}
                      </div>
                      {r.hours_today && <div className="mt-0.5 text-[11.5px] text-[#8A928C]">{r.hours_today}</div>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-[12.5px]`}>
                      {r.phone && (
                        <a href={`tel:${r.phone}`} className="text-[#3D4A44] hover:underline">
                          {r.phone}
                        </a>
                      )}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {r.places_rating != null && (
                        <span title={`${r.places_rating} out of 5 on Google`}>
                          {r.places_rating.toFixed(1)}
                          <span className="text-[11px] text-[#A9AFA9]"> / 5</span>
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-right tabular-nums text-[#5B6560]`}>
                      {r.places_rating_count ?? null}
                    </td>
                    <td className={`${td} max-w-[170px] text-[12.5px]`}>
                      {r.website && (
                        <a
                          href={r.website.startsWith("http") ? r.website : `https://${r.website}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 truncate text-[#3D4A44] hover:underline"
                        >
                          <Ico name="external" size={11} />
                          <span className="truncate">{hostOf(r.website)}</span>
                        </a>
                      )}
                    </td>
                    <td className={`${td} text-right font-medium tabular-nums`}>{r.triage_score.toFixed(0)}</td>

                    {anyEnriched && (
                      <td className={`${td} text-[12.5px] text-[#3D4A44]`}>{r.decision_maker_candidate}</td>
                    )}
                    {anyEnriched && (
                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {r.fit_tags.map((t) => (
                            <span
                              key={t}
                              className="whitespace-nowrap rounded-full border border-[#E2DFD5] px-1.5 py-0.5 text-[11px] text-[#5B6560]"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                    )}
                    {anyEnriched && (
                      <td className={`${td} max-w-[280px] text-[12.5px] text-[#5B6560]`}>
                        {r.about ? (
                          <button
                            type="button"
                            onClick={() => onExpand(r.key)}
                            aria-expanded={isOpen}
                            className="text-left underline-offset-2 hover:underline"
                          >
                            <span className={isOpen ? "" : "line-clamp-2"}>{r.about}</span>
                          </button>
                        ) : r.enriched && r.site_failures.length > 0 ? (
                          <span className="text-[#A0762C]">site would not load</span>
                        ) : null}
                      </td>
                    )}
                  </tr>

                  {isOpen && (
                    <tr className="bg-[#FAF9F5]">
                      <td />
                      <td colSpan={cols - 1} className="px-3 pb-3 pt-0">
                        <div className="flex flex-col gap-1.5 text-[12.5px] text-[#5B6560]">
                          {r.about_url && (
                            <a
                              href={r.about_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex w-fit items-center gap-1 text-[#3D4A44] hover:underline"
                            >
                              <Ico name="external" size={11} />
                              {r.about_basis} · {r.about_url}
                            </a>
                          )}
                          {r.decision_maker_found_by && <span>Named at {r.decision_maker_found_by}</span>}
                          {r.catalog_terms.length > 0 && (
                            <span>Site mentions: {r.catalog_terms.slice(0, 14).join(", ")}</span>
                          )}
                          {r.site_failures.length > 0 && (
                            <span className="text-[#A0762C]">{r.site_failures.join(" · ")}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One result on a phone: the whole row is the 44px selection toggle, no
 *  16px checkbox to aim for. A landed row has nothing to toggle. */
function MobileRow({
  row: r,
  selected,
  onToggle,
}: {
  row: Candidate;
  selected: boolean;
  onToggle: () => void;
}) {
  const meta = (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[#8A928C]">
      {r.city && <span>{r.city}</span>}
      {r.places_rating != null && (
        <span>
          {r.places_rating.toFixed(1)} / 5{r.places_rating_count != null ? ` (${r.places_rating_count})` : ""}
        </span>
      )}
      {r.id && (
        <span className="rounded-full bg-[#E7EDE4] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#3D6B4A]">
          Queued
        </span>
      )}
    </div>
  );

  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-[#14201B]">{r.name}</span>
        <span className="shrink-0 text-[13px] font-medium tabular-nums text-[#14201B]">
          {r.triage_score.toFixed(0)}
        </span>
      </div>
      {meta}
      {r.address && <div className="mt-1 text-[12.5px] text-[#5B6560]">{r.address}</div>}
      {r.about && <div className="mt-1 line-clamp-2 text-[12.5px] text-[#5B6560]">{r.about}</div>}
    </div>
  );

  if (r.id) {
    return (
      <div className={`flex min-h-11 items-start gap-3 px-3 py-3 ${selected ? "bg-[#F4F2EA]" : ""}`}>
        <span className="mt-0.5 shrink-0 text-[#3D6B4A]" title="Already added as a prospect">
          <Ico name="check" size={16} />
        </span>
        {body}
      </div>
    );
  }

  return (
    <label
      className={`flex min-h-11 w-full cursor-pointer items-start gap-3 px-3 py-3 ${selected ? "bg-[#F4F2EA]" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select ${r.name ?? "this business"}`}
        className="mt-0.5 h-5 w-5 shrink-0 accent-[#14201B]"
      />
      {body}
    </label>
  );
}

function SortTh({
  label,
  k,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  return (
    <th className={`${th} ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-[0.1em] ${
          sort === k ? "text-[#14201B]" : ""
        }`}
      >
        {label}
        {sort === k && <Ico name="chevron-down" size={10} />}
      </button>
    </th>
  );
}

function hostOf(website: string): string {
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).host.replace(/^www\./, "");
  } catch {
    return website;
  }
}
