import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeFile, disassemble } from "@llmtobinary/decode";
import { TypeTag, parseU64Decimal } from "@llmtobinary/spec";
import { validateBytes } from "@llmtobinary/validate";
import { COST_MODEL_ID, LATENCY_TABLE } from "@llmtobinary/runtime";
import { anmrClaim, validateAnmr } from "@llmtobinary/research";
import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { openStore } from "@llmtobinary/artifacts";
import type { EntryInput, MicroEvent, TickEvent } from "@llmtobinary/protocol";
import { FIXTURES, loadFixture } from "../fixtures.ts";
import { Analyzer } from "./Analyzer.tsx";
import { Die, litUnits, type Glow } from "./Die.tsx";
import { ChipDriver } from "./driver.ts";
import { ANMA_PLAN, ANMR_PLAN } from "./geometry.ts";
import { describe } from "./units.ts";
import "./chip.css";

const SPEEDS = [
  { label: "4 ticks/s", mode: "event" as const, rate: 4 },
  { label: "12 ticks/s", mode: "event" as const, rate: 12 },
  { label: "40 ticks/s", mode: "event" as const, rate: 40 },
  { label: "120 ticks/s", mode: "event" as const, rate: 120 },
  { label: "Heat · 2k instr/s", mode: "heat" as const, rate: 2000 },
  { label: "Heat · 50k instr/s", mode: "heat" as const, rate: 50_000 },
];
const F_CHOICES = [1, 2, 4, 8, 16, 32, 64];
const R_CHOICES = [4, 8, 16, 32];
const WINDOW_TICKS = 120;
const CAPSTONE_SHA = "d6e710f149bac62226ad57f9d3a2f4e4bf958cebbf3727994f0ec5477013e88a";
const ALLOWED = 15;

type Source = { kind: "fixture"; file: string; task: string | null } | { kind: "artifact"; sha: string };

interface Program {
  name: string;
  bytes: Uint8Array;
  taskId: string | null;
  sha: string;
  params: TypeTag[];
  records: { rec: number; text: string }[];
  interactive: boolean;
  valid: boolean;
  error: string | null;
}

async function sha256(b: Uint8Array): Promise<string> {
  const c = new Uint8Array(b.byteLength);
  c.set(b);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", c)), (x) => x.toString(16).padStart(2, "0")).join("");
}

function readParams(): { source: Source; F: number; compare: boolean; R: number; x: string | null } {
  const q = new URLSearchParams(location.search);
  const sha = q.get("sha");
  const file = q.get("fixture");
  const fixture = FIXTURES.find((f) => f.file === file) ?? FIXTURES.find((f) => f.file === "upstream-capstone-40.anma")!;
  const F = Number(q.get("F"));
  const R = Number(q.get("R"));
  return {
    source: sha && /^[0-9a-f]{64}$/.test(sha) ? { kind: "artifact", sha } : { kind: "fixture", file: fixture.file, task: fixture.task },
    F: F_CHOICES.includes(F) ? F : 8,
    compare: q.get("compare") === "1",
    R: R_CHOICES.includes(R) ? R : 8,
    x: q.get("x"),
  };
}

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setR(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return r;
}

