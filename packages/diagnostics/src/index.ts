// Model-facing diagnostics (PRD Section 7.7): the Diagnostic shape, the versioned rule
// catalog, and deterministic report assembly (root cause first, cascades suppressed, bounded).

export const CATALOG_VERSION = "anma-diagnostics/1";

export type ErrorClass =
  // provider / transport
  | "API_ERROR"
  | "REFUSAL"
  | "INCOMPLETE_RESPONSE"
  | "TRANSPORT_INVALID"
  | "CANCELLED"
  // binary
  | "BAD_HEADER"
  | "LENGTH_MISMATCH"
  | "UNKNOWN_OPCODE"
  | "BAD_RECORD_GRAMMAR"
  | "INVALID_ID"
  | "TYPE_MISMATCH"
  | "CAPABILITY_NOT_DECLARED"
  // runtime
  | "DIVIDE_BY_ZERO"
  | "BOUNDS"
  | "INVALID_HANDLE"
  | "INVALID_UTF8"
  | "CAPABILITY_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "FUEL_EXHAUSTED"
  // task
  | "WRONG_RESULT"
  | "WRONG_EFFECTS"
  | "SIGNATURE_MISMATCH"
  | "PRESSURE_STRUCTURE_MISMATCH"
  // annotation / contract
  | "ANNOTATION_INVALID"
  | "ANNOTATION_MISMATCH"
  | "EXAMPLE_FAILED"
  | "CONTRACT_VIOLATED"
  | "CONTRACT_REFUTED"
  | "CONTRACT_UNPROVEN"
  // loop
  | "LOOP_BUDGET_EXHAUSTED"
  | "LOOP_STALLED"
  | "CONTEXT_BUDGET_EXHAUSTED"
  // advisory
  | "ADVISORY";

export interface DiagnosticLocation {
  byteOffset: number | null;
  recordIndex: number | null;
  field: string | null;
  functionId: number | null;
  blockId: number | null;
}

export interface Diagnostic {
  rule: string;
  severity: "error" | "warning";
  category: ErrorClass;
  message: string;
  location: DiagnosticLocation;
  found: string | null;
  expected: string | null;
  derived: string | null;
  context: string | null;
  claim: string | null;
  manualRef: string;
  /** Internal: this diagnostic is a consequence of an earlier root cause and is not reported. */
  cascade?: boolean;
  /** Internal ordering stage: lower stages are reported first. */
  stage?: number;
}

export interface RuleInfo {
  id: string;
  category: ErrorClass;
  severity: "error" | "warning";
  title: string;
  manualRef: string;
}

const r = (id: string, category: ErrorClass, title: string, manualRef: string, severity: "error" | "warning" = "error"): RuleInfo => ({
  id,
  category,
  severity,
  title,
  manualRef,
});

