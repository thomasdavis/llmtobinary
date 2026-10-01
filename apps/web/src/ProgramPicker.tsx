// The program bar under the top bar: one dropdown for every program a visitor can run — the
// featured AI-written programs, everything visitors chose to publish (newest first), and the
// reference programs our own tools made — with each one's prompt, age and how it was made.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Feature } from "@llmtobinary/spec";
import type { GallerySummary } from "@llmtobinary/protocol";
import { getGallery } from "./api.ts";
import { AI_EXAMPLES, REFERENCE_EXAMPLES, type AiExample } from "./examples.ts";

export type RefExample = (typeof REFERENCE_EXAMPLES)[number];

export type Pick =
  | { kind: "featured"; key: string; example: AiExample }
  | { kind: "public"; key: string; summary: GallerySummary }
  | { kind: "ref"; key: string; ref: RefExample };

/** What the card under the bar shows about the program that is loaded. */
export interface ChosenProgram {
  key: string;
  label: string;
  by: "ai" | "tools";
  /** Who asked: "a visitor", "you", "this project". */
  askedBy: string;
  prompt: string | null;
  facts: { k: string; v: string }[];
  controls?: string;
  /** Shareable link (published programs). */
  link?: string;
  /** For "Use this prompt". */
  remix?: { description: string; params: ("u64" | "bool")[]; returns: "unit" | "u64" | "bool"; features: number };
}

// ---------------------------------------------------------------------------
// Formatting

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" }) : null;
export function ago(t: number, now = Date.now()): string {
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (!rtf || !Number.isFinite(t)) return "";
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(s / 86_400), "day");
  if (abs < 86_400 * 365) return rtf.format(Math.round(s / (86_400 * 30)), "month");
  return rtf.format(Math.round(s / (86_400 * 365)), "year");
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const DEVICE_NAMES: [number, string][] = [
  [Feature.TERMINAL, "terminal"],
  [Feature.FRAMEBUFFER, "screen"],
  [Feature.INPUT, "keyboard"],
  [Feature.HEAP, "heap"],
];
export const devices = (bits: number) => DEVICE_NAMES.filter(([b]) => (bits & b) !== 0).map(([, n]) => n);

const outcomeText = (o: GallerySummary["outcome"]) => (o === "passed" ? "passed every test" : "runs; its own examples hold");
const fullDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtInt = (n: number) => (Number.isFinite(n) ? n.toLocaleString() : "?");

// ---------------------------------------------------------------------------
// The rows

interface Row {
  pick: Pick;
  group: "featured" | "public" | "ref";
  label: string;
  prompt: string | null;
  badge: string;
  when: number | null;
  meta: string[];
  search: string;
}

function featuredRow(e: AiExample): Row {
  const when = (e.counters as { startedAt?: number }).startedAt ?? null;
  return {
    pick: { kind: "featured", key: `featured:${e.file}`, example: e },
    group: "featured",
    label: e.title,
    prompt: e.prompt,
    badge: "AI · featured",
    when,
    meta: [e.provenance.requestedModel ?? "AI", `${e.counters.turns} turns`, `${fmtInt(e.bytes)} B`, e.controls].filter(Boolean) as string[],
    search: `${e.title} ${e.prompt}`.toLowerCase(),
  };
}

function publicRow(g: GallerySummary): Row {
  return {
    pick: { kind: "public", key: `public:${g.id}`, summary: g },
    group: "public",
    label: g.label || "Untitled program",
    prompt: g.prompt,
    badge: g.taskId ? "AI · curated task" : "AI · visitor prompt",
    when: g.finishedAt,
    meta: [g.model, `${g.turns} turns`, `${fmtInt(g.bytes)} B`, devices(g.features).join(" + ") || "no devices", outcomeText(g.outcome)],
    search: `${g.label} ${g.prompt} ${g.model} ${g.taskId ?? ""}`.toLowerCase(),
  };
}

