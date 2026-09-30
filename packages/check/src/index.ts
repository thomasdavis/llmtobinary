// The static check pipeline behind `check_candidate` (PRD Sections 7.6–7.7, 15.1, 15.3).
// Used unchanged by the Cloudflare Worker (inner loop) and the browser (independent validation).
// It decodes, validates, and cross-checks annotations. It NEVER executes guest code and NEVER
// returns corrected bytes.

import { DEFAULT_LIMITS, IMPORTS, OP_BY_CODE, Op, SPEC_ID, TYPE_NAMES, opName, type Limits, type TypeTag } from "@llmtobinary/spec";
import { listingLines, parseEnvelope, parseHex, toHex, type DecodedFile } from "@llmtobinary/decode";
import { validateBytes, type Module } from "@llmtobinary/validate";
import { CATALOG_VERSION, Stage, assemble, diag, jsonBytes, renderContext, type Diagnostic } from "@llmtobinary/diagnostics";
import { canonicalJson, checkContracts, crossCheckClaims, parseAnnotations, type ParsedAnnotations } from "@llmtobinary/annotations";
import type { AnnotationSummary, CheckReport } from "@llmtobinary/protocol";
import { validateAnmr, type AnmrProgram } from "@llmtobinary/anmr";

export interface CheckInput {
  /** JSON text of a check/submit call (or a response.json fixture). */
  envelopeText?: string;
  /** Already-parsed envelope object. */
  envelope?: unknown;
  /** Bare hex (raw-hex profile). */
  hex?: string;
  /** Bare bytes (imports, fixtures). */
  bytes?: Uint8Array;
}

export interface CheckOptions {
  limits?: Partial<Limits>;
  /** Host policy (features granted). */
  allowedFeatures?: number;
  /** Size cap for transported candidates (defaults to the live-generation cap). */
  maxCandidateBytes?: number;
  /**
   * What the task's tests will require (known to the generation loop). Lets the static check catch
   * a wrong entry signature, or a program that can never produce the output the tests compare,
   * before a submission is spent. Still static: nothing is executed.
   */
  task?: TaskRequirements;
}

export interface TaskRequirements {
  params: readonly ("u64" | "bool")[];
  returns: "unit" | "u64" | "bool";
  /** Output the task's tests compare with the oracle. */
  effects: readonly ("terminal" | "framebuffer" | "frames")[];
}

const typeWord = (t: TypeTag): string => TYPE_NAMES[t];

/** Static task-level checks on a valid module (signature and the presence of required output). */
export function checkTaskRequirements(module: Module, task: TaskRequirements): Diagnostic[] {
  const out: Diagnostic[] = [];
  const entry = module.functions[module.entry]!;
  const got = `(${entry.params.map(typeWord).join(", ")}) -> ${typeWord(entry.ret)}`;
  const want = `(${task.params.join(", ")}) -> ${task.returns}`;
  if (got !== want) out.push(diag("ANMA-K-003", { message: `The entry function has signature ${got} but the task requires ${want}.`, found: got, expected: want, stage: Stage.TASK }));
  const used = new Set<string>();
  for (const r of module.records) if (r.op === Op.HOST) used.add(IMPORTS[r.b]?.name ?? "");
  const calls = [...used].filter(Boolean).sort();
  const callsText = calls.length ? calls.join(", ") : "no host imports";
  const draws = used.has("display.clear") || used.has("display.pixel");
  if ((task.effects.includes("framebuffer") || task.effects.includes("frames") || draws) && !used.has("display.present")) {
    out.push(diag("ANMA-K-002", {
      message: draws
        ? "This executable draws but never calls display.present, so nothing it draws is ever shown: the visitor sees an empty screen. Present each finished frame with display.present."
        : "The task's tests compare what the program draws, but this executable never calls display.present, so no frame is ever shown and the final framebuffer stays blank (every pixel 0x00000000).",
      found: `calls: ${callsText}; declared features 0x${module.features.toString(16)}`,
      expected: "drawing with display.* imports and a display.present call for each frame (the FRAMEBUFFER feature, 0x4, must be declared)",
      stage: Stage.TASK,
    }));
  }
  if (task.effects.includes("terminal") && ![...used].some((n) => n.startsWith("terminal."))) {
    out.push(diag("ANMA-K-002", {
      message: "The task's tests compare terminal output, but this executable never calls a terminal.* import, so it prints nothing.",
      found: `calls: ${callsText}; declared features 0x${module.features.toString(16)}`,
      expected: "terminal output via terminal.print_u64 or terminal.print_utf8 (the TERMINAL feature, 0x2, must be declared)",
      stage: Stage.TASK,
    }));
  }
  return out;
}

