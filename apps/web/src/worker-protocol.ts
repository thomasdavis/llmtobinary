// Messages between the page and the machine Web Worker (the browser worker that executes guest
// bytes; not the Cloudflare Worker). Every run message carries a runId so late events from an old
// run can never update a newer one. Bytes are always transferred as COPIES.

import type { EntryInput, MachineConfig, MachineSnapshot, RunResult, TestReport, TickEvent } from "@llmtobinary/protocol";

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
