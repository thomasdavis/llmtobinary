// ANMA-1 wire constants, opcode metadata, host imports, and public resource limits.
// Normative source: PRD.md Sections 10–14 (extracted to spec/anma-1.md).

export const ISA_TAG = "ANMA-1" as const;
export const MAGIC = [0x41, 0x4e, 0x4d, 0x41] as const; // "ANMA"
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const RECORD_BYTES = 16;
export const UNIT_SENTINEL = 0xffffffff;
export const U64_MASK = (1n << 64n) - 1n;

/** Version of the executable-semantics contract implemented by this code base. */
export const SPEC_ID = "ANMA-1/prd-3.2";

// ---------------------------------------------------------------------------
// Features (header word 2)

export const Feature = {
  HEAP: 1 << 0,
  TERMINAL: 1 << 1,
  FRAMEBUFFER: 1 << 2,
  INPUT: 1 << 3,
} as const;
export type FeatureBit = (typeof Feature)[keyof typeof Feature];
export const KNOWN_FEATURES = Feature.HEAP | Feature.TERMINAL | Feature.FRAMEBUFFER | Feature.INPUT;

export const FEATURE_NAMES: Record<FeatureBit, string> = {
  [Feature.HEAP]: "heap",
  [Feature.TERMINAL]: "terminal",
  [Feature.FRAMEBUFFER]: "framebuffer",
  [Feature.INPUT]: "input",
};

export function featureList(mask: number): string[] {
  const bits: FeatureBit[] = [Feature.HEAP, Feature.TERMINAL, Feature.FRAMEBUFFER, Feature.INPUT];
  return bits.filter((bit) => (mask & bit) !== 0).map((bit) => FEATURE_NAMES[bit] as string);
}

// ---------------------------------------------------------------------------
// Types

export const TypeTag = {
  UNIT: 0,
  U64: 1,
  BOOL: 2,
  HANDLE_U8: 3,
  HANDLE_U64: 4,
} as const;
export type TypeTag = (typeof TypeTag)[keyof typeof TypeTag];

export const TYPE_NAMES: Record<TypeTag, string> = {
  0: "unit",
  1: "u64",
  2: "bool",
  3: "handle<u8>",
  4: "handle<u64>",
};

/** Names accepted in record claims and contracts ("u64", "bool", "handle_u8", …). */
export const TYPE_CLAIM_NAMES: Record<TypeTag, string> = {
  0: "unit",
  1: "u64",
  2: "bool",
  3: "handle_u8",
  4: "handle_u64",
};

export function isTypeTag(n: number): n is TypeTag {
  return n >= 0 && n <= 4 && Number.isInteger(n);
}

// ---------------------------------------------------------------------------
// Opcodes

export const Op = {
  FUNC: 0x01,
  BLOCK: 0x02,
  PARAM: 0x03,
  END_FUNC: 0x04,
  CONST_U64: 0x10,
  CONST_BOOL: 0x11,
  ADD_U64: 0x20,
  SUB_U64: 0x21,
  MUL_U64: 0x22,
  UDIV_U64: 0x23,
  UREM_U64: 0x24,
  AND_U64: 0x25,
  OR_U64: 0x26,
  XOR_U64: 0x27,
  SHL_U64: 0x28,
  SHR_U64: 0x29,
  ROTL_U64: 0x2a,
  ROTR_U64: 0x2b,
  EQ_U64: 0x30,
  LT_U64: 0x31,
  LE_U64: 0x32,
  NOT_BOOL: 0x33,
  BOOL_TO_U64: 0x34,
  U64_NONZERO: 0x35,
  JUMP: 0x40,
  BR_IF: 0x41,
  CALL: 0x42,
  RETURN: 0x43,
  ARG: 0x44,
  EDGE_ARGS: 0x45,
  ALLOC_U64: 0x50,
  LOAD_U64: 0x51,
  STORE_U64: 0x52,
  ALLOC_U8: 0x53,
  LOAD_U8: 0x54,
  STORE_U8: 0x55,
  HOST: 0x60,
} as const;
export type OpCode = (typeof Op)[keyof typeof Op];

/**
 * How a record field is interpreted.
 * - dest: value ID defined by this record (dense)
 * - dest-or-unit: dest, or UNIT_SENTINEL for unit-returning CALL/HOST
 * - src: value ID read by this record
 * - src-or-unit: RETURN source, or UNIT_SENTINEL in unit functions
 * - imm-lo / imm-hi: CONST_U64 immediates; imm-bool: 0 or 1
 * - func / block / import / type / count / index: declaration fields
 * - zero: must be zero
 */
export type FieldRole =
  | "dest"
  | "dest-or-unit"
  | "src"
  | "src-or-unit"
  | "imm-lo"
  | "imm-hi"
  | "imm-bool"
  | "func"
  | "block"
  | "import"
  | "type"
  | "count"
  | "index"
  | "zero";

