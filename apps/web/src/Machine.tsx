import { Feature, TypeTag, parseU64Decimal } from "@llmtobinary/spec";
import { formatGuestValue } from "@llmtobinary/devices";
import type { EntryInput } from "@llmtobinary/protocol";
import type { LoadedArtifact } from "./artifact.ts";
import type { MachineClient, MachineView } from "./machine-client.ts";
import type { CompareRow } from "./worker-protocol.ts";
import { LiveChip } from "./chip/LiveChip.tsx";

export const F_CHOICES = [1, 4, 8, 16, 32, 64];

const COUNTER_LABELS: [string, string][] = [
  ["executedInstructions", "executed guest instructions"],
  ["microsteps", "modeled microsteps"],
  ["operandReads", "operand reads"],
  ["operandHits", "fast-slot hits"],
  ["operandMisses", "misses (backing loads)"],
  ["backingReads", "backing reads"],
  ["backingWrites", "backing writes"],
  ["backingBytesRead", "backing bytes read"],
  ["backingBytesWritten", "backing bytes written"],
  ["evictions", "evictions"],
  ["reclaimed", "reclaimed values"],
  ["peakLiveValues", "peak live values"],
  ["peakFastOccupied", "peak fast slots used"],
  ["peakBackingEntries", "peak backing entries"],
  ["peakStagingBytes", "peak staging bytes"],
  ["peakMetadataBytes", "peak modeled metadata bytes"],
  ["peakFrames", "peak frames"],
  ["heapBytes", "heap bytes"],
  ["hostCalls", "host calls"],
  ["hostWallTimeMs", "host wall time (ms, not a chip measurement)"],
];

export function parseEntryInputs(a: LoadedArtifact, texts: string[]): { inputs: EntryInput[] | null; error: string | null } {
  const entry = a.module?.functions[a.module.entry];
  if (!entry) return { inputs: null, error: "invalid executable" };
  const out: EntryInput[] = [];
  for (let i = 0; i < entry.params.length; i++) {
    const s = (texts[i] ?? "").trim();
    if (entry.params[i] === TypeTag.BOOL) {
      if (s !== "true" && s !== "false") return { inputs: null, error: `input ${i} must be true or false` };
      out.push({ t: "bool", v: s === "true" });
    } else {
      if (parseU64Decimal(s) === null) return { inputs: null, error: `input ${i} must be a canonical u64 decimal (0..18446744073709551615, no signs, fractions, or whitespace)` };
      out.push({ t: "u64", v: s });
    }
  }
  return { inputs: out, error: null };
}

