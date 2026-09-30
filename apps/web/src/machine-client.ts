// Page-side controller for the machine Web Worker: run lifecycle with runIds, cooperative Stop with
// a hard-terminate fallback (fresh worker), fixed-rate recorded ticks for interactive programs,
// and promise-based test/compare jobs.

import type { EntryInput, MachineConfig, MachineSnapshot, RunResult, TestReport, TickEvent } from "@llmtobinary/protocol";
import type { ChipBatch, CompareRow, EngineKind, FromMachine, ToMachine, WatchMode } from "./worker-protocol.ts";

/** One live-chip delivery: the executed microsteps (or activity) since the last one, plus the snapshot taken with them. */
export interface ChipDelivery {
  runId: number;
  batch: ChipBatch | null;
  snapshot: MachineSnapshot | null;
}

export interface MachineView {
  status: string;
  snapshot: MachineSnapshot | null;
  terminal: string;
  frame: Uint8ClampedArray | null;
  /** Frames the program has presented (display.present) in this run. */
  framesPresented: number;
  result: RunResult | null;
  error: string | null;
  ticks: TickEvent[];
}


const STOP_GRACE_MS = 400;

export class MachineClient {
  private worker: Worker;
  private runId = 0;
  private jobId = 0;
  private jobs = new Map<number, { resolve: (v: FromMachine) => void; reject: (e: Error) => void }>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickNo = 0;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  keys = 0;
  view: MachineView = { status: "empty", snapshot: null, terminal: "", frame: null, framesPresented: 0, result: null, error: null, ticks: [] };
  private listeners = new Set<(v: MachineView) => void>();
  private interactive = false;
  private chipListeners = new Set<(d: ChipDelivery) => void>();
  private watchMode: WatchMode = "off";
  /** Instructions per second while slowed for watching; null = full speed. */
  rate: number | null = null;
  /** Input ticks per second offered to interactive programs (paced: never faster than the program). */
  tickRate = 30;
  private replayTicks: TickEvent[] = [];

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(new URL("./machine.worker.ts", import.meta.url));
    w.onmessage = (ev: MessageEvent<FromMachine>) => this.onMessage(ev.data);
    w.onerror = (e) => this.update({ error: e.message || "machine worker error", status: "trapped" });
    // A fresh worker inherits the page's watch mode and speed.
    if (this.watchMode !== "off") w.postMessage({ type: "watch", mode: this.watchMode } satisfies ToMachine);
    if (this.rate !== null) w.postMessage({ type: "rate", rate: this.rate } satisfies ToMachine);
    return w;
  }

  get currentRunId(): number {
    return this.runId;
  }

  /** Live chip stream of the machine's own run (see WatchMode). */
  subscribeChip(fn: (d: ChipDelivery) => void): () => void {
    this.chipListeners.add(fn);
    return () => this.chipListeners.delete(fn);
  }

  setWatch(mode: WatchMode): void {
    this.watchMode = mode;
    this.send({ type: "watch", mode });
  }

  /** Slow the run for watching (instructions per second), or null for full speed. Applies immediately. */
  setRate(rate: number | null): void {
    this.rate = rate;
    this.send({ type: "rate", rate });
  }

  private emitChip(batch: ChipBatch | null, snapshot: MachineSnapshot | null): void {
    for (const l of this.chipListeners) l({ runId: this.runId, batch, snapshot });
  }

  subscribe(fn: (v: MachineView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private update(p: Partial<MachineView>): void {
    this.view = { ...this.view, ...p };
    for (const l of this.listeners) l(this.view);
  }

  private send(m: ToMachine, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private onMessage(m: FromMachine): void {
    if ("jobId" in m) {
      const j = this.jobs.get(m.jobId);
      this.jobs.delete(m.jobId);
      if (!j) return;
      if (m.type === "job-error") j.reject(new Error(m.message));
      else j.resolve(m);
      return;
    }
    if (m.runId !== this.runId) return; // late event from an older run
    switch (m.type) {
      case "loaded":
        this.update({ status: "ready", error: null });
        break;
      case "load-error":
        this.update({ status: "empty", error: m.message });
        break;
      case "state":
        this.update({ status: m.snapshot.status, snapshot: m.snapshot, terminal: m.terminal, framesPresented: m.framesPresented, ...(m.frame ? { frame: m.frame } : {}) });
        this.emitChip(m.chip ?? null, m.snapshot);
        break;
      case "done":
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTicks();
        this.update({ status: m.result.status, snapshot: m.snapshot, terminal: m.terminal, result: m.result, framesPresented: m.result.framesPresented, ...(m.frame ? { frame: m.frame } : {}) });
        this.emitChip(m.chip ?? null, m.snapshot);
        break;
    }
  }

  /** Load an immutable artifact (a COPY of its bytes is transferred). Changing F reloads the same bytes. */
  load(bytes: Uint8Array, inputs: EntryInput[], config: MachineConfig, allowedFeatures: number, opts: { interactive: boolean; replayTicks?: TickEvent[]; engine?: EngineKind }): void {
    this.runId++;
    this.stopTicks();
    this.interactive = opts.interactive;
    this.replayTicks = opts.replayTicks ?? [];
    this.tickNo = this.replayTicks.length ? Number(this.replayTicks[this.replayTicks.length - 1]!.tick) : 0;
    const copy = bytes.slice().buffer;
    this.update({ status: "validating", snapshot: null, terminal: "", frame: null, framesPresented: 0, result: null, error: null, ticks: [...this.replayTicks] });
    this.emitChip(null, null);
    this.send({ type: "load", runId: this.runId, bytes: copy, inputs, config, allowedFeatures, ticks: this.replayTicks, engine: opts.engine ?? "exact" }, [copy]);
  }

  run(): void {
    this.send({ type: "run", runId: this.runId });
    this.update({ status: "running" });
    if (this.interactive && !this.replayTicks.length) this.startTicks();
  }

  pause(): void {
    this.send({ type: "pause", runId: this.runId });
    this.stopTicks();
  }

  step(): void {
    this.send({ type: "step", runId: this.runId });
  }

  /** Cooperative stop; if the worker does not answer quickly, terminate it and start a fresh one. */
  stop(): void {
    this.stopTicks();
    const id = this.runId;
    this.send({ type: "stop", runId: id });
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.runId !== id || this.view.result) return;
      this.hardReset("stopped by terminating the machine worker");
    }, STOP_GRACE_MS);
  }

  hardReset(reason: string | null = null): void {
    this.stopTicks();
    this.worker.terminate();
    for (const j of this.jobs.values()) j.reject(new Error("machine worker restarted"));
    this.jobs.clear();
    this.worker = this.spawn();
    this.runId++;
    this.update({ status: reason ? "cancelled" : "empty", snapshot: reason ? this.view.snapshot : null, result: null, error: reason, ...(reason ? {} : { terminal: "", frame: null, framesPresented: 0, ticks: [] }) });
  }

  /** Change the offered tick rate; an interactive run in progress switches immediately. */
  setTickRate(perSecond: number): void {
    this.tickRate = perSecond;
    if (this.tickTimer) this.startTicks();
  }

  private startTicks(): void {
    this.stopTicks();
    this.tickTimer = setInterval(() => {
      // Only send the next tick once the program is waiting for it: a program slower than the tick
      // rate would otherwise fall behind a growing queue (key presses applied seconds late, then
      // dropped when the queue fills). Every sent tick is recorded, so replay stays exact.
      if (this.view.status !== "waiting-input") return;
      const event: TickEvent = { tick: String(++this.tickNo), keys: this.keys };
      this.view.ticks.push(event); // recorded for exact replay
      this.send({ type: "tick", runId: this.runId, event });
      this.view.status = "running"; // until the worker reports waiting again
    }, Math.round(1000 / this.tickRate));
  }

  private stopTicks(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private job<T extends FromMachine>(m: ToMachine, transfer: Transferable[]): Promise<T> {
    return new Promise((resolve, reject) => {
      this.jobs.set((m as { jobId: number }).jobId, { resolve: resolve as (v: FromMachine) => void, reject });
      this.send(m, transfer);
    });
  }

  test(bytes: Uint8Array, taskId: string | null, annotations: unknown, claims: { checked: number; matched: number } | null, allowedFeatures: number): Promise<{ report: TestReport; modelReport: TestReport; witness: unknown }> {
    const copy = bytes.slice().buffer;
    return this.job<Extract<FromMachine, { type: "test-result" }>>({ type: "test", jobId: ++this.jobId, bytes: copy, taskId, annotations, claims, allowedFeatures }, [copy]);
  }

  compare(bytes: Uint8Array, inputs: EntryInput[], Fs: number[], ticks: TickEvent[], allowedFeatures: number): Promise<{ rows: CompareRow[]; semanticAgreement: boolean; missingBackingActivity: number[]; resourceLimited: number[] }> {
    const copy = bytes.slice().buffer;
    return this.job<Extract<FromMachine, { type: "compare-result" }>>({ type: "compare", jobId: ++this.jobId, bytes: copy, inputs, Fs, ticks, allowedFeatures }, [copy]);
  }
}