export type OpKind =
  | "decl"
  | "const"
  | "binary"
  | "unary"
  | "terminator"
  | "call"
  | "arg"
  | "memory"
  | "host";

export interface OpInfo {
  code: OpCode;
  name: keyof typeof Op;
  kind: OpKind;
  fields: readonly [FieldRole, FieldRole, FieldRole];
  /** Result type for value-producing arithmetic/memory ops (dest type). */
  result?: TypeTag;
  /** Operand types for `src` fields in field order. */
  operands?: readonly TypeTag[];
  /** Feature bit required by the opcode itself (HOST features depend on the import). */
  feature?: FeatureBit;
  summary: string;
}

const U = TypeTag.U64;
const B = TypeTag.BOOL;
const H8 = TypeTag.HANDLE_U8;
const H64 = TypeTag.HANDLE_U64;

const bin = (code: OpCode, name: keyof typeof Op, result: TypeTag, summary: string): OpInfo => ({
  code,
  name,
  kind: "binary",
  fields: ["dest", "src", "src"],
  result,
  operands: [U, U],
  summary,
});

export const OPS: readonly OpInfo[] = [
  { code: Op.FUNC, name: "FUNC", kind: "decl", fields: ["func", "count", "type"], summary: "function ID, parameter count, return type" },
  { code: Op.BLOCK, name: "BLOCK", kind: "decl", fields: ["block", "count", "count"], summary: "block ID, parameter count, local value count" },
  { code: Op.PARAM, name: "PARAM", kind: "decl", fields: ["dest", "type", "index"], summary: "value ID, type tag, parameter index" },
  { code: Op.END_FUNC, name: "END_FUNC", kind: "decl", fields: ["zero", "zero", "zero"], summary: "end of function" },
  { code: Op.CONST_U64, name: "CONST_U64", kind: "const", fields: ["dest", "imm-lo", "imm-hi"], result: U, summary: "destination, low 32 bits, high 32 bits" },
  { code: Op.CONST_BOOL, name: "CONST_BOOL", kind: "const", fields: ["dest", "imm-bool", "zero"], result: B, summary: "destination, 0-or-1" },
  bin(Op.ADD_U64, "ADD_U64", U, "destination = left + right (mod 2^64)"),
  bin(Op.SUB_U64, "SUB_U64", U, "destination = left - right (mod 2^64)"),
  bin(Op.MUL_U64, "MUL_U64", U, "destination = left * right (mod 2^64)"),
  bin(Op.UDIV_U64, "UDIV_U64", U, "destination = left / right (unsigned; traps on zero)"),
  bin(Op.UREM_U64, "UREM_U64", U, "destination = left % right (unsigned; traps on zero)"),
  bin(Op.AND_U64, "AND_U64", U, "destination = left & right"),
  bin(Op.OR_U64, "OR_U64", U, "destination = left | right"),
  bin(Op.XOR_U64, "XOR_U64", U, "destination = left ^ right"),
  bin(Op.SHL_U64, "SHL_U64", U, "destination = value << (count & 63)"),
  bin(Op.SHR_U64, "SHR_U64", U, "destination = value >> (count & 63) (logical)"),
  bin(Op.ROTL_U64, "ROTL_U64", U, "destination = rotate-left(value, count & 63)"),
  bin(Op.ROTR_U64, "ROTR_U64", U, "destination = rotate-right(value, count & 63)"),
  bin(Op.EQ_U64, "EQ_U64", B, "bool destination = left == right"),
  bin(Op.LT_U64, "LT_U64", B, "bool destination = left < right (unsigned)"),
  bin(Op.LE_U64, "LE_U64", B, "bool destination = left <= right (unsigned)"),
  { code: Op.NOT_BOOL, name: "NOT_BOOL", kind: "unary", fields: ["dest", "src", "zero"], result: B, operands: [B], summary: "bool destination = !operand" },
  { code: Op.BOOL_TO_U64, name: "BOOL_TO_U64", kind: "unary", fields: ["dest", "src", "zero"], result: U, operands: [B], summary: "u64 destination = operand ? 1 : 0" },
  { code: Op.U64_NONZERO, name: "U64_NONZERO", kind: "unary", fields: ["dest", "src", "zero"], result: B, operands: [U], summary: "bool destination = operand != 0" },
  { code: Op.JUMP, name: "JUMP", kind: "terminator", fields: ["block", "count", "zero"], summary: "target block, argument count (ARG records follow)" },
  { code: Op.BR_IF, name: "BR_IF", kind: "terminator", fields: ["src", "block", "block"], operands: [B], summary: "bool condition, true block, false block (EDGE_ARGS+ARG follow for each edge)" },
  { code: Op.CALL, name: "CALL", kind: "call", fields: ["dest-or-unit", "func", "count"], summary: "destination or unit sentinel, function ID, argument count (ARG records follow)" },
  { code: Op.RETURN, name: "RETURN", kind: "terminator", fields: ["src-or-unit", "zero", "zero"], summary: "source value ID, or unit sentinel in unit functions" },
  { code: Op.ARG, name: "ARG", kind: "arg", fields: ["src", "zero", "zero"], summary: "argument source value ID" },
  { code: Op.EDGE_ARGS, name: "EDGE_ARGS", kind: "arg", fields: ["count", "zero", "zero"], summary: "argument count for one BR_IF edge" },
  { code: Op.ALLOC_U64, name: "ALLOC_U64", kind: "memory", fields: ["dest", "src", "zero"], result: H64, operands: [U], feature: Feature.HEAP, summary: "destination handle<u64>, count value" },
  { code: Op.LOAD_U64, name: "LOAD_U64", kind: "memory", fields: ["dest", "src", "src"], result: U, operands: [H64, U], feature: Feature.HEAP, summary: "destination, handle<u64>, index" },
  { code: Op.STORE_U64, name: "STORE_U64", kind: "memory", fields: ["src", "src", "src"], operands: [H64, U, U], feature: Feature.HEAP, summary: "handle<u64>, index, source value" },
  { code: Op.ALLOC_U8, name: "ALLOC_U8", kind: "memory", fields: ["dest", "src", "zero"], result: H8, operands: [U], feature: Feature.HEAP, summary: "destination handle<u8>, count value" },
  { code: Op.LOAD_U8, name: "LOAD_U8", kind: "memory", fields: ["dest", "src", "src"], result: U, operands: [H8, U], feature: Feature.HEAP, summary: "u64 destination, handle<u8>, index" },
  { code: Op.STORE_U8, name: "STORE_U8", kind: "memory", fields: ["src", "src", "src"], operands: [H8, U, U], feature: Feature.HEAP, summary: "handle<u8>, index, u64 source (0..255)" },
  { code: Op.HOST, name: "HOST", kind: "host", fields: ["dest-or-unit", "import", "count"], summary: "destination or unit sentinel, import ID, argument count (ARG records follow)" },
];

