import { useMemo, useState } from "react";
import { disassemble, describeHeader, recordBytesHex } from "@llmtobinary/decode";
import { compareClaim } from "@llmtobinary/annotations";
import { TYPE_NAMES, featureList } from "@llmtobinary/spec";
import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import type { LoadedArtifact } from "./artifact.ts";
import { DiagnosticList } from "./Diagnostics.tsx";
import type { VerificationReport } from "@llmtobinary/verify";

export type VerificationState = { sha: string; status: "running" } | { sha: string; status: "done"; report: VerificationReport } | { sha: string; status: "unavailable"; reason: string };

const MAX_ROWS = 2000;

function statusText(a: LoadedArtifact): string {
  if (!a.check.ok) return "✕ invalid — does not execute";
  if (a.test) {
    if (a.test.passed) return a.test.taskId ? "✓ task-passed" : "✓ executed; intent not independently verified";
    if (a.test.diagnostics.some((d) => d.rule === "ANMA-K-009")) return "! resource-limited";
    return "✕ task-failed (still inspectable and runnable)";
  }
  return a.record.taskId ? "✓ valid (not yet tested)" : "✓ valid; intent not independently verified";
}

export function Inspector({ artifact, selected, onSelect, verification, onVerify }: { artifact: LoadedArtifact | null; selected: number | null; onSelect: (i: number | null) => void; verification: VerificationState | null; onVerify: () => void }) {
  const [tab, setTab] = useState<"records" | "hex" | "values" | "diagnostics">("records");
  const a = artifact;
  const rows = useMemo(() => {
    if (!a?.decoded) return [];
    const recAnn = new Map((a.annotations?.records ?? []).map((r) => [r.index, r]));
    return a.decoded.records.slice(0, MAX_ROWS).map((r) => {
      const ann = recAnn.get(r.index);
      const cmp = ann?.claim ? compareClaim(ann.claim, r) : null;
      return { r, text: disassemble(r), hex: recordBytesHex(a.record.bytes, r), claim: ann?.claimText ?? null, note: ann?.note ?? null, matches: cmp ? cmp.matches : null };
    });
  }, [a]);
  if (!a) return <section className="panel" aria-label="Executable inspector"><h2>Executable</h2><p className="muted">Load a bundled fixture, import a file, or generate a program.</p></section>;
  const errs = a.check.errors.length;
  const held = a.test?.cases.filter((c) => c.kind === "contract" || c.kind === "example");
  return (
    <section className="panel" aria-label="Executable inspector">
      <h2>Executable</h2>
      <dl className="facts">
        <dt>name</dt><dd>{a.record.name}</dd>
        <dt>SHA-256</dt><dd><code className="hash">{a.record.sha256}</code></dd>
        <dt>bytes</dt><dd>{a.record.byteLength}</dd>
        <dt>origin</dt><dd>{a.record.provenance.kind === "bundled-fixture" ? "bundled fixture — not model output" : a.record.provenance.kind === "model-generated" ? `OpenAI generation (${a.record.provenance.mode === "raw-hex" ? "raw hex" : a.annotations ? "literal bytes · annotated" : "literal bytes · checker-assisted loop"})` : "imported — unverified until rerun"}</dd>
        <dt>status</dt><dd><strong>{statusText(a)}</strong></dd>
        {a.decoded && <><dt>header</dt><dd><code>{describeHeader(a.decoded.header)}</code> ({featureList(a.decoded.header.features).join(", ") || "no devices"})</dd></>}
        {a.test && <><dt>verification</dt><dd>{a.test.tier === "T2" ? `held on ${a.test.cases.filter((c) => c.kind !== "contract" && c.kind !== "witness").length} executions (${a.test.contractOwner === "task" ? "task contract" : "model's contract"}) — evidence, not proof` : a.test.tier === "T1" ? "claims match bytes" : "tests only"}{held?.length ? "" : ""}</dd></>}
      </dl>
      <Verification a={a} v={verification?.sha === a.record.sha256 ? verification : null} onVerify={onVerify} />
      <div role="tablist" className="tabs small">
        {(["records", "hex", "values", "diagnostics"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t}{t === "diagnostics" && (errs || a.check.warnings.length) ? ` (${errs}✕ ${a.check.warnings.length}!)` : ""}
          </button>
        ))}
      </div>
      {tab === "records" && (
        <div className="scroll">
          <table className="records">
            <thead><tr><th>#</th><th>@</th><th>bytes</th><th>decoded</th><th>annotation</th></tr></thead>
            <tbody>
              {rows.map(({ r, text, hex, claim, note, matches }) => (
                <tr key={r.index} className={selected === r.index ? "sel" : ""} onClick={() => onSelect(selected === r.index ? null : r.index)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(r.index)}>
                  <td>{r.index}</td><td>{r.offset}</td><td><code className="bytes">{hex}</code></td><td><code>{text}</code></td>
                  <td>
                    {claim && <div><span className={`badge ${matches ? "ok" : "bad"}`}>{matches ? "✓ claim matches bytes" : "✕ claim ≠ bytes"}</span> <code>{claim}</code></div>}
                    {note && <div><span className="badge">model's comment</span> {note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.decoded && a.decoded.records.length > MAX_ROWS && <p className="muted">Showing {MAX_ROWS} of {a.decoded.records.length} records.</p>}
        </div>
      )}
      {tab === "hex" && <HexView bytes={a.record.bytes} selected={selected} onSelect={onSelect} />}
      {tab === "values" && <Values a={a} />}
      {tab === "diagnostics" && (
        <div className="scroll">
          <DiagnosticList items={a.check.errors} empty="No validation errors." />
          {a.check.suppressed > 0 && <p className="muted">{a.check.suppressed} cascade diagnostic(s) suppressed; {a.check.omitted} omitted beyond the cap.</p>}
          <DiagnosticList items={a.check.warnings} />
          {a.test && <><h3>Tests</h3><DiagnosticList items={a.test.diagnostics} empty={a.test.passed ? "All tests passed." : ""} /></>}
        </div>
      )}
    </section>
  );
}

function HexView({ bytes, selected, onSelect }: { bytes: Uint8Array; selected: number | null; onSelect: (i: number | null) => void }) {
  const lines = Math.min(Math.ceil(bytes.length / 16), 4096);
  const recOf = (off: number) => (off < 32 ? null : Math.floor((off - 32) / 16));
  return (
    <div className="scroll hex" aria-label="Hex bytes">
      {Array.from({ length: lines }, (_, l) => {
        const off = l * 16;
        const rec = recOf(off);
        return (
          <div key={l} className={rec !== null && rec === selected ? "sel" : ""} onClick={() => onSelect(rec)}>
            <span className="muted">{off.toString(16).padStart(6, "0")}</span>{"  "}
            {Array.from(bytes.subarray(off, off + 16), (b) => b.toString(16).padStart(2, "0")).join(" ")}
            {off < 32 ? "   header" : ""}
          </div>
        );
      })}
    </div>
  );
}

function Values({ a }: { a: LoadedArtifact }) {
  if (!a.module) return <p className="muted">Values are shown for valid executables.</p>;
  return (
    <div className="scroll">
      {a.module.functions.map((f) => (
        <div key={f.id}>
          <h3>fn{f.id}({f.params.map((t) => TYPE_NAMES[t]).join(", ")}) → {TYPE_NAMES[f.ret]}</h3>
          {f.blocks.map((b) => {
            const producer = new Map<number, string>();
            for (const ins of b.instrs) if ("dst" in ins && ins.dst !== null) producer.set(ins.dst, `record ${ins.rec}: ${disassemble(a.module!.records[ins.rec]!)}`);
            return (
              <details key={b.id} open={f.blocks.length <= 3}>
                <summary>block{b.id} — {b.params.length} params, {b.types.length} values</summary>
                <table className="values"><tbody>
                  {b.types.slice(0, 500).map((t, v) => (
                    <tr key={v}><td><code>v{v}</code></td><td>{TYPE_NAMES[t]}</td><td>{v < b.params.length ? `parameter ${v}` : producer.get(v)}</td><td className="muted">{b.uses[v]} use{b.uses[v] === 1 ? "" : "s"}</td></tr>
                  ))}
                </tbody></table>
              </details>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Verification({ a, v, onVerify }: { a: LoadedArtifact; v: VerificationState | null; onVerify: () => void }) {
  const canTask = !!a.record.taskId && !!TASK_BY_ID.get(a.record.taskId)?.referenceContract;
  const canModel = !!a.annotations?.contracts.length;
  if (!a.module || (!canTask && !canModel)) return null;
  return (
    <details className="verify" open={!!v}>
      <summary>Formal verification (T3, z3 in your browser) — {canTask ? "task reference contract" : "the model's own contract"}</summary>
      <button onClick={onVerify} disabled={v?.status === "running"}>{v?.status === "running" ? "Verifying… (loading a 34 MB solver the first time)" : "Verify with z3"}</button>
      {v?.status === "unavailable" && <p className="muted">T3 unavailable here: {v.reason}</p>}
      {v?.status === "done" && (
        <div>
          <p><strong>{v.report.overall === "proved" ? "✓ " : v.report.overall === "refuted" ? "✕ " : "? "}{v.report.label}</strong></p>
          <ul className="mono small">
            {v.report.outcomes.map((o) => (
              <li key={o.id}>{o.status === "proved" ? "✓" : o.status === "refuted" ? "✕" : "?"} {o.description}{o.counterexample ? ` — counterexample inputs ${o.counterexample.join(", ")}` : ""} <span className="muted">({o.ms} ms)</span></li>
            ))}
          </ul>
          <p className="muted small">{v.report.prover} · {v.report.vcgen} · partial correctness only (termination is not proved).</p>
        </div>
      )}
    </details>
  );
}
