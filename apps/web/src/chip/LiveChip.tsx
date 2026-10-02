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
import { Keypad } from "../Keypad.tsx";
import { Framebuffer } from "../Framebuffer.tsx";
import type { MachineClient, MachineView } from "../machine-client.ts";
import { Analyzer } from "./Analyzer.tsx";
import { Die, litUnits, type ActiveEvent, type Glow } from "./Die.tsx";
import { ANMA_PLAN } from "./geometry.ts";
import { ChipViewModel } from "./viewmodel.ts";
import "./chip.css";
import { isBool, oneOf, usePersistentState } from "../settings.ts";
import type { EngineKind } from "../worker-protocol.ts";

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

export function LiveChip(props: { artifact: LoadedArtifact; view: MachineView; machine: MachineClient; F: number; engine: EngineKind; onEngine: (e: EngineKind) => void; interactive: boolean; hasFramebuffer: boolean; controls: LiveChipControls }) {
  const { artifact, view, machine, controls } = props;
  const reducedMotion = useReducedMotion();
  const [speed, setSpeed] = usePersistentState("chipSpeed", 0, (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < SPEEDS.length);
  const [lights, setLights] = usePersistentState("chipLights", true, isBool);
  const fast = props.engine === "fast";
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
      if (s.engine === "fast") {
        // The fast engine does not simulate storage: the die stays as it was, only time moves.
        g.t = g.bufferedTo = s.counters.modeledTicks;
        g.queue = [];
        g.synced = true;
        return;
      }
      if (g.vm.cells.length !== s.slots.length) g.vm = new ChipViewModel("ANMA-1", s.slots.length);
      g.vm.loadState({ cells: s.slots.map((c) => ({ value: c.value, payload: c.payload })), memOccupied: s.backing.occupied, rec: s.position?.recordIndex ?? null, text: s.position ? textOf(s.position.recordIndex) : "", depth: s.position ? s.position.depth + 1 : 1, counters: s.counters as unknown as Record<string, number>, latches: s.latches });
      g.t = g.bufferedTo = s.counters.modeledTicks;
      g.queue = [];
      g.synced = true;
    },
    [textOf],
  );

  // Watch the machine while this panel is mounted; the speed also slows the machine itself.
  useEffect(() => {
    const rate = fast ? null : SPEEDS[speed]!.rate;
    machine.setRate(rate);
    // Instrumentation costs time: with lights off (or the fast engine) the machine runs without a listener.
    machine.setWatch(fast || !lights ? "off" : rate === null ? "heat" : "events");
  }, [machine, speed, lights, fast]);
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
        {!fast && (
          <label className="chip-field livechip-speed">
            <span>Speed</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
            </select>
          </label>
        )}
        <label className={`chip-check livechip-lights${fast ? " is-disabled" : ""}`} title={fast ? "The fast engine does not simulate the chip's storage; switch to Exact to watch the lights" : "Turn off to run faster: the chip stops listening to the machine"}>
          <input type="checkbox" checked={lights && !fast} disabled={fast} onChange={(e) => setLights(e.target.checked)} />
          <span>Lights</span>
        </label>
        {expanded && (
          <div className="chip-transport" role="toolbar" aria-label="Execution controls">
            <button className="chip-btn is-primary" onClick={controls.run} disabled={!controls.canRun || running}>Run</button>
            <button className="chip-btn" onClick={view.status === "paused" ? controls.resume : controls.pause} disabled={!running && view.status !== "paused"}>{view.status === "paused" ? "Continue" : "Pause"}</button>
            <button className="chip-btn" onClick={controls.step} disabled={fast || !(view.status === "paused" || view.status === "ready")}>Step</button>
            <button className="chip-btn" onClick={controls.stop} disabled={!running && view.status !== "paused"}>Stop</button>
          </div>
        )}
        <button className="chip-btn" onClick={() => void toggleExpanded()} aria-pressed={expanded}>{expanded ? "Exit full screen" : "Full screen"}</button>
      </div>

      <div className="livechip-body">
        <div className="livechip-stage">
          <div className={`livechip-diewrap${fast || !lights ? " is-dark" : ""}`}>
            <Die plan={ANMA_PLAN} vm={g.vm} active={active} glows={g.glows} records={records} memCapacity={view.snapshot?.backing.capacity ?? 0} reducedMotion={reducedMotion || heatView} label={`ANMA-1 chip, F = ${g.vm.cells.length} fast slots, modeled tick ${Math.floor(g.t)}`} />
            {fast ? (
              <div className="livechip-callout" role="note">
                <p>
                  <strong>The chip only lights up on the Exact engine.</strong> Exact simulates every step of the chip; Fast runs the program translated into your computer's own machine code, so there is nothing here to light up.
                </p>
                <button className="chip-btn is-primary" onClick={() => props.onEngine("exact")}>Light it up: switch to Exact</button>
                <span className="livechip-callout-note">Exact is slower; games play best on Fast.</span>
              </div>
            ) : !lights ? (
              <div className="livechip-callout" role="note">
                <p><strong>Lights are off.</strong> The program runs a little faster without them.</p>
                <button className="chip-btn is-primary" onClick={() => setLights(true)}>Turn the lights on</button>
              </div>
            ) : null}
          </div>
          {expanded && !heatView && <Analyzer tracks={[{ label: `ANMA-1 · F = ${g.vm.cells.length}`, isa: "ANMA-1", events: g.history, t: g.t }]} windowTicks={120} />}
          {/* Three fixed lines: changing text never changes the column's height. */}
          <p className="livechip-status">
            <span>{`state ${view.status}`}</span>
            <span title={g.vm.rec !== null ? `record ${g.vm.rec} ${g.vm.text}` : undefined}>{g.vm.rec !== null ? `record ${g.vm.rec} ${g.vm.text}` : c.instructions ? "\u00a0" : "arguments installed"}</span>
            <span>{fast ? "fast engine: the lights need the exact engine" : !lights ? "lights off: running without instrumentation" : rate === null ? (running ? "full speed: units glow by activity" : "\u00a0") : `slowed to ${rate.toLocaleString()} instr/s`}</span>
          </p>
        </div>
        <aside className="livechip-devices" aria-label="Devices">
          {props.hasFramebuffer && (
            <Framebuffer
              frame={view.frame}
              note={!view.frame && (view.snapshot?.counters.executedInstructions ?? 0) > 0 ? "Nothing shown yet: the program has not called display.present, so its drawing has not been published to the screen." : null}
            />
          )}
          {props.interactive && <Keypad machine={machine} view={view} />}
          <div>
            <h3>Terminal</h3>
            <pre className="livechip-terminal" aria-label="Terminal output">{view.terminal || " "}</pre>
          </div>
          <ChipTime view={view} fast={fast} />
          {fast ? (
            <dl className="rail-counters livechip-counters">
              <dt>Instructions</dt><dd>{(view.snapshot?.counters.executedInstructions ?? 0).toLocaleString()}</dd>
              <dt>Modeled ticks (lower bound)</dt><dd>{(view.snapshot?.counters.modeledTicks ?? 0).toLocaleString()}</dd>
              <dt>Fast slots, backing</dt><dd className="muted">not simulated</dd>
            </dl>
          ) : (
            <dl className="rail-counters livechip-counters">
              <dt>Instructions</dt><dd>{c.instructions.toLocaleString()}</dd>
              <dt>Modeled ticks</dt><dd>{c.ticks.toLocaleString()}</dd>
              <dt>Fast-slot hits</dt><dd>{c.hits.toLocaleString()}</dd>
              <dt>Backing reads / writes</dt><dd>{`${c.backingReads.toLocaleString()} / ${c.backingWrites.toLocaleString()}`}</dd>
              <dt>Evictions</dt><dd>{c.evictions.toLocaleString()}</dd>
            </dl>
          )}
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

