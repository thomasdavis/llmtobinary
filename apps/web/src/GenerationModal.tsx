// The generation modal: opened by Generate and kept open while the AI works (it can be cancelled,
// not dismissed). Everything shown comes from the loop's own events: the turn in progress, the
// bytes as they stream (unchecked), every checker report, every submission and its tests.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LoopEvent } from "@llmtobinary/protocol";
import type { GenState, SubmittedCandidate } from "./generation.ts";

const STAGES = ["Thinking", "Writing bytes", "Checking", "Fixing", "Testing", "Reviewing", "Done"] as const;
type Stage = (typeof STAGES)[number];

const busyPhases = new Set(["creating", "streaming", "testing"]);

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Hex digits of the draft being streamed (the "hex" field of the tool call), formatted as 16-byte records. */
function streamedBytes(turnText: string): { lines: string[]; bytes: number } {
  const i = turnText.indexOf('"hex"');
  if (i < 0) return { lines: [], bytes: 0 };
  const start = turnText.indexOf('"', turnText.indexOf(":", i) + 1);
  if (start < 0) return { lines: [], bytes: 0 };
  let end = turnText.indexOf('"', start + 1);
  if (end < 0) end = turnText.length;
  const digits = turnText.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, "");
  const bytes = Math.floor(digits.length / 2);
  const tail = digits.slice(Math.max(0, digits.length - 32 * 12));
  const offset = digits.length - tail.length;
  const lines: string[] = [];
  for (let k = 0; k < tail.length; k += 32) {
    const chunk = tail.slice(k, k + 32);
    lines.push((chunk.match(/.{1,2}/g) ?? []).join(" "));
  }
  if (offset % 32 !== 0 && lines.length) lines.shift(); // keep whole records aligned
  return { lines, bytes };
}

interface Item {
  key: string;
  tone: "info" | "ok" | "bad" | "warn" | "live";
  title: string;
  detail?: string[];
  /** Playtest frames (PNG data URLs). */
  images?: string[];
}

function timeline(g: GenState): Item[] {
  const items: Item[] = [];
  const subs = new Map<number, SubmittedCandidate>(g.submissions.map((s) => [s.seq, s]));
  let draft = 0;
  g.events.forEach((e, i) => {
    switch (e.type) {
      case "attempt.started":
        // Only when the AI then keeps working: after a pass, this exchange just reports success.
        // (A playtest review in this exchange speaks for itself.)
        if ((e as Extract<LoopEvent, { type: "attempt.started" }>).iteration > 0 && g.events.slice(i + 1).some((x) => x.type === "turn.started") && g.events[i + 1]?.type !== "review.started") {
          items.push({ key: `a${e.seq}`, tone: "info", title: "The test results went back to the AI" });
        }
        break;
      case "turn.started":
        items.push({ key: `t${e.seq}`, tone: "info", title: `Turn ${(e as Extract<LoopEvent, { type: "turn.started" }>).turn}` });
        break;
      case "check.result": {
        draft++;
        const r = (e as Extract<LoopEvent, { type: "check.result" }>).report;
        items.push(
          r.ok
            ? { key: `c${e.seq}`, tone: "ok", title: `The checker read draft ${draft}: no problems (${(r.byteLength ?? 0).toLocaleString()} bytes)` }
            : { key: `c${e.seq}`, tone: "bad", title: `The checker read draft ${draft}: ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"} to fix`, detail: r.errors.slice(0, 3).map((d) => `${d.message}${d.location.recordIndex !== null ? ` (instruction ${d.location.recordIndex})` : ""}`) },
        );
        break;
      }
      case "candidate.submitted": {
        const ev = e as Extract<LoopEvent, { type: "candidate.submitted" }>;
        items.push({ key: `s${e.seq}`, tone: "info", title: `The AI submitted its program (${(ev.candidate.byteLength ?? 0).toLocaleString()} bytes)` });
        const s = subs.get(ev.candidate.seq);
        if (s) {
          const diags = s.test?.diagnostics.length ? s.test.diagnostics : (s.test?.cases ?? []).map((c) => c.diagnostic).filter((d): d is NonNullable<typeof d> => !!d);
          if (s.status === "testing" || s.status === "validating") items.push({ key: `r${e.seq}`, tone: "live", title: "Your browser is testing it on the simulated chip" });
          else if (s.status === "task-passed") items.push({ key: `r${e.seq}`, tone: "ok", title: "Your browser tested it: every test passes" });
          else if (s.status === "executed-unverified") items.push({ key: `r${e.seq}`, tone: "ok", title: "Your browser ran it: it works, and the AI's own examples hold" });
          else if (s.status === "invalid") items.push({ key: `r${e.seq}`, tone: "bad", title: "Your browser's own check rejected it" });
          else items.push({ key: `r${e.seq}`, tone: "bad", title: "Your browser tested it: some tests fail", detail: diags.slice(0, 2).map((d) => d.message) });
        }
        break;
      }
      case "attempt.incomplete":
        items.push({ key: `i${e.seq}`, tone: "warn", title: "The AI's answer was cut off; it was asked to send a complete program" });
        break;
      case "attempt.error": {
        const ev = e as Extract<LoopEvent, { type: "attempt.error" }>;
        items.push({ key: `e${e.seq}`, tone: "warn", title: ev.code === "attempt_lost" ? "The server restarted; resuming from the last saved point" : `A problem reaching the AI: ${ev.message}` });
        break;
      }
      case "loop.elided":
        items.push({ key: `l${e.seq}`, tone: "info", title: "Older drafts were trimmed to fit the AI's memory" });
        break;
      case "attempt.refused":
        items.push({ key: `x${e.seq}`, tone: "bad", title: "The AI declined the request" });
        break;
      case "review.started": {
        const ev = e as Extract<LoopEvent, { type: "review.started" }>;
        const done = g.events.slice(i + 1).some((x) => x.type === "review.result");
        const pt = g.playtests[ev.candidateSha256];
        items.push({ key: `p${e.seq}`, tone: done ? "info" : "live", title: `Your browser played it for ${pt ? `${pt.ticks} ticks` : "a few seconds"} with scripted key presses; a reviewer is comparing what it saw with your request`, ...(pt ? { images: pt.frames.map((f) => f.png) } : {}) });
        break;
      }
      case "review.result": {
        const ev = e as Extract<LoopEvent, { type: "review.result" }>;
        if (!ev.verdict) items.push({ key: `v${e.seq}`, tone: "info", title: `No review this time: ${ev.note}` });
        else if (ev.verdict.complete) items.push({ key: `v${e.seq}`, tone: "ok", title: "The reviewer says it delivers your request", detail: [ev.verdict.delivered] });
        else items.push({ key: `v${e.seq}`, tone: "warn", title: "The reviewer says it isn't there yet, so the AI is improving it", detail: ev.verdict.missing.slice(0, 4) });
        break;
      }
    }
  });
  return items;
}

