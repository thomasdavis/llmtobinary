// Declared synthetic cost model for the chip view (PRD Section 12.4: "An optional synthetic cost
// model is versioned and labelled 'modeled ticks'"). These are NOT measured cycles and make no
// claim about any physical implementation; they only let the two modeled machines be compared on
// one clock. The same table prices the ANMA-1 finite machine and the ANMR-1 register control.

import { Op } from "@llmtobinary/spec";

export const COST_MODEL_ID = "anma-cost/1";

export const LATENCY = {
  /** Instruction memory read + decode. */
  fetch: 2,
  /** Fast-slot read into a latch (ANMA) — the register-file read equivalent. */
  hit: 1,
  /** Backing SRAM read into a latch. */
  miss: 4,
  /** Installing a loaded value into a fast slot. */
  install: 1,
  /** Writing an evicted live value to backing SRAM. */
  evict: 4,
  /** Writing the result latch into a fast slot (ANMA) — the register write equivalent. */
  publish: 1,
  /** Freeing a slot or backing entry. */
  reclaim: 0,
  /** One argument into the staging buffer. */
  stage: 1,
  branch: 1,
  call: 2,
  return: 2,
  heapAlloc: 2,
  heapAccess: 4,
  /** Host device call; full-buffer device work is added per modeled work unit. */
  host: 4,
  // ANMR-1 register control
  regRead: 1,
  regWrite: 1,
  /** SAVE register -> spill memory (same memory class as backing SRAM). */
  save: 4,
  /** RESTORE spill memory -> register. */
  restore: 4,
} as const;

/** ALU latency by opcode: one tick for add/logic/compare/shift, three for multiply, twenty for divide. */
export function aluTicks(op: number): number {
  if (op === Op.MUL_U64) return 3;
  if (op === Op.UDIV_U64 || op === Op.UREM_U64) return 20;
  return 1;
}

export const LATENCY_TABLE: { unit: string; ticks: string }[] = [
  { unit: "fetch + decode", ticks: `${LATENCY.fetch}` },
  { unit: "fast slot / register read", ticks: `${LATENCY.hit}` },
  { unit: "fast slot / register write", ticks: `${LATENCY.publish}` },
  { unit: "backing / spill read", ticks: `${LATENCY.miss}` },
  { unit: "backing / spill write", ticks: `${LATENCY.evict}` },
  { unit: "ALU add, logic, compare, shift", ticks: "1" },
  { unit: "ALU multiply", ticks: "3" },
  { unit: "ALU divide / remainder", ticks: "20" },
  { unit: "argument staging (per value)", ticks: `${LATENCY.stage}` },
  { unit: "branch / call / return", ticks: `${LATENCY.branch} / ${LATENCY.call} / ${LATENCY.return}` },
  { unit: "heap alloc / access", ticks: `${LATENCY.heapAlloc} / ${LATENCY.heapAccess}` },
  { unit: "host device call", ticks: `${LATENCY.host} + device work` },
];
