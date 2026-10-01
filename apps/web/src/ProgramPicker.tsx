// The program bar under the top bar: a search box and one dropdown for every program a visitor can
// open — the featured AI-written programs, every generation anyone has run here (newest first,
// whatever happened to it), and the reference programs our own tools made — with each one's
// prompt, age, status and how it was made.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Feature } from "@llmtobinary/spec";
import type { GalleryOutcome, GallerySummary } from "@llmtobinary/protocol";
import { getGallery } from "./api.ts";
import { AI_EXAMPLES, REFERENCE_EXAMPLES, type AiExample } from "./examples.ts";

export type RefExample = (typeof REFERENCE_EXAMPLES)[number];

export type Pick =
  | { kind: "featured"; key: string; example: AiExample }
  | { kind: "public"; key: string; summary: GallerySummary }
  | { kind: "ref"; key: string; ref: RefExample };

type Tone = "ok" | "bad" | "live" | "plain";

/** What the card under the bar shows about the program that is open. */
export interface ChosenProgram {
  key: string;
  label: string;
  by: "ai" | "tools";
  /** Who asked: "a visitor", "you", "this project". */
  askedBy: string;
  prompt: string | null;
  /** Where it stands, e.g. "✓ works" or "✕ ran out of budget". */
  status?: { text: string; tone: Tone };
  facts: { k: string; v: string }[];
  /** Shareable link (generations). */
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

/** A generation's status in plain words, and how to colour it. */
export function outcomeStatus(o: GalleryOutcome): { text: string; tone: Tone } {
  switch (o) {
    case "passed":
      return { text: "✓ passed every test", tone: "ok" };
    case "passed-unverified":
      return { text: "✓ works; its own examples hold", tone: "ok" };
    case "in-progress":
      return { text: "● being generated", tone: "live" };
    case "unfinished":
      return { text: "stopped part-way", tone: "plain" };
    case "budget-exhausted":
      return { text: "✕ ran out of budget", tone: "bad" };
    case "stalled":
      return { text: "✕ got stuck", tone: "bad" };
    case "refused":
      return { text: "✕ the AI declined", tone: "bad" };
    case "cancelled":
      return { text: "■ cancelled", tone: "plain" };
    case "infrastructure-error":
      return { text: "✕ server error", tone: "bad" };
  }
}

/** Which bytes a generation carries, in words. */
export function programText(g: GallerySummary): string {
  if (g.program === "passed") return "the program that passed";
  if (g.program === "submission") return g.outcome === "in-progress" ? "the AI's latest submission (being tested)" : "the AI's last submission (it did not pass)";
  if (g.program === "draft") return `the AI's last draft${g.checkerOk === true ? " (the checker accepted it)" : g.checkerOk === false ? " (the checker found mistakes)" : ""}`;
  return g.outcome === "in-progress" ? "none yet: the AI is still writing" : "none: the AI never wrote a complete program";
}

export const works = (g: { outcome: GalleryOutcome }) => g.outcome === "passed" || g.outcome === "passed-unverified";
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
  status: { text: string; tone: Tone } | null;
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
    status: { text: "✓ works", tone: "ok" },
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
    status: outcomeStatus(g.outcome),
    when: g.createdAt,
    meta: [g.model, `${g.turns} turns`, g.bytes ? `${fmtInt(g.bytes)} B` : "no bytes yet", devices(g.features).join(" + ") || "no devices"],
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
    status: null,
    when: null,
    meta: [r.about, r.controls ?? ""].filter(Boolean),
    search: `${r.title} ${r.about}`.toLowerCase(),
  };
}

const GROUPS: { id: Row["group"]; title: string; note: string }[] = [
  { id: "featured", title: "Featured", note: "written by the AI, byte by byte" },
  { id: "public", title: "Every generation", note: "every prompt anyone has given the AI here, newest first, whatever happened" },
  { id: "ref", title: "Reference programs", note: "made by this project's own tools for comparison, not by the AI" },
];

type Filter = "all" | Row["group"];

const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;

// ---------------------------------------------------------------------------

