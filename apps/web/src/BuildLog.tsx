// The Boot page's build log: every step of a `gen` request, from the prompt the OS sent, through
// each AI turn and checker report, to the bytes handed back and what the program printed. All of it
// comes from the loop's own events and the OS's own terminal; the page adds no judgement.

import { useEffect, useRef } from "react";
import type { LoopEvent } from "@llmtobinary/protocol";
import { plainEnglish } from "./plain.ts";

export type Tone = "info" | "ok" | "bad" | "warn" | "live";

export interface LogEntry {
  id: number;
  job: number;
  at: number;
  tone: Tone;
  title: string;
  detail?: string[];
  /** Preformatted text, such as program output. */
  output?: string;
  /** The submitted program, decoded one instruction per row. */
  program?: Uint8Array;
  link?: { href: string; label: string };
}

export type LogInput = Omit<LogEntry, "id" | "job" | "at">;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
const word = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const hex4 = (b: Uint8Array, at: number): string => [...b.slice(at, at + 4)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const plural = (n: number, s: string): string => `${n.toLocaleString()} ${s}${n === 1 ? "" : "s"}`;

interface Diag {
  rule: string;
  message: string;
  location?: { recordIndex: number | null };
}
const diagLine = (d: Diag): string => `${d.location?.recordIndex != null ? `instruction ${d.location.recordIndex}: ` : ""}${d.message} [${d.rule}]`;

const OUTCOME: Record<string, { tone: Tone; text: string }> = {
  passed: { tone: "ok", text: "The AI finished: the program passed every check." },
  "passed-unverified": { tone: "ok", text: "The AI finished: the program passed the checker." },
  "budget-exhausted": { tone: "bad", text: "The AI ran out of its limits before finishing." },
  stalled: { tone: "bad", text: "The AI got stuck repeating the same mistake." },
  refused: { tone: "bad", text: "The AI declined the request." },
  cancelled: { tone: "bad", text: "The generation was cancelled." },
  "infrastructure-error": { tone: "bad", text: "Something went wrong on the server." },
};

export interface GenResult {
  bytes: Uint8Array | null;
}

/**
 * Runs one generation through the site's normal loop, logging each step, and returns the submitted
 * bytes. `status` carries the one-line live state (such as bytes streamed so far).
 */
export async function generateLogged(description: string, prompt: string, log: (e: LogInput) => void, status: (s: string | null) => void): Promise<Uint8Array | null> {
  const headers = { "content-type": "application/json" };
  log({ tone: "info", title: `The OS asked the AI for a program: “${prompt}”` });
  status("Starting a generation session…");
  const res = await fetch("/api/generation-sessions", { method: "POST", headers, body: JSON.stringify({ task: { taskId: null, description, params: [], returns: "u64", allowedFeatures: 3, requireClaims: false }, mode: "tools", profile: "default" }) });
  const created = (await res.json().catch(() => ({}))) as { sessionId?: string; token?: string; error?: string; message?: string };
  if (!res.ok || !created.sessionId || !created.token) {
    log({ tone: "bad", title: "The generation could not start", detail: [created.message ?? created.error ?? `The server answered ${res.status}.`] });
    return null;
  }
  log({ tone: "info", title: `Session ${created.sessionId.slice(0, 8)} started` });
  const run = await fetch(`/api/generation-sessions/${created.sessionId}/attempts`, { method: "POST", headers: { ...headers, authorization: `Bearer ${created.token}` }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), feedback: null }) });
  if (!run.ok || !run.body) {
    const body = (await run.json().catch(() => ({}))) as { error?: string; message?: string };
    log({ tone: "bad", title: "The AI could not be reached", detail: [body.message ?? body.error ?? `The server answered ${run.status}.`] });
    return null;
  }
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes: Uint8Array | null = null;
  let draft = 0;
  let turn = 0;
  let streamed = 0;
  let counters: Extract<LoopEvent, { type: "loop.budget" }>["counters"] | null = null;
  let stopped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const lines = text.split("\n");
    text = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      const e = JSON.parse(l) as LoopEvent;
      switch (e.type) {
        case "turn.started":
          turn = e.turn;
          streamed = 0;
          log({ tone: "info", title: `Turn ${e.turn}: the AI is working` });
          status(`Turn ${turn}: thinking…`);
          break;
        case "model.tool_args.delta":
          streamed += (e.delta.match(/[0-9a-fA-F]/g) ?? []).length;
          status(`Turn ${turn}: writing bytes, ${plural(Math.floor(streamed / 2), "byte")} so far`);
          break;
        case "check.requested":
          status(`Turn ${turn}: the checker is reading the draft`);
          break;
        case "check.result": {
          draft++;
          const r = e.report;
          const warnings = r.warnings.length ? [`${plural(r.warnings.length, "warning")}: ${(r.warnings as Diag[]).slice(0, 3).map(diagLine).join("; ")}`] : [];
          if (r.ok) log({ tone: "ok", title: `Checker, draft ${draft}: no problems (${plural(r.byteLength ?? 0, "byte")})`, detail: warnings });
          else {
            const shown = (r.errors as Diag[]).slice(0, 12).map(diagLine);
            const more = r.errors.length - shown.length + r.suppressed + r.omitted;
            log({ tone: "bad", title: `Checker, draft ${draft}: ${plural(r.errors.length + r.suppressed + r.omitted, "problem")} for the AI to fix`, detail: [...shown, ...(more > 0 ? [`and ${plural(more, "more problem")}`] : []), ...warnings] });
          }
          break;
        }
        case "library.searched":
          log({ tone: "info", title: `The AI searched the library for “${e.query}”: ${e.results} ${e.results === 1 ? "match" : "matches"}` });
          break;
        case "library.selected":
          log({ tone: "info", title: `The AI chose ${e.symbols.join(", ")} from the library` });
          break;
        case "library.linked":
          log({
            tone: "ok",
            title: e.uses.length ? `Linked in ${e.uses.join(", ")} from the library` : "Linked the AI's program",
            detail: e.packages.map((p) => `${p.slot} (${p.evidence}): ${p.symbols.join(", ")}`),
          });
          break;
        case "candidate.submitted": {
          try {
            bytes = bytesOf((JSON.parse(e.envelopeText) as { hex: string }).hex.replace(/\s+/g, ""));
          } catch {
            bytes = null;
          }
          if (bytes) {
            const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))].map((x) => x.toString(16).padStart(2, "0")).join("");
            log({ tone: "ok", title: `The AI submitted its program: ${plural(bytes.length, "byte")}, ${plural(Math.max(0, Math.floor((bytes.length - 32) / 16)), "instruction")}`, program: bytes, link: { href: `/package/sha256:${digest}`, label: "Its page in the registry" } });
          } else log({ tone: "bad", title: "The AI submitted something that is not a program" });
          break;
        }
        case "loop.budget":
          counters = e.counters;
          break;
        case "loop.elided":
          log({ tone: "info", title: "Older drafts were trimmed to fit the AI's memory" });
          break;
        case "attempt.incomplete":
          log({ tone: "warn", title: "The AI's answer was cut off; it was asked for a complete program", detail: [e.reason] });
          break;
        case "attempt.refused":
          log({ tone: "bad", title: "The AI declined the request", detail: [e.message] });
          break;
        case "attempt.error":
          log({ tone: e.retryable ? "warn" : "bad", title: e.code === "attempt_lost" ? "The server restarted mid-generation" : "A problem reaching the AI", detail: [`${e.message} (${e.code})`] });
          break;
        case "loop.stopped": {
          stopped = true;
          const o = OUTCOME[e.outcome] ?? { tone: "info" as Tone, text: `Stopped: ${e.outcome}` };
          log({ tone: o.tone, title: o.text, detail: e.detail ? [e.detail] : [] });
          break;
        }
      }
    }
  }
  status(null);
  if (counters) log({ tone: "info", title: `Used ${plural(counters.turns, "turn")}, ${plural(counters.checks, "check")}, ${plural(counters.outputTokens, "output token")}${counters.libraryCalls ? `, ${plural(counters.libraryCalls, "library call")}` : ""}, in ${Math.round((Date.now() - counters.startedAt) / 1000)} s` });
  if (!bytes && !stopped) log({ tone: "bad", title: "The AI stopped without submitting a program" });
  return bytes;
}

