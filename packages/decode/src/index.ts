// Bounded transport parsing, header/record decoding, and disassembly (PRD Sections 9, 10.1).
// Nothing here repairs bytes: strict results gate execution; lenient results exist only
// to write diagnostics and listings.

import {
  DEFAULT_LIMITS,
  HEADER_BYTES,
  IMPORTS,
  ISA_TAG,
  KNOWN_FEATURES,
  MAGIC,
  OP_BY_CODE,
  Op,
  RECORD_BYTES,
  TYPE_CLAIM_NAMES,
  UNIT_SENTINEL,
  VERSION,
  constFromWords,
  isTypeTag,
  opName,
  type FieldRole,
  type Limits,
} from "@llmtobinary/spec";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";

// ---------------------------------------------------------------------------
// Hex transport

export type HexResult = { ok: true; bytes: Uint8Array } | { ok: false; diagnostics: Diagnostic[] };

function describeChar(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f) return `control character U+${code.toString(16).padStart(4, "0")}`;
  return `"${ch}" (U+${code.toString(16).padStart(4, "0")})`;
}

/**
 * Strict literal-hex parse: ASCII hex digits plus space/tab/CR/LF only; even, nonzero digit count.
 * No 0x prefixes, prose stripping, padding, or any other repair.
 */
export function parseHex(text: string, maxBytes: number = DEFAULT_LIMITS.liveCandidateBytes): HexResult {
  const out: Diagnostic[] = [];
  let digits = 0;
  let firstBad = -1;
  let badCount = 0;
  let sawPrefix = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isHex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (isHex) {
      digits++;
      continue;
    }
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) continue;
    badCount++;
    if (firstBad < 0) firstBad = i;
    if ((c === 0x78 || c === 0x58) && i > 0 && text[i - 1] === "0") sawPrefix = true;
  }
  if (firstBad >= 0) {
    const ch = String.fromCodePoint(text.codePointAt(firstBad)!);
    const start = Math.max(0, firstBad - 8);
    out.push(
      diag("ANMA-T-001", {
        message: `The hex string contains ${badCount} character${badCount === 1 ? "" : "s"} that are not hex digits or whitespace.`,
        location: { field: "hex.char", byteOffset: null },
        found: `first invalid character ${describeChar(ch)} at string index ${firstBad}, near ${JSON.stringify(text.slice(start, firstBad + 8))}`,
        expected: "only 0-9, a-f, A-F, space, tab, CR, and LF",
        derived: sawPrefix ? "The text contains \"0x\" prefixes; literal hex has no prefixes." : null,
        stage: Stage.TRANSPORT,
      }),
    );
    return { ok: false, diagnostics: out };
  }
  if (digits === 0) {
    out.push(diag("ANMA-T-003", { message: "The hex string is empty.", stage: Stage.TRANSPORT, expected: "a complete ANMA-1 file as hex digits" }));
    return { ok: false, diagnostics: out };
  }
  if (digits % 2 !== 0) {
    out.push(
      diag("ANMA-T-002", {
        message: "The hex string has an odd number of digits, so it cannot be split into bytes.",
        found: `${digits} hex digits`,
        expected: "an even number of hex digits (two per byte)",
        derived: `${(digits - 1) / 2} whole bytes plus one dangling digit`,
        stage: Stage.TRANSPORT,
      }),
    );
    return { ok: false, diagnostics: out };
  }
  const n = digits / 2;
  if (n > maxBytes) {
    out.push(
      diag("ANMA-T-004", {
        message: "The candidate is larger than the permitted binary size.",
        found: `${n} bytes`,
        expected: `at most ${maxBytes} bytes`,
        stage: Stage.TRANSPORT,
      }),
    );
    return { ok: false, diagnostics: out };
  }
  const bytes = new Uint8Array(n);
  let k = 0;
  let hi = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let v: number;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 70) v = c - 55;
    else if (c >= 97 && c <= 102) v = c - 87;
    else continue;
    if (hi < 0) hi = v;
    else {
      bytes[k++] = (hi << 4) | v;
      hi = -1;
    }
  }
  return { ok: true, bytes };
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexDump(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(Array.from(bytes.subarray(i, i + perLine), (b) => b.toString(16).padStart(2, "0")).join(" "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Candidate envelope

export interface Envelope {
  isa: typeof ISA_TAG;
  hex: string;
  /** Raw annotation object (validated by @llmtobinary/annotations), or null. */
  annotations: unknown;
}

export type EnvelopeResult = { ok: true; envelope: Envelope } | { ok: false; diagnostics: Diagnostic[] };

/** Bounded, exact-key envelope parse. Accepts the JSON text of a submit/check call or the parsed object. */
export function parseEnvelope(input: string | unknown, maxTextBytes: number = DEFAULT_LIMITS.modelResponseTextBytes): EnvelopeResult {
  let value: unknown = input;
  if (typeof input === "string") {
    const size = new TextEncoder().encode(input).length;
    if (size > maxTextBytes) {
      return {
        ok: false,
        diagnostics: [
          diag("ANMA-T-005", { message: "The envelope text is too large.", found: `${size} bytes`, expected: `at most ${maxTextBytes} bytes`, stage: Stage.TRANSPORT }),
        ],
      };
    }
    try {
      value = JSON.parse(input);
    } catch (e) {
      return {
        ok: false,
        diagnostics: [diag("ANMA-T-005", { message: "The envelope is not valid JSON.", found: String((e as Error).message).slice(0, 200), stage: Stage.TRANSPORT })],
      };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, diagnostics: [diag("ANMA-T-006", { message: "The envelope must be a JSON object.", expected: '{"isa":"ANMA-1","hex":"…","annotations":null}', stage: Stage.TRANSPORT })] };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(["isa", "hex", "annotations"]);
  const extra = Object.keys(obj).filter((k) => !allowed.has(k));
  const problems: string[] = [];
  if (extra.length) problems.push(`unexpected key${extra.length > 1 ? "s" : ""} ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  if (!("isa" in obj)) problems.push('missing "isa"');
  if (!("hex" in obj)) problems.push('missing "hex"');
  else if (typeof obj.hex !== "string") problems.push('"hex" must be a string');
  if ("annotations" in obj && obj.annotations !== null && (typeof obj.annotations !== "object" || Array.isArray(obj.annotations))) {
    problems.push('"annotations" must be an object or null');
  }
  if (problems.length) {
    return {
      ok: false,
      diagnostics: [diag("ANMA-T-006", { message: "The envelope has the wrong keys or value types.", found: problems.join("; "), expected: 'exactly the keys "isa", "hex", and "annotations"', stage: Stage.TRANSPORT })],
    };
  }
  if (obj.isa !== ISA_TAG) {
    return { ok: false, diagnostics: [diag("ANMA-T-007", { message: 'The "isa" tag must be "ANMA-1".', found: JSON.stringify(obj.isa), expected: '"ANMA-1"', stage: Stage.TRANSPORT })] };
  }
  return { ok: true, envelope: { isa: ISA_TAG, hex: obj.hex as string, annotations: obj.annotations ?? null } };
}

// ---------------------------------------------------------------------------
// Header and records

export interface Header {
  magic: number[];
  version: number;
  features: number;
  recordCount: number;
  dataBytes: number;
  entry: number;
  reserved6: number;
  reserved7: number;
}

export interface RawRecord {
  index: number;
  offset: number;
  op: number;
  a: number;
  b: number;
  c: number;
}

export interface DecodedFile {
  byteLength: number;
  header: Header;
  records: RawRecord[];
  data: Uint8Array;
}

export interface DecodeResult {
  /** True when the header and length are exactly consistent (records may still be invalid). */
  ok: boolean;
  /** Header-level diagnostics (errors block execution). */
  diagnostics: Diagnostic[];
  /**
   * Decoded view. When `ok` is false this is a lenient best-effort view for diagnostics only;
   * it is null when not even the header is present.
   */
  file: DecodedFile | null;
}

function word(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

export function decodeFile(bytes: Uint8Array, limits: Pick<Limits, "importedExecutableBytes"> = DEFAULT_LIMITS): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  const len = bytes.length;
  if (len > limits.importedExecutableBytes) {
    diagnostics.push(
      diag("ANMA-V-HDR-007", {
        message: "The file is larger than the permitted executable size.",
        found: `${len} bytes`,
        expected: `at most ${limits.importedExecutableBytes} bytes`,
        stage: Stage.HEADER,
      }),
    );
    return { ok: false, diagnostics, file: null };
  }
  if (len < HEADER_BYTES) {
    diagnostics.push(
      diag("ANMA-V-HDR-001", {
        message: "The file is shorter than the 32-byte header.",
        location: { byteOffset: 0, field: "header" },
        found: `${len} bytes`,
        expected: "a 32-byte header of eight little-endian u32 words, then 16-byte records, then read-only data",
        stage: Stage.HEADER,
      }),
    );
    return { ok: false, diagnostics, file: null };
  }
  const header: Header = {
    magic: Array.from(bytes.subarray(0, 4)),
    version: word(bytes, 4),
    features: word(bytes, 8),
    recordCount: word(bytes, 12),
    dataBytes: word(bytes, 16),
    entry: word(bytes, 20),
    reserved6: word(bytes, 24),
    reserved7: word(bytes, 28),
  };
  let ok = true;
  if (!MAGIC.every((m, i) => header.magic[i] === m)) {
    ok = false;
    diagnostics.push(
      diag("ANMA-V-HDR-002", {
        message: "The file does not start with the ANMA magic bytes.",
        location: { byteOffset: 0, field: "header.word0" },
        found: header.magic.map((b) => b.toString(16).padStart(2, "0")).join(" "),
        expected: "41 4e 4d 41",
        stage: Stage.HEADER,
      }),
    );
  }
  if (header.version !== VERSION) {
    ok = false;
    diagnostics.push(
      diag("ANMA-V-HDR-003", {
        message: "The version word must be 1.",
        location: { byteOffset: 4, field: "header.word1" },
        found: `${header.version}`,
        expected: "01 00 00 00 (version 1, little-endian)",
        derived: header.version === 0x01000000 ? "The bytes look big-endian; every word is little-endian." : null,
        stage: Stage.HEADER,
      }),
    );
  }
  if ((header.features & ~KNOWN_FEATURES) !== 0) {
    ok = false;
    diagnostics.push(
      diag("ANMA-V-HDR-005", {
        message: "The header sets feature bits that ANMA-1 does not define.",
        location: { byteOffset: 8, field: "header.word2" },
        found: `0x${header.features.toString(16)}`,
        expected: "only bits 0 (heap), 1 (terminal), 2 (framebuffer), 3 (input), i.e. a subset of 0xf",
        stage: Stage.HEADER,
      }),
    );
  }
  if (header.reserved6 !== 0 || header.reserved7 !== 0) {
    ok = false;
    diagnostics.push(
      diag("ANMA-V-HDR-006", {
        message: "Reserved header words 6 and 7 must both be zero.",
        location: { byteOffset: header.reserved6 !== 0 ? 24 : 28, field: header.reserved6 !== 0 ? "header.word6" : "header.word7" },
        found: `word6=${header.reserved6}, word7=${header.reserved7}`,
        expected: "0 and 0",
        stage: Stage.HEADER,
      }),
    );
  }

  const expectedLen = HEADER_BYTES + RECORD_BYTES * header.recordCount + header.dataBytes;
  let recordBytes: number;
  let dataStart: number;
  if (expectedLen !== len) {
    ok = false;
    const body = len - HEADER_BYTES;
    const dataFits = header.dataBytes <= body;
    const recordArea = dataFits ? body - header.dataBytes : body;
    const complete = Math.floor(recordArea / RECORD_BYTES);
    const rem = recordArea % RECORD_BYTES;
    let derived = `${plural(header.recordCount, "record")}${header.dataBytes ? ` and ${header.dataBytes} data bytes` : ""} need ${expectedLen} bytes. `;
    if (rem === 0) {
      derived += `${len} = 32 + 16*${complete}${dataFits && header.dataBytes ? ` + ${header.dataBytes}` : ""}, so the file holds ${plural(complete, "complete record")}`;
      if (complete < header.recordCount) {
        const miss = header.recordCount - complete;
        derived += `: either ${miss === 1 ? "one record is" : `${miss} records are`} missing or the header count is wrong.`;
      } else if (complete > header.recordCount) {
        derived += `: either ${complete - header.recordCount} extra record(s) are present or the header count is wrong.`;
      } else {
        derived += ", so the data byte count (header word 4) is wrong.";
      }
    } else {
      derived += `After the header${dataFits && header.dataBytes ? " and data" : ""} there are ${recordArea} bytes = ${plural(complete, "complete record")} plus ${rem} stray bytes; every record is exactly 16 bytes.`;
    }
    if (!dataFits) derived += ` The declared ${header.dataBytes} data bytes do not fit in the file.`;
    diagnostics.push(
      diag("ANMA-V-HDR-004", {
        message: "File length does not match the header.",
        location: { byteOffset: 12, field: "header.word3" },
        found: `${len} bytes; header word 3 (record count) = ${header.recordCount}, word 4 (data bytes) = ${header.dataBytes}`,
        expected: "length = 32 + 16 * recordCount + dataBytes",
        derived,
        stage: Stage.HEADER,
      }),
    );
    recordBytes = complete * RECORD_BYTES;
    dataStart = HEADER_BYTES + recordArea;
  } else {
    recordBytes = RECORD_BYTES * header.recordCount;
    dataStart = HEADER_BYTES + recordBytes;
  }

  const n = recordBytes / RECORD_BYTES;
  const records: RawRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const off = HEADER_BYTES + i * RECORD_BYTES;
    records[i] = { index: i, offset: off, op: word(bytes, off), a: word(bytes, off + 4), b: word(bytes, off + 8), c: word(bytes, off + 12) };
  }
  const dataEnd = Math.min(len, dataStart + header.dataBytes);
  const data = bytes.slice(Math.min(dataStart, len), dataEnd);
  return { ok, diagnostics, file: { byteLength: len, header, records, data } };
}

// ---------------------------------------------------------------------------
// Disassembly in record-claim syntax (PRD Section 15.3)

export function renderField(role: FieldRole, v: number): string {
  switch (role) {
    case "dest":
    case "src":
      return v === UNIT_SENTINEL ? "_" : `v${v}`;
    case "dest-or-unit":
    case "src-or-unit":
      return v === UNIT_SENTINEL ? "_" : `v${v}`;
    case "func":
      return `fn${v}`;
    case "block":
      return `block${v}`;
    case "import": {
      const imp = IMPORTS[v];
      return imp ? imp.name : `import${v}`;
    }
    case "type":
      return isTypeTag(v) ? TYPE_CLAIM_NAMES[v] : `type${v}`;
    case "imm-bool":
    case "count":
    case "index":
    case "zero":
    case "imm-lo":
    case "imm-hi":
      return `${v}`;
  }
}

/** Render one record as a claim-syntax s-expression, e.g. "(ADD_U64 v3 v1 v2)". */
export function disassemble(rec: Pick<RawRecord, "op" | "a" | "b" | "c">): string {
  const info = OP_BY_CODE.get(rec.op);
  if (!info) return `(UNKNOWN 0x${rec.op.toString(16)} ${rec.a} ${rec.b} ${rec.c})`;
  if (info.code === Op.END_FUNC) return "(END_FUNC)";
  if (info.code === Op.CONST_U64) return `(CONST_U64 v${rec.a} ${constFromWords(rec.b, rec.c).toString(10)})`;
  const parts: string[] = [info.name];
  const f = [rec.a, rec.b, rec.c];
  for (let i = 0; i < 3; i++) {
    const role = info.fields[i]!;
    if (role === "zero") continue;
    parts.push(renderField(role, f[i]!));
  }
  return `(${parts.join(" ")})`;
}

export function recordBytesHex(bytes: Uint8Array, rec: RawRecord): string {
  return Array.from(bytes.subarray(rec.offset, rec.offset + RECORD_BYTES), (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** One listing line per record: index, byte offset, raw bytes, decoded claim syntax. */
export function listingLines(bytes: Uint8Array, records: readonly RawRecord[]): string[] {
  const w = String(Math.max(0, records.length - 1)).length;
  return records.map((rec) => `${String(rec.index).padStart(w)} @${rec.offset}  ${recordBytesHex(bytes, rec)}  ${disassemble(rec)}`);
}

export function describeHeader(h: Header): string {
  return `ANMA v${h.version} features=0x${h.features.toString(16)} records=${h.recordCount} data=${h.dataBytes} entry=fn${h.entry}`;
}

export { opName };