export function MachinePanel(props: {
  artifact: LoadedArtifact | null;
  view: MachineView;
  machine: MachineClient;
  F: number;
  setF: (f: number) => void;
  inputTexts: string[];
  setInputTexts: (t: string[]) => void;
  onLoadRun: (replay?: boolean) => void;
  compare: { rows: CompareRow[]; semanticAgreement: boolean; missingBackingActivity: number[]; resourceLimited: number[] } | null;
  onCompare: () => void;
  comparing: boolean;
  allowedFeatures: number;
}) {
  const { artifact: a, view, machine, F } = props;
  const entry = a?.module?.functions[a.module.entry];
  const parsed = a ? parseEntryInputs(a, props.inputTexts) : { inputs: null, error: null };
  const interactive = !!a && (a.module?.features ?? 0) & Feature.INPUT;
  const s = view.snapshot;
  const running = view.status === "running" || view.status === "waiting-input";
  return (
    <section className="panel" aria-label="Machine">
      <h2>Machine</h2>
      {!a?.module ? <p className="muted">A valid executable is required to run.</p> : (
        <>
          <div className="row wrap">
            {entry!.params.map((t, i) => (
              <label key={i} className="field">
                <span>{`input ${i} (${t === TypeTag.BOOL ? "bool" : "u64"})`}</span>
                {t === TypeTag.BOOL ? (
                  <select value={props.inputTexts[i] ?? "false"} onChange={(e) => { const n = [...props.inputTexts]; n[i] = e.target.value; props.setInputTexts(n); }}>
                    <option>false</option><option>true</option>
                  </select>
                ) : (
                  <input inputMode="numeric" spellCheck={false} value={props.inputTexts[i] ?? ""} onChange={(e) => { const n = [...props.inputTexts]; n[i] = e.target.value; props.setInputTexts(n); }} aria-invalid={!!parsed.error} />
                )}
              </label>
            ))}
            <label className="field">
              <span>fast slots F</span>
              <select value={F} onChange={(e) => props.setF(Number(e.target.value))}>{F_CHOICES.map((f) => <option key={f} value={f}>{f}{f === 1 ? " (edge test)" : ""}</option>)}</select>
            </label>
          </div>
          {parsed.error && <p className="error" role="alert">{parsed.error}</p>}
          <div className="row controls" role="toolbar" aria-label="Execution controls">
            <button onClick={() => props.onLoadRun(false)} disabled={!!parsed.error || running}>▶ Run</button>
            <button onClick={() => machine.pause()} disabled={!running}>❚❚ Pause</button>
            <button onClick={() => (view.status === "paused" ? machine.run() : null)} disabled={view.status !== "paused" && view.status !== "ready"}>▶ Continue</button>
            <button onClick={() => machine.step()} disabled={!(view.status === "paused" || view.status === "ready")}>↦ Step</button>
            <button onClick={() => machine.stop()} disabled={!running && view.status !== "paused"}>■ Stop execution</button>
            <button onClick={() => machine.hardReset()}>⟲ Reset machine</button>
            {interactive ? <button onClick={() => props.onLoadRun(true)} disabled={!view.ticks.length || running} title="Rerun with the recorded tick events">⟳ Replay ticks ({view.ticks.length})</button> : null}
          </div>
          <p className="status" aria-live="polite">
            state: <strong>{view.status}</strong>
            {s?.position && <> · fn{s.position.functionId} block{s.position.blockId} record {s.position.recordIndex} · depth {s.position.depth}</>}
            {view.result && <> · return <code>{formatGuestValue(view.result.returnValue)}</code></>}
            {view.result?.trap && <> · <span className="error">trap {view.result.trap.code}: {view.result.trap.message}</span></>}
            {view.error && <> · <span className="error">{view.error}</span></>}
          </p>
          <LiveChip
            artifact={a}
            view={view}
            machine={machine}
            F={F}
            interactive={!!interactive}
            hasFramebuffer={(a.module.features & Feature.FRAMEBUFFER) !== 0}
            controls={{ run: () => props.onLoadRun(false), pause: () => machine.pause(), resume: () => machine.run(), step: () => machine.step(), stop: () => machine.stop(), canRun: !parsed.error }}
          />
          <details className="machine-text">
            <summary>Machine state as text (slots, latches, backing, frames)</summary>
            <div>
              <h3>Fast slots (F = {s?.config.fastSlots ?? F}, {s?.config.policy ?? "fifo-v1"})</h3>
              <div className="slots">
                {(s?.slots ?? []).map((sl) => (
                  <div key={sl.index} className={`slot ${sl.value ? "full" : ""}`} title={sl.value ? `${sl.value} = ${sl.payload} (${sl.type}), FIFO stamp ${sl.insertedAt}, ${sl.remainingUses} uses left` : "empty"}>
                    <span className="muted">s{sl.index}</span> {sl.value ? <><code>{sl.value.split(".").pop()}</code><br /><small>{sl.payload}</small></> : <small>empty</small>}
                  </div>
                ))}
              </div>
              <p>latches: A <code>{s?.latches.A ?? "—"}</code> · B <code>{s?.latches.B ?? "—"}</code> · R <code>{s?.latches.R ?? "—"}</code></p>
              <p>backing: {s ? `${s.backing.used} entries in use of ${s.backing.capacity}` : "—"} · staging {s ? `${s.staging.usedBytes} B` : "—"} · live values {s?.liveValues ?? 0}</p>
              {s && s.backing.sample.length > 0 && <details><summary>backing sample</summary><ul className="mono small">{s.backing.sample.slice(0, 32).map((b) => <li key={b.entry}>[{b.entry}] {b.value} = {b.payload}</li>)}</ul></details>}
              {s && <details><summary>frames ({s.frames.length})</summary><ul className="mono small">{s.frames.map((f, i) => <li key={i}>fn{f.functionId} block{f.blockId} activation {f.blockActivation} · {f.liveValues} live</li>)}</ul></details>}
            </div>
          </details>
          <details open>
            <summary>Counters (modeled; not CPU cycles, power, or native speed)</summary>
            <table className="counters"><tbody>
              {COUNTER_LABELS.map(([k, label]) => <tr key={k}><td>{label}</td><td className="num">{s ? Math.round(Number((s.counters as unknown as Record<string, number>)[k] ?? 0)).toLocaleString() : "—"}</td></tr>)}
            </tbody></table>
          </details>
          <details>
            <summary>Last instruction microsteps</summary>
            {s?.lastMicrosteps.length ? <ol className="mono small">{s.lastMicrosteps.map((m, i) => <li key={i}>{m}</li>)}</ol> : <p className="muted">Enable by stepping (tracing runs are recorded at the default trace level).</p>}
          </details>
          <details>
            <summary>Trace (bounded; latest 200 of up to 10,000){s?.traceTruncated ? " — truncated" : ""}</summary>
            <pre className="trace">{(s?.trace ?? []).map((t) => t.text).join("\n")}</pre>
          </details>
          <h3>Same binary, different F</h3>
          <button onClick={props.onCompare} disabled={!!parsed.error || props.comparing}>{props.comparing ? "Comparing…" : `Compare across F = ${F_CHOICES.join("/")}`}</button>
          {props.compare && (
            <>
              <p><strong>{props.compare.semanticAgreement ? "✓ identical return value, terminal bytes, effects, and framebuffer at every completed F" : "✕ results differ across F"}</strong>{props.compare.resourceLimited.length ? ` · resource-limited at F=${props.compare.resourceLimited.join(",")}` : ""}{props.compare.missingBackingActivity.length ? ` · ✕ missing backing activity at F=${props.compare.missingBackingActivity.join(",")}` : ""}</p>
              <div className="scroll"><table className="counters">
                <thead><tr><th>F</th><th>result</th><th>terminal sha</th><th>effects sha</th><th>misses</th><th>backing R/W</th><th>evictions</th><th>microsteps</th></tr></thead>
                <tbody>{props.compare.rows.map((r) => (
                  <tr key={r.F}><td>{r.F}</td><td><code>{r.trap ? `trap ${r.trap}` : r.returnValue}</code></td><td><code>{r.terminalSha256.slice(0, 10)}</code></td><td><code>{r.effectsHash.slice(0, 10)}</code></td><td className="num">{r.operandMisses}</td><td className="num">{r.backingReads}/{r.backingWrites}</td><td className="num">{r.evictions}</td><td className="num">{r.microsteps.toLocaleString()}</td></tr>
                ))}</tbody>
              </table></div>
            </>
          )}
        </>
      )}
    </section>
  );
}
