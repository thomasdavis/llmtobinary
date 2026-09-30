// Shared, logic-free contracts between packages, the browser, the machine Web Worker, and the
// Cloudflare Worker broker. Changing a type here is a protocol change: bump PROTOCOL_VERSION.

import type { Diagnostic, ErrorClass } from "@llmtobinary/diagnostics";

export const PROTOCOL_VERSION = "llmtobinary-protocol/1";

// ---------------------------------------------------------------------------
// Guest values at API boundaries (u64 is always a canonical decimal string)

export type GuestValue =
  | { t: "u64"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "handle"; elem: "u8" | "u64"; id: number }
  | { t: "unit" };

export type EntryInput = { t: "u64"; v: string } | { t: "bool"; v: boolean };

// ---------------------------------------------------------------------------
// Execution

export type RunStatus = "empty" | "validating" | "ready" | "running" | "paused" | "waiting-input" | "halted" | "trapped" | "cancelled";

export type TrapCode = Extract<
  ErrorClass,
  "DIVIDE_BY_ZERO" | "BOUNDS" | "INVALID_HANDLE" | "INVALID_UTF8" | "CAPABILITY_DENIED" | "RESOURCE_EXHAUSTED" | "FUEL_EXHAUSTED"
>;

export interface Trap {
  code: TrapCode;
  rule: string;
  message: string;
  recordIndex: number | null;
  byteOffset: number | null;
  functionId: number | null;
  blockId: number | null;
  /** Which resource ran out, for RESOURCE_EXHAUSTED / FUEL_EXHAUSTED. */
  resource?: string;
}

/** A virtual tick event (Section 13): strictly increasing tick number plus the complete key mask. */
export interface TickEvent {
  tick: string; // u64 decimal
  keys: number; // bit i = KEYS[i] held
}

/** One ordered host-call effect, for cross-run and cross-capacity comparison. */
export interface Effect {
  seq: number;
  importId: number;
  args: string[];
  result: string | null;
}

export interface MachineCounters {
  executedInstructions: number;
  decodedRecords: number;
  microsteps: number;
  operandReads: number;
  operandHits: number;
  operandMisses: number;
  backingReads: number;
  backingWrites: number;
  backingBytesRead: number;
  backingBytesWritten: number;
  evictions: number;
  reclaimed: number;
  peakLiveValues: number;
  peakFastOccupied: number;
  peakBackingEntries: number;
  peakStagingBytes: number;
  peakMetadataBytes: number;
  peakFrames: number;
  heapBytes: number;
  heapAllocations: number;
  hostCalls: number;
  hostWallTimeMs: number;
  /** Synthetic modeled ticks from the declared cost model (anma-cost/1). Not measured cycles. */
  modeledTicks: number;
}

export interface MachineConfig {
  /** F: fast-value slots. Default 16; comparison set 1/4/8/16/32/64. */
  fastSlots: number;
  /** Replacement policy identifier; the only v1 policy is "fifo-v1". */
  policy: "fifo-v1";
  /** Record detailed trace events into a bounded ring. */
  trace: boolean;
}

export interface RunResult {
  /** "fast": the WebAssembly translation (architecturally identical; storage not simulated). */
  engine: "reference" | "finite" | "fast";
  status: "halted" | "trapped" | "cancelled";
  returnValue: GuestValue | null;
  /** Exact terminal bytes (UTF-8/ASCII as written by the guest). */
  terminal: Uint8Array;
  /** Up to the first 2000 effects, verbatim (effectsHash covers all of them). */
  effects: Effect[];
  effectCount: number;
  effectsTruncated: boolean;
  effectsHash: string;
  framebufferHash: string | null;
  /** Final authoritative framebuffer (256x144 RGBA) when the program declares the framebuffer feature. */
  finalFramebuffer?: Uint8Array | null;
  framesPresented: number;
  trap: Trap | null;
  counters: Partial<MachineCounters>;
  config: MachineConfig | null;
  traceTruncated: boolean;
}

// ---------------------------------------------------------------------------
// check_candidate / browser validation report (Section 7.7)

export interface AnnotationSummary {
  present: boolean;
  records: number;
  claimsChecked: number;
  claimsMatched: number;
  contracts: number;
  invariants: number;
  examples: number;
  sha256: string | null;
}

export interface CheckReport {
  ok: boolean;
  byteLength: number | null;
  sha256: string | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  suppressed: number;
  omitted: number;
  /** Bounded annotated disassembly of every decodable record. */
  listing: string | null;
  listingTruncated: boolean;
  annotations: AnnotationSummary;
  catalogVersion: string;
}

// ---------------------------------------------------------------------------
// Generation sessions and the agentic loop (Sections 7.6, 8)

export type OutputMode = "tools" | "raw-hex";

export type StopOutcome =
  | "passed"
  | "passed-unverified"
  | "budget-exhausted"
  | "stalled"
  | "refused"
  | "cancelled"
  | "infrastructure-error";

