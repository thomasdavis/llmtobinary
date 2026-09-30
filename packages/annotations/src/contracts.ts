// ANMA-Spec contract language (PRD Section 15.4): parse, typecheck, and evaluate requires/ensures/
// invariants. STUB — replaced by the full implementation (parser, typechecker, evaluator) in
// Milestone E. The signature below is the contract used by @llmtobinary/check.

import type { Module } from "@llmtobinary/validate";
import type { Diagnostic } from "@llmtobinary/diagnostics";
import type { ParsedAnnotations } from "./schema.ts";

/** Static contract checks against a valid module: parse + typecheck every contract, invariant, param name, and example. */
export function checkContracts(_ann: ParsedAnnotations, _module: Module): Diagnostic[] {
  return [];
}
