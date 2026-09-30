// Machine-invariance track (PRD Section 18.1): run one immutable artifact across fast-slot
// capacities with identical inputs/events and compare semantic outputs; storage counters are
// reported separately and are expected to vary.

import type { Module } from "@llmtobinary/validate";
import { runFinite } from "@llmtobinary/runtime";
import { runToCompletion } from "@llmtobinary/reference";
import { sha256HexSync, formatGuestValue } from "@llmtobinary/devices";
import type { EntryInput, MachineCounters, RunResult, TickEvent } from "@llmtobinary/protocol";
import type { Limits } from "@llmtobinary/spec";

export const INVARIANCE_FS = [1, 4, 8, 16, 32, 64] as const;

export interface InvarianceRow {
  F: number;
  status: RunResult["status"];
  trap: string | null;
  returnValue: string;
  terminalSha256: string;
  effectsHash: string;
  framebufferHash: string | null;
  counters: Partial<MachineCounters>;
}

export interface InvarianceReport {
  rows: InvarianceRow[];
  reference: Omit<InvarianceRow, "F" | "counters">;
  /** All completed runs agree with each other and with the reference interpreter. */
  semanticAgreement: boolean;
  /** Runs that stopped on a resource limit (not counted as wrong answers). */
  resourceLimited: number[];
  /** Capacities below the peak live values that nonetheless showed no backing traffic (must be empty). */
  missingBackingActivity: number[];
}

function row(F: number, r: RunResult): InvarianceRow {
  return {
    F,
    status: r.status,
    trap: r.trap ? r.trap.code : null,
    returnValue: formatGuestValue(r.returnValue),
    terminalSha256: sha256HexSync(r.terminal),
    effectsHash: r.effectsHash,
    framebufferHash: r.framebufferHash,
    counters: r.counters,
  };
}

export function runInvariance(module: Module, inputs: readonly EntryInput[], opts: { Fs?: readonly number[]; ticks?: TickEvent[]; limits?: Partial<Limits> } = {}): InvarianceReport {
  const common = { ...(opts.ticks ? { ticks: opts.ticks } : {}), ...(opts.limits ? { limits: opts.limits } : {}) };
  const ref = runToCompletion(module, inputs, common);
  const { F: _f, counters: _c, ...reference } = row(0, ref);
  const rows = (opts.Fs ?? INVARIANCE_FS).map((F) => row(F, runFinite(module, inputs, { ...common, config: { fastSlots: F } })));
  const resourceLimited = rows.filter((r) => r.trap === "RESOURCE_EXHAUSTED" || r.trap === "FUEL_EXHAUSTED").map((r) => r.F);
  const completed = rows.filter((r) => !resourceLimited.includes(r.F));
  const semanticAgreement = completed.every(
    (r) => r.status === reference.status && r.returnValue === reference.returnValue && r.terminalSha256 === reference.terminalSha256 && r.effectsHash === reference.effectsHash && r.framebufferHash === reference.framebufferHash && r.trap === reference.trap,
  );
  const missingBackingActivity = completed
    .filter((r) => (r.counters.peakLiveValues ?? 0) > r.F && (r.counters.backingWrites ?? 0) === 0)
    .map((r) => r.F);
  return { rows, reference, semanticAgreement, resourceLimited, missingBackingActivity };
}