export interface LoopBudget {
  maxOutputTokensPerTurn: number;
  maxOutputTokensPerSession: number;
  maxTurns: number;
  maxChecks: number;
  maxSubmissions: number;
  maxWallClockMs: number;
  stallRepeatK: number;
}

export interface LoopCounters {
  turns: number;
  checks: number;
  submissions: number;
  outputTokens: number;
  inputTokens: number;
  unknownUsageTurns: number;
  startedAt: number;
}

export interface TaskRequest {
  /** Curated task ID from the registry, or null for an open-ended visitor task. */
  taskId: string | null;
  /** Visitor-described program (open tasks) or null to use the curated description. */
  description: string | null;
  /** Entry signature the program must have, e.g. ["u64"] -> "u64". */
  params: ("u64" | "bool")[];
  returns: "unit" | "u64" | "bool";
  /** Feature bits the visitor permits. */
  allowedFeatures: number;
  requireClaims: boolean;
  /** Research only: generate for the matched register-control ISA (Section 18.5). Default ANMA-1. */
  isa?: "ANMA-1" | "ANMR-1";
  /** ANMR-1 architectural register count R (4..32). */
  registers?: number;
}

export interface CreateSessionRequest {
  task: TaskRequest;
  mode: OutputMode;
  profile: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  token: string;
  budget: LoopBudget;
  expiresAt: number;
}

/** Bounded browser test feedback posted as the next outer-loop iteration. Untrusted steering data. */
export interface BrowserFeedback {
  candidateSha256: string;
  validation: CheckReport;
  tests: TestReport | null;
}

export interface AttemptRequest {
  idempotencyKey: string;
  feedback: BrowserFeedback | null;
}

export interface TestCaseResult {
  name: string;
  kind: "visible" | "holdout" | "example" | "contract" | "witness";
  passed: boolean;
  inputs: string[];
  expected: string | null;
  actual: string | null;
  diagnostic: Diagnostic | null;
}

export interface TestReport {
  taskId: string | null;
  passed: boolean;
  cases: TestCaseResult[];
  diagnostics: Diagnostic[];
  /** Highest verification tier reached (Section 15.5). */
  tier: "T0" | "T1" | "T2" | "T3";
  contractOwner: "model" | "task" | null;
}

export interface Candidate {
  attemptId: string;
  kind: "check" | "submit";
  seq: number;
  /** The exact function-call argument text (or raw text in raw-hex mode). */
  rawText: string;
  sha256: string | null;
  byteLength: number | null;
}

interface EventBase {
  sessionId: string;
  attemptId: string;
  seq: number;
  at: number;
}

export type LoopEvent =
  | (EventBase & { type: "attempt.started"; iteration: number })
  | (EventBase & { type: "turn.started"; turn: number })
  | (EventBase & { type: "model.text.delta"; delta: string })
  | (EventBase & { type: "model.tool_args.delta"; tool: "check_candidate" | "submit_candidate"; delta: string })
  | (EventBase & { type: "check.requested"; candidate: Candidate })
  | (EventBase & { type: "check.result"; candidateSeq: number; report: CheckReport })
  | (EventBase & { type: "candidate.submitted"; candidate: Candidate; envelopeText: string })
  | (EventBase & { type: "loop.budget"; counters: LoopCounters; budget: LoopBudget })
  | (EventBase & { type: "loop.elided"; elidedChecks: number; elidedDrafts?: number })
  | (EventBase & { type: "attempt.completed"; providerStatus: string; responseIds: string[] })
  | (EventBase & { type: "attempt.refused"; message: string })
  | (EventBase & { type: "attempt.incomplete"; reason: string })
  | (EventBase & { type: "attempt.error"; code: string; message: string; retryable: boolean })
  | (EventBase & { type: "attempt.cancelled" })
  | (EventBase & { type: "loop.stopped"; outcome: StopOutcome; detail: string })
  | (EventBase & { type: "heartbeat" });

export interface ConfigResponse {
  protocol: string;
  specId: string;
  specSha256: string;
  catalogVersion: string;
  buildCommit: string;
  deploymentId: string | null;
  environment: string;
  liveGeneration: boolean;
  profiles: { id: string; label: string; model: string; reasoningEffort: string | null; openTaskReasoningEffort?: string | null }[];
  allowedFeatures: number;
  budget: LoopBudget;
  recoveryTtlSeconds: number;
}