function Program({ bytes }: { bytes: Uint8Array }) {
  const count = Math.max(0, Math.floor((bytes.length - 32) / 16));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const at = 32 + i * 16;
    const r = { op: word(bytes, at), a: word(bytes, at + 4), b: word(bytes, at + 8), c: word(bytes, at + 12) };
    let text: string;
    try {
      text = plainEnglish(r);
    } catch {
      text = "?";
    }
    rows.push(
      <tr key={i}>
        <td className="log-n">{i}</td>
        <td className="log-hex">{[0, 4, 8, 12].map((k) => hex4(bytes, at + k)).join("  ")}</td>
        <td>{text}</td>
      </tr>,
    );
  }
  return (
    <details className="log-program">
      <summary>Show all {plural(count, "instruction")} in plain English</summary>
      <div className="log-program-scroll">
        <table>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </details>
  );
}

const ICON: Record<Tone, string> = { info: "•", ok: "✓", bad: "✗", warn: "!", live: "…" };
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

export function BuildLog({ entries, status, onClear }: { entries: LogEntry[]; status: string | null; onClear: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = end.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [entries.length, status]);
  if (!entries.length && !status) return null;
  return (
    <section className="build-log" aria-label="Build log">
      <header className="build-log-head">
        <h2>Build log</h2>
        <button className="link" onClick={onClear}>Clear</button>
      </header>
      <div className="build-log-body" role="log" aria-live="polite">
        <ol>
          {entries.map((e) => (
            <li key={e.id} className={`log-${e.tone}`}>
              <span className="log-time">{clock(e.at)}</span>
              <span className="log-icon" aria-hidden="true">{ICON[e.tone]}</span>
              <div className="log-main">
                <span className="log-title">
                  <span className="log-job">gen #{e.job}</span> {e.title}
                  {e.link ? <> · <a href={e.link.href} target="_blank" rel="noreferrer">{e.link.label}</a></> : null}
                </span>
                {e.detail?.length ? (
                  <ul className="log-detail">
                    {e.detail.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                ) : null}
                {e.output !== undefined ? <pre className="log-output">{e.output || "(no output)"}</pre> : null}
                {e.program ? <Program bytes={e.program} /> : null}
              </div>
            </li>
          ))}
        </ol>
        {status ? <p className="log-status"><span className="log-spinner" aria-hidden="true" />{status}</p> : null}
        <div ref={end} />
      </div>
    </section>
  );
}
