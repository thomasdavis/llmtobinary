// ANMR-1 interpreter (research only; never imported by the Cloudflare Worker). A stepping machine
// priced by the same declared cost model as the ANMA-1 finite machine (anma-cost/1), so the chip
// view can run both on one modeled-tick clock. Register reads/writes correspond to fast-slot
// hits/publishes; SAVE/RESTORE correspond to backing writes/reads — but here the MODEL wrote them.

import { HEADER_BYTES, RECORD_BYTES, U64_MASK, evalBinary, opName } from "@llmtobinary/spec";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import { LATENCY, aluTicks } from "@llmtobinary/runtime";
import type { MicroEvent } from "@llmtobinary/protocol";
import type { AnmrInstr, AnmrProgram } from "@llmtobinary/anmr";

export * from "@llmtobinary/anmr";

export interface AnmrCounters {
  instructions: number;
  saves: number;
  restores: number;
  spillBytesWritten: number;
  spillBytesRead: number;
  regReads: number;
  regWrites: number;
  modeledTicks: number;
}

export interface AnmrResult {
  status: "halted" | "trapped";
  value: bigint | null;
  trap: Diagnostic | null;
  counters: AnmrCounters;
}

export function anmrClaim(ins: AnmrInstr): string {
  switch (ins.k) {
    case "const": return `(CONST_U64 r${ins.rd} ${ins.value})`;
    case "bin": return `(${opName(ins.op)} r${ins.rd} r${ins.ra} r${ins.rb})`;
    case "save": return `(SAVE r${ins.rs} slot${ins.slot})`;
    case "restore": return `(RESTORE r${ins.rd} slot${ins.slot})`;
    case "ret": return `(RETURN r${ins.rs})`;
  }
}

export class AnmrMachine {
  readonly regs: (bigint | undefined)[];
  readonly slots: (bigint | undefined)[];
  readonly counters: AnmrCounters = { instructions: 0, saves: 0, restores: 0, spillBytesWritten: 0, spillBytesRead: 0, regReads: 0, regWrites: 0, modeledTicks: 0 };
  status: "ready" | "halted" | "trapped" = "ready";
  value: bigint | null = null;
  trap: Diagnostic | null = null;
  pc = 0;

  constructor(
    readonly program: AnmrProgram,
    x: bigint,
    private readonly onEvent: ((e: MicroEvent) => void) | null = null,
  ) {
    this.regs = new Array(program.R).fill(undefined);
    this.slots = new Array(program.S).fill(undefined);
    this.regs[0] = x & U64_MASK;
  }

  private tk(n: number): number {
    const at = this.counters.modeledTicks;
    this.counters.modeledTicks += n;
    return at;
  }

  private fail(rule: string, message: string, rec: number): "trapped" {
    this.trap = diag(rule, { message, location: { recordIndex: rec, byteOffset: HEADER_BYTES + RECORD_BYTES * rec }, stage: Stage.RUNTIME });
    this.status = "trapped";
    return "trapped";
  }

  private readReg(r: number, rec: number): bigint | null {
    const v = this.regs[r];
    if (v === undefined) {
      this.fail("ANMR-R-001", `r${r} is read before it is written`, rec);
      return null;
    }
    this.counters.regReads++;
    const at = this.tk(LATENCY.regRead);
    this.onEvent?.({ at, ticks: LATENCY.regRead, u: "reg-read", reg: r, payload: v.toString() });
    return v;
  }

  private writeReg(r: number, v: bigint): void {
    this.regs[r] = v;
    this.counters.regWrites++;
    const at = this.tk(LATENCY.regWrite);
    this.onEvent?.({ at, ticks: LATENCY.regWrite, u: "reg-write", reg: r, payload: v.toString() });
  }

  /** Execute one instruction. */
  step(): "ready" | "halted" | "trapped" {
    if (this.status !== "ready") return this.status;
    const ins = this.program.instrs[this.pc];
    if (!ins) throw new Error("unreachable: validated ANMR programs end with RETURN");
    const at = this.tk(LATENCY.fetch);
    this.onEvent?.({ at, ticks: LATENCY.fetch, u: "fetch", rec: ins.rec, op: ins.k === "bin" ? opName(ins.op) : ins.k.toUpperCase(), text: anmrClaim(ins) });
    this.counters.instructions++;
    switch (ins.k) {
      case "const": {
        const t = this.tk(1);
        this.onEvent?.({ at: t, ticks: 1, u: "alu", op: "CONST", result: ins.value.toString() });
        this.writeReg(ins.rd, ins.value);
        break;
      }
      case "bin": {
        // Read all sources before writing the destination.
        const a = this.readReg(ins.ra, ins.rec);
        if (a === null) return this.status;
        const b = this.readReg(ins.rb, ins.rec);
        if (b === null) return this.status;
        const r = evalBinary(ins.op, a, b);
        const value = r.ok ? (r.value as bigint) : 0n;
        const n = aluTicks(ins.op);
        const t = this.tk(n);
        this.onEvent?.({ at: t, ticks: n, u: "alu", op: opName(ins.op), result: value.toString() });
        this.writeReg(ins.rd, value);
        break;
      }
      case "save": {
        const v = this.regs[ins.rs];
        if (v === undefined) return this.fail("ANMR-R-001", `r${ins.rs} is saved before it is written`, ins.rec);
        this.slots[ins.slot] = v;
        this.counters.saves++;
        this.counters.spillBytesWritten += 8;
        const t = this.tk(LATENCY.save);
        this.onEvent?.({ at: t, ticks: LATENCY.save, u: "save", reg: ins.rs, slot: ins.slot, payload: v.toString() });
        break;
      }
      case "restore": {
        const v = this.slots[ins.slot];
        if (v === undefined) return this.fail("ANMR-R-002", `spill slot ${ins.slot} is restored before it is saved`, ins.rec);
        this.regs[ins.rd] = v;
        this.counters.restores++;
        this.counters.spillBytesRead += 8;
        const t = this.tk(LATENCY.restore);
        this.onEvent?.({ at: t, ticks: LATENCY.restore, u: "restore", slot: ins.slot, reg: ins.rd, payload: v.toString() });
        break;
      }
      case "ret": {
        const v = this.readReg(ins.rs, ins.rec);
        if (v === null) return this.status;
        const t = this.tk(LATENCY.return);
        this.onEvent?.({ at: t, ticks: LATENCY.return, u: "return", fn: 0 });
        this.value = v;
        this.status = "halted";
        return this.status;
      }
    }
    this.pc++;
    return this.status;
  }

  result(): AnmrResult {
    return { status: this.status === "ready" ? "trapped" : this.status, value: this.value, trap: this.trap, counters: { ...this.counters } };
  }
}

export function runAnmr(p: AnmrProgram, x: bigint, onEvent?: (e: MicroEvent) => void): AnmrResult {
  const m = new AnmrMachine(p, x, onEvent ?? null);
  while (m.step() === "ready");
  return m.result();
}
