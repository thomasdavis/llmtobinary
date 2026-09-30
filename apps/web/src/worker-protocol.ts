// Messages between the page and the machine Web Worker (the browser worker that executes guest
// bytes; not the Cloudflare Worker). Every run message carries a runId so late events from an old
// run can never update a newer one. Bytes are always transferred as COPIES.

import type { ChipUnit, EntryInput, MachineConfig, MachineSnapshot, MicroEvent, RunResult, TestReport, TickEvent } from "@llmtobinary/protocol";

export type ToMachine =
  | { type: "load"; runId: number; bytes: ArrayBuffer; inputs: EntryInput[]; config: MachineConfig; allowedFeatures: number; ticks: TickEvent[] }
  | { type: "run"; runId: number }
  | { type: "pause"; runId: number }
  | { type: "step"; runId: number }
  | { type: "stop"; runId: number }
  | { type: "tick"; runId: number; event: TickEvent }
  | { type: "test"; jobId: number; bytes: ArrayBuffer; taskId: string | null; annotations: unknown; claims: { checked: number; matched: number } | null; allowedFeatures: number }
  | { type: "compare"; jobId: number; bytes: ArrayBuffer; inputs: EntryInput[]; Fs: number[]; ticks: TickEvent[]; allowedFeatures: number };

export interface CompareRow {
  F: number;
  status: string;
  trap: string | null;
  returnValue: string;
  terminalSha256: string;
  effectsHash: string;
  framebufferHash: string | null;
  backingReads: number;
  backingWrites: number;
  operandMisses: number;
  evictions: number;
  microsteps: number;
  executedInstructions: number;
  peakLiveValues: number;
}

export type FromMachine =
  | { type: "loaded"; runId: number }
  | { type: "load-error"; runId: number; message: string }
  | { type: "state"; runId: number; snapshot: MachineSnapshot; terminal: string; frame: Uint8ClampedArray | null; framesPresented: number }
  | { type: "done"; runId: number; result: RunResult; snapshot: MachineSnapshot; terminal: string; frame: Uint8ClampedArray | null }
  | { type: "test-result"; jobId: number; report: TestReport; modelReport: TestReport; witness: unknown }
  | { type: "compare-result"; jobId: number; rows: CompareRow[]; reference: { returnValue: string; terminalSha256: string; effectsHash: string; framebufferHash: string | null; status: string }; semanticAgreement: boolean; missingBackingActivity: number[]; resourceLimited: number[] }
  | { type: "job-error"; jobId: number; message: string };

// ---------------------------------------------------------------------------
// Chip view (a separate worker instance; one or two chip sessions)


export type ChipIsa = "ANMA-1" | "ANMR-1";

export interface ChipCell {
  /** Short identity: "v3" (ANMA slot) or "r3" (ANMR register). */
  label: string | null;
  /** Full identity for tooltips, e.g. "f0.b0.v3". */
  value: string | null;
  payload: string | null;
}

export interface ChipState {
  isa: ChipIsa;
  status: string;
  rec: number | null;
  cells: ChipCell[];
  /** Occupied backing (ANMA) or initialized spill slots (ANMR), bounded. */
  memOccupied: number[];
  memCapacity: number;
  latches: { A: string | null; B: string | null; R: string | null };
  frames: number;
  liveValues: number;
  counters: Record<string, number>;
  terminal: string;
  result: string | null;
  trap: string | null;
}

export interface ChipStep {
  /** Instruction ordinal (0 = entry prologue: arguments installed before the first instruction). */
  n: number;
  rec: number | null;
  text: string;
  events: MicroEvent[];
}

export type ToChip =
  | { type: "chip-load"; chipId: number; isa: ChipIsa; bytes: ArrayBuffer; inputs: EntryInput[]; fastSlots: number; allowedFeatures: number; ticks: TickEvent[] }
  | { type: "chip-step"; chipId: number; instructions: number }
  | { type: "chip-run"; chipId: number; maxInstructions: number; maxMs: number };

export type FromChip =
  | { type: "chip-loaded"; chipId: number; state: ChipState; prologue: ChipStep }
  | { type: "chip-steps"; chipId: number; steps: ChipStep[]; state: ChipState }
  | { type: "chip-heat"; chipId: number; activity: Partial<Record<ChipUnit, number>>; spill: number; instructions: number; state: ChipState }
  | { type: "chip-error"; chipId: number; message: string };
