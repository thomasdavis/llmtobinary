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
  engine: "reference" | "finite";
  status: "halted" | "trapped" | "cancelled";
  returnValue: GuestValue | null;
  /** Exact terminal bytes (UTF-8/ASCII as written by the guest). */
  terminal: Uint8Array;
  effects: Effect[];
  effectsHash: string;
  framebufferHash: string | null;
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
  | (EventBase & { type: "loop.elided"; elidedChecks: number })
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
  profiles: { id: string; label: string; model: string; reasoningEffort: string | null }[];
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
