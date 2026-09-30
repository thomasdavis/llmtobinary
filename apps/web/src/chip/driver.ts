// Chip driver: talks to a dedicated machine Web Worker, keeps each track's executed-but-not-yet-
// shown microsteps buffered ahead of the animation clock, and replays them into the view model as
// the clock passes them. The clock never runs past events that have not arrived.

import type { ChipUnit, EntryInput, MicroEvent, TickEvent } from "@llmtobinary/protocol";
import type { ChipIsa, ChipState, FromChip, ToChip } from "../worker-protocol.ts";
import { ChipViewModel } from "./viewmodel.ts";

const HISTORY = 6000;
const PREFETCH_STEPS = 48;

export interface Track {
  id: number;
  isa: ChipIsa;
  vm: ChipViewModel;
  /** Executed microsteps not yet reached by the clock (ascending `at`). */
  pending: MicroEvent[];
  /** Microsteps already reached (bounded), for the analyzer and active highlights. */
  history: MicroEvent[];
  /** End tick of the last buffered event. */
  bufferedTo: number;
  workerDone: boolean;
  requesting: boolean;
  state: ChipState | null;
  error: string | null;
  /** Step boundaries (end tick of each instruction) for step-instruction. */
  stepEnds: number[];
  heat: Partial<Record<ChipUnit, number>>;
  heatSpill: number;
  heatPending: boolean;
  instructionsInHeat: number;
}