function stage(g: GenState): Stage {
  if (g.outcome || g.phase === "stopped" || g.phase === "error") return "Done";
  if (g.phase === "testing") return "Testing";
  const review = [...g.events].reverse().find((e) => e.type === "review.started" || e.type === "review.result" || e.type === "turn.started");
  if (review?.type === "review.started") return "Reviewing";
  if (g.phase === "creating") return "Thinking";
  if (streamedBytes(g.turnText).bytes > 0) return "Writing bytes";
  const last = [...g.events].reverse().find((e) => e.type === "check.result" || e.type === "check.requested" || e.type === "turn.started");
  if (last?.type === "check.requested") return "Checking";
  const lastCheck = [...g.events].reverse().find((e) => e.type === "check.result") as Extract<LoopEvent, { type: "check.result" }> | undefined;
  if (lastCheck && !lastCheck.report.ok) return "Fixing";
  return "Thinking";
}

function outcomeHeadline(g: GenState): { tone: "ok" | "bad"; text: string } {
  switch (g.outcome) {
    case "passed":
      return { tone: "ok", text: "The AI wrote a program that passes every test." };
    case "passed-unverified":
      return { tone: "ok", text: "The AI wrote a working program." };
    case "budget-exhausted":
      return { tone: "bad", text: "The AI ran out of its limits before finishing." };
    case "stalled":
      return { tone: "bad", text: "The AI got stuck repeating the same mistake." };
    case "refused":
      return { tone: "bad", text: "The AI declined the request." };
    case "cancelled":
      return { tone: "bad", text: "Generation was cancelled." };
    default:
      return { tone: "bad", text: g.error ? "Something went wrong." : "Generation stopped." };
  }
}

