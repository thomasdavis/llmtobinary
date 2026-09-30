// ANMR-1 interpreter (research only; never imported by the Cloudflare Worker).
import { HEADER_BYTES, RECORD_BYTES, U64_MASK, evalBinary } from "@llmtobinary/spec";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import type { AnmrProgram } from "@llmtobinary/anmr";

export * from "@llmtobinary/anmr";

export interface AnmrResult {
  status: "halted" | "trapped";
  value: bigint | null;
  trap: Diagnostic | null;
  counters: { instructions: number; saves: number; restores: number; spillBytesWritten: number; spillBytesRead: number };
}

export function runAnmr(p: AnmrProgram, x: bigint): AnmrResult {
  const regs: (bigint | undefined)[] = new Array(p.R).fill(undefined);
  const slots: (bigint | undefined)[] = new Array(p.S).fill(undefined);
  regs[0] = x & U64_MASK;
  const counters = { instructions: 0, saves: 0, restores: 0, spillBytesWritten: 0, spillBytesRead: 0 };
  const trap = (rule: string, message: string, rec: number): AnmrResult => ({
    status: "trapped",
    value: null,
    trap: diag(rule, { message, location: { recordIndex: rec, byteOffset: HEADER_BYTES + RECORD_BYTES * rec }, stage: Stage.RUNTIME }),
    counters,
  });
  for (const ins of p.instrs) {
    counters.instructions++;
    switch (ins.k) {
      case "const":
        regs[ins.rd] = ins.value;
        break;
      case "bin": {
        const a = regs[ins.ra];
        const b = regs[ins.rb];
        if (a === undefined) return trap("ANMR-R-001", `r${ins.ra} is read before it is written`, ins.rec);
        if (b === undefined) return trap("ANMR-R-001", `r${ins.rb} is read before it is written`, ins.rec);
        // Read all sources before overwriting the destination.
        const r = evalBinary(ins.op, a, b);
        regs[ins.rd] = r.ok ? (r.value as bigint) : 0n;
        break;
      }
      case "save": {
        const v = regs[ins.rs];
        if (v === undefined) return trap("ANMR-R-001", `r${ins.rs} is saved before it is written`, ins.rec);
        slots[ins.slot] = v;
        counters.saves++;
        counters.spillBytesWritten += 8;
        break;
      }
      case "restore": {
        const v = slots[ins.slot];
        if (v === undefined) return trap("ANMR-R-002", `spill slot ${ins.slot} is restored before it is saved`, ins.rec);
        regs[ins.rd] = v;
        counters.restores++;
        counters.spillBytesRead += 8;
        break;
      }
      case "ret": {
        const v = regs[ins.rs];
        if (v === undefined) return trap("ANMR-R-001", `r${ins.rs} is returned before it is written`, ins.rec);
        return { status: "halted", value: v, trap: null, counters };
      }
    }
  }
  throw new Error("unreachable: validated ANMR programs end with RETURN");
}