/** The rule catalog. Every rule ID a diagnostic can carry is listed here and in the model manual. */
export const RULES: readonly RuleInfo[] = [
  // Transport
  r("ANMA-T-001", "TRANSPORT_INVALID", "hex contains a character other than 0-9, a-f, A-F, space, tab, CR, LF", "§9"),
  r("ANMA-T-002", "TRANSPORT_INVALID", "odd number of hex digits", "§9"),
  r("ANMA-T-003", "TRANSPORT_INVALID", "hex contains no digits", "§9"),
  r("ANMA-T-004", "TRANSPORT_INVALID", "candidate exceeds the size limit", "§14.1"),
  r("ANMA-T-005", "TRANSPORT_INVALID", "envelope is not valid bounded JSON", "§7.2"),
  r("ANMA-T-006", "TRANSPORT_INVALID", "envelope keys or value types are wrong", "§7.2"),
  r("ANMA-T-007", "TRANSPORT_INVALID", "isa tag is not \"ANMA-1\"", "§7.2"),
  // Header
  r("ANMA-V-HDR-001", "BAD_HEADER", "file is shorter than the 32-byte header", "§10.1"),
  r("ANMA-V-HDR-002", "BAD_HEADER", "magic bytes are not 41 4e 4d 41 (\"ANMA\")", "§10.1"),
  r("ANMA-V-HDR-003", "BAD_HEADER", "version word is not 1", "§10.1"),
  r("ANMA-V-HDR-004", "LENGTH_MISMATCH", "file length does not equal 32 + 16*recordCount + dataBytes", "§10.1"),
  r("ANMA-V-HDR-005", "BAD_HEADER", "unknown feature bits are set", "§10.1"),
  r("ANMA-V-HDR-006", "BAD_HEADER", "reserved header words 6 and 7 must be zero", "§10.1"),
  r("ANMA-V-HDR-007", "RESOURCE_EXHAUSTED", "file or record count exceeds a resource limit", "§14.1"),
  r("ANMA-V-HDR-008", "INVALID_ID", "entry function ID does not name a declared function", "§10.1"),
  r("ANMA-V-HDR-009", "SIGNATURE_MISMATCH", "entry function parameters must be u64 or bool", "§11"),
  // Records / grammar
  r("ANMA-V-REC-001", "UNKNOWN_OPCODE", "unknown opcode", "§10"),
  r("ANMA-V-REC-002", "BAD_RECORD_GRAMMAR", "an unused record field is not zero", "§10.1"),
  r("ANMA-V-REC-003", "BAD_RECORD_GRAMMAR", "expected FUNC at top level", "§10.2"),
  r("ANMA-V-REC-004", "INVALID_ID", "function IDs must be dense in declaration order", "§10.2"),
  r("ANMA-V-REC-005", "BAD_RECORD_GRAMMAR", "expected BLOCK", "§10.2"),
  r("ANMA-V-REC-006", "INVALID_ID", "block IDs must be dense within each function, starting at 0", "§10.2"),
  r("ANMA-V-REC-007", "SIGNATURE_MISMATCH", "block 0 parameter count must equal the function parameter count", "§10.2"),
  r("ANMA-V-REC-008", "BAD_RECORD_GRAMMAR", "a block must begin with exactly its declared PARAM records", "§10.2"),
  r("ANMA-V-REC-009", "BAD_RECORD_GRAMMAR", "PARAM records must appear in parameter-index order", "§10.2"),
  r("ANMA-V-REC-010", "TYPE_MISMATCH", "invalid type tag for a parameter", "§10.2"),
  r("ANMA-V-REC-011", "BAD_RECORD_GRAMMAR", "block has no terminator (JUMP, BR_IF, or RETURN) before the next BLOCK/END_FUNC", "§10.2"),
  r("ANMA-V-REC-012", "BAD_RECORD_GRAMMAR", "record after a terminator must be BLOCK or END_FUNC", "§10.2"),
  r("ANMA-V-REC-013", "BAD_RECORD_GRAMMAR", "file ends inside a function (missing END_FUNC)", "§10.2"),
  r("ANMA-V-REC-014", "BAD_RECORD_GRAMMAR", "BLOCK local value count does not match its parameters plus results", "§10.2"),
  r("ANMA-V-REC-015", "BAD_RECORD_GRAMMAR", "function has no blocks", "§10.2"),
  r("ANMA-V-REC-016", "TYPE_MISMATCH", "invalid function return type tag", "§10.2"),
  r("ANMA-V-REC-017", "BAD_RECORD_GRAMMAR", "declaration record in the wrong place", "§10.2"),
  r("ANMA-V-REC-018", "BAD_RECORD_GRAMMAR", "CONST_BOOL immediate must be 0 or 1", "§10.3"),
  // Argument framing
  r("ANMA-V-ARG-001", "BAD_RECORD_GRAMMAR", "an instruction's declared ARG records are missing", "§10.4"),
  r("ANMA-V-ARG-002", "BAD_RECORD_GRAMMAR", "ARG or EDGE_ARGS appears without an owner instruction", "§10.4"),
  r("ANMA-V-ARG-003", "BAD_RECORD_GRAMMAR", "BR_IF must be followed by EDGE_ARGS for the true edge, then for the false edge", "§10.4"),
  r("ANMA-V-ARG-004", "RESOURCE_EXHAUSTED", "argument count exceeds the parameter limit", "§14.1"),
  // IDs
  r("ANMA-V-ID-001", "INVALID_ID", "destination is not the next dense value ID in this block", "§10.2"),
  r("ANMA-V-ID-002", "INVALID_ID", "source value is not defined earlier in this block", "§10.2"),
  r("ANMA-V-ID-003", "INVALID_ID", "branch target block does not exist in this function", "§10.4"),
  r("ANMA-V-ID-004", "INVALID_ID", "called function does not exist", "§10.4"),
  r("ANMA-V-ID-005", "INVALID_ID", "unknown host import ID", "§13"),
  r("ANMA-V-ID-006", "INVALID_ID", "unit sentinel 0xffffffff used incorrectly", "§10.4"),
  r("ANMA-V-ID-007", "INVALID_ID", "PARAM value IDs must be 0..p-1 in order", "§10.2"),
  // Types
  r("ANMA-V-TYPE-001", "TYPE_MISMATCH", "operand has the wrong type", "§10.3"),
  r("ANMA-V-TYPE-002", "SIGNATURE_MISMATCH", "edge arguments do not match the target block's parameters", "§10.4"),
  r("ANMA-V-TYPE-003", "SIGNATURE_MISMATCH", "call arguments do not match the callee's parameters", "§10.4"),
  r("ANMA-V-TYPE-004", "TYPE_MISMATCH", "returned value does not match the function return type", "§10.4"),
  r("ANMA-V-TYPE-005", "SIGNATURE_MISMATCH", "host call arguments or destination do not match the import signature", "§13"),
  // Capabilities
  r("ANMA-V-CAP-001", "CAPABILITY_NOT_DECLARED", "instruction needs a feature bit the header does not declare", "§10.1"),
  r("ANMA-V-CAP-002", "CAPABILITY_DENIED", "host policy does not grant a declared feature", "§10.1"),
  // Limits
  r("ANMA-V-LIM-001", "RESOURCE_EXHAUSTED", "too many values in one block", "§14.1"),
  r("ANMA-V-LIM-002", "RESOURCE_EXHAUSTED", "too many parameters", "§14.1"),
  r("ANMA-V-LIM-003", "RESOURCE_EXHAUSTED", "too many functions or blocks", "§14.1"),
  r("ANMA-V-LIM-004", "RESOURCE_EXHAUSTED", "validation work limit exceeded", "§14.1"),
  // Warnings
  r("ANMA-W-001", "ADVISORY", "value is defined but never used", "§11", "warning"),
  r("ANMA-W-002", "ADVISORY", "declared feature is never used", "§10.1", "warning"),
  r("ANMA-W-003", "ADVISORY", "block is unreachable from block 0", "§10.4", "warning"),
  // Annotations
  r("ANMA-A-001", "ANNOTATION_INVALID", "annotations exceed a size limit or have the wrong shape", "§15.3"),
  r("ANMA-A-002", "ANNOTATION_INVALID", "annotation refers to a record, function, block, or parameter that does not exist", "§15.3"),
  r("ANMA-A-003", "ANNOTATION_INVALID", "record claim does not parse", "§15.3"),
  r("ANMA-A-004", "ANNOTATION_MISMATCH", "record claim disagrees with the decoded bytes", "§15.3"),
  r("ANMA-A-005", "ANNOTATION_INVALID", "the same record is annotated more than once", "§15.3"),
  r("ANMA-A-006", "ANNOTATION_INVALID", "parameter name is invalid or duplicated", "§15.3"),
  r("ANMA-A-007", "ANNOTATION_INVALID", "contract or invariant does not parse", "§15.4"),
  r("ANMA-A-008", "ANNOTATION_INVALID", "contract or invariant is ill-typed", "§15.4"),
  r("ANMA-A-010", "ANNOTATION_INVALID", "example inputs do not match the entry signature", "§15.4"),
  // Runtime traps
  r("ANMA-R-001", "DIVIDE_BY_ZERO", "division or remainder by zero", "§10.3"),
  r("ANMA-R-002", "BOUNDS", "index, coordinate, colour, key, or data range out of bounds", "§10.5"),
  r("ANMA-R-003", "INVALID_HANDLE", "invalid or stale handle", "§10.5"),
  r("ANMA-R-004", "CAPABILITY_DENIED", "host call denied by capability policy", "§13"),
  r("ANMA-R-005", "RESOURCE_EXHAUSTED", "a modeled resource limit was exhausted", "§12.4"),
  r("ANMA-R-006", "FUEL_EXHAUSTED", "executed-instruction or microstep budget exhausted", "§14.1"),
  r("ANMA-R-007", "INVALID_UTF8", "print_utf8 data is not valid UTF-8", "§13"),
  // Task / contract
  r("ANMA-K-001", "WRONG_RESULT", "returned value differs from the task oracle", "§15.2"),
  r("ANMA-K-002", "WRONG_EFFECTS", "terminal/device effects differ from the task oracle", "§15.2"),
  r("ANMA-K-003", "SIGNATURE_MISMATCH", "entry signature differs from the task signature", "§15.2"),
  r("ANMA-K-004", "PRESSURE_STRUCTURE_MISMATCH", "program does not have the prescribed pressure structure", "§18.2"),
  r("ANMA-K-005", "EXAMPLE_FAILED", "a model-claimed example does not hold", "§15.4"),
  r("ANMA-K-006", "CONTRACT_VIOLATED", "a contract or invariant failed at runtime", "§15.4"),
  r("ANMA-K-007", "CONTRACT_REFUTED", "the verifier found a counterexample to a contract", "§15.5"),
  r("ANMA-K-008", "CONTRACT_UNPROVEN", "the verifier could not decide a contract", "§15.5", "warning"),
  r("ANMA-K-009", "RESOURCE_EXHAUSTED", "a test run stopped on a resource or fuel limit", "§14.1"),
  // Loop
  r("ANMA-L-001", "LOOP_BUDGET_EXHAUSTED", "the generation loop budget is exhausted", "§7.6"),
  r("ANMA-L-002", "LOOP_STALLED", "the loop is repeating the same candidate or the same errors", "§7.6"),
  r("ANMA-L-003", "CONTEXT_BUDGET_EXHAUSTED", "the loop context budget is exhausted", "§7.6"),
];