export interface CheckOutcome {
  report: CheckReport;
  /** Exact candidate bytes (private copy) when transport parsing succeeded. */
  bytes: Uint8Array | null;
  /** Validated module when the candidate is valid. */
  module: Module | null;
  annotations: ParsedAnnotations | null;
  /** Raw annotations object as supplied (for hashing/export). */
  annotationsRaw: unknown;
}

export const CHECKER_ID = `llmtobinary-check/1 (${SPEC_ID}, ${CATALOG_VERSION})`;

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

const EMPTY_ANN: AnnotationSummary = { present: false, records: 0, claimsChecked: 0, claimsMatched: 0, contracts: 0, invariants: 0, examples: 0, sha256: null };

function baseReport(): CheckReport {
  return {
    ok: false,
    byteLength: null,
    sha256: null,
    errors: [],
    warnings: [],
    suppressed: 0,
    omitted: 0,
    listing: null,
    listingTruncated: false,
    annotations: { ...EMPTY_ANN },
    catalogVersion: CATALOG_VERSION,
  };
}

function annotatedListing(bytes: Uint8Array, file: DecodedFile, claims: Map<number, string>, notes: Map<number, string>): string[] {
  const base = listingLines(bytes, file.records);
  return base.map((line, i) => {
    const c = claims.get(i);
    const n = notes.get(i);
    let s = line;
    if (c !== undefined) s += `   ; claim: ${c}`;
    if (n !== undefined) s += `   ; note: ${n.replace(/\s+/g, " ").slice(0, 120)}`;
    return s;
  });
}