const CLOCKS: { mhz: number; label: string }[] = [
  { mhz: 100, label: "100 MHz (FPGA prototype)" },
  { mhz: 1000, label: "1 GHz" },
  { mhz: 3000, label: "3 GHz" },
];

/**
 * What the run would cost on a physical ANMA chip: modeled ticks (anma-cost/1, 1 tick = 1 cycle)
 * per presented frame at a chosen clock, next to the frame rate this browser's simulator achieves.
 */
function ChipTime({ view, fast }: { view: MachineView; fast: boolean }) {
  const [mhz, setMhz] = usePersistentState("chipClockMHz", 1000, oneOf(100, 1000, 3000));
  const samples = useRef<{ at: number; frames: number; ticks: number }[]>([]);
  const ticks = view.snapshot?.counters.modeledTicks ?? 0;
  const frames = view.framesPresented;
  const s = samples.current;
  const last = s[s.length - 1];
  if (!last || frames < last.frames || ticks < last.ticks) samples.current = [{ at: performance.now(), frames, ticks }];
  else if (frames !== last.frames) {
    s.push({ at: performance.now(), frames, ticks });
    while (s.length > 2 && s[s.length - 1]!.at - s[0]!.at > 2000) s.shift();
  }
  const cur = samples.current;
  const first = cur[0]!;
  const end = cur[cur.length - 1]!;
  const df = end.frames - first.frames;
  const perFrame = df > 0 ? (end.ticks - first.ticks) / df : frames > 0 ? ticks / frames : null;
  const browserFps = df > 0 && end.at > first.at ? (df * 1000) / (end.at - first.at) : null;
  const ticksPerMs = mhz * 1000;
  const fmtMs = (ms: number) => (ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`);
  if (!view.snapshot) return null;
  return (
    <div className="chip-time">
      <div className="chip-time-head">
        <h3>On an ANMA chip</h3>
        <select aria-label="Chip clock" value={mhz} onChange={(e) => setMhz(Number(e.target.value))}>
          {CLOCKS.map((c) => <option key={c.mhz} value={c.mhz}>{c.label}</option>)}
        </select>
      </div>
      {perFrame !== null ? (
        <p className="chip-time-big">
          {fmtMs(perFrame / ticksPerMs)} per frame · ≈{Math.round((1000 * ticksPerMs) / perFrame).toLocaleString()} fps
          <span className="chip-time-sim">{browserFps !== null ? `this browser's simulator: ${browserFps.toFixed(1)} fps` : "this browser's simulator: measuring…"}</span>
        </p>
      ) : (
        <p className="chip-time-big">
          {fmtMs(ticks / ticksPerMs)} for this run so far
          <span className="chip-time-sim">per-frame time appears once the program presents frames</span>
        </p>
      )}
      <p className="chip-time-note">Modeled with {COST_MODEL_ID} (1 tick = 1 cycle), not measured{fast ? "; a lower bound, because the fast engine does not simulate storage stalls" : ""}.</p>
    </div>
  );
}