export const OP_BY_CODE: ReadonlyMap<number, OpInfo> = new Map(OPS.map((o) => [o.code, o]));
export const OP_BY_NAME: ReadonlyMap<string, OpInfo> = new Map(OPS.map((o) => [o.name, o]));

export function opName(code: number): string {
  return OP_BY_CODE.get(code)?.name ?? `UNKNOWN_0x${code.toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Host imports (Section 13)

export interface ImportInfo {
  id: number;
  name: string;
  params: readonly TypeTag[];
  paramNames: readonly string[];
  result: TypeTag;
  feature: FeatureBit;
}

export const IMPORTS: readonly ImportInfo[] = [
  { id: 0, name: "terminal.print_u64", params: [U], paramNames: ["value"], result: TypeTag.UNIT, feature: Feature.TERMINAL },
  { id: 1, name: "terminal.print_utf8", params: [U, U], paramNames: ["dataOffset", "byteLength"], result: TypeTag.UNIT, feature: Feature.TERMINAL },
  { id: 2, name: "display.clear", params: [U], paramNames: ["rgba"], result: TypeTag.UNIT, feature: Feature.FRAMEBUFFER },
  { id: 3, name: "display.pixel", params: [U, U, U], paramNames: ["x", "y", "rgba"], result: TypeTag.UNIT, feature: Feature.FRAMEBUFFER },
  { id: 4, name: "display.present", params: [], paramNames: [], result: TypeTag.UNIT, feature: Feature.FRAMEBUFFER },
  { id: 5, name: "input.key_down", params: [U], paramNames: ["keyId"], result: B, feature: Feature.INPUT },
  { id: 6, name: "input.wait_tick", params: [], paramNames: [], result: U, feature: Feature.INPUT },
];
export const IMPORT_BY_NAME: ReadonlyMap<string, ImportInfo> = new Map(IMPORTS.map((i) => [i.name, i]));

export const FRAMEBUFFER_WIDTH = 256;
export const FRAMEBUFFER_HEIGHT = 144;

export const KEYS = ["Left", "Right", "Up", "Down", "Space", "Enter", "Escape"] as const;
export type KeyName = (typeof KEYS)[number];

// ---------------------------------------------------------------------------
// Public resource limits (Section 14.1). Each is enforced independently.

export interface Limits {
  importedExecutableBytes: number;
  liveCandidateBytes: number;
  modelResponseTextBytes: number;
  valuesPerBlock: number;
  paramsPerFunctionOrBlock: number;
  activeFrames: number;
  activeLogicalValues: number;
  backingPayloadBytes: number;
  heapPayloadBytes: number;
  stagingPayloadBytes: number;
  metadataBytes: number;
  heapAllocations: number;
  executedInstructions: number;
  microsteps: number;
  terminalBytes: number;
  traceEvents: number;
  inputEvents: number;
  annotationBytes: number;
  claimBytes: number;
  contractExpressionBytes: number;
  contractAstDepth: number;
  examplesPerCandidate: number;
  diagnosticReportBytes: number;
  diagnosticReportedErrors: number;
  contractSteps: number;
  functions: number;
  blocksPerFunction: number;
  validationWork: number;
}

const MiB = 1024 * 1024;
const KiB = 1024;

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  importedExecutableBytes: 1 * MiB,
  liveCandidateBytes: 64 * KiB,
  modelResponseTextBytes: 256 * KiB,
  valuesPerBlock: 65_536,
  paramsPerFunctionOrBlock: 256,
  activeFrames: 256,
  activeLogicalValues: 262_144,
  backingPayloadBytes: 32 * MiB,
  heapPayloadBytes: 16 * MiB,
  stagingPayloadBytes: 4 * MiB,
  metadataBytes: 32 * MiB,
  heapAllocations: 65_536,
  executedInstructions: 5_000_000,
  microsteps: 50_000_000,
  terminalBytes: 1 * MiB,
  traceEvents: 10_000,
  inputEvents: 4_096,
  annotationBytes: 128 * KiB,
  claimBytes: 512,
  contractExpressionBytes: 4 * KiB,
  contractAstDepth: 64,
  examplesPerCandidate: 32,
  diagnosticReportBytes: 24 * KiB,
  diagnosticReportedErrors: 12,
  contractSteps: 1_000_000,
  // Not listed in 14.1 but required so validation work is bounded: derived from the 1 MiB import cap.
  functions: 65_536,
  blocksPerFunction: 65_536,
  validationWork: 4_000_000,
});

// ---------------------------------------------------------------------------
// Arithmetic helpers shared by every engine (exact u64 semantics, Section 10.3)

export function u64(v: bigint): bigint {
  return BigInt.asUintN(64, v);
}

export function constFromWords(lo: number, hi: number): bigint {
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

export function wordsFromConst(v: bigint): [number, number] {
  const x = u64(v);
  return [Number(x & 0xffffffffn), Number(x >> 32n)];
}

export function rotl64(v: bigint, count: bigint): bigint {
  const c = count & 63n;
  if (c === 0n) return v;
  return u64((v << c) | (v >> (64n - c)));
}

export function rotr64(v: bigint, count: bigint): bigint {
  const c = count & 63n;
  if (c === 0n) return v;
  return u64((v >> c) | (v << (64n - c)));
}

export type BinaryResult = { ok: true; value: bigint | boolean } | { ok: false; trap: "DIVIDE_BY_ZERO" };

/** Evaluate a binary opcode on two u64 operands. Used by both interpreters and the contract evaluator. */
export function evalBinary(op: number, a: bigint, b: bigint): BinaryResult {
  switch (op) {
    case Op.ADD_U64: return { ok: true, value: u64(a + b) };
    case Op.SUB_U64: return { ok: true, value: u64(a - b) };
    case Op.MUL_U64: return { ok: true, value: u64(a * b) };
    case Op.UDIV_U64: return b === 0n ? { ok: false, trap: "DIVIDE_BY_ZERO" } : { ok: true, value: a / b };
    case Op.UREM_U64: return b === 0n ? { ok: false, trap: "DIVIDE_BY_ZERO" } : { ok: true, value: a % b };
    case Op.AND_U64: return { ok: true, value: a & b };
    case Op.OR_U64: return { ok: true, value: a | b };
    case Op.XOR_U64: return { ok: true, value: a ^ b };
    case Op.SHL_U64: return { ok: true, value: u64(a << (b & 63n)) };
    case Op.SHR_U64: return { ok: true, value: a >> (b & 63n) };
    case Op.ROTL_U64: return { ok: true, value: rotl64(a, b) };
    case Op.ROTR_U64: return { ok: true, value: rotr64(a, b) };
    case Op.EQ_U64: return { ok: true, value: a === b };
    case Op.LT_U64: return { ok: true, value: a < b };
    case Op.LE_U64: return { ok: true, value: a <= b };
    default: throw new Error(`evalBinary: not a binary opcode 0x${op.toString(16)}`);
  }
}

/** Canonical decimal encoding for u64 values in JSON and exports. */
export function formatU64(v: bigint): string {
  return u64(v).toString(10);
}

/** Strict decimal u64 parse: rejects signs, fractions, exponents, whitespace, leading "+", and overflow. */
export function parseU64Decimal(text: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) return null;
  const v = BigInt(text);
  return v > U64_MASK ? null : v;
}
