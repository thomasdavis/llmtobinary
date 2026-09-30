// The chip, live, inside the machine panel. It instruments the panel's OWN run (the same machine
// the Run/Step buttons drive, with the same live keyboard ticks), never a second copy:
//   - slowed runs and single steps stream every executed microstep, which is replayed in order
//     into the view model (the display never runs ahead of events it has not shown);
//   - full-speed runs send per-unit activity counts and the latest microsteps, and the view adopts
//     the machine's own reported state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { disassemble } from "@llmtobinary/decode";
import { COST_MODEL_ID } from "@llmtobinary/runtime";
import type { MachineSnapshot, MicroEvent } from "@llmtobinary/protocol";
import type { LoadedArtifact } from "../artifact.ts";
import { Framebuffer } from "../Framebuffer.tsx";
import type { MachineClient, MachineView } from "../machine-client.ts";
import { Analyzer } from "./Analyzer.tsx";
import { Die, litUnits, type ActiveEvent, type Glow } from "./Die.tsx";
import { ANMA_PLAN } from "./geometry.ts";
import { ChipViewModel } from "./viewmodel.ts";
import "./chip.css";

const SPEEDS: { label: string; rate: number | null }[] = [
  { label: "Full speed", rate: null },
  { label: "1,000 instr/s", rate: 1000 },
  { label: "100 instr/s", rate: 100 },
  { label: "10 instr/s", rate: 10 },
  { label: "2 instr/s", rate: 2 },
];
const HISTORY = 1500;
const FLASH_MS = 180;
const CHASE_TAU_S = 0.35;

export interface LiveChipControls {
  run: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
  stop: () => void;
  canRun: boolean;
}