export class ChipDriver {
  private worker: Worker;
  readonly tracks = new Map<number, Track>();
  private loaders = new Map<number, (s: ChipState) => void>();
  private errors = new Map<number, (m: string) => void>();
  onChange: (() => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL("../machine.worker.ts", import.meta.url));
    this.worker.onmessage = (ev: MessageEvent<FromChip>) => this.receive(ev.data);
  }

  dispose(): void {
    this.worker.terminate();
  }

  private send(m: ToChip, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  load(id: number, isa: ChipIsa, bytes: Uint8Array, inputs: EntryInput[], opts: { fastSlots: number; allowedFeatures: number; ticks: TickEvent[]; cells: number; initialR0: string | null }): Promise<ChipState> {
    const vm = new ChipViewModel(isa, opts.cells, opts.initialR0);
    this.tracks.set(id, { id, isa, vm, pending: [], history: [], bufferedTo: 0, workerDone: false, requesting: false, state: null, error: null, stepEnds: [], heat: {}, heatSpill: 0, heatPending: false, instructionsInHeat: 0 });
    const copy = bytes.slice().buffer;
    return new Promise((resolve, reject) => {
      this.loaders.set(id, resolve);
      this.errors.set(id, reject);
      this.send({ type: "chip-load", chipId: id, isa, bytes: copy, inputs, fastSlots: opts.fastSlots, allowedFeatures: opts.allowedFeatures, ticks: opts.ticks }, [copy]);
    });
  }

  private receive(m: FromChip): void {
    const tr = this.tracks.get(m.chipId);
    if (!tr) return;
    if (m.type === "chip-error") {
      tr.error = m.message;
      tr.requesting = false;
      tr.heatPending = false;
      this.errors.get(m.chipId)?.(new Error(m.message) as never);
      this.onChange?.();
      return;
    }
    tr.state = m.state;
    if (m.type === "chip-loaded") {
      this.push(tr, m.prologue.events);
      tr.stepEnds.push(tr.bufferedTo);
      this.loaders.get(m.chipId)?.(m.state);
    } else if (m.type === "chip-steps") {
      tr.requesting = false;
      for (const s of m.steps) {
        this.push(tr, s.events);
        tr.stepEnds.push(tr.bufferedTo);
      }
      const st = m.state.status;
      if (m.steps.length === 0 || st === "halted" || st === "trapped" || st === "cancelled" || st === "waiting-input") tr.workerDone = true;
    } else {
      tr.heatPending = false;
      for (const [u, n] of Object.entries(m.activity)) tr.heat[u as ChipUnit] = (tr.heat[u as ChipUnit] ?? 0) + (n ?? 0);
      tr.heatSpill += m.spill;
      tr.instructionsInHeat += m.instructions;
      const st = m.state.status;
      if (st === "halted" || st === "trapped" || st === "cancelled" || st === "waiting-input") tr.workerDone = true;
    }
    this.onChange?.();
  }

  private push(tr: Track, events: MicroEvent[]): void {
    for (const e of events) {
      tr.pending.push(e);
      tr.bufferedTo = Math.max(tr.bufferedTo, e.at + e.ticks);
    }
  }

  /** Keep enough executed microsteps buffered ahead of tick t. */
  ensure(id: number, t: number): void {
    const tr = this.tracks.get(id);
    if (!tr || tr.requesting || tr.workerDone || tr.error) return;
    if (tr.pending.length > 0 && tr.bufferedTo > t + 400) return;
    tr.requesting = true;
    this.send({ type: "chip-step", chipId: id, instructions: PREFETCH_STEPS });
  }

  /** The furthest tick the clock may reach without outrunning the data. */
  limit(id: number): number {
    const tr = this.tracks.get(id);
    if (!tr) return 0;
    return tr.workerDone ? Number.POSITIVE_INFINITY : tr.bufferedTo;
  }

  /** Replay every microstep that starts at or before t into the view model. */
  advance(id: number, t: number): void {
    const tr = this.tracks.get(id);
    if (!tr) return;
    let n = 0;
    while (n < tr.pending.length && tr.pending[n]!.at <= t) {
      const e = tr.pending[n]!;
      tr.vm.apply(e);
      tr.history.push(e);
      n++;
    }
    if (n) tr.pending.splice(0, n);
    if (tr.history.length > HISTORY) tr.history.splice(0, tr.history.length - HISTORY);
  }

  /** Microsteps in progress at t (zero-tick steps stay visible for a moment). */
  active(id: number, t: number, minVisible = 0.5): { e: MicroEvent; p: number }[] {
    const tr = this.tracks.get(id);
    if (!tr) return [];
    const out: { e: MicroEvent; p: number }[] = [];
    for (let i = tr.history.length - 1; i >= 0 && i >= tr.history.length - 40; i--) {
      const e = tr.history[i]!;
      const d = Math.max(e.ticks, minVisible);
      if (e.at <= t && t < e.at + d) out.push({ e, p: (t - e.at) / d });
    }
    return out.reverse();
  }

  /** End tick of the next instruction after t (for step-instruction). */
  nextStepEnd(id: number, t: number): number | null {
    const tr = this.tracks.get(id);
    if (!tr) return null;
    const next = tr.stepEnds.find((x) => x > t + 1e-9);
    return next ?? null;
  }

  /** Start of the next microstep boundary after t (for step-microstep). */
  nextEventBoundary(id: number, t: number): number | null {
    const tr = this.tracks.get(id);
    if (!tr) return null;
    const cur = this.active(id, t, 0);
    if (cur.length) return Math.max(...cur.map(({ e }) => e.at + e.ticks));
    return tr.pending[0] ? tr.pending[0].at + tr.pending[0].ticks : null;
  }

  finished(id: number, t: number): boolean {
    const tr = this.tracks.get(id);
    return !!tr && tr.workerDone && tr.pending.length === 0 && t >= tr.bufferedTo;
  }

  /** Heat mode: run a time-boxed batch in the worker and accumulate per-unit activity. */
  heat(id: number, instructions: number): void {
    const tr = this.tracks.get(id);
    if (!tr || tr.heatPending || tr.workerDone || tr.error) return;
    tr.heatPending = true;
    this.send({ type: "chip-run", chipId: id, maxInstructions: Math.max(1, Math.floor(instructions)), maxMs: 12 });
  }

  /** After heat mode: adopt the engine's current state and continue the event timeline from it. */
  resync(id: number): number {
    const tr = this.tracks.get(id);
    if (!tr?.state) return 0;
    tr.vm.loadState(tr.state);
    tr.pending = [];
    tr.history = [];
    tr.bufferedTo = tr.state.counters.modeledTicks ?? 0;
    tr.stepEnds = [tr.bufferedTo];
    return tr.bufferedTo;
  }

  takeHeat(id: number): { activity: Partial<Record<ChipUnit, number>>; spill: number } {
    const tr = this.tracks.get(id)!;
    const out = { activity: tr.heat, spill: tr.heatSpill };
    tr.heat = {};
    tr.heatSpill = 0;
    return out;
  }
}
