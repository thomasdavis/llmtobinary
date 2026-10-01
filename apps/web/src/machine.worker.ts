/// <reference lib="webworker" />
// The machine Web Worker: validates and executes guest bytes off the UI thread in bounded
// instruction chunks, yielding between chunks so Pause/Stop work mid-run. It never evaluates
// guest-derived code and has no credentials. Snapshots are throttled, never per instruction.

import { validateBytes, type Module } from "@llmtobinary/validate";
import { INTERACTIVE_RUN_LIMITS } from "@llmtobinary/spec";
import { createFastMachine, createFiniteMachine, type FastMachine, type FiniteMachine } from "@llmtobinary/runtime";
import { runTaskTests, redactForModel, TASK_BY_ID } from "@llmtobinary/tasks";
import { parseAnnotations } from "@llmtobinary/annotations";
import { capstoneWitness, runInvariance } from "@llmtobinary/research";
import type { MicroEvent, TickEvent } from "@llmtobinary/protocol";
import type { ChipBatch, CompareRow, FromChip, FromMachine, ToChip, ToMachine, WatchMode } from "./worker-protocol.ts";
import { handleChip } from "./chip/chip-worker.ts";
import { isSpillTraffic, unitsOf } from "./chip/units.ts";

declare const self: DedicatedWorkerGlobalScope;

const CHUNK = 20_000;
const SLICE_MS = 30;
const SNAPSHOT_MS = 100;

let machine: FiniteMachine | FastMachine | null = null;
let runId = -1;
let running = false;
let lastSnap = 0;
let lastFrames = -1;
/** A scheduled loop continuation exists (ticks must not start a second loop chain). */
let scheduled = false;
/** Instructions per second when slowed for watching; null = full speed. */
let rate: number | null = null;
let credit = 0;
let lastSlice = 0;

// Live chip instrumentation: the listener sees the SAME machine the panel runs.
const MAX_BATCH_EVENTS = 4000;
const HEAT_TAIL = 24;
let watch: WatchMode = "off";
let batch: ChipBatch = emptyBatch();

function emptyBatch(): ChipBatch {
  return { mode: watch === "events" ? "events" : "heat", events: [], dropped: 0, activity: {}, spill: 0 };
}

function sink(e: MicroEvent): void {
  for (const u of unitsOf(e)) batch.activity[u] = (batch.activity[u] ?? 0) + 1;
  if (isSpillTraffic(e)) batch.spill++;
  if (watch === "events") {
    if (batch.events.length < MAX_BATCH_EVENTS) batch.events.push(e);
    else batch.dropped++;
  } else {
    batch.events.push(e);
    if (batch.events.length > HEAT_TAIL * 8) batch.events.splice(0, batch.events.length - HEAT_TAIL);
  }
}

function takeBatch(): ChipBatch | undefined {
  if (watch === "off") return undefined;
  const b = batch;
  if (b.mode === "heat" && b.events.length > HEAT_TAIL) b.events = b.events.slice(-HEAT_TAIL);
  batch = emptyBatch();
  return b;
}

function setWatch(mode: WatchMode): void {
  watch = mode;
  batch = emptyBatch();
  machine?.setEventSink(mode === "off" ? null : sink);
}

const post = (m: FromMachine, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function frame(): Uint8ClampedArray | null {
  const f = machine?.devices.presentedFrame();
  return f ? new Uint8ClampedArray(f) : null;
}

function terminalText(): string {
  return machine ? new TextDecoder().decode(machine.devices.terminal()) : "";
}

function sendState(force = false): void {
  if (!machine) return;
  const now = performance.now();
  if (!force && now - lastSnap < SNAPSHOT_MS) return;
  lastSnap = now;
  const fp = machine.devices.framesPresented;
  const f = fp !== lastFrames ? frame() : null;
  lastFrames = fp;
  const chip = takeBatch();
  // The engine reports "paused" between the slices this loop runs it in; to the page it is running
  // until it is really paused (Pause, Step) or finished.
  const snap = machine.snapshot();
  const snapshot = running && snap.status === "paused" ? { ...snap, status: "running" as const } : snap;
  post({ type: "state", runId, snapshot, terminal: terminalText(), frame: f, framesPresented: fp, ...(chip ? { chip } : {}) }, f ? [f.buffer] : []);
}

function finished(): boolean {
  const s = machine?.status;
  return s === "halted" || s === "trapped" || s === "cancelled";
}

function sendDone(): void {
  if (!machine) return;
  const f = frame();
  const chip = takeBatch();
  post({ type: "done", runId, result: machine.result(), snapshot: machine.snapshot(), terminal: terminalText(), frame: f, ...(chip ? { chip } : {}) }, f ? [f.buffer] : []);
}

function loop(id: number): void {
  scheduled = false;
  if (id !== runId || !machine || !running) return;
  const t0 = performance.now();
  if (rate !== null) {
    // Slowed for watching: spend instruction credit earned at `rate` per second (bounded burst).
    credit = Math.min(credit + ((t0 - lastSlice) * rate) / 1000, Math.max(1, rate / 5));
    lastSlice = t0;
    const n = Math.floor(credit);
    if (n > 0) {
      credit -= n;
      machine.run(n);
    }
  } else {
    while (performance.now() - t0 < SLICE_MS) {
      const s = machine.run(CHUNK);
      if (s !== "paused") break;
    }
  }
  if (finished()) {
    running = false;
    sendDone();
    return;
  }
  if (machine.status === "waiting-input") {
    sendState(true); // the page paces its ticks on this status
    return; // resumed by the next tick message
  }
  sendState();
  schedule(id);
}

function schedule(id: number): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => loop(id), rate !== null ? Math.max(16, Math.min(100, 1000 / rate)) : 0);
}