export function ChipPage() {
  const initial = useMemo(readParams, []);
  const [source, setSource] = useState<Source>(initial.source);
  const [program, setProgram] = useState<Program | null>(null);
  const [inputTexts, setInputTexts] = useState<string[]>(initial.x ? [initial.x] : []);
  const [F, setF] = useState(initial.F);
  const [compare, setCompare] = useState(initial.compare);
  const [R, setR] = useState(initial.R);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, setFrame] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const reducedMotion = useReducedMotion();

  const driverRef = useRef<ChipDriver | null>(null);
  const tRef = useRef(0);
  const targetRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const glowsRef = useRef<[Map<string, Glow>, Map<string, Glow>]>([new Map(), new Map()]);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  playingRef.current = playing;

  const isCapstone = program?.sha === CAPSTONE_SHA || program?.taskId === "capstone-40";
  const compareOn = compare && !!isCapstone;
  const trackIds = compareOn ? [1, 2] : [1];

  useEffect(() => {
    document.documentElement.classList.add("chip-root");
    document.body.classList.add("chip-body");
    document.title = "llmtobinary · chip view";
    return () => {
      document.documentElement.classList.remove("chip-root");
      document.body.classList.remove("chip-body");
    };
  }, []);

  // Load the program bytes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadState("loading");
      try {
        let bytes: Uint8Array;
        let name: string;
        let taskId: string | null;
        if (source.kind === "fixture") {
          bytes = await loadFixture(source.file);
          name = source.file;
          taskId = source.task && TASK_BY_ID.has(source.task) ? source.task : null;
        } else {
          const store = await openStore();
          const a = await store.getArtifact(source.sha);
          if (!a) throw new Error("That artifact is not in this browser's local history. Open it in the machine view first, or pick a bundled program.");
          bytes = a.bytes;
          name = a.name;
          taskId = a.taskId;
        }
        const v = validateBytes(bytes, { allowedFeatures: ALLOWED });
        const decoded = decodeFile(bytes).file;
        const records = decoded ? decoded.records.map((r) => ({ rec: r.index, text: disassemble(r) })) : [];
        const entry = v.module?.functions[v.module.entry];
        const p: Program = {
          name,
          bytes,
          taskId,
          sha: await sha256(bytes),
          params: entry?.params ?? [],
          records,
          interactive: !!v.module && (v.module.features & 8) !== 0,
          valid: v.ok,
          error: v.ok ? null : (v.diagnostics.find((d) => d.severity === "error")?.message ?? "invalid executable"),
        };
        if (cancelled) return;
        setProgram(p);
        const task = taskId ? TASK_BY_ID.get(taskId) : null;
        setInputTexts((prev) => (p.params.length && prev.length === p.params.length ? prev : p.params.map((t, i) => task?.visible[0]?.inputs[i] ?? (t === TypeTag.BOOL ? "false" : "1"))));
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as Error).message);
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const inputs: EntryInput[] | null = useMemo(() => {
    if (!program) return null;
    const out: EntryInput[] = [];
    for (let i = 0; i < program.params.length; i++) {
      const s = (inputTexts[i] ?? "").trim();
      if (program.params[i] === TypeTag.BOOL) {
        if (s !== "true" && s !== "false") return null;
        out.push({ t: "bool", v: s === "true" });
      } else {
        if (parseU64Decimal(s) === null) return null;
        out.push({ t: "u64", v: s });
      }
    }
    return out;
  }, [program, inputTexts]);

  const anmrRecords = useRef<{ rec: number; text: string }[]>([]);

  // (Re)load the chip sessions whenever the program, inputs, F, or compare configuration changes.
  useEffect(() => {
    if (!program || !program.valid || !inputs) return;
    let cancelled = false;
    driverRef.current?.dispose();
    const d = new ChipDriver();
    driverRef.current = d;
    tRef.current = 0;
    targetRef.current = null;
    glowsRef.current = [new Map(), new Map()];
    setPlaying(false);
    setLoadState("loading");
    const task = program.taskId ? TASK_BY_ID.get(program.taskId) : null;
    const ticks: TickEvent[] = program.interactive ? ((task?.visible[0]?.ticks as TickEvent[] | undefined) ?? []) : [];
    d.onChange = () => setFrame((n) => n + 1);
    (async () => {
      try {
        await d.load(1, "ANMA-1", program.bytes, inputs, { fastSlots: F, allowedFeatures: ALLOWED, ticks, cells: F, initialR0: null });
        if (compareOn) {
          const anmr = await loadFixture(`anmr-capstone-r${R}.anmr`);
          const v = validateAnmr(anmr);
          if (!v.ok) throw new Error("ANMR fixture failed validation");
          anmrRecords.current = v.program.instrs.map((ins) => ({ rec: ins.rec, text: anmrClaim(ins) }));
          await d.load(2, "ANMR-1", anmr, inputs, { fastSlots: F, allowedFeatures: ALLOWED, ticks: [], cells: R, initialR0: inputs[0]?.t === "u64" ? inputs[0].v : "0" });
        }
        if (cancelled) return;
        for (const id of compareOn ? [1, 2] : [1]) d.ensure(id, 0);
        setLoadState("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as Error).message);
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program, inputs, F, compareOn, R, epoch]);

  useEffect(() => () => driverRef.current?.dispose(), []);

  // The clock: modeled ticks advance at the chosen rate; heat mode runs batches instead.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastRender = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const d = driverRef.current;
      if (d && loadState === "ready") {
        const sp = SPEEDS[speedRef.current]!;
        const ids = trackIds;
        if (sp.mode === "event") {
          if (playingRef.current || targetRef.current !== null) {
            let limit = Number.POSITIVE_INFINITY;
            for (const id of ids) limit = Math.min(limit, d.limit(id));
            let next = tRef.current + sp.rate * dt;
            if (targetRef.current !== null && next >= targetRef.current) {
              next = targetRef.current;
              targetRef.current = null;
              if (!playingRef.current) setPlaying(false);
            }
            tRef.current = Math.min(next, limit);
          }
          for (const id of ids) {
            d.ensure(id, tRef.current);
            d.advance(id, tRef.current);
          }
          if (ids.every((id) => d.finished(id, tRef.current)) && playingRef.current) setPlaying(false);
        } else if (playingRef.current) {
          for (const id of ids) {
            d.heat(id, sp.rate * dt);
            const tr = d.tracks.get(id)!;
            if (tr.state) tRef.current = Math.max(tRef.current, tr.state.counters.modeledTicks ?? 0);
          }
          if (ids.every((id) => d.tracks.get(id)!.workerDone)) setPlaying(false);
        }
        // Glow smoothing: instant attack, exponential release (no strobing at high rates).
        ids.forEach((id, k) => {
          const glows = glowsRef.current[k]!;
          const tr = d.tracks.get(id);
          if (!tr) return;
          const decay = reducedMotion ? 0 : Math.exp(-dt / 0.22);
          for (const [u, g] of glows) glows.set(u, { level: g.level * decay, spill: g.spill });
          if (sp.mode === "event") {
            for (const [u, spill] of litUnits(d.active(id, tRef.current))) glows.set(u, { level: 1, spill });
          } else if (playingRef.current) {
            const h = d.takeHeat(id);
            const total = Math.max(1, Object.values(h.activity).reduce((a, b) => a + (b ?? 0), 0));
            for (const [u, n] of Object.entries(h.activity)) {
              const target = Math.min(1, 0.25 + (4 * (n ?? 0)) / total);
              const prev = glows.get(u)?.level ?? 0;
              glows.set(u, { level: Math.max(prev, target), spill: u === "backing" || u === "spill" });
            }
            if (tr.state) tr.vm.loadState(tr.state);
          }
        });
      }
      if (now - lastRender > 33) {
        lastRender = now;
        setFrame((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [loadState, trackIds.length, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaveHeat = useCallback(() => {
    const d = driverRef.current;
    if (!d) return;
    let t = 0;
    for (const id of trackIds) t = Math.max(t, d.resync(id));
    tRef.current = t;
  }, [trackIds]);

  const onSpeed = (i: number) => {
    const wasHeat = SPEEDS[speed]!.mode === "heat";
    setSpeed(i);
    if (wasHeat && SPEEDS[i]!.mode === "event") leaveHeat();
  };

  const stepInstruction = useCallback(() => {
    const d = driverRef.current;
    if (!d) return;
    if (SPEEDS[speed]!.mode === "heat") onSpeed(1);
    setPlaying(false);
    const ends = trackIds.map((id) => d.nextStepEnd(id, tRef.current)).filter((x): x is number => x !== null);
    if (ends.length) targetRef.current = Math.min(...ends);
    else for (const id of trackIds) d.ensure(id, tRef.current);
  }, [speed, trackIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepMicro = useCallback(() => {
    const d = driverRef.current;
    if (!d) return;
    if (SPEEDS[speed]!.mode === "heat") onSpeed(1);
    setPlaying(false);
    const ends = trackIds.map((id) => d.nextEventBoundary(id, tRef.current)).filter((x): x is number => x !== null);
    if (ends.length) targetRef.current = Math.min(...ends);
  }, [speed, trackIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => setEpoch((n) => n + 1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepInstruction();
      } else if (e.key === ".") stepMicro();
      else if (e.key === "r" || e.key === "R") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepInstruction, stepMicro]);

  const exportTrace = () => {
    const d = driverRef.current;
    if (!d || !program) return;
    const trace = {
      kind: "llmtobinary-chip-trace/1",
      costModel: COST_MODEL_ID,
      note: "Modeled ticks from a declared synthetic cost model; not measured cycles.",
      program: { name: program.name, sha256: program.sha, inputs },
      tracks: trackIds.map((id) => {
        const tr = d.tracks.get(id)!;
        return { isa: tr.isa, fastSlots: id === 1 ? F : null, registers: id === 2 ? R : null, t: tRef.current, events: tr.history };
      }),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `chip-trace-${program.sha.slice(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Keep the URL shareable.
  useEffect(() => {
    const q = new URLSearchParams();
    if (source.kind === "fixture") q.set("fixture", source.file);
    else q.set("sha", source.sha);
    q.set("F", String(F));
    if (compare) {
      q.set("compare", "1");
      q.set("R", String(R));
    }
    if (inputTexts[0]) q.set("x", inputTexts[0]);
    history.replaceState(null, "", `/chip?${q}`);
  }, [source, F, compare, R, inputTexts]);

  const d = driverRef.current;
  const t = tRef.current;
  const sp = SPEEDS[speed]!;
  const tracks = trackIds.map((id) => d?.tracks.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const allDone = !!d && tracks.length > 0 && tracks.every((tr) => d.finished(tr.id, t) || (sp.mode === "heat" && tr.workerDone));

  return (
    <div className="chip-page">
      <header className="chip-head">
        <div className="chip-title">
          <a className="chip-back" href="/">← Machine</a>
          <h1>Chip view</h1>
          <p className="chip-honest">
            A modeled microarchitecture for the ANMA-1 machine. Every light is a microstep the engine executed; time is in <strong>modeled ticks</strong> ({COST_MODEL_ID}), not measured cycles. It is not silicon.
          </p>
        </div>
      </header>

      <div className="chip-toolbar" role="toolbar" aria-label="Chip controls">
        <label className="chip-field">
          <span>Program</span>
          <select
            value={source.kind === "fixture" ? source.file : `sha:${source.sha}`}
            onChange={(e) => {
              const f = FIXTURES.find((x) => x.file === e.target.value);
              if (f) setSource({ kind: "fixture", file: f.file, task: f.task });
            }}
          >
            {source.kind === "artifact" && <option value={`sha:${source.sha}`}>{program?.name ?? "artifact"}</option>}
            {FIXTURES.map((f) => (
              <option key={f.file} value={f.file}>{f.file.replace(/\.anma$/, "")}</option>
            ))}
          </select>
        </label>
        {program?.params.map((p, i) => (
          <label key={i} className="chip-field">
            <span>{`input ${i} (${p === TypeTag.BOOL ? "bool" : "u64"})`}</span>
            <input className="mono" value={inputTexts[i] ?? ""} spellCheck={false} inputMode="numeric" aria-invalid={!inputs} onChange={(e) => setInputTexts((prev) => prev.map((v, k) => (k === i ? e.target.value : v)))} />
          </label>
        ))}
        <label className="chip-field">
          <span>Fast slots F</span>
          <select value={F} onChange={(e) => setF(Number(e.target.value))}>
            {F_CHOICES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className={`chip-check${isCapstone ? "" : " is-disabled"}`} title={isCapstone ? "" : "The ANMR-1 register control exists for the forty-value capstone"}>
          <input type="checkbox" checked={compareOn} disabled={!isCapstone} onChange={(e) => setCompare(e.target.checked)} />
          <span>Compare with ANMR-1</span>
        </label>
        {compareOn && (
          <label className="chip-field">
            <span>Registers R</span>
            <select value={R} onChange={(e) => setR(Number(e.target.value))}>
              {R_CHOICES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
        <div className="chip-transport">
          <button className="chip-btn is-primary" onClick={() => setPlaying((p) => !p)} disabled={loadState !== "ready" || allDone} aria-keyshortcuts="Space">{playing ? "Pause" : "Play"}</button>
          <button className="chip-btn" onClick={stepInstruction} disabled={loadState !== "ready" || allDone} aria-keyshortcuts="ArrowRight">Step instruction</button>
          <button className="chip-btn" onClick={stepMicro} disabled={loadState !== "ready" || allDone || sp.mode === "heat"} aria-keyshortcuts=".">Step microstep</button>
          <button className="chip-btn" onClick={reset} aria-keyshortcuts="R">Reset</button>
        </div>
        <label className="chip-field chip-speed">
          <span>Clock</span>
          <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
            {SPEEDS.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
          </select>
        </label>
        <button className="chip-btn is-quiet" onClick={exportTrace} disabled={!d}>Export trace</button>
      </div>

      {loadState === "error" && <p className="chip-error" role="alert">{loadError}</p>}
      {program && !program.valid && <p className="chip-error" role="alert">This executable does not validate, so it cannot run: {program.error}</p>}
      {program && program.valid && !inputs && <p className="chip-error" role="alert">Enter canonical inputs (u64 as decimal 0..18446744073709551615; bool as true/false).</p>}

      <main className={`chip-main${compareOn ? " is-compare" : ""}`}>
        <section className="chip-stage" aria-label="Die">
          <div className="chip-dies">
            {(tracks.length ? tracks : [null]).map((tr, k) => (
              <figure key={k} className="chip-die">
                {tr ? (
                  <Die
                    plan={tr.isa === "ANMR-1" ? ANMR_PLAN : ANMA_PLAN}
                    vm={tr.vm}
                    active={sp.mode === "event" && d ? d.active(tr.id, t) : []}
                    glows={glowsRef.current[k]!}
                    records={tr.isa === "ANMR-1" ? anmrRecords.current : (program?.records ?? [])}
                    memCapacity={tr.state?.memCapacity ?? 0}
                    reducedMotion={reducedMotion}
                    label={`${tr.isa} die at modeled tick ${Math.floor(t)}`}
                  />
                ) : (
                  <div className="chip-die-empty">{program && !program.valid ? "This executable cannot run." : program && !inputs ? "Waiting for valid inputs." : loadState === "loading" ? "Loading the program…" : "Pick a program to run."}</div>
                )}
                {tr && (
                  <figcaption>
                    <strong>{tr.isa === "ANMR-1" ? `ANMR-1 · R = ${R} registers` : `ANMA-1 · F = ${F} fast slots`}</strong>
                    <span>{tr.isa === "ANMR-1" ? "storage placement written by the model (SAVE / RESTORE)" : "storage placement managed by the hardware"}</span>
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
          {sp.mode === "event" ? (
            <Analyzer tracks={tracks.map((tr) => ({ label: tr.isa === "ANMR-1" ? `ANMR-1 · R = ${R}` : `ANMA-1 · F = ${F}`, isa: tr.isa, events: tr.history, t }))} windowTicks={WINDOW_TICKS} />
          ) : (
            <p className="chip-heat-note">Heat mode: units glow by the share of executed microsteps that used them. Per-event traces resume when the clock returns to a tick rate.</p>
          )}
        </section>

        <aside className="chip-rail" aria-label="Details">
          {tracks.map((tr) => {
            const act = sp.mode === "event" && d ? d.active(tr.id, t, 0.5) : [];
            const c = tr.vm.counters;
            const anmr = tr.isa === "ANMR-1";
            const spillTransfers = anmr ? c.saves + c.restores : c.backingReads + c.backingWrites;
            return (
              <section key={tr.id} className="rail-block">
                <h2>{anmr ? `ANMR-1 · R = ${R}` : `ANMA-1 · F = ${F}`}</h2>
                <p className="rail-now mono">{tr.vm.rec !== null ? `record ${tr.vm.rec}  ${tr.vm.text}` : tr.vm.counters.instructions ? "halted" : "entry: arguments installed"}</p>
                <ol className="rail-micro">
                  {act.length ? act.map(({ e }) => <li key={`${e.at}-${e.u}`} className={isSpill(e) ? "is-spill" : ""}>{describe(e)}</li>) : <li className="dim">{allDone ? "finished" : playing || targetRef.current !== null ? "…" : "paused"}</li>}
                </ol>
                <dl className="rail-counters">
                  <dt>Instructions</dt><dd>{c.instructions.toLocaleString()}</dd>
                  <dt>Modeled ticks</dt><dd>{c.ticks.toLocaleString()}</dd>
                  {anmr ? (
                    <>
                      <dt>Register reads / writes</dt><dd>{`${c.regReads.toLocaleString()} / ${c.regWrites.toLocaleString()}`}</dd>
                      <dt>SAVE / RESTORE (model-written)</dt><dd>{`${c.saves} / ${c.restores}`}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Fast-slot hits</dt><dd>{c.hits.toLocaleString()}</dd>
                      <dt>Backing reads / writes (hardware)</dt><dd>{`${c.backingReads} / ${c.backingWrites}`}</dd>
                      <dt>Evictions</dt><dd>{c.evictions}</dd>
                    </>
                  )}
                  <dt>Backing traffic</dt><dd>{`${spillTransfers} transfers`}</dd>
                </dl>
                {tr.workerDone && tr.state && (d?.finished(tr.id, t) || sp.mode === "heat") && (
                  <>
                    <p className="rail-result mono">{tr.state.trap ? `trapped: ${tr.state.trap}` : `returned ${tr.state.result ?? "()"}`}</p>
                    {tr.state.terminal && (
                      <>
                        <h3 className="rail-sub">Terminal output</h3>
                        <pre className="rail-terminal mono">{tr.state.terminal}</pre>
                      </>
                    )}
                  </>
                )}
                {tr.error && <p className="chip-error">{tr.error}</p>}
              </section>
            );
          })}
          <section className="rail-block">
            <h2>Legend</h2>
            <ul className="rail-legend">
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" className="legend-signal" /></svg>Datapath microstep (fetch, hits, ALU, results)</li>
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" transform="rotate(45 10 10)" className="legend-spill" /></svg>Backing / spill traffic (the cost of limited fast storage)</li>
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" className="legend-unit" /></svg>A unit outlined in light is working this tick</li>
            </ul>
          </section>
          <section className="rail-block">
            <h2>Cost model · {COST_MODEL_ID}</h2>
            <table className="rail-costs">
              <tbody>
                {LATENCY_TABLE.map((r) => <tr key={r.unit}><td>{r.unit}</td><td className="mono">{r.ticks}</td></tr>)}
              </tbody>
            </table>
            <p className="dim small">Declared latencies used only to put both machines on one clock. They are not measurements of any processor.</p>
            <p className="dim small">Keys: Space play/pause · → step instruction · . step microstep · R reset</p>
          </section>
        </aside>
      </main>
    </div>
  );
}

function isSpill(e: MicroEvent): boolean {
  return e.u === "miss" || e.u === "evict" || e.u === "save" || e.u === "restore";
}
