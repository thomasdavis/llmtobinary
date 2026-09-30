// Which functional units each microstep exercises. Shared by the worker (heat totals) and the UI
// (lighting), so a glow on the die and a count in heat mode always mean the same event.

import type { ChipUnit, MicroEvent } from "@llmtobinary/protocol";

export function unitsOf(e: MicroEvent): ChipUnit[] {
  switch (e.u) {
    case "fetch": return ["imem", "fetch", "decode"];
    case "hit": return ["directory", "slots", "latches"];
    case "miss": return ["directory", "backing", "latches"];
    case "install": return ["slots"];
    case "evict": return ["slots", "backing"];
    case "alu": return ["latches", "alu"];
    case "publish": return ["latches", "directory", "slots"];
    case "reclaim": return e.entry !== null ? ["directory", "backing"] : ["directory", "slots"];
    case "stage": return ["latches", "staging"];
    case "heap": return ["latches", "heap"];
    case "host": return ["staging", "io"];
    case "branch": return ["decode", "fetch"];
    case "call":
    case "return": return ["stack", "staging"];
    case "reg-read": return ["regfile", "alu"];
    case "reg-write": return ["alu", "regfile"];
    case "save": return ["regfile", "spill"];
    case "restore": return ["spill", "regfile"];
  }
}

/** Backing/spill traffic: the cost the argument is about (drawn in the second, cool signal). */
export function isSpillTraffic(e: MicroEvent): boolean {
  return e.u === "miss" || e.u === "evict" || e.u === "save" || e.u === "restore";
}

/** One-line, exact description of a microstep for the rail, the analyzer tooltip, and the trace export. */
export function describe(e: MicroEvent): string {
  const t = `${e.ticks} tick${e.ticks === 1 ? "" : "s"}`;
  switch (e.u) {
    case "fetch": return `fetch + decode record ${e.rec}: ${e.text} (${t})`;
    case "hit": return `directory hit: ${e.value} = ${e.payload} from fast slot s${e.slot} into latch ${e.latch} (${t})`;
    case "miss": return `directory miss: ${e.value} = ${e.payload} read from backing[${e.entry}] into latch ${e.latch} (${t})`;
    case "install": return `install ${e.value} into fast slot s${e.slot} (${t})`;
    case "evict": return `evict ${e.value} from s${e.slot} to backing[${e.entry}] (${t})`;
    case "alu": return `ALU ${e.op} = ${e.result} (${t})`;
    case "publish": return `publish R = ${e.payload} as ${e.value} in fast slot s${e.slot} (${t})`;
    case "reclaim": return `reclaim ${e.value}${e.slot !== null ? ` from s${e.slot}` : e.entry !== null ? ` from backing[${e.entry}]` : ""} (no remaining uses)`;
    case "stage": return `stage argument ${e.payload} (${t})`;
    case "heap": return `heap ${e.kind}: ${e.allocations} allocation${e.allocations === 1 ? "" : "s"}, ${e.bytes} bytes (${t})`;
    case "host": return `host call ${e.name} over the I/O bus (${t})`;
    case "branch": return e.taken === null ? `jump to block${e.target} (${t})` : `branch ${e.taken ? "taken" : "not taken"} to block${e.target} (${t})`;
    case "call": return `call fn${e.fn}: push frame (${t})`;
    case "return": return `return from fn${e.fn}: pop frame (${t})`;
    case "reg-read": return `read r${e.reg} = ${e.payload} (${t})`;
    case "reg-write": return `write r${e.reg} = ${e.payload} (${t})`;
    case "save": return `SAVE r${e.reg} = ${e.payload} to spill slot ${e.slot} — written by the model (${t})`;
    case "restore": return `RESTORE spill slot ${e.slot} = ${e.payload} into r${e.reg} — written by the model (${t})`;
  }
}