export function ProgramBar(props: { chosen: ChosenProgram | null; onPick: (p: Pick) => Promise<void> | void; onAsk: () => void; refresh: number }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [onlyWorking, setOnlyWorking] = useState(false);
  const [gallery, setGallery] = useState<GallerySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  const listId = useId();
  const barSearchRef = useRef<HTMLInputElement>(null);
  const popSearchRef = useRef<HTMLInputElement>(null);
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

  // First load, when the visitor starts or finishes a generation, and when reopened after a while.
  useEffect(() => void load(null), [load, props.refresh]);
  useEffect(() => {
    if (open && Date.now() - fetchedAt > 15_000) void load(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...AI_EXAMPLES.map(featuredRow), ...gallery.filter((g) => !onlyWorking || works(g)).map(publicRow), ...REFERENCE_EXAMPLES.map(refRow)];
    return all.filter((r) => (filter === "all" || r.group === filter) && words.every((w) => r.search.includes(w)));
  }, [gallery, query, filter, onlyWorking]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(rows.length - 1, 0))), [rows.length]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const focusSearch = () => requestAnimationFrame(() => (isNarrow() ? popSearchRef.current : barSearchRef.current)?.focus());
  const show = (fresh: boolean) => {
    if (fresh) {
      // The dropdown button starts from the whole list, on the program that is open.
      setQuery("");
      setFilter("all");
    }
    setOpen(true);
    focusSearch();
  };
  useEffect(() => {
    if (!open || query) return;
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
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      show(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[active];
      if (r) void choose(r);
    }
  };
  const onQuery = (v: string) => {
    setQuery(v);
    setActive(0);
    if (!open) setOpen(true);
  };

  const cur = rows[active] ?? null;
  const c = props.chosen;
  const total = `${gallery.length}${cursor ? "+" : ""}`;
  const searchProps = {
    type: "search" as const,
    role: "combobox" as const,
    "aria-expanded": open,
    "aria-controls": listId,
    "aria-activedescendant": open && cur ? `${listId}-${active}` : undefined,
    "aria-autocomplete": "list" as const,
    value: query,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onQuery(e.target.value),
    onKeyDown: onSearchKey,
  };

  return (
    <nav className="programbar" aria-label="Program">
      <div className="programbar-inner">
        <span className="programbar-label" aria-hidden="true">Program</span>
        <button ref={triggerRef} className={`picker-trigger${open ? " open" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? hide() : show(true))}>
          <span className="picker-trigger-main">{picking ?? (c ? c.label : "Choose a program to run…")}</span>
          {picking ? (
            <span className="picker-trigger-sub">Loading and checking the bytes…</span>
          ) : c ? (
            <span className="picker-trigger-sub">{c.by === "ai" ? `written by the AI · asked by ${c.askedBy}` : "made by our tools, not the AI"}</span>
          ) : (
            <span className="picker-trigger-sub">
              {AI_EXAMPLES.length + REFERENCE_EXAMPLES.length} presets{gallery.length ? ` · ${total} generations` : ""}
            </span>
          )}
          <span className="picker-caret" aria-hidden="true">▾</span>
        </button>
        <label className="bar-search">
          <span className="bar-search-icon" aria-hidden="true">⌕</span>
          <input ref={barSearchRef} {...searchProps} aria-label="Search programs" placeholder={gallery.length ? `Search ${total} generations and the presets` : "Search programs"} onFocus={() => !open && show(false)} />
        </label>
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
              <input ref={popSearchRef} className="picker-search pop-search" {...searchProps} aria-label="Search programs" placeholder="Search prompts and labels" />
              <div className="segmented tight picker-filter" role="radiogroup" aria-label="Show">
                {(["all", "featured", "public", "ref"] as const).map((f) => (
                  <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => { setFilter(f); setActive(0); }}>
                    {f === "all" ? "All" : f === "featured" ? "Featured" : f === "public" ? `Generations${gallery.length ? ` (${total})` : ""}` : "Reference"}
                  </button>
                ))}
              </div>
              <label className="check picker-working">
                <input type="checkbox" checked={onlyWorking} onChange={(e) => { setOnlyWorking(e.target.checked); setActive(0); }} /> Only working programs
              </label>
              <button className="picker-close" aria-label="Close" onClick={() => hide()}>✕</button>
            </div>

            <div className="picker-body">
              <div className="picker-list" ref={listRef} id={listId} role="listbox" aria-label="Programs">
                {GROUPS.filter((g) => filter === "all" || filter === g.id).map((g) => {
                  const inGroup = rows.filter((r) => r.group === g.id);
                  if (query && inGroup.length === 0 && g.id !== "public") return null;
                  return (
                    <div key={g.id} className="picker-group" role="group" aria-label={g.title}>
                      <div className="picker-group-head">
                        <strong>{g.title}</strong> <span className="muted">{g.note}</span>
                      </div>
                      {g.id === "public" && loading && gallery.length === 0 && <p className="picker-empty">Loading generations…</p>}
                      {g.id === "public" && loadError && <p className="picker-empty error">Couldn't load the generations: {loadError}. <button className="link" onClick={() => void load(null)}>Try again</button></p>}
                      {g.id === "public" && !loading && !loadError && gallery.length === 0 && <p className="picker-empty">No generations yet. Ask the AI for a program to be the first.</p>}
                      {g.id === "public" && inGroup.length === 0 && gallery.length > 0 && <p className="picker-empty">No generation matches{query ? ` “${query}”` : ""}{cursor ? "; older ones are searched once shown" : ""}.</p>}
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
                              {isChosen && <span className="picker-row-now">open</span>}
                              {r.when && <time className="picker-row-when" dateTime={new Date(r.when).toISOString()} title={fullDate(r.when)}>{ago(r.when, now)}</time>}
                            </div>
                            {r.prompt && <p className="picker-row-prompt">“{r.prompt}”</p>}
                            <div className="picker-row-meta">
                              <span className={`picker-kind kind-${r.group}`}>{r.badge}</span>
                              {r.status && <span className={`picker-status tone-${r.status.tone}`}>{r.status.text}</span>}
                              {r.meta.map((m, k) => <span key={k}>{m}</span>)}
                            </div>
                          </div>
                        );
                      })}
                      {g.id === "public" && cursor && (
                        <button className="link picker-more" disabled={loading} onClick={() => void load(cursor)}>{loading ? "Loading…" : "Show older generations"}</button>
                      )}
                    </div>
                  );
                })}
              </div>

              <aside className="picker-detail" aria-live="polite">
                {cur ? <Detail row={cur} now={now} onRun={() => void choose(cur)} /> : <p className="muted">Nothing matches “{query}”.</p>}
              </aside>
            </div>
            <p className="picker-foot muted small">Type to search · ↑ ↓ to move · Enter to open · Esc to close</p>
          </div>
        </>
      )}
    </nav>
  );
}

function Detail({ row, now, onRun }: { row: Row; now: number; onRun: () => void }) {
  const p = row.pick;
  const facts: [string, string][] = [];
  let action = "▶ Load and run";
  if (p.kind === "public") {
    const g = p.summary;
    facts.push(["Asked", `${fullDate(g.createdAt)} (${ago(g.createdAt, now)})`]);
    const took = g.finishedAt ? duration(g.finishedAt - g.createdAt) : "";
    if (took) facts.push(["Took", took]);
    facts.push(["Model", `${g.model}${g.reasoningEffort ? `, ${g.reasoningEffort} reasoning` : ""}`]);
    facts.push(["Work", `${g.turns} turns · ${g.checks} checks · ${g.submissions} submissions · ${fmtInt(g.outputTokens)} tokens written`]);
    facts.push(["Bytes shown", programText(g)]);
    if (g.bytes) facts.push(["Size", `${fmtInt(g.bytes)} bytes · ${fmtInt(g.instructions)} instructions`]);
    facts.push(["Entry", g.signature]);
    facts.push(["Devices", devices(g.features).join(", ") || "none"]);
    if (g.outcome === "passed-unverified") facts.push(["Note", "A visitor's own prompt has no reference answer: it validated, ran, and the examples the AI wrote about it hold."]);
    if (!g.program) action = "Show the prompt";
    else if (!works(g)) action = "Open its bytes";
  } else if (p.kind === "featured") {
    const e = p.example;
    const when = (e.counters as { startedAt?: number }).startedAt;
    if (when) facts.push(["Asked", `${fullDate(when)} (${ago(when, now)})`]);
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
      <div className="picker-detail-tags">
        <span className={`picker-kind kind-${row.group}`}>{row.badge}</span>
        {row.status && <span className={`picker-status tone-${row.status.tone}`}>{row.status.text}</span>}
      </div>
      <h3>{row.label}</h3>
      {row.prompt && (
        <>
          <p className="picker-detail-lead">{p.kind === "featured" ? "The prompt it was given" : "The prompt"}</p>
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
      <button className="primary" onClick={onRun}>{action}</button>
    </div>
  );
}

/** The open program's story, under the bar: what was asked, by whom, how it went. */
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
        {chosen.status && <p className={`program-card-status picker-status tone-${chosen.status.tone}`}>{chosen.status.text}</p>}
        {chosen.prompt && <blockquote className={`program-card-prompt${long && !more ? " clamped" : ""}`}>{chosen.prompt}</blockquote>}
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