function copy(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf.slice(0));
}

function validated(bytes: Uint8Array, allowedFeatures: number): Module {
  const v = validateBytes(bytes, { allowedFeatures });
  if (!v.ok || !v.module) {
    const first = v.diagnostics.find((d) => d.severity === "error");
    throw new Error(first ? `${first.rule}: ${first.message}` : "invalid executable");
  }
  return v.module;
}

self.onmessage = (ev: MessageEvent<ToMachine | ToChip>) => {
  if (ev.data.type.startsWith("chip-")) {
    handleChip(ev.data as ToChip, (r: FromChip) => self.postMessage(r));
    return;
  }
  const m = ev.data as ToMachine;
  try {
    switch (m.type) {
      case "load": {
        runId = m.runId;
        running = false;
        lastFrames = -1;
        const module = validated(copy(m.bytes), m.allowedFeatures);
        const opts = { config: m.config, allowedFeatures: m.allowedFeatures, ticks: m.ticks, limits: INTERACTIVE_RUN_LIMITS };
        machine = m.engine === "fast" ? createFastMachine(module, m.inputs, opts) : createFiniteMachine(module, m.inputs, opts);
        setWatch(watch);
        post({ type: "loaded", runId });
        sendState(true);
        return;
      }
      case "run":
        if (m.runId !== runId || !machine || finished()) return;
        running = true;
        credit = 1;
        lastSlice = performance.now();
        machine.setTracing(rate !== null); // full speed runs without building trace text
        if (!scheduled) loop(runId); // else the pending continuation resumes it
        return;
      case "pause":
        if (m.runId !== runId) return;
        running = false;
        sendState(true);
        return;
      case "step":
        if (m.runId !== runId || !machine || finished()) return;
        running = false;
        machine.setTracing(true);
        {
          // A single step always streams its full microstep sequence so the chip can animate it.
          const prev = watch;
          if (prev === "heat") setWatch("events");
          machine.step();
          if (finished()) sendDone();
          else sendState(true);
          if (prev === "heat") setWatch(prev);
        }
        return;
      case "stop":
        if (m.runId !== runId || !machine) return;
        running = false;
        machine.cancel();
        sendDone();
        return;
      case "tick":
        if (m.runId !== runId || !machine || finished()) return;
        try {
          machine.pushTick(m.event);
        } catch {
          return; // out-of-order or full queue: the event is dropped, never half-applied
        }
        if (running && !scheduled) schedule(runId);
        return;
      case "watch":
        setWatch(m.mode);
        return;
      case "rate":
        rate = m.rate !== null && m.rate > 0 ? m.rate : null;
        machine?.setTracing(rate !== null || !running);
        credit = 1;
        lastSlice = performance.now();
        return;
      case "test": {
        const bytes = copy(m.bytes);
        const module = validated(bytes, m.allowedFeatures);
        const task = m.taskId ? (TASK_BY_ID.get(m.taskId) ?? null) : null;
        const ann = parseAnnotations(m.annotations);
        const witnessResults: unknown[] = [];
        const report = runTaskTests(module, task, {
          annotations: ann.ok ? ann.annotations : null,
          claims: m.claims,
          allowedFeatures: m.allowedFeatures,
          witness: (mod, p) => {
            const w = capstoneWitness(mod, p.K, p.stride);
            witnessResults.push(w.ok ? w.certificate : w.diagnostic);
            return { ok: w.ok, diagnostic: w.diagnostic };
          },
        });
        post({ type: "test-result", jobId: m.jobId, report, modelReport: redactForModel(report), witness: witnessResults[0] ?? null });
        return;
      }
      case "playtest": {
        // Play a program that draws on the fast engine with a scripted input sequence, capturing
        // frames; when it reads input, replay the same number of ticks with no keys and compare.
        const module = validated(copy(m.bytes), m.allowedFeatures);
        const readsInput = (module.features & 8) !== 0;
        const play = (ticks: TickEvent[]) => {
          const mach = createFastMachine(module, m.inputs, { config: { fastSlots: 16, policy: "fifo-v1", trace: false }, allowedFeatures: m.allowedFeatures, ticks, limits: INTERACTIVE_RUN_LIMITS });
          const want = new Set(m.capture);
          const frames = new Map<number, Uint8ClampedArray>();
          const t0 = performance.now();
          let last = 0;
          let ended = "still running when the playtest ended";
          while (performance.now() - t0 < m.wallMs) {
            const s = mach.run(4000);
            const fp = mach.devices.framesPresented;
            if (fp !== last) {
              const shot = mach.devices.presentedFrame();
              for (let f = last + 1; f <= fp; f++) if (want.has(f) && shot && !frames.has(f)) frames.set(f, new Uint8ClampedArray(shot));
              last = fp;
            }
            if (s === "halted") { ended = "halted (the program returned)"; break; }
            if (s === "trapped") { ended = `trapped: ${mach.result().trap?.code ?? ""} ${mach.result().trap?.message ?? ""}`.trim(); break; }
            if (s === "cancelled") { ended = "cancelled"; break; }
            if (s === "waiting-input") { ended = "still running, waiting for more input when the scripted ticks ran out"; break; }
          }
          return { frames, framesPresented: mach.devices.framesPresented, ended };
        };
        const hash = (f: Uint8ClampedArray) => {
          let h = 0x811c9dc5;
          for (let i = 0; i < f.length; i += 4) h = Math.imul(h ^ (f[i]! | (f[i + 1]! << 8) | (f[i + 2]! << 16)), 0x01000193);
          return h >>> 0;
        };
        const withKeys = play(readsInput ? (m.ticks as TickEvent[]) : []);
        let inputChangesScreen: boolean | null = null;
        if (readsInput) {
          const idle = play((m.ticks as TickEvent[]).map((t) => ({ tick: t.tick, keys: 0 })));
          inputChangesScreen = [...withKeys.frames].some(([n, f]) => { const g = idle.frames.get(n); return !g || hash(g) !== hash(f); });
        }
        const list = [...withKeys.frames].sort((a, b) => a[0] - b[0]);
        const distinct = new Set(list.map(([, f]) => hash(f))).size;
        let translucent = 0;
        for (const [, f] of list) for (let i = 3; i < f.length; i += 4) if (f[i]! < 255) translucent++;
        const translucentPercent = list.length ? (100 * translucent) / (list.length * 256 * 144) : null;
        const frames = list.map(([frame, f]) => ({ frame, rgba: f.buffer as ArrayBuffer }));
        post({ type: "playtest-result", jobId: m.jobId, frames, framesPresented: withKeys.framesPresented, ended: withKeys.ended, distinctFrames: distinct, inputChangesScreen, translucentPercent }, frames.map((f) => f.rgba));
        return;
      }
      case "compare": {
        const module = validated(copy(m.bytes), m.allowedFeatures);
        const rep = runInvariance(module, m.inputs, { Fs: m.Fs, ticks: m.ticks as TickEvent[] });
        const rows: CompareRow[] = rep.rows.map((r) => ({
          F: r.F,
          status: r.status,
          trap: r.trap,
          returnValue: r.returnValue,
          terminalSha256: r.terminalSha256,
          effectsHash: r.effectsHash,
          framebufferHash: r.framebufferHash,
          backingReads: r.counters.backingReads ?? 0,
          backingWrites: r.counters.backingWrites ?? 0,
          operandMisses: r.counters.operandMisses ?? 0,
          evictions: r.counters.evictions ?? 0,
          microsteps: r.counters.microsteps ?? 0,
          executedInstructions: r.counters.executedInstructions ?? 0,
          peakLiveValues: r.counters.peakLiveValues ?? 0,
        }));
        post({ type: "compare-result", jobId: m.jobId, rows, reference: rep.reference, semanticAgreement: rep.semanticAgreement, missingBackingActivity: rep.missingBackingActivity, resourceLimited: rep.resourceLimited });
        return;
      }
    }
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if ("jobId" in m) post({ type: "job-error", jobId: m.jobId, message });
    else post({ type: "load-error", runId: "runId" in m ? m.runId : -1, message });
  }
};