export const RULE_BY_ID: ReadonlyMap<string, RuleInfo> = new Map(RULES.map((x) => [x.id, x]));

export function ruleInfo(id: string): RuleInfo {
  const info = RULE_BY_ID.get(id);
  if (!info) throw new Error(`unknown diagnostic rule ${id}`);
  return info;
}

export interface DiagnosticInit {
  message: string;
  location?: Partial<DiagnosticLocation>;
  found?: string | null;
  expected?: string | null;
  derived?: string | null;
  claim?: string | null;
  context?: string | null;
  cascade?: boolean;
  stage?: number;
}

export const Stage = {
  TRANSPORT: 0,
  HEADER: 1,
  RECORDS: 2,
  ANNOTATIONS: 3,
  WARNINGS: 4,
  RUNTIME: 5,
  TASK: 6,
} as const;

/** Build a diagnostic from a catalog rule; category, severity, and manualRef come from the catalog. */
export function diag(ruleId: string, init: DiagnosticInit): Diagnostic {
  const info = ruleInfo(ruleId);
  return {
    rule: info.id,
    severity: info.severity,
    category: info.category,
    message: init.message,
    location: {
      byteOffset: init.location?.byteOffset ?? null,
      recordIndex: init.location?.recordIndex ?? null,
      field: init.location?.field ?? null,
      functionId: init.location?.functionId ?? null,
      blockId: init.location?.blockId ?? null,
    },
    found: init.found ?? null,
    expected: init.expected ?? null,
    derived: init.derived ?? null,
    context: init.context ?? null,
    claim: init.claim ?? null,
    manualRef: info.manualRef,
    ...(init.cascade ? { cascade: true } : {}),
    ...(init.stage !== undefined ? { stage: init.stage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Report assembly

export interface ReportOptions {
  maxErrors: number;
  maxBytes: number;
}

export interface AssembledDiagnostics {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Cascade diagnostics hidden because they follow from a reported root cause. */
  suppressed: number;
  /** Independent errors beyond the per-report cap. */
  omitted: number;
}

function sortKey(d: Diagnostic): [number, number, number] {
  return [d.stage ?? Stage.RECORDS, d.location.byteOffset ?? Number.MAX_SAFE_INTEGER, d.location.recordIndex ?? Number.MAX_SAFE_INTEGER];
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < 3; i++) {
    const x = ka[i]!;
    const y = kb[i]!;
    if (x !== y) return x - y;
  }
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

/** Strip internal fields so reports are stable, serializable objects. */
export function publicDiagnostic(d: Diagnostic): Diagnostic {
  const { cascade: _c, stage: _s, ...rest } = d;
  return rest;
}

/**
 * Root cause first, cascades suppressed, capped. Deterministic: the same input list
 * always yields the same output.
 */
export function assemble(all: readonly Diagnostic[], opts: ReportOptions): AssembledDiagnostics {
  const sorted = [...all].sort(compareDiagnostics);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  let suppressed = 0;
  let omitted = 0;
  for (const d of sorted) {
    if (d.cascade) {
      suppressed++;
      continue;
    }
    if (d.severity === "warning") {
      if (warnings.length < opts.maxErrors) warnings.push(publicDiagnostic(d));
      continue;
    }
    if (errors.length < opts.maxErrors) errors.push(publicDiagnostic(d));
    else omitted++;
  }
  return { errors, warnings, suppressed, omitted };
}

/** Render up to `radius` lines either side of `index`, marking the focus line with ">". */
export function renderContext(lines: readonly string[], index: number, radius = 3): string | null {
  if (index < 0 || index >= lines.length) return null;
  const lo = Math.max(0, index - radius);
  const hi = Math.min(lines.length - 1, index + radius);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push((i === index ? "> " : "  ") + lines[i]);
  return out.join("\n");
}

/** Render the rule catalog as the manual's error-reference chapter. */
export function renderRuleCatalog(): string {
  const lines = [`Diagnostic rule catalog (${CATALOG_VERSION})`, ""];
  for (const rule of RULES) {
    lines.push(`${rule.id}  [${rule.category}${rule.severity === "warning" ? ", warning" : ""}]  ${rule.title}  (see ${rule.manualRef})`);
  }
  return lines.join("\n");
}

/** Byte length of a JSON-serialized value (UTF-8). */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
