// Annotation sidecar shape validation (PRD Sections 7.2, 15.3). Bounded; never trusted.

import { DEFAULT_LIMITS, type Limits } from "@llmtobinary/spec";
import { Stage, diag, jsonBytes, type Diagnostic } from "@llmtobinary/diagnostics";
import { parseClaim, type Claim } from "./claims.ts";

export interface RecordAnnotation {
  index: number;
  claimText: string | null;
  claim: Claim | null;
  note: string | null;
}

export interface ContractAnnotation {
  function: number;
  requires: string | null;
  ensures: string | null;
}

export interface InvariantAnnotation {
  function: number;
  block: number;
  expr: string;
}

export interface ExampleAnnotation {
  inputs: string[];
  result: string | null;
  terminal: string | null;
}

export interface ParsedAnnotations {
  summary: string;
  params: { function: number; index: number; name: string }[];
  records: RecordAnnotation[];
  contracts: ContractAnnotation[];
  invariants: InvariantAnnotation[];
  examples: ExampleAnnotation[];
}

export type AnnotationParse = { ok: true; annotations: ParsedAnnotations | null; diagnostics: Diagnostic[] } | { ok: false; annotations: null; diagnostics: Diagnostic[] };

const RESERVED = new Set([
  "result", "true", "false", "add", "sub", "mul", "udiv", "urem", "band", "bor", "bxor", "shl", "shr", "rotl", "rotr",
  "eq", "ne", "lt", "le", "gt", "ge", "not", "and", "or", "implies", "ite",
]);

export const PARAM_NAME_RE = /^[a-z_][a-z0-9_]{0,31}$/;