interface Engine {
  runId: number;
  vm: ChipViewModel;
  queue: MicroEvent[];
  history: MicroEvent[];
  t: number;
  bufferedTo: number;
  latest: MachineSnapshot | null;
  synced: boolean;
  glows: Map<string, Glow>;
  heat: Partial<Record<string, number>>;
  flash: MicroEvent[];
  flashAt: number;
  mode: "heat" | "events";
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

export function LiveChip(props: { artifact: LoadedArtifact; view: MachineView; machine: MachineClient; F: number; interactive: boolean; hasFramebuffer: boolean; controls: LiveChipControls }) {
  const { artifact, view, machine, controls } = props;
  const reducedMotion = useReducedMotion();
  const [speed, setSpeed] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [, setFrame] = useState(0);
  const rootRef = useRef<HTMLElement>(null);

  const records = useMemo(() => (artifact.decoded ? artifact.decoded.records.map((r) => ({ rec: r.index, text: disassemble(r) })) : []), [artifact]);
  const textOf = useCallback((rec: number) => records.find((r) => r.rec === rec)?.text ?? "", [records]);

  const eng = useRef<Engine>(null as unknown as Engine);
  if (!eng.current) eng.current = { runId: -1, vm: new ChipViewModel("ANMA-1", props.F), queue: [], history: [], t: 0, bufferedTo: 0, latest: null, synced: true, glows: new Map(), heat: {}, flash: [], flashAt: 0, mode: "heat" };

  const adopt = useCallback(
    (s: MachineSnapshot) => {
      const g = eng.current;
      if (g.vm.cells.length !== s.slots.length) g.vm = new ChipViewModel("ANMA-1", s.slots.length);
      g.vm.loadState({ cells: s.slots.map((c) => ({ value: c.value, payload: c.payload })), memOccupied: s.backing.occupied, rec: s.position?.recordIndex ?? null, text: s.position ? textOf(s.position.recordIndex) : "", counters: s.counters as unknown as Record<string, number>, latches: s.latches });
      g.t = g.bufferedTo = s.counters.modeledTicks;
      g.queue = [];
      g.synced = true;
    },
    [textOf],
  );

  // Watch the machine while this panel is mounted; the speed also slows the machine itself.
  useEffect(() => {
    const rate = SPEEDS[speed]!.rate;
    machine.setRate(rate);
    machine.setWatch(rate === null ? "heat" : "events");
  }, [machine, speed]);
  useEffect(
    () => () => {
      machine.setWatch("off");
      machine.setRate(null);
    },
    [machine],
  );

  // Start from whatever state the machine already reports.
  useEffect(() => {
    const g = eng.current;
    g.runId = machine.currentRunId;
    g.history = [];
    g.glows.clear();
    if (machine.view.snapshot) adopt(machine.view.snapshot);
    else g.vm = new ChipViewModel("ANMA-1", props.F);
    setFrame((n) => n + 1);
  }, [artifact, adopt, machine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () =>
      machine.subscribeChip((d) => {
        const g = eng.current;
        if (d.runId !== g.runId) {
          g.runId = d.runId;
          g.history = [];
          g.flash = [];
          g.glows.clear();
          g.queue = [];
          g.t = g.bufferedTo = 0;
          g.vm = new ChipViewModel("ANMA-1", d.snapshot?.slots.length ?? props.F);
        }
        const b = d.batch;
        if (!d.snapshot) return;
        if (!b || b.mode === "heat" || b.dropped > 0) {
          // Full speed (or more events than one delivery holds): show the machine's own state.
          adopt(d.snapshot);
          g.mode = "heat";
          if (b) {
            for (const [u, n] of Object.entries(b.activity)) g.heat[u] = (g.heat[u] ?? 0) + (n ?? 0);
            g.flash = b.events;
            g.flashAt = performance.now();
          }
          return;
        }
        g.mode = "events";
        for (const e of b.events) {
          g.queue.push(e);
          g.bufferedTo = Math.max(g.bufferedTo, e.at + e.ticks);
        }
        g.latest = d.snapshot;
        g.synced = false;
      }),
    [machine, adopt], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The display clock: chase the executed events (never past them), glow with instant attack and
  // exponential release.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastRender = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const g = eng.current;
      let busy = false;
      const gap = g.bufferedTo - g.t;
      if (gap > 0) {
        g.t += Math.min(gap, Math.max(gap * (1 - Math.exp(-dt / CHASE_TAU_S)), dt * 8));
        busy = true;
      }
      let n = 0;
      while (n < g.queue.length && g.queue[n]!.at <= g.t) {
        g.vm.apply(g.queue[n]!);
        g.history.push(g.queue[n]!);
        n++;
      }
      if (n) g.queue.splice(0, n);
      if (g.history.length > HISTORY) g.history.splice(0, g.history.length - HISTORY);
      if (!g.queue.length && g.t >= g.bufferedTo && !g.synced && g.latest) {
        adopt(g.latest); // every event before this snapshot has now been shown
        busy = true;
      }
      const decay = reducedMotion ? 0 : Math.exp(-dt / 0.22);
      for (const [u, gl] of g.glows) {
        const level = gl.level * decay;
        if (level < 0.02) g.glows.delete(u);
        else g.glows.set(u, { level, spill: gl.spill });
        busy = true;
      }
      for (const [u, spill] of litUnits(activeAt(g))) g.glows.set(u, { level: 1, spill });
      const total = Object.values(g.heat).reduce<number>((a, b) => a + (b ?? 0), 0);
      if (total > 0) {
        for (const [u, c] of Object.entries(g.heat)) {
          const level = Math.min(1, 0.25 + (4 * (c ?? 0)) / total);
          g.glows.set(u, { level: Math.max(level, g.glows.get(u)?.level ?? 0), spill: u === "backing" });
        }
        g.heat = {};
        busy = true;
      }
      if (now - g.flashAt < FLASH_MS) busy = true;
      if (busy && now - lastRender > 33) {
        lastRender = now;
        setFrame((k) => k + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [adopt, reducedMotion]);

  // Full screen: the real Fullscreen API when available, else a fixed overlay.
  const toggleExpanded = async () => {
    if (!expanded) {
      setExpanded(true);
      try {
        await rootRef.current?.requestFullscreen?.();
      } catch {
        /* the overlay still covers the page */
      }
    } else {
      setExpanded(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    }
  };
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener("fullscreenchange", onFs);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const g = eng.current;
  const heatView = g.mode === "heat";
  const active: ActiveEvent[] = heatView ? (performance.now() - g.flashAt < FLASH_MS ? g.flash.slice(-8).map((e) => ({ e, p: 1 })) : []) : activeAt(g);
  const c = g.vm.counters;
  const running = view.status === "running" || view.status === "waiting-input";
  const rate = SPEEDS[speed]!.rate;

  return (
    <section ref={rootRef} className={`livechip chip-scope${expanded ? " is-expanded" : ""}`} aria-label="Live chip">
      <div className="livechip-head">
        <h3>Chip</h3>
        <p className="livechip-note">Every light is a microstep this run executed. Modeled floorplan, not silicon.</p>
        <label className="chip-field livechip-speed">
          <span>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
          </select>
        </label>
        {expanded && (
          <div className="chip-transport" role="toolbar" aria-label="Execution controls">
            <button className="chip-btn is-primary" onClick={controls.run} disabled={!controls.canRun || running}>Run</button>
            <button className="chip-btn" onClick={view.status === "paused" ? controls.resume : controls.pause} disabled={!running && view.status !== "paused"}>{view.status === "paused" ? "Continue" : "Pause"}</button>
            <button className="chip-btn" onClick={controls.step} disabled={!(view.status === "paused" || view.status === "ready")}>Step</button>
            <button className="chip-btn" onClick={controls.stop} disabled={!running && view.status !== "paused"}>Stop</button>
          </div>
        )}
        <button className="chip-btn" onClick={() => void toggleExpanded()} aria-pressed={expanded}>{expanded ? "Exit full screen" : "Full screen"}</button>
      </div>

      <div className="livechip-body">
        <div className="livechip-stage">
          <Die plan={ANMA_PLAN} vm={g.vm} active={active} glows={g.glows} records={records} memCapacity={view.snapshot?.backing.capacity ?? 0} reducedMotion={reducedMotion || heatView} label={`ANMA-1 chip, F = ${g.vm.cells.length} fast slots, modeled tick ${Math.floor(g.t)}`} />
          {expanded && !heatView && <Analyzer tracks={[{ label: `ANMA-1 · F = ${g.vm.cells.length}`, isa: "ANMA-1", events: g.history, t: g.t }]} windowTicks={120} />}
          <p className="livechip-status">
            <span>{`state ${view.status}`}</span>
            <span>{g.vm.rec !== null ? `record ${g.vm.rec} ${g.vm.text}` : c.instructions ? "" : "arguments installed"}</span>
            <span>{rate === null ? (running ? "full speed: units glow by activity" : "") : `slowed to ${rate.toLocaleString()} instr/s`}</span>
          </p>
        </div>
        <aside className="livechip-devices" aria-label="Devices">
          {props.hasFramebuffer && <Framebuffer frame={view.frame} interactive={props.interactive} machine={machine} autoFocus={expanded} />}
          <div>
            <h3>Terminal</h3>
            <pre className="livechip-terminal" aria-label="Terminal output">{view.terminal || " "}</pre>
          </div>
          <dl className="rail-counters livechip-counters">
            <dt>Instructions</dt><dd>{c.instructions.toLocaleString()}</dd>
            <dt>Modeled ticks</dt><dd>{c.ticks.toLocaleString()}</dd>
            <dt>Fast-slot hits</dt><dd>{c.hits.toLocaleString()}</dd>
            <dt>Backing reads / writes</dt><dd>{`${c.backingReads.toLocaleString()} / ${c.backingWrites.toLocaleString()}`}</dd>
            <dt>Evictions</dt><dd>{c.evictions.toLocaleString()}</dd>
          </dl>
          <p className="livechip-legend">
            <span className="lg-signal" aria-hidden="true" /> datapath <span className="lg-spill" aria-hidden="true" /> backing traffic · ticks are {COST_MODEL_ID}, not cycles
          </p>
        </aside>
      </div>
    </section>
  );
}

function activeAt(g: Engine): ActiveEvent[] {
  const out: ActiveEvent[] = [];
  for (let i = g.history.length - 1; i >= 0 && i >= g.history.length - 40; i--) {
    const e = g.history[i]!;
    const d = Math.max(e.ticks, 0.5);
    if (e.at <= g.t && g.t < e.at + d) out.push({ e, p: (g.t - e.at) / d });
  }
  return out.reverse();
}