export interface SessionSummary {
  sessionId: string;
  status: "active" | "stopped";
  outcome: StopOutcome | null;
  counters: LoopCounters;
  budget: LoopBudget;
  events: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Engine contract (implemented by @llmtobinary/reference and @llmtobinary/runtime)

/** In-engine value: u64 as bigint, bool as boolean, handles as opaque run-local tokens. */
export type RuntimeValue = bigint | boolean | { readonly handle: number; readonly elem: "u8" | "u64" };

/**
 * Observation hooks used by T2 contract monitoring (reference engine only; the finite machine
 * never runs contract checks so its modeled counters stay unperturbed). Hooks must not mutate
 * engine state. `entryArgs` are the arguments of the current function activation.
 */
export interface EngineHooks {
  onCall?(fn: number, args: readonly RuntimeValue[], depth: number): void;
  onBlockEnter?(fn: number, block: number, params: readonly RuntimeValue[], entryArgs: readonly RuntimeValue[]): void;
  onReturn?(fn: number, entryArgs: readonly RuntimeValue[], result: RuntimeValue | null): void;
}

export interface EngineOptions {
  /** Override public limits (Section 14.1); each limit is enforced independently. */
  limits?: Partial<import("@llmtobinary/spec").Limits>;
  /** Host policy: granted features; HOST calls outside it trap CAPABILITY_DENIED. */
  allowedFeatures?: number;
  /** Pre-recorded tick events for deterministic replay (Section 13). */
  ticks?: TickEvent[];
  hooks?: EngineHooks;
  /** Chip-view instrumentation: receives every microstep. Never alters counters or results. */
  onEvent?: (e: MicroEvent) => void;
}

export interface Engine {
  readonly status: RunStatus;
  /** Execute up to `maxInstructions` guest instructions, stopping early on halt/trap/wait. */
  run(maxInstructions: number): RunStatus;
  /** Execute exactly one guest instruction (or terminator). */
  step(): RunStatus;
  /** Queue a tick event (browser input). Consumed only by input.wait_tick. */
  pushTick(event: TickEvent): void;
  cancel(): void;
  /** Final (or current, for inspection) result. */
  result(): RunResult;
  /** Current guest position, for inspectors. */
  position(): { functionId: number; blockId: number; recordIndex: number; depth: number } | null;
}

export interface SlotView {
  index: number;
  /** Logical value identity "f<fnAct>.b<blockAct>.v<id>" or null when empty. */
  value: string | null;
  payload: string | null; // decimal / bool / handle token
  type: string | null;
  insertedAt: number | null; // FIFO order stamp
  remainingUses: number | null;
}

export interface MachineSnapshot {
  status: RunStatus;
  position: { functionId: number; blockId: number; recordIndex: number; depth: number } | null;
  config: MachineConfig;
  slots: SlotView[];
  latches: { A: string | null; B: string | null; R: string | null };
  backing: { used: number; capacity: number; sample: { entry: number; value: string; payload: string }[]; highWater: number; occupied: number[] };
  staging: { usedBytes: number; capacityBytes: number };
  frames: { functionId: number; blockId: number; blockActivation: number; liveValues: number }[];
  liveValues: number;
  counters: MachineCounters;
  /** Microsteps of the last executed guest instruction (bounded). */
  lastMicrosteps: string[];
  trace: { seq: number; text: string }[];
  traceTruncated: boolean;
  /** Which engine produced the snapshot; "fast" does not simulate storage (slots, backing). */
  engine?: "exact" | "fast";
}

// ---------------------------------------------------------------------------
// Micro-events and the modeled-tick cost model (chip view; PRD Sections 5.1, 12.4)

/** Functional units of the modeled microarchitecture. */
export type ChipUnit =
  | "imem"
  | "fetch"
  | "decode"
  | "directory"
  | "slots"
  | "latches"
  | "alu"
  | "backing"
  | "staging"
  | "stack"
  | "heap"
  | "io"
  | "regfile" // ANMR-1 register file
  | "spill"; // ANMR-1 spill memory

/**
 * One microstep, exactly as the machine performed it. `at` is the modeled tick at which it starts
 * and `ticks` its declared latency from the versioned cost model; neither is a measured cycle.
 */
export type MicroEvent = { at: number; ticks: number } & (
  | { u: "fetch"; rec: number; op: string; text: string }
  | { u: "hit"; slot: number; latch: "A" | "B" | "R"; value: string; payload: string }
  | { u: "miss"; entry: number; latch: "A" | "B" | "R"; value: string; payload: string }
  | { u: "install"; slot: number; value: string }
  | { u: "evict"; slot: number; entry: number; value: string }
  | { u: "alu"; op: string; result: string }
  | { u: "publish"; slot: number; value: string; payload: string }
  | { u: "reclaim"; slot: number | null; entry: number | null; value: string }
  | { u: "stage"; payload: string }
  | { u: "heap"; kind: "alloc" | "load" | "store"; /** heap size and live allocations after the op */ bytes: number; allocations: number }
  | { u: "host"; name: string }
  | { u: "branch"; target: number; taken: boolean | null }
  | { u: "call"; fn: number }
  | { u: "return"; fn: number }
  // ANMR-1 register machine
  | { u: "reg-read"; reg: number; payload: string }
  | { u: "reg-write"; reg: number; payload: string }
  | { u: "save"; reg: number; slot: number; payload: string }
  | { u: "restore"; slot: number; reg: number; payload: string }
);

export type MicroEventKind = MicroEvent["u"];