export function isReservedName(name: string): boolean {
  return RESERVED.has(name) || /^arg[0-9]+$/.test(name) || /^bp[0-9]+$/.test(name) || /^v[0-9]+$/.test(name);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isNat(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate the sidecar's shape and bounds and parse record claims. Reference checks against the
 * actual module (record indices, functions, blocks) happen in crossCheck / contracts.
 */
export function parseAnnotations(raw: unknown, limits: Limits = DEFAULT_LIMITS): AnnotationParse {
  if (raw === null || raw === undefined) return { ok: true, annotations: null, diagnostics: [] };
  const fail = (message: string, found?: string): AnnotationParse => ({
    ok: false,
    annotations: null,
    diagnostics: [diag("ANMA-A-001", { message, found: found ?? null, expected: "the annotations object from the candidate schema (§7.2)", stage: Stage.ANNOTATIONS })],
  });
  if (!isObj(raw)) return fail("annotations must be an object or null.");
  const size = jsonBytes(raw);
  if (size > limits.annotationBytes) return fail("The annotation sidecar is too large.", `${size} bytes; limit ${limits.annotationBytes}`);
  const keys = ["summary", "params", "records", "contracts", "invariants", "examples"];
  const extra = Object.keys(raw).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in raw));
  if (extra.length || missing.length) {
    return fail("annotations has the wrong keys.", [extra.length ? `unexpected ${extra.join(", ")}` : "", missing.length ? `missing ${missing.join(", ")}` : ""].filter(Boolean).join("; "));
  }
  if (typeof raw.summary !== "string") return fail('"summary" must be a string.');
  for (const k of ["params", "records", "contracts", "invariants", "examples"]) if (!Array.isArray(raw[k])) return fail(`"${k}" must be an array.`);

  const diagnostics: Diagnostic[] = [];
  const out: ParsedAnnotations = { summary: raw.summary as string, params: [], records: [], contracts: [], invariants: [], examples: [] };

  const seenNames = new Map<string, true>();
  for (const p of raw.params as unknown[]) {
    if (!isObj(p) || !isNat(p.function) || !isNat(p.index) || typeof p.name !== "string") return fail("each params entry is {function, index, name}.");
    const key = `${p.function}:${p.name}`;
    const slot = `${p.function}#${p.index}`;
    if (!PARAM_NAME_RE.test(p.name) || isReservedName(p.name)) {
      diagnostics.push(diag("ANMA-A-006", { message: `Parameter name ${JSON.stringify(p.name)} is not allowed.`, found: p.name, expected: "a lowercase identifier matching [a-z_][a-z0-9_]{0,31} that is not a reserved word (result, argN, bpN, vN, operator names)", stage: Stage.ANNOTATIONS }));
      continue;
    }
    if (seenNames.has(key) || seenNames.has(slot)) {
      diagnostics.push(diag("ANMA-A-006", { message: `Parameter ${p.index} of fn${p.function} is named more than once, or the name ${JSON.stringify(p.name)} is reused.`, found: p.name, stage: Stage.ANNOTATIONS }));
      continue;
    }
    seenNames.set(key, true);
    seenNames.set(slot, true);
    out.params.push({ function: p.function, index: p.index, name: p.name });
  }

  const seenRecords = new Set<number>();
  for (const r of raw.records as unknown[]) {
    if (!isObj(r) || !isNat(r.index) || !(r.claim === null || typeof r.claim === "string") || !(r.note === null || typeof r.note === "string")) {
      return fail("each records entry is {index, claim, note}; claim and note are strings or null.");
    }
    if (seenRecords.has(r.index)) {
      diagnostics.push(diag("ANMA-A-005", { message: `Record ${r.index} is annotated more than once.`, location: { recordIndex: r.index }, stage: Stage.ANNOTATIONS }));
      continue;
    }
    seenRecords.add(r.index);
    for (const [k, v] of [["claim", r.claim], ["note", r.note]] as const) {
      if (typeof v === "string" && utf8Len(v) > limits.claimBytes) {
        return fail(`A record ${k} is longer than ${limits.claimBytes} bytes.`, `record ${r.index}`);
      }
    }
    let claim: Claim | null = null;
    if (typeof r.claim === "string") {
      const parsed = parseClaim(r.claim);
      if (parsed.ok) claim = parsed.claim;
      else diagnostics.push(diag("ANMA-A-003", { message: `The claim for record ${r.index} does not parse: ${parsed.error}.`, location: { recordIndex: r.index }, found: r.claim, stage: Stage.ANNOTATIONS }));
    }
    out.records.push({ index: r.index, claimText: (r.claim as string | null) ?? null, claim, note: (r.note as string | null) ?? null });
  }
  out.records.sort((a, b) => a.index - b.index);

  for (const c of raw.contracts as unknown[]) {
    if (!isObj(c) || !isNat(c.function) || !(c.requires === null || typeof c.requires === "string") || !(c.ensures === null || typeof c.ensures === "string")) {
      return fail("each contracts entry is {function, requires, ensures}; requires/ensures are strings or null.");
    }
    for (const e of [c.requires, c.ensures]) if (typeof e === "string" && utf8Len(e) > limits.contractExpressionBytes) return fail(`A contract expression is longer than ${limits.contractExpressionBytes} bytes.`);
    out.contracts.push({ function: c.function, requires: (c.requires as string | null) ?? null, ensures: (c.ensures as string | null) ?? null });
  }
  for (const inv of raw.invariants as unknown[]) {
    if (!isObj(inv) || !isNat(inv.function) || !isNat(inv.block) || typeof inv.expr !== "string") return fail("each invariants entry is {function, block, expr}.");
    if (utf8Len(inv.expr) > limits.contractExpressionBytes) return fail(`An invariant is longer than ${limits.contractExpressionBytes} bytes.`);
    out.invariants.push({ function: inv.function, block: inv.block, expr: inv.expr });
  }
  if ((raw.examples as unknown[]).length > limits.examplesPerCandidate) return fail(`At most ${limits.examplesPerCandidate} examples are allowed.`);
  for (const ex of raw.examples as unknown[]) {
    if (!isObj(ex) || !Array.isArray(ex.inputs) || !ex.inputs.every((x) => typeof x === "string") || !(ex.result === null || typeof ex.result === "string") || !(ex.terminal === null || typeof ex.terminal === "string")) {
      return fail("each examples entry is {inputs: string[], result: string|null, terminal: string|null}.");
    }
    out.examples.push({ inputs: ex.inputs as string[], result: (ex.result as string | null) ?? null, terminal: (ex.terminal as string | null) ?? null });
  }
  return { ok: true, annotations: out, diagnostics };
}

/** Canonical JSON (sorted keys) used to hash the sidecar, so the hash is independent of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
