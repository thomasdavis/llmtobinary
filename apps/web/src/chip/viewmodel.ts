// The chip's visible state at animation time t, rebuilt ONLY by replaying the engine's own
// micro-events in order. The worker executes ahead of the animation, so its snapshot is in the
// future; replaying events keeps what the die shows exactly in step with what is lighting up.
// Tests prove the replay ends in the same state the engine reports.

import type { MicroEvent } from "@llmtobinary/protocol";

export interface CellView {
  value: string | null;
  payload: string | null;
}

export interface ChipCounters {
  instructions: number;
  ticks: number;
  hits: number;
  misses: number;
  backingReads: number;
  backingWrites: number;
  evictions: number;
  regReads: number;
  regWrites: number;
  saves: number;
  restores: number;
  hostCalls: number;
}

export class ChipViewModel {
  cells: CellView[];
  /** Backing entries (ANMA) or spill slots (ANMR) currently holding a value. */
  mem = new Map<number, CellView>();
  latches: { A: string | null; B: string | null; R: string | null } = { A: null, B: null, R: null };
  alu: { op: string; result: string } | null = null;
  staged: string[] = [];
  depth = 1;
  lastLookup: string | null = null;
  lastHost: string | null = null;
  rec: number | null = null;
  text = "";
  counters: ChipCounters = { instructions: 0, ticks: 0, hits: 0, misses: 0, backingReads: 0, backingWrites: 0, evictions: 0, regReads: 0, regWrites: 0, saves: 0, restores: 0, hostCalls: 0 };
  private pendingPayload: string | null = null;

  constructor(
    readonly isa: "ANMA-1" | "ANMR-1",
    size: number,
    /** ANMR-1: the input arrives in r0 before any instruction (no event). */
    initialR0: string | null = null,
  ) {
    this.cells = Array.from({ length: size }, () => ({ value: null, payload: null }));
    if (isa === "ANMR-1" && initialR0 !== null && this.cells[0]) this.cells[0] = { value: "r0", payload: initialR0 };
  }

  /** Re-synchronize from the engine's reported state (after heat mode ran ahead without events). */
  loadState(st: { cells: { value: string | null; payload: string | null }[]; memOccupied: number[]; rec: number | null; text: string; counters: Record<string, number>; latches: { A: string | null; B: string | null; R: string | null } }): void {
    this.cells = st.cells.map((c) => ({ value: c.value, payload: c.payload }));
    this.mem = new Map(st.memOccupied.map((i) => [i, { value: null, payload: null }]));
    this.rec = st.rec;
    this.text = st.text;
    this.latches = { ...st.latches };
    const c = st.counters;
    this.counters = {
      instructions: c.executedInstructions ?? c.instructions ?? 0,
      ticks: c.modeledTicks ?? 0,
      hits: c.operandHits ?? 0,
      misses: c.operandMisses ?? 0,
      backingReads: (c.backingReads ?? 0) + (c.restores ?? 0),
      backingWrites: (c.backingWrites ?? 0) + (c.saves ?? 0),
      evictions: c.evictions ?? 0,
      regReads: c.regReads ?? 0,
      regWrites: c.regWrites ?? 0,
      saves: c.saves ?? 0,
      restores: c.restores ?? 0,
      hostCalls: c.hostCalls ?? 0,
    };
    this.pendingPayload = null;
  }

  private freeByValue(value: string): void {
    for (const c of this.cells) if (c.value === value) Object.assign(c, { value: null, payload: null });
    for (const [k, c] of this.mem) if (c.value === value) this.mem.delete(k);
  }

  apply(e: MicroEvent): void {
    this.counters.ticks = e.at + e.ticks;
    switch (e.u) {
      case "fetch":
        this.counters.instructions++;
        this.rec = e.rec;
        this.text = e.text;
        this.latches = { A: null, B: null, R: null };
        break;
      case "hit":
        this.counters.hits++;
        this.latches[e.latch] = e.payload;
        this.lastLookup = `${e.value} → fast slot s${e.slot}`;
        break;
      case "miss":
        this.counters.misses++;
        this.counters.backingReads++;
        this.latches[e.latch] = e.payload;
        this.pendingPayload = e.payload;
        this.mem.delete(e.entry);
        this.lastLookup = `${e.value} → backing[${e.entry}]`;
        break;
      case "install":
        this.cells[e.slot] = { value: e.value, payload: this.pendingPayload };
        this.pendingPayload = null;
        break;
      case "evict": {
        const c = this.cells[e.slot]!;
        this.mem.set(e.entry, { value: e.value, payload: c.payload });
        this.cells[e.slot] = { value: null, payload: null };
        this.counters.evictions++;
        this.counters.backingWrites++;
        break;
      }
      case "alu":
        this.alu = { op: e.op, result: e.result };
        this.latches.R = e.result;
        break;
      case "publish":
        this.cells[e.slot] = { value: e.value, payload: e.payload };
        this.lastLookup = `${e.value} → fast slot s${e.slot} (new)`;
        break;
      case "reclaim":
        if (e.slot !== null && this.cells[e.slot]?.value === e.value) this.cells[e.slot] = { value: null, payload: null };
        else if (e.entry !== null) this.mem.delete(e.entry);
        else this.freeByValue(e.value);
        break;
      case "stage":
        this.staged = [...this.staged.slice(-7), e.payload];
        break;
      case "heap":
        break;
      case "host":
        this.counters.hostCalls++;
        this.lastHost = e.name;
        this.staged = [];
        break;
      case "branch":
        break;
      case "call":
        this.depth++;
        break;
      case "return":
        this.depth = Math.max(1, this.depth - 1);
        break;
      case "reg-read":
        this.counters.regReads++;
        break;
      case "reg-write":
        this.counters.regWrites++;
        if (this.cells[e.reg]) this.cells[e.reg] = { value: `r${e.reg}`, payload: e.payload };
        break;
      case "save":
        this.counters.saves++;
        this.counters.backingWrites++;
        this.mem.set(e.slot, { value: `slot${e.slot}`, payload: e.payload });
        break;
      case "restore":
        this.counters.restores++;
        this.counters.backingReads++;
        if (this.cells[e.reg]) this.cells[e.reg] = { value: `r${e.reg}`, payload: e.payload };
        break;
    }
  }
}