export async function checkCandidate(input: CheckInput, opts: CheckOptions = {}): Promise<CheckOutcome> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const report = baseReport();
  const maxCandidate = opts.maxCandidateBytes ?? limits.liveCandidateBytes;
  const finish = (all: Diagnostic[]) => {
    const a = assemble(all, { maxErrors: limits.diagnosticReportedErrors, maxBytes: limits.diagnosticReportBytes });
    report.errors = a.errors;
    report.warnings = a.warnings;
    report.suppressed = a.suppressed;
    report.omitted = a.omitted;
  };

  // 1. transport
  let hex: string | null = input.hex ?? null;
  let annotationsRaw: unknown = null;
  if (input.envelopeText !== undefined || input.envelope !== undefined) {
    const env = parseEnvelope(input.envelopeText ?? input.envelope, limits.modelResponseTextBytes);
    if (!env.ok) {
      finish(env.diagnostics);
      return { report, bytes: null, module: null, annotations: null, annotationsRaw: null };
    }
    hex = env.envelope.hex;
    annotationsRaw = env.envelope.annotations;
  }
  let bytes: Uint8Array;
  if (input.bytes) {
    if (input.bytes.length > maxCandidate) {
      const h = parseHex("00".repeat(maxCandidate + 1), maxCandidate); // produces the canonical T-004 diagnostic
      finish(h.ok ? [] : h.diagnostics);
      return { report, bytes: null, module: null, annotations: null, annotationsRaw };
    }
    bytes = input.bytes.slice();
  } else {
    const h = parseHex(hex ?? "", maxCandidate);
    if (!h.ok) {
      finish(h.diagnostics);
      return { report, bytes: null, module: null, annotations: null, annotationsRaw };
    }
    bytes = h.bytes;
  }
  report.byteLength = bytes.length;
  report.sha256 = await sha256Hex(bytes);

  // 2. decode + validate
  const v = validateBytes(bytes, { limits, ...(opts.allowedFeatures !== undefined ? { allowedFeatures: opts.allowedFeatures } : {}) });
  const all: Diagnostic[] = [...v.diagnostics];

  // 3. annotations (T1 + static contract checks)
  const ap = parseAnnotations(annotationsRaw, limits);
  all.push(...ap.diagnostics);
  const ann = ap.annotations;
  let claims = new Map<number, string>();
  let notes = new Map<number, string>();
  if (ann) {
    report.annotations = {
      present: true,
      records: ann.records.length,
      claimsChecked: 0,
      claimsMatched: 0,
      contracts: ann.contracts.length,
      invariants: ann.invariants.length,
      examples: ann.examples.length,
      sha256: await sha256Hex(canonicalJson(annotationsRaw)),
    };
    if (v.decoded) {
      const recordErrors = v.diagnostics.filter((d) => d.severity === "error" && d.location.recordIndex !== null && d.stage !== 1);
      const structuralFrom = recordErrors.length ? Math.min(...recordErrors.map((d) => d.location.recordIndex!)) : null;
      const headerMisaligned = v.diagnostics.some((d) => d.rule === "ANMA-V-HDR-004");
      const cc = crossCheckClaims(ann, v.decoded, structuralFrom, headerMisaligned);
      all.push(...cc.diagnostics);
      report.annotations.claimsChecked = cc.checked;
      report.annotations.claimsMatched = cc.matched;
      claims = cc.claimByRecord;
      notes = cc.noteByRecord;
    }
    if (v.module) all.push(...checkContracts(ann, v.module));
  }
  if (v.module && opts.task) all.push(...checkTaskRequirements(v.module, opts.task));

  // 3b. Misaligned files (stray bytes: the record area is not a multiple of 16) decode as garbage
  // after the misalignment, so only the length error and the first record-level error are root
  // causes; later record-level errors are cascades.
  if (v.decoded) {
    const h = v.decoded.header;
    const recordArea = bytes.length - 32 - (h.dataBytes <= bytes.length - 32 ? h.dataBytes : 0);
    if (bytes.length >= 32 && recordArea % 16 !== 0) {
      let kept = 0;
      for (const d of all.sort((a, b) => (a.location.recordIndex ?? -1) - (b.location.recordIndex ?? -1))) {
        if (d.severity !== "error" || d.location.recordIndex === null || d.stage === 1) continue;
        if (kept++ >= 1) d.cascade = true;
      }
    }
  }

  // 3c. A record written a word short (or long) shifts every later record, and the checker then
  // reports a cascade at the symptoms. Locate the break by finding where the byte stream re-aligns;
  // the hint names the record and the size of the slip, never replacement bytes.
  if (v.decoded) {
    const recErrors = all.filter((d) => d.severity === "error" && d.location.recordIndex !== null && d.stage !== 1);
    if (recErrors.length) {
      const first = Math.min(...recErrors.map((d) => d.location.recordIndex!));
      const h = v.decoded.header;
      const hint = misalignmentHint(bytes, h.dataBytes <= bytes.length - 32 ? h.dataBytes : 0, first);
      if (hint) {
        const target = recErrors.find((d) => d.location.recordIndex === first) ?? recErrors[0]!;
        target.derived = target.derived ? `${hint} ${target.derived}` : hint;
        const len = all.find((d) => d.rule === "ANMA-V-HDR-004");
        if (len) len.derived = len.derived ? `${len.derived} ${hint}` : hint;
      }
    }
  }

  // 4. attach the model's own claim to structural diagnostics at that record
  for (const d of all) {
    if (d.claim === null && d.location.recordIndex !== null && claims.has(d.location.recordIndex)) d.claim = claims.get(d.location.recordIndex)!;
  }

  // 5. listing + contexts
  let lines: string[] = [];
  if (v.decoded) {
    lines = annotatedListing(bytes, v.decoded, claims, notes);
    for (const d of all) {
      const ri = d.location.recordIndex;
      if (ri === null || d.context !== null) continue;
      const idx = ri >= lines.length ? lines.length - 1 : ri;
      d.context = renderContext(lines, idx, 3);
    }
  }
  finish(all);
  report.ok = v.ok && report.errors.length === 0;

  // 6. bound the report
  report.listing = lines.length ? lines.join("\n") : null;
  let size = jsonBytes(report);
  if (size > limits.diagnosticReportBytes && lines.length) {
    let keep = lines.length;
    while (keep > 0 && size > limits.diagnosticReportBytes) {
      keep = Math.floor(keep * 0.8);
      report.listing = [...lines.slice(0, keep), `… ${lines.length - keep} more records not shown`].join("\n");
      report.listingTruncated = true;
      size = jsonBytes(report);
    }
  }
  for (let i = report.errors.length - 1; i >= 1 && size > limits.diagnosticReportBytes; i--) {
    report.errors[i]!.context = null;
    size = jsonBytes(report);
  }
  if (size > limits.diagnosticReportBytes) {
    report.warnings = [];
    size = jsonBytes(report);
  }

  return { report, bytes, module: report.ok ? v.module : null, annotations: ann, annotationsRaw };
}

/** Render a report as compact text for the model's function_call_output (JSON is also acceptable). */
export function reportForModel(report: CheckReport): string {
  return JSON.stringify(report);
}

// ---------------------------------------------------------------------------
// ANMR-1 matched control (research, Section 18.5): the same static check for the register ISA.


