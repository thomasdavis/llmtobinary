// ANMA-2 module format (spec/anma-2.md). A module is an ANMA-1 file with header version 2 and zero
// or more IMPORT declarations after its last function. This package only reads the format: it holds
// no linker, so the model-facing checker can use it without reaching the link tool.

import { Op } from "@llmtobinary/spec";

export const MODULE_VERSION = 2;
export const IMPORT_OP = 0x70;
export const UNIT_SENTINEL = 0xffffffff;

const HEADER = 32;
const RECORD = 16;
const MAGIC = 0x414d4e41; // "ANMA", little-endian

export type TypeCode = 0 | 1 | 2 | 3 | 4;

export interface Signature {
  params: TypeCode[];
  ret: TypeCode;
}

export interface ModuleImport extends Signature {
  id: number;
}

export interface ParsedModule {
  version: number;
  features: number;
  entry: number;
  recordCount: number;
  dataBytes: number;
  /** Records holding defined functions, exactly as written. */
  body: Uint8Array;
  data: Uint8Array;
  functions: Signature[];
  imports: ModuleImport[];
}

export interface ModuleError {
  rule: string;
  message: string;
}

export type ParseResult = { ok: true; module: ParsedModule } | { ok: false; error: ModuleError };

const fail = (rule: string, message: string): ParseResult => ({ ok: false, error: { rule, message } });
const word = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

export const headerVersion = (b: Uint8Array): number | null => (b.length >= HEADER && word(b, 0) === MAGIC ? word(b, 4) : null);

export function parseModule(bytes: Uint8Array): ParseResult {
  if (bytes.length < HEADER || word(bytes, 0) !== MAGIC) return fail("ANMA-M-001", "The file does not start with the ANMA magic bytes.");
  const version = word(bytes, 4);
  if (version !== 1 && version !== MODULE_VERSION) return fail("ANMA-M-002", `Unsupported version ${version}: a module uses header version 2.`);
  const recordCount = word(bytes, 12);
  const dataBytes = word(bytes, 16);
  if (HEADER + RECORD * recordCount + dataBytes !== bytes.length) return fail("ANMA-M-003", `The file length does not equal 32 + 16 * ${recordCount} + ${dataBytes}.`);
  const rec = (i: number) => {
    const at = HEADER + i * RECORD;
    return { op: word(bytes, at), a: word(bytes, at + 4), b: word(bytes, at + 8), c: word(bytes, at + 12) };
  };
  const functions: Signature[] = [];
  let bodyEnd = 0;
  for (let i = 0; i < recordCount; i++) {
    const r = rec(i);
    if (r.op === IMPORT_OP) break;
    bodyEnd = i + 1;
    if (r.op === Op.FUNC) {
      const params: TypeCode[] = [];
      for (let p = 0; p < r.b && i + 2 + p < recordCount; p++) {
        const q = rec(i + 2 + p);
        if (q.op !== Op.PARAM) break;
        params.push(q.b as TypeCode);
      }
      functions.push({ params, ret: r.c as TypeCode });
    }
  }
  const imports: ModuleImport[] = [];
  for (let i = bodyEnd; i < recordCount; ) {
    const r = rec(i);
    if (r.op !== IMPORT_OP) return fail("ANMA-M-004", `Record ${i}: only IMPORT declarations may follow the last function.`);
    if (version !== MODULE_VERSION) return fail("ANMA-M-005", `Record ${i}: IMPORT needs header version 2.`);
    const id = functions.length + imports.length;
    if (r.a !== id) return fail("ANMA-M-006", `Record ${i}: IMPORT declares function ID ${r.a} but the next dense ID is ${id}. Imports take the IDs after your defined functions.`);
    if (r.c > 4) return fail("ANMA-M-007", `Record ${i}: unknown return type ${r.c}.`);
    if (i + 1 + r.b > recordCount) return fail("ANMA-M-008", `Record ${i}: IMPORT declares ${r.b} parameters but the records end first.`);
    const params: TypeCode[] = [];
    for (let p = 0; p < r.b; p++) {
      const q = rec(i + 1 + p);
      if (q.op !== Op.PARAM || q.a !== p || q.c !== p || q.b < 1 || q.b > 4) return fail("ANMA-M-009", `Record ${i + 1 + p}: IMPORT parameter ${p} must be PARAM with value ID ${p}, a value type, and parameter index ${p}.`);
      params.push(q.b as TypeCode);
    }
    imports.push({ id, params, ret: r.c as TypeCode });
    i += 1 + r.b;
  }
  const entry = word(bytes, 20);
  if (entry >= functions.length) return fail("ANMA-M-010", `The entry function ${entry} must be a defined function, not an import.`);
  const dataStart = HEADER + RECORD * recordCount;
  return { ok: true, module: { version, features: word(bytes, 8), entry, recordCount, dataBytes, body: bytes.slice(HEADER, HEADER + RECORD * bodyEnd), data: bytes.slice(dataStart), functions, imports } };
}

const put = (out: number[], ...words: number[]) => {
  for (const w of words) out.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255);
};

/** Records for a stand-in function with the import's signature, so the ordinary validator can run. */
function stubRecords(i: ModuleImport): { words: number[]; records: number } {
  const w: number[] = [];
  const p = i.params.length;
  const body: number[][] = [];
  let src = UNIT_SENTINEL;
  if (i.ret === 1) {
    body.push([Op.CONST_U64, p, 0, 0]);
    src = p;
  } else if (i.ret === 2) {
    body.push([Op.CONST_BOOL, p, 0, 0]);
    src = p;
  } else if (i.ret === 3 || i.ret === 4) {
    body.push([Op.CONST_U64, p, 0, 0], [i.ret === 3 ? Op.ALLOC_U8 : Op.ALLOC_U64, p + 1, p, 0]);
    src = p + 1;
  }
  put(w, Op.FUNC, i.id, p, i.ret);
  put(w, Op.BLOCK, 0, p, p + body.length);
  i.params.forEach((t, k) => put(w, Op.PARAM, k, t, k));
  for (const b of body) put(w, b[0]!, b[1]!, b[2]!, b[3]!);
  put(w, Op.RETURN, i.ret === 0 ? UNIT_SENTINEL : src, 0, 0);
  put(w, Op.END_FUNC, 0, 0, 0);
  return { words: w, records: 3 + p + body.length + 1 };
}

/**
 * The module as a standalone ANMA-1 file, with each import replaced by a stub. Stubs sit after the
 * defined functions, so diagnostics keep the record numbers of the module as written.
 */
export function standalone(m: ParsedModule): Uint8Array {
  const tail: number[] = [];
  let extra = 0;
  for (const i of m.imports) {
    const s = stubRecords(i);
    tail.push(...s.words);
    extra += s.records;
  }
  const recordCount = m.body.length / RECORD + extra;
  const needsHeap = m.imports.some((i) => i.ret === 3 || i.ret === 4);
  const out = new Uint8Array(HEADER + m.body.length + tail.length + m.data.length);
  const head: number[] = [];
  put(head, MAGIC, 1, m.features | (needsHeap ? 1 : 0), recordCount, m.dataBytes, m.entry, 0, 0);
  out.set(head);
  out.set(m.body, HEADER);
  out.set(tail, HEADER + m.body.length);
  out.set(m.data, HEADER + m.body.length + tail.length);
  return out;
}
