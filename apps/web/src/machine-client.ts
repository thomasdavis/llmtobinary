// Page-side controller for the machine Web Worker: run lifecycle with runIds, cooperative Stop with
// a hard-terminate fallback (fresh worker), fixed-rate recorded ticks for interactive programs,
// and promise-based test/compare jobs.

import type { EntryInput, MachineConfig, MachineSnapshot, RunResult, TestReport, TickEvent } from "@llmtobinary/protocol";
import type { CompareRow, FromMachine, ToMachine } from "./worker-protocol.ts";

export interface MachineView {
  status: string;
  snapshot: MachineSnapshot | null;
  terminal: string;
  frame: Uint8ClampedArray | null;
  result: RunResult | null;
  error: string | null;
  ticks: TickEvent[];
}

const TICK_MS = 50;
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
  view: MachineView = { status: "empty", snapshot: null, terminal: "", frame: null, result: null, error: null, ticks: [] };
  private listeners = new Set<(v: MachineView) => void>();
  private interactive = false;
  private replayTicks: TickEvent[] = [];

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(new URL("./machine.worker.ts", import.meta.url));
    w.onmessage = (ev: MessageEvent<FromMachine>) => this.onMessage(ev.data);
    w.onerror = (e) => this.update({ error: e.message || "machine worker error", status: "trapped" });
    return w;
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
        this.update({ status: m.snapshot.status, snapshot: m.snapshot, terminal: m.terminal, ...(m.frame ? { frame: m.frame } : {}) });
        break;
      case "done":
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTicks();
        this.update({ status: m.result.status, snapshot: m.snapshot, terminal: m.terminal, result: m.result, ...(m.frame ? { frame: m.frame } : {}) });
        break;
    }
  }

  /** Load an immutable artifact (a COPY of its bytes is transferred). Changing F reloads the same bytes. */
  load(bytes: Uint8Array, inputs: EntryInput[], config: MachineConfig, allowedFeatures: number, opts: { interactive: boolean; replayTicks?: TickEvent[] }): void {
    this.runId++;
    this.stopTicks();
    this.interactive = opts.interactive;
    this.replayTicks = opts.replayTicks ?? [];
    this.tickNo = this.replayTicks.length ? Number(this.replayTicks[this.replayTicks.length - 1]!.tick) : 0;
    const copy = bytes.slice().buffer;
    this.update({ status: "validating", snapshot: null, terminal: "", frame: null, result: null, error: null, ticks: [...this.replayTicks] });
    this.send({ type: "load", runId: this.runId, bytes: copy, inputs, config, allowedFeatures, ticks: this.replayTicks }, [copy]);
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
    this.update({ status: reason ? "cancelled" : "empty", snapshot: reason ? this.view.snapshot : null, result: null, error: reason, ...(reason ? {} : { terminal: "", frame: null, ticks: [] }) });
  }

  private startTicks(): void {
    this.stopTicks();
    this.tickTimer = setInterval(() => {
      const event: TickEvent = { tick: String(++this.tickNo), keys: this.keys };
      this.view.ticks.push(event); // recorded for exact replay
      this.send({ type: "tick", runId: this.runId, event });
    }, TICK_MS);
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