function refRow(r: RefExample): Row {
  return {
    pick: { kind: "ref", key: `ref:${r.file}`, ref: r },
    group: "ref",
    label: r.title,
    prompt: null,
    badge: "Reference · not AI",
    when: null,
    meta: [r.about, r.controls ?? ""].filter(Boolean),
    search: `${r.title} ${r.about}`.toLowerCase(),
  };
}

const GROUPS: { id: Row["group"]; title: string; note: string }[] = [
  { id: "featured", title: "Featured", note: "written by the AI, byte by byte" },
  { id: "public", title: "Published by visitors", note: "newest first; each was written by the AI from the prompt shown" },
  { id: "ref", title: "Reference programs", note: "made by this project's own tools for comparison, not by the AI" },
];

type Filter = "all" | Row["group"];

// ---------------------------------------------------------------------------

export function ProgramBar(props: { chosen: ChosenProgram | null; onPick: (p: Pick) => Promise<void> | void; onAsk: () => void; refresh: number }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [gallery, setGallery] = useState<GallerySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const now = Date.now();

  const load = useCallback(async (more: string | null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await getGallery(more);
      setGallery((g) => (more ? [...g, ...page.items.filter((x) => !g.some((y) => y.id === x.id))] : page.items));
      setCursor(page.cursor);
      setFetchedAt(Date.now());
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // First load, after the visitor publishes something, and when reopened after a while.
  useEffect(() => void load(null), [load, props.refresh]);
  useEffect(() => {
    if (open && Date.now() - fetchedAt > 30_000) void load(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...AI_EXAMPLES.map(featuredRow), ...gallery.map(publicRow), ...REFERENCE_EXAMPLES.map(refRow)];
    return all.filter((r) => (filter === "all" || r.group === filter) && (!q || q.split(/\s+/).every((w) => r.search.includes(w))));
  }, [gallery, query, filter]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(rows.length - 1, 0))), [rows.length]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const show = () => {
    // Each opening starts from the whole list, on the program that is loaded.
    setQuery("");
    setFilter("all");
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const i = rows.findIndex((r) => r.pick.key === props.chosen?.key);
    setActive(i >= 0 ? i : 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const choose = async (r: Row) => {
    hide();
    setPicking(r.label);
    try {
      await props.onPick(r.pick);
    } finally {
      setPicking(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home" && !query) {
      setActive(0);
    } else if (e.key === "End" && !query) {
      setActive(rows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[active];
      if (r) void choose(r);
    }
  };

  const cur = rows[active] ?? null;
  const c = props.chosen;
  const counts = { featured: AI_EXAMPLES.length, public: gallery.length, ref: REFERENCE_EXAMPLES.length };

  return (
    <nav className="programbar" aria-label="Program">
      <div className="programbar-inner">
        <span className="programbar-label" aria-hidden="true">Program</span>
        <button ref={triggerRef} className={`picker-trigger${open ? " open" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? hide() : show())}>
          <span className="picker-trigger-main">{picking ?? (c ? c.label : "Choose a program to run…")}</span>
          {picking ? (
            <span className="picker-trigger-sub">Loading and checking the bytes…</span>
          ) : c ? (
            <span className="picker-trigger-sub">{c.by === "ai" ? `written by the AI · asked by ${c.askedBy}` : "made by our tools, not the AI"}</span>
          ) : (
            <span className="picker-trigger-sub">
              {counts.featured + counts.ref} presets{gallery.length ? ` · ${gallery.length}${cursor ? "+" : ""} published by visitors` : ""}
            </span>
          )}
          <span className="picker-caret" aria-hidden="true">▾</span>
        </button>
        <button className="programbar-ask" onClick={props.onAsk}>
          <span className="wide-only">Ask the AI for a new program</span>
          <span className="narrow-only">New</span>
        </button>
      </div>

      {open && (
        <>
          <div className="picker-scrim" onClick={() => hide(false)} />
          <div className="picker-pop" role="dialog" aria-label="Choose a program">
            <div className="picker-head">
              <input
                ref={searchRef}
                className="picker-search"
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={cur ? `${listId}-${active}` : undefined}
                aria-label="Search programs"
                placeholder="Search labels and prompts"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
              />
              <div className="segmented tight picker-filter" role="radiogroup" aria-label="Show">
                {(["all", "featured", "public", "ref"] as const).map((f) => (
                  <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => { setFilter(f); setActive(0); }}>
                    {f === "all" ? "All" : f === "featured" ? "Featured" : f === "public" ? `Visitors${gallery.length ? ` (${gallery.length}${cursor ? "+" : ""})` : ""}` : "Reference"}
                  </button>
                ))}
              </div>
              <button className="picker-close" aria-label="Close" onClick={() => hide()}>✕</button>
            </div>

            <div className="picker-body">
              <div className="picker-list" ref={listRef} id={listId} role="listbox" aria-label="Programs">
                {GROUPS.filter((g) => filter === "all" || filter === g.id).map((g) => {
                  const inGroup = rows.filter((r) => r.group === g.id);
                  return (
                    <div key={g.id} className="picker-group" role="group" aria-label={g.title}>
                      <div className="picker-group-head">
                        <strong>{g.title}</strong> <span className="muted">{g.note}</span>
                      </div>
                      {g.id === "public" && loading && gallery.length === 0 && <p className="picker-empty">Loading published programs…</p>}
                      {g.id === "public" && loadError && <p className="picker-empty error">Couldn't load published programs: {loadError}. <button className="link" onClick={() => void load(null)}>Try again</button></p>}
                      {g.id === "public" && !loading && !loadError && gallery.length === 0 && <p className="picker-empty">Nothing published yet. Ask the AI for a program and tick “publish” to be the first.</p>}
                      {inGroup.length === 0 && query && (g.id !== "public" || gallery.length > 0) && <p className="picker-empty">No matches.</p>}
                      {inGroup.map((r) => {
                        const i = rows.indexOf(r);
                        const isChosen = r.pick.key === c?.key;
                        return (
                          <div
                            key={r.pick.key}
                            id={`${listId}-${i}`}
                            data-index={i}
                            role="option"
                            aria-selected={i === active}
                            className={`picker-row${i === active ? " active" : ""}${isChosen ? " chosen" : ""}`}
                            onMouseMove={() => i !== active && setActive(i)}
                            onClick={() => void choose(r)}
                          >
                            <div className="picker-row-top">
                              <span className="picker-row-label">{r.label}</span>
                              {isChosen && <span className="picker-row-now">loaded</span>}
                              {r.when && <time className="picker-row-when" dateTime={new Date(r.when).toISOString()} title={fullDate(r.when)}>{ago(r.when, now)}</time>}
                            </div>
                            {r.prompt && <p className="picker-row-prompt">“{r.prompt}”</p>}
                            <div className="picker-row-meta">
                              <span className={`picker-kind kind-${r.group}`}>{r.badge}</span>
                              {r.meta.map((m, k) => <span key={k}>{m}</span>)}
                            </div>
                          </div>
                        );
                      })}
                      {g.id === "public" && cursor && !query && (
                        <button className="link picker-more" disabled={loading} onClick={() => void load(cursor)}>{loading ? "Loading…" : "Show older programs"}</button>
                      )}
                    </div>
                  );
                })}
              </div>

              <aside className="picker-detail" aria-live="polite">
                {cur ? <Detail row={cur} now={now} onRun={() => void choose(cur)} /> : <p className="muted">No program matches “{query}”.</p>}
              </aside>
            </div>
            <p className="picker-foot muted small">↑ ↓ to move · Enter to load and run · Esc to close</p>
          </div>
        </>
      )}
    </nav>
  );
}

function Detail({ row, now, onRun }: { row: Row; now: number; onRun: () => void }) {
  const p = row.pick;
  const facts: [string, string][] = [];
  if (p.kind === "public") {
    const g = p.summary;
    facts.push(["Generated", `${fullDate(g.finishedAt)} (${ago(g.finishedAt, now)})`]);
    const took = duration(g.finishedAt - g.createdAt);
    if (took) facts.push(["Took", took]);
    facts.push(["Model", `${g.model}${g.reasoningEffort ? `, ${g.reasoningEffort} reasoning` : ""}`]);
    facts.push(["Work", `${g.turns} turns · ${g.checks} checks · ${fmtInt(g.outputTokens)} tokens written`]);
    facts.push(["Size", `${fmtInt(g.bytes)} bytes · ${fmtInt(g.instructions)} instructions`]);
    facts.push(["Entry", g.signature]);
    facts.push(["Devices", devices(g.features).join(", ") || "none"]);
    facts.push(["Result", g.outcome === "passed" ? "passed every test of the curated task" : "validated and ran; the examples the AI wrote about it hold (no reference answer exists for a visitor's own prompt)"]);
  } else if (p.kind === "featured") {
    const e = p.example;
    const when = (e.counters as { startedAt?: number }).startedAt;
    if (when) facts.push(["Generated", `${fullDate(when)} (${ago(when, now)})`]);
    facts.push(["Model", `${e.provenance.requestedModel ?? "?"}${e.reasoningEffort ? `, ${e.reasoningEffort} reasoning` : ""}`]);
    facts.push(["Work", `${e.counters.turns} turns · ${e.counters.checks} checks · ${fmtInt(e.counters.outputTokens)} tokens written`]);
    facts.push(["Size", `${fmtInt(e.bytes)} bytes`]);
    facts.push(["Cost", `$${e.usdSpent.toFixed(3)} of model time`]);
    facts.push(["Controls", e.controls]);
  } else {
    facts.push(["What it does", p.ref.about]);
    if (p.ref.controls) facts.push(["Controls", p.ref.controls]);
    facts.push(["Made by", "this project's own tools, for comparison. Not written by the AI."]);
  }
  return (
    <div className="picker-detail-inner">
      <span className={`picker-kind kind-${row.group}`}>{row.badge}</span>
      <h3>{row.label}</h3>
      {row.prompt && (
        <>
          <p className="picker-detail-lead">{p.kind === "featured" ? "The prompt it was given" : "The prompt the visitor wrote"}</p>
          <blockquote className="picker-detail-prompt">{row.prompt}</blockquote>
        </>
      )}
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k} className="facts-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <button className="primary" onClick={onRun}>▶ Load and run</button>
    </div>
  );
}

/** The loaded program's story, under the bar: what was asked, by whom, and how it was made. */
export function ProgramCard({ chosen, onRemix }: { chosen: ChosenProgram; onRemix: (r: NonNullable<ChosenProgram["remix"]>) => void }) {
  const [copied, setCopied] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    setMore(false);
    setCopied(false);
  }, [chosen.key]);
  const long = (chosen.prompt?.length ?? 0) > 420;
  return (
    <section className="program-card" aria-label="About this program">
      <div className="program-card-main">
        <p className="program-card-by">{chosen.by === "ai" ? `Written by the AI, byte by byte · asked by ${chosen.askedBy}` : "Made by this project's own tools (not the AI), for comparison"}</p>
        <h2 className="program-card-title">{chosen.label}</h2>
        {chosen.prompt && (
          <blockquote className={`program-card-prompt${long && !more ? " clamped" : ""}`}>
            {chosen.prompt}
          </blockquote>
        )}
        {long && <button className="link small" onClick={() => setMore(!more)}>{more ? "Show less" : "Show the whole prompt"}</button>}
      </div>
      <div className="program-card-side">
        <dl className="program-card-facts">
          {chosen.facts.map((f) => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
        <div className="row wrap">
          {chosen.remix && <button onClick={() => onRemix(chosen.remix!)}>Use this prompt</button>}
          {chosen.link && (
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(chosen.link!).then(() => setCopied(true), () => setCopied(false));
              }}
            >
              {copied ? "Link copied" : "Copy link"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