export function GenerationModal(props: { gen: GenState; open: boolean; onClose: () => void; onCancel: () => void; onRun: (sha: string) => void; onShareDebug: () => Promise<{ debugId: string; environment: string }> }) {
  const { gen } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const busy = busyPhases.has(gen.phase);
  const [, tick] = useState(0);
  const [share, setShare] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      setShare(null);
      d.showModal();
    } else if (!props.open && d.open) d.close();
  }, [props.open]);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  const items = useMemo(() => {
    const xs = timeline(gen);
    const last = xs.at(-1);
    if (busy && last && last.key.startsWith("t")) xs[xs.length - 1] = { ...last, tone: "live", title: `${last.title}: the AI is working` };
    return xs;
  }, [gen.events, gen.submissions, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const l = listRef.current;
    if (l) l.scrollTop = l.scrollHeight;
  }, [items.length]);

  const current = stage(gen);
  const stream = streamedBytes(gen.turnText);
  const now = Date.now();
  const c = gen.counters;
  const b = gen.budget;
  const passed = gen.submissions.filter((s) => s.status === "task-passed" || s.status === "executed-unverified").at(-1);
  const done = !busy && gen.phase !== "idle";
  const head = outcomeHeadline(gen);
  const prompt = gen.request?.task.description ?? null;

  return (
    <dialog
      ref={ref}
      className="genmodal"
      aria-labelledby="genmodal-title"
      onCancel={(e) => {
        e.preventDefault(); // Escape cannot dismiss it; Close appears when the AI has finished
        if (done) props.onClose();
      }}
    >
      <div className="genmodal-inner">
        <header className="genmodal-head">
          <div>
            <h2 id="genmodal-title">{done ? "Finished" : "The AI is writing your program"}</h2>
            {prompt && <p className="genmodal-prompt">“{prompt.length > 220 ? `${prompt.slice(0, 220)}…` : prompt}”</p>}
          </div>
          <dl className="genmodal-stats">
            <dt>Time</dt>
            <dd>{gen.startedAt ? mmss((done ? (gen.events.at(-1)?.at ?? now) : now) - gen.startedAt) : "0:00"}</dd>
            <dt>Turns</dt>
            <dd>{c ? `${c.turns}${b ? ` / ${b.maxTurns}` : ""}` : "0"}</dd>
            <dt>Checks</dt>
            <dd>{c ? `${c.checks}${b ? ` / ${b.maxChecks}` : ""}` : "0"}</dd>
            <dt>Tokens written</dt>
            <dd>{c ? c.outputTokens.toLocaleString() : "0"}</dd>
          </dl>
        </header>

        <ol className="genmodal-stages" aria-label="Progress">
          {STAGES.map((st) => {
            const idx = STAGES.indexOf(st);
            const cur = STAGES.indexOf(current);
            const state = st === current ? "is-current" : idx < cur || current === "Done" ? "is-past" : "";
            return (
              <li key={st} className={state} aria-current={st === current ? "step" : undefined}>
                <span className="stage-dot" aria-hidden="true" />
                {st}
              </li>
            );
          })}
        </ol>

        <div className="genmodal-body">
          <section className="genmodal-stream" aria-label="Bytes as the AI writes them">
            <div className="stream-head">
              <span>Live: the bytes as the AI writes them</span>
              <span className="stream-count">{stream.bytes ? `${stream.bytes.toLocaleString()} bytes · ≈${Math.max(0, Math.floor((stream.bytes - 32) / 16)).toLocaleString()} instructions` : ""}</span>
            </div>
            <pre className="stream-bytes" aria-live="off">
              {stream.lines.length ? (
                <>
                  {stream.lines.join("\n")}
                  {busy && current === "Writing bytes" && <span className="stream-caret" aria-hidden="true">▍</span>}
                </>
              ) : busy ? (
                <span className="stream-wait">{current === "Fixing" ? "The AI is reading the checker's report and planning its fixes" : "The AI is thinking before it writes"}{gen.turnStartedAt ? ` · ${mmss(now - gen.turnStartedAt)}` : ""}</span>
              ) : (
                <span className="stream-wait">No draft is being written.</span>
              )}
            </pre>
            <p className="stream-note">Unchecked: these bytes reach the checker only when the AI sends the draft.</p>
          </section>

          <section className="genmodal-timeline" aria-label="What has happened">
            <ol ref={listRef}>
              {items.length === 0 && <li className="tl-info">Connecting to the AI…</li>}
              {items.map((it) => (
                <li key={it.key} className={`tl-${it.tone}`}>
                  <span className="tl-title">{it.title}</span>
                  {it.detail?.map((d, k) => (
                    <span key={k} className="tl-detail">{d}</span>
                  ))}
                  {it.images && it.images.length > 0 && (
                    <span className="tl-frames">
                      {it.images.map((src, k) => <img key={k} src={src} alt={`playtest frame ${k + 1}`} width={128} height={72} />)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="genmodal-foot">
          {done ? (
            <>
              <p className={`genmodal-outcome is-${head.tone}`}>
                {head.tone === "ok" ? "✓ " : ""}
                {head.text}
                {passed?.bytes && <span className="outcome-size"> {passed.bytes.length.toLocaleString()} bytes, {Math.floor((passed.bytes.length - 32) / 16).toLocaleString()} instructions, every one written by the AI.</span>}
                {head.tone === "bad" && (gen.stopDetail || gen.error) && <span className="outcome-detail">{gen.error ?? gen.stopDetail}</span>}
              </p>
              <div className="genmodal-actions">
                {head.tone === "bad" && gen.sessionId && (
                  <button
                    onClick={() =>
                      void props.onShareDebug().then(
                        (r) => setShare(`llmtobinary debug ${r.environment} ${r.debugId}`),
                        (e) => setShare(`could not share: ${(e as Error).message}`),
                      )
                    }
                  >
                    Share for debugging
                  </button>
                )}
                {passed?.sha256 && (
                  <button className="primary" onClick={() => props.onRun(passed.sha256!)}>
                    ▶ Run it
                  </button>
                )}
                <button onClick={props.onClose}>Close</button>
              </div>
              {share && <p className="genmodal-share"><code>{share}</code></p>}
            </>
          ) : (
            <>
              <p className="genmodal-hint">This can take a few minutes. The checker explains mistakes; it never writes a byte for the AI.</p>
              <button onClick={props.onCancel}>Cancel generation</button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