export async function checkAnmrCandidate(input: { envelopeText?: string; hex?: string }, opts: { maxCandidateBytes?: number } = {}): Promise<{ report: CheckReport; program: AnmrProgram | null; bytes: Uint8Array | null }> {
  const report = baseReport();
  const finish = (all: Diagnostic[]) => {
    const a = assemble(all, { maxErrors: DEFAULT_LIMITS.diagnosticReportedErrors, maxBytes: DEFAULT_LIMITS.diagnosticReportBytes });
    Object.assign(report, { errors: a.errors, warnings: a.warnings, suppressed: a.suppressed, omitted: a.omitted });
  };
  let hex = input.hex ?? "";
  if (input.envelopeText !== undefined) {
    const env = parseEnvelope(input.envelopeText, DEFAULT_LIMITS.modelResponseTextBytes, "ANMR-1");
    if (!env.ok) {
      finish(env.diagnostics);
      return { report, program: null, bytes: null };
    }
    hex = env.envelope.hex;
  }
  const h = parseHex(hex, opts.maxCandidateBytes ?? DEFAULT_LIMITS.liveCandidateBytes);
  if (!h.ok) {
    finish(h.diagnostics);
    return { report, program: null, bytes: null };
  }
  report.byteLength = h.bytes.length;
  report.sha256 = await sha256Hex(h.bytes);
  const v = validateAnmr(h.bytes);
  finish(v.diagnostics);
  report.ok = v.ok;
  return { report, program: v.ok ? v.program : null, bytes: h.bytes };
}

/** Is there a well-formed record at byte offset `off`: a known opcode whose zero fields are zero? */
function plausibleRecord(dv: DataView, off: number, end: number): boolean {
  if (off < 32 || off + 16 > end) return false;
  const info = OP_BY_CODE.get(dv.getUint32(off, true));
  if (!info) return false;
  for (let i = 0; i < 3; i++) if (info.fields[i] === "zero" && dv.getUint32(off + 4 + 4 * i, true) !== 0) return false;
  return true;
}

/**
 * Find the record whose length slip best explains a decoding cascade: for records just before the
 * first error, test whether the following bytes decode as well-formed records if that record were
 * 4, 8 or 12 bytes short or long. Returns a plain-language hint, or null when nothing stands out.
 */
export function misalignmentHint(bytes: Uint8Array, dataBytes: number, firstError: number): string | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - dataBytes;
  const WINDOW = 32;
  const score = (start: number) => {
    let n = 0;
    let total = 0;
    for (let off = start; off + 16 <= end && total < WINDOW; off += 16, total++) if (plausibleRecord(dv, off, end)) n++;
    return { n, total };
  };
  let best: { r: number; k: number; n: number; total: number; base: number } | null = null;
  for (let r = Math.max(0, firstError - 3); r <= firstError; r++) {
    const next = 32 + 16 * (r + 1);
    const base = score(next).n;
    for (const k of [-12, -8, -4, 4, 8, 12]) {
      const s = score(next + k);
      if (s.total < 4 || s.n / s.total < 0.9 || s.n < base + 4) continue;
      // Several readings can realign identically (record r+1 one word short == record r three words
      // long); prefer the most records explained, then the smallest slip, then the flagged record.
      const better = !best || s.n > best.n || (s.n === best.n && (Math.abs(k) < Math.abs(best.k) || (Math.abs(k) === Math.abs(best.k) && Math.abs(r - firstError) < Math.abs(best.r - firstError))));
      if (better) best = { r, k, n: s.n, total: s.total, base };
    }
  }
  if (!best) return null;
  const { r, k, n, total, base } = best;
  const off = 32 + 16 * r;
  const at = off + 16 + k;
  const words = Math.abs(k) / 4;
  if (k < 0) {
    const stray = dv.getUint32(off + 16 + k, true);
    return `Record ${r} (byte ${off}) looks ${-k} bytes short: its last ${words === 1 ? "word is" : `${words} words are`} missing. The next record really starts at byte ${at}, where 0x${stray.toString(16)} is the opcode ${opName(stray)}. Read that way, ${n} of the next ${total} records are well-formed, against ${base} with the current layout. Every later record is shifted by ${-k} bytes until the slip is fixed.`;
  }
  return `Record ${r} (byte ${off}) looks ${k} bytes too long: ${words === 1 ? "an extra word follows" : `${words} extra words follow`} it. The next record really starts at byte ${at}. Read that way, ${n} of the next ${total} records are well-formed, against ${base} with the current layout.`;
}
