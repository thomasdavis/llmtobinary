// T3 driver: discharge generated VCs with a pluggable SMT backend and label the outcome honestly
// (PRD Section 15.5): proved | refuted (with a counterexample when the VC starts at entry) |
// unknown/timeout (never "proved") | not eligible. Partial correctness only.

import type { Module } from "@llmtobinary/validate";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import type { ParsedAnnotations, ParseLimits } from "@llmtobinary/annotations";
import { VCGEN_ID, generateVcs, type Eligibility, type Obligation } from "./vcgen.ts";

export interface SolverBackend {
  /** Identifier including solver name and version. */
  readonly id: string;
  /**
   * Run one SMT-LIB script (it ends with check-sat). On "sat", return the values of `getValues`
   * as SMT-LIB literals.
   */
  check(script: string, timeoutMs: number, getValues: readonly string[]): Promise<{ status: "sat" | "unsat" | "unknown"; values?: Record<string, string> }>;
}

export interface VcOutcome {
  id: string;
  kind: Obligation["kind"];
  description: string;
  recordIndex: number;
  status: "proved" | "refuted" | "unknown";
  /** Counterexample inputs (decimal) when the VC starts at function entry. */
  counterexample: string[] | null;
  /** False when a refutation comes from a cut-point VC (an invariant that is not inductive). */
  concrete: boolean;
  ms: number;
}

export interface VerificationReport {
  prover: string;
  vcgen: string;
  functionId: number;
  contractOwner: "task" | "model";
  eligibility: Eligibility;
  overall: "proved" | "refuted" | "unknown" | "not-eligible";
  outcomes: VcOutcome[];
  diagnostics: Diagnostic[];
  /** Human label for the UI (Section 15.5 wording). */
  label: string;
}

/** Parse an SMT-LIB bitvector/bool literal to a decimal string. */
export function smtLiteralToDecimal(lit: string): string {
  const t = lit.trim();
  if (t === "true" || t === "false") return t;
  let m = /^#x([0-9a-fA-F]+)$/.exec(t);
  if (m) return BigInt(`0x${m[1]}`).toString(10);
  m = /^#b([01]+)$/.exec(t);
  if (m) return BigInt(`0b${m[1]}`).toString(10);
  m = /^\(_ bv(\d+) \d+\)$/.exec(t);
  if (m) return m[1]!;
  throw new Error(`unrecognized SMT-LIB literal ${t}`);
}

export async function verifyFunction(
  module: Module,
  ann: ParsedAnnotations,
  fnId: number,
  backend: SolverBackend,
  opts: { timeoutMs?: number; contractOwner: "task" | "model"; parseLimits?: ParseLimits },
): Promise<VerificationReport> {
  const set = generateVcs(module, ann, fnId, opts.parseLimits ? { parseLimits: opts.parseLimits } : {});
  const base = { prover: backend.id, vcgen: VCGEN_ID, functionId: fnId, contractOwner: opts.contractOwner, eligibility: set.eligibility };
  if (!set.eligibility.eligible) {
    return { ...base, overall: "not-eligible", outcomes: [], diagnostics: [], label: `T3 not attempted: ${set.eligibility.reason}` };
  }
  const outcomes: VcOutcome[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const ob of set.obligations) {
    const t0 = Date.now();
    let r: Awaited<ReturnType<SolverBackend["check"]>>;
    try {
      r = await backend.check(ob.smt, opts.timeoutMs ?? 10_000, ob.inputs);
    } catch {
      r = { status: "unknown" };
    }
    const ms = Date.now() - t0;
    if (r.status === "unsat") {
      outcomes.push({ id: ob.id, kind: ob.kind, description: ob.description, recordIndex: ob.recordIndex, status: "proved", counterexample: null, concrete: false, ms });
      continue;
    }
    if (r.status === "sat") {
      const cex = ob.fromEntry && r.values ? ob.inputs.map((n) => smtLiteralToDecimal(r.values![n] ?? "#x0")) : null;
      outcomes.push({ id: ob.id, kind: ob.kind, description: ob.description, recordIndex: ob.recordIndex, status: "refuted", counterexample: cex, concrete: ob.fromEntry, ms });
      diagnostics.push(
        diag("ANMA-K-007", {
          message: ob.fromEntry ? `The verifier found inputs for which ${ob.description} fails.` : `The verifier could not show that ${ob.description}: the invariant is not inductive (the counterexample state may be unreachable).`,
          location: { functionId: fnId, recordIndex: ob.recordIndex, byteOffset: 32 + 16 * ob.recordIndex },
          found: cex ? `counterexample inputs: ${cex.join(", ")}` : "a state satisfying the assumptions but not the obligation",
          expected: ob.description,
          stage: Stage.TASK,
        }),
      );
      continue;
    }
    outcomes.push({ id: ob.id, kind: ob.kind, description: ob.description, recordIndex: ob.recordIndex, status: "unknown", counterexample: null, concrete: false, ms });
    diagnostics.push(diag("ANMA-K-008", { message: `The verifier could not decide whether ${ob.description} (timeout or unknown).`, location: { functionId: fnId, recordIndex: ob.recordIndex }, stage: Stage.TASK }));
  }
  const overall = outcomes.some((o) => o.status === "refuted") ? "refuted" : outcomes.some((o) => o.status === "unknown") ? "unknown" : "proved";
  const label =
    overall === "proved"
      ? opts.contractOwner === "task"
        ? "proved to meet the task specification for all inputs (partial correctness)"
        : "proved against the model's stated contract (partial correctness)"
      : overall === "refuted"
        ? "refuted: the verifier found a counterexample"
        : "unproven: the verifier timed out or returned unknown";
  return { ...base, overall, outcomes, diagnostics, label };
}
