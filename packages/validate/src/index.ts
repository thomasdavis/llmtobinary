// Independent ANMA-1 validator (PRD Section 15.1). It checks every machine-level rule and builds
// read-only lookup indexes (the Module IR). It never repairs bytes, chooses storage locations,
// inserts instructions, or optimizes arithmetic.

import {
  DEFAULT_LIMITS,
  Feature,
  FEATURE_NAMES,
  IMPORTS,
  OP_BY_CODE,
  Op,
  RECORD_BYTES,
  HEADER_BYTES,
  TYPE_NAMES,
  TypeTag,
  UNIT_SENTINEL,
  constFromWords,
  featureList,
  isTypeTag,
  type FeatureBit,
  type Limits,
  type OpInfo,
} from "@llmtobinary/spec";
import { decodeFile, disassemble, type DecodedFile, type Header, type RawRecord } from "@llmtobinary/decode";
import { Stage, diag, type Diagnostic, type DiagnosticInit } from "@llmtobinary/diagnostics";

// ---------------------------------------------------------------------------
// Module IR

export type Instr =
  | { k: "const"; op: number; dst: number; value: bigint | boolean; rec: number }
  | { k: "bin"; op: number; dst: number; a: number; b: number; rec: number }
  | { k: "un"; op: number; dst: number; a: number; rec: number }
  | { k: "call"; dst: number | null; fn: number; args: number[]; rec: number }
  | { k: "host"; dst: number | null; imp: number; args: number[]; rec: number }
  | { k: "alloc"; op: number; dst: number; count: number; rec: number }
  | { k: "load"; op: number; dst: number; handle: number; index: number; rec: number }
  | { k: "store"; op: number; handle: number; index: number; value: number; rec: number };

export interface Edge {
  target: number;
  args: number[];
}

export type Terminator =
  | { k: "jump"; edge: Edge; rec: number }
  | { k: "br"; cond: number; t: Edge; f: Edge; rec: number }
  | { k: "ret"; src: number | null; rec: number };

export interface Block {
  id: number;
  fn: number;
  rec: number;
  params: TypeTag[];
  /** Type of every local value ID (params first, then results). */
  types: TypeTag[];
  instrs: Instr[];
  term: Terminator;
  /** Number of read occurrences of each value (instructions + both BR_IF edges + RETURN). */
  uses: number[];
  /** Index of the last instruction reading each value; instrs.length means the terminator; -1 means never read. */
  lastUse: number[];
}

export interface Func {
  id: number;
  rec: number;
  params: TypeTag[];
  ret: TypeTag;
  blocks: Block[];
}

export interface Module {
  byteLength: number;
  header: Header;
  features: number;
  entry: number;
  functions: Func[];
  data: Uint8Array;
  records: readonly RawRecord[];
}

export interface ValidateOptions {
  limits?: Partial<Limits>;
  /** Host policy: features the host grants. Declared features outside this mask yield CAPABILITY_DENIED. */
  allowedFeatures?: number;
}

export interface ValidationResult {
  ok: boolean;
  module: Module | null;
  /** All diagnostics (errors, warnings, cascades). Use @llmtobinary/diagnostics.assemble to report. */
  diagnostics: Diagnostic[];
  /** The decoded (possibly lenient) file, for listings. */
  decoded: DecodedFile | null;
}

// ---------------------------------------------------------------------------

const POISON = -1 as unknown as TypeTag; // type of a value whose definition was invalid

interface Sig {
  params: (TypeTag | typeof POISON)[];
  ret: TypeTag;
}

function tname(t: TypeTag): string {
  return (t as number) === -1 ? "unknown" : TYPE_NAMES[t];
}

function recLoc(r: RawRecord, field: string | null, fn: number | null, block: number | null): Partial<Diagnostic["location"]> {
  return { byteOffset: r.offset + (field === "record.a" ? 4 : field === "record.b" ? 8 : field === "record.c" ? 12 : 0), recordIndex: r.index, field, functionId: fn, blockId: block };
}

const FIELD_NAMES = ["record.a", "record.b", "record.c"] as const;

export function validateBytes(bytes: Uint8Array, opts: ValidateOptions = {}): ValidationResult {
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const owned = bytes.slice(); // private copy: later caller mutation cannot affect the module
  const decoded = decodeFile(owned, limits);
  if (!decoded.file) return { ok: false, module: null, diagnostics: decoded.diagnostics, decoded: null };
  const v = new Validator(decoded.file, limits, opts.allowedFeatures);
  v.run();
  const diagnostics = [...decoded.diagnostics, ...v.diags];
  const hasError = diagnostics.some((d) => d.severity === "error");
  const ok = decoded.ok && !hasError;
  return { ok, module: ok ? v.buildModule(owned) : null, diagnostics, decoded: decoded.file };
}

class Validator {
  diags: Diagnostic[] = [];
  private readonly recs: readonly RawRecord[];
  private readonly header: Header;
  private sigs: Sig[] = [];
  private funcs: Func[] = [];
  private work = 0;
  private usedFeatures = 0;
  private missingArgRecords = 0;
  private argDiags: Diagnostic[] = [];
  private structuralFailure = false;

  constructor(
    private readonly file: DecodedFile,
    private readonly limits: Limits,
    private readonly allowed: number | undefined,
  ) {
    this.recs = file.records;
    this.header = file.header;
  }

  private err(rule: string, init: DiagnosticInit): Diagnostic {
    const d = diag(rule, { stage: Stage.RECORDS, ...init });
    this.diags.push(d);
    if (d.severity === "error" && !d.cascade) this.structuralFailure = true;
    return d;
  }

  private warn(rule: string, init: DiagnosticInit): void {
    this.diags.push(diag(rule, { stage: Stage.WARNINGS, ...init }));
  }

  /** Pre-scan function signatures so calls can reference later functions. */
  private prescan(): void {
    const r = this.recs;
    for (let i = 0; i < r.length; i++) {
      if (r[i]!.op !== Op.FUNC) continue;
      const f = r[i]!;
      const params: (TypeTag | typeof POISON)[] = [];
      const blk = r[i + 1];
      if (blk && blk.op === Op.BLOCK) {
        for (let k = 0; k < f.b && k < this.limits.paramsPerFunctionOrBlock; k++) {
          const p = r[i + 2 + k];
          params.push(p && p.op === Op.PARAM && isTypeTag(p.b) && p.b !== TypeTag.UNIT ? (p.b as TypeTag) : POISON);
        }
      } else {
        for (let k = 0; k < Math.min(f.b, this.limits.paramsPerFunctionOrBlock); k++) params.push(POISON);
      }
      this.sigs.push({ params, ret: isTypeTag(f.c) ? (f.c as TypeTag) : POISON });
    }
  }

  run(): void {
    this.prescan();
    const r = this.recs;
    const n = r.length;
    let pos = 0;
    let fnCount = 0;
    while (pos < n) {
      if (++this.work > this.limits.validationWork) {
        this.err("ANMA-V-LIM-004", { message: "Validation work limit exceeded.", location: recLoc(r[pos]!, null, null, null) });
        return;
      }
      const rec = r[pos]!;
      if (rec.op !== Op.FUNC) {
        if (rec.op === Op.ARG || rec.op === Op.EDGE_ARGS) {
          this.err("ANMA-V-ARG-002", { message: `${disassemble(rec)} appears outside any function.`, location: recLoc(rec, "record.opcode", null, null), found: disassemble(rec), expected: "ARG/EDGE_ARGS only directly after JUMP, BR_IF, CALL, or HOST" });
        } else if (!OP_BY_CODE.has(rec.op)) {
          this.err("ANMA-V-REC-001", { message: `Unknown opcode 0x${rec.op.toString(16)}.`, location: recLoc(rec, "record.opcode", null, null), found: `opcode word ${rec.op} (0x${rec.op.toString(16)})`, expected: "an opcode from the manual's opcode tables" });
        } else {
          this.err("ANMA-V-REC-003", {
            message: `Expected FUNC at top level but found ${disassemble(rec)}.`,
            location: recLoc(rec, "record.opcode", null, null),
            found: disassemble(rec),
            expected: fnCount === 0 ? "the first record must be FUNC" : "after END_FUNC, the next record must be FUNC or the file must end",
          });
        }
        pos++;
        continue;
      }
      pos = this.parseFunction(pos, fnCount);
      fnCount++;
    }
    this.finish(fnCount);
  }

  // ---- function / block grammar -------------------------------------------------

  private parseFunction(start: number, expectedId: number): number {
    const r = this.recs;
    const f = r[start]!;
    if (f.a !== expectedId) {
      this.err("ANMA-V-REC-004", {
        message: `Function ID ${f.a} is not dense; this is function number ${expectedId} in declaration order.`,
        location: recLoc(f, "record.a", expectedId, null),
        found: disassemble(f),
        expected: `(FUNC fn${expectedId} …)`,
      });
    }
    if (expectedId >= this.limits.functions) this.err("ANMA-V-LIM-003", { message: "Too many functions.", location: recLoc(f, null, expectedId, null) });
    if (f.b > this.limits.paramsPerFunctionOrBlock) {
      this.err("ANMA-V-LIM-002", { message: `Function declares ${f.b} parameters.`, location: recLoc(f, "record.b", expectedId, null), expected: `at most ${this.limits.paramsPerFunctionOrBlock}` });
    }
    let ret: TypeTag = TypeTag.UNIT;
    if (!isTypeTag(f.c)) {
      this.err("ANMA-V-REC-016", { message: `Invalid return type tag ${f.c}.`, location: recLoc(f, "record.c", expectedId, null), expected: "0 unit, 1 u64, 2 bool, 3 handle<u8>, 4 handle<u64>" });
      ret = POISON;
    } else ret = f.c as TypeTag;
    const func: Func = { id: expectedId, rec: f.index, params: [], ret, blocks: [] };
    this.funcs.push(func);
    const sig = this.sigs[expectedId]!;

    let pos = start + 1;
    const n = r.length;
    let blockCount = 0;
    const pendingEdges: { edge: Edge; rec: RawRecord; which: string; blockId: number }[] = [];
    while (true) {
      if (pos >= n) {
        this.err("ANMA-V-REC-013", {
          message: `The file ends inside function ${expectedId} without END_FUNC.`,
          location: { byteOffset: HEADER_BYTES + RECORD_BYTES * n, recordIndex: n, functionId: expectedId },
          expected: blockCount === 0 ? "BLOCK records, a terminator, then END_FUNC" : "END_FUNC after the last block's terminator",
        });
        break;
      }
      const rec = r[pos]!;
      if (rec.op === Op.END_FUNC) {
        this.checkZeroFields(rec, ["a", "b", "c"], expectedId, null);
        if (blockCount === 0) this.err("ANMA-V-REC-015", { message: `Function ${expectedId} has no blocks.`, location: recLoc(rec, null, expectedId, null), expected: "at least block 0 before END_FUNC" });
        pos++;
        break;
      }
      if (rec.op !== Op.BLOCK) {
        this.err(blockCount === 0 ? "ANMA-V-REC-005" : "ANMA-V-REC-012", {
          message: blockCount === 0 ? `Expected BLOCK after FUNC but found ${disassemble(rec)}.` : `After a terminator the next record must be BLOCK or END_FUNC, but found ${disassemble(rec)}.`,
          location: recLoc(rec, "record.opcode", expectedId, null),
          found: disassemble(rec),
          expected: blockCount === 0 ? "(BLOCK block0 <paramCount> <localValueCount>)" : "BLOCK or END_FUNC",
          derived: blockCount > 0 ? "Each block ends with exactly one terminator (JUMP, BR_IF, or RETURN); there is no fall-through." : null,
        });
        pos++;
        continue;
      }
      pos = this.parseBlock(pos, func, sig, blockCount, pendingEdges);
      blockCount++;
      if (blockCount > this.limits.blocksPerFunction) {
        this.err("ANMA-V-LIM-003", { message: "Too many blocks in one function.", location: recLoc(rec, null, expectedId, null) });
      }
    }
    // Resolve intra-function edges now that every block is known.
    for (const pe of pendingEdges) this.checkEdge(pe.edge, pe.rec, func, pe.blockId, pe.which);
    return pos;
  }

  private checkZeroFields(rec: RawRecord, fields: ("a" | "b" | "c")[], fn: number | null, block: number | null): void {
    for (const f of fields) {
      if (rec[f] !== 0) {
        this.err("ANMA-V-REC-002", {
          message: `Unused field ${f} of ${OP_BY_CODE.get(rec.op)?.name ?? "record"} must be zero.`,
          location: recLoc(rec, `record.${f}`, fn, block),
          found: `${f} = ${rec[f]}`,
          expected: "0",
        });
      }
    }
  }

  private parseBlock(start: number, func: Func, sig: Sig, expectedId: number, pendingEdges: { edge: Edge; rec: RawRecord; which: string; blockId: number }[]): number {
    const r = this.recs;
    const b = r[start]!;
    const fnId = func.id;
    if (b.a !== expectedId) {
      this.err("ANMA-V-REC-006", {
        message: `Block ID ${b.a} is not dense; this is block ${expectedId} of function ${fnId}.`,
        location: recLoc(b, "record.a", fnId, expectedId),
        found: disassemble(b),
        expected: `(BLOCK block${expectedId} …)`,
      });
    }
    const pcount = Math.min(b.b, this.limits.paramsPerFunctionOrBlock);
    if (b.b > this.limits.paramsPerFunctionOrBlock) {
      this.err("ANMA-V-LIM-002", { message: `Block declares ${b.b} parameters.`, location: recLoc(b, "record.b", fnId, expectedId), expected: `at most ${this.limits.paramsPerFunctionOrBlock}` });
    }
    const funcRec = r[func.rec]!;
    if (expectedId === 0 && b.b !== funcRec.b) {
      this.err("ANMA-V-REC-007", {
        message: `Block 0 declares ${b.b} parameters but FUNC fn${fnId} declares ${funcRec.b}.`,
        location: recLoc(b, "record.b", fnId, 0),
        found: disassemble(b),
        expected: `block 0 parameter count = ${funcRec.b}`,
      });
    }
    const block: Block = { id: expectedId, fn: fnId, rec: b.index, params: [], types: [], instrs: [], term: { k: "ret", src: null, rec: -1 }, uses: [], lastUse: [] };
    func.blocks.push(block);
    let pos = start + 1;
    for (let k = 0; k < pcount; k++) {
      const p = r[pos];
      if (!p || p.op !== Op.PARAM) {
        this.err("ANMA-V-REC-008", {
          message: `Block ${expectedId} declares ${b.b} parameters but only ${k} PARAM record${k === 1 ? "" : "s"} follow.`,
          location: p ? recLoc(p, "record.opcode", fnId, expectedId) : { recordIndex: pos, byteOffset: HEADER_BYTES + RECORD_BYTES * pos, functionId: fnId, blockId: expectedId },
          found: p ? disassemble(p) : "end of file",
          expected: `(PARAM v${k} <type> ${k})`,
        });
        for (let j = k; j < pcount; j++) {
          block.params.push(POISON);
          block.types.push(POISON);
        }
        break;
      }
      let t: TypeTag = POISON;
      if (p.a !== k) {
        this.err("ANMA-V-ID-007", { message: `PARAM value ID must be v${k}.`, location: recLoc(p, "record.a", fnId, expectedId), found: disassemble(p), expected: `(PARAM v${k} <type> ${k})` });
      }
      if (!isTypeTag(p.b) || p.b === TypeTag.UNIT) {
        this.err("ANMA-V-REC-010", { message: `Invalid parameter type tag ${p.b}.`, location: recLoc(p, "record.b", fnId, expectedId), found: disassemble(p), expected: "1 u64, 2 bool, 3 handle<u8>, or 4 handle<u64> (unit is not a parameter type)" });
      } else t = p.b as TypeTag;
      if (p.c !== k) {
        this.err("ANMA-V-REC-009", { message: `PARAM index must be ${k}.`, location: recLoc(p, "record.c", fnId, expectedId), found: disassemble(p), expected: `(PARAM v${k} <type> ${k})` });
      }
      block.params.push(t);
      block.types.push(t);
      pos++;
    }
    if (expectedId === 0) func.params = [...block.params];

    // body
    const n = r.length;
    let terminated = false;
    while (pos < n && !terminated) {
      if (++this.work > this.limits.validationWork) {
        this.err("ANMA-V-LIM-004", { message: "Validation work limit exceeded.", location: recLoc(r[pos]!, null, fnId, expectedId) });
        return n;
      }
      const rec = r[pos]!;
      const info = OP_BY_CODE.get(rec.op);
      if (!info) {
        this.err("ANMA-V-REC-001", {
          message: `Unknown opcode 0x${rec.op.toString(16)}.`,
          location: recLoc(rec, "record.opcode", fnId, expectedId),
          found: `opcode word ${rec.op} (0x${rec.op.toString(16)}); bytes ${disassemble(rec)}`,
          expected: "an opcode from the manual's opcode tables",
          derived: rec.op > 0xff ? "Opcode words are little-endian u32; the opcode byte comes first." : null,
        });
        pos++;
        continue;
      }
      if (rec.op === Op.BLOCK || rec.op === Op.END_FUNC) {
        this.err("ANMA-V-REC-011", {
          message: `Block ${expectedId} of function ${fnId} has no terminator before ${info.name}.`,
          location: recLoc(rec, "record.opcode", fnId, expectedId),
          found: disassemble(rec),
          expected: "JUMP, BR_IF, or RETURN as the block's final instruction",
        });
        this.closeBlock(block);
        return pos;
      }
      if (rec.op === Op.FUNC || rec.op === Op.PARAM) {
        this.err("ANMA-V-REC-017", {
          message: `${info.name} cannot appear inside a block body.`,
          location: recLoc(rec, "record.opcode", fnId, expectedId),
          found: disassemble(rec),
          expected: rec.op === Op.FUNC ? "functions do not nest; close the function with END_FUNC first" : "PARAM records only directly after their BLOCK",
        });
        pos++;
        continue;
      }
      if (rec.op === Op.ARG || rec.op === Op.EDGE_ARGS) {
        this.err("ANMA-V-ARG-002", {
          message: `${disassemble(rec)} does not belong to an instruction.`,
          location: recLoc(rec, "record.opcode", fnId, expectedId),
          found: disassemble(rec),
          expected: "ARG records only directly after JUMP/CALL/HOST (exactly their argument count) or after EDGE_ARGS",
          derived: r[pos - 1] ? `The previous record is ${disassemble(r[pos - 1]!)}.` : null,
        });
        pos++;
        continue;
      }
      pos = this.parseInstr(pos, info, func, block, sig, pendingEdges);
      if (info.kind === "terminator") terminated = true;
    }
    if (!terminated && pos >= n) {
      this.err("ANMA-V-REC-013", {
        message: `The file ends inside block ${expectedId} of function ${fnId}.`,
        location: { byteOffset: HEADER_BYTES + RECORD_BYTES * n, recordIndex: n, functionId: fnId, blockId: expectedId },
        expected: "a terminator (JUMP, BR_IF, or RETURN) and then END_FUNC",
      });
    }
    this.closeBlock(block);
    return pos;
  }

  private closeBlock(block: Block): void {
    const b = this.recs[block.rec]!;
    const defined = block.types.length;
    if (defined > this.limits.valuesPerBlock) {
      this.err("ANMA-V-LIM-001", { message: `Block ${block.id} defines ${defined} values.`, location: recLoc(b, null, block.fn, block.id), expected: `at most ${this.limits.valuesPerBlock}` });
    }
    if (b.c !== defined) {
      this.err("ANMA-V-REC-014", {
        message: `Block ${block.id} of function ${block.fn} declares ${b.c} local values but defines ${defined}.`,
        location: recLoc(b, "record.c", block.fn, block.id),
        found: disassemble(b),
        expected: `local value count = ${block.params.length} parameters + ${defined - block.params.length} results = ${defined}`,
      });
    }
    // Use counts and last-use positions.
    const uses = new Array<number>(defined).fill(0);
    const lastUse = new Array<number>(defined).fill(-1);
    const use = (v: number, at: number) => {
      if (v >= 0 && v < defined) {
        uses[v]!++;
        lastUse[v] = at;
      }
    };
    block.instrs.forEach((ins, i) => {
      switch (ins.k) {
        case "bin": use(ins.a, i); use(ins.b, i); break;
        case "un": use(ins.a, i); break;
        case "call": case "host": for (const a of ins.args) use(a, i); break;
        case "alloc": use(ins.count, i); break;
        case "load": use(ins.handle, i); use(ins.index, i); break;
        case "store": use(ins.handle, i); use(ins.index, i); use(ins.value, i); break;
        case "const": break;
      }
    });
    const t = block.term;
    const ti = block.instrs.length;
    if (t.k === "jump") for (const a of t.edge.args) use(a, ti);
    else if (t.k === "br") {
      use(t.cond, ti);
      for (const a of t.t.args) use(a, ti);
      for (const a of t.f.args) use(a, ti);
    } else if (t.src !== null) use(t.src, ti);
    block.uses = uses;
    block.lastUse = lastUse;
  }

  // ---- instructions ------------------------------------------------------------

  private src(v: number, want: TypeTag | null, rec: RawRecord, field: string, block: Block, role: string): number {
    const at = recLoc(rec, field, block.fn, block.id);
    if (v === UNIT_SENTINEL) {
      this.err("ANMA-V-ID-006", { message: `The unit sentinel 0xffffffff is not a value and cannot be the ${role}.`, location: at, found: disassemble(rec), expected: "a value ID defined earlier in this block" });
      return v;
    }
    if (v >= block.types.length) {
      this.err("ANMA-V-ID-002", {
        message: `v${v} is used as the ${role} but is not defined earlier in block ${block.id}.`,
        location: at,
        found: disassemble(rec),
        expected: block.types.length === 0 ? "a value defined earlier in this block (none are defined yet)" : `a value ID in v0..v${block.types.length - 1}`,
        derived: "Value IDs are block-local: pass values into another block as edge arguments (block parameters).",
      });
      return v;
    }
    const t = block.types[v]!;
    if (want !== null && (t as number) !== -1 && t !== want) {
      this.err("ANMA-V-TYPE-001", {
        message: `The ${role} v${v} has type ${tname(t)} but ${tname(want)} is required.`,
        location: at,
        found: `${disassemble(rec)} where v${v} : ${tname(t)}`,
        expected: `${role} of type ${tname(want)}`,
        derived: (want === TypeTag.BOOL && t === TypeTag.U64) ? "Convert with U64_NONZERO; there is no implicit u64/bool conversion." : (want === TypeTag.U64 && t === TypeTag.BOOL) ? "Convert with BOOL_TO_U64; there is no implicit bool/u64 conversion." : null,
      });
    }
    return v;
  }

  private dest(v: number, type: TypeTag, rec: RawRecord, field: string, block: Block): number {
    const next = block.types.length;
    if (v === UNIT_SENTINEL) {
      this.err("ANMA-V-ID-006", { message: "This instruction produces a value, so its destination cannot be the unit sentinel.", location: recLoc(rec, field, block.fn, block.id), found: disassemble(rec), expected: `destination v${next}` });
    } else if (v !== next) {
      this.err("ANMA-V-ID-001", {
        message: `Destination v${v} is not the next dense value ID in block ${block.id}.`,
        location: recLoc(rec, field, block.fn, block.id),
        found: disassemble(rec),
        expected: `destination v${next}`,
        derived: `Block ${block.id} has defined v0..v${next - 1} so far (${block.params.length} parameters + ${next - block.params.length} results), so the next result is v${next}.`,
      });
    }
    block.types.push(type);
    return next;
  }

  private requireFeature(bit: FeatureBit, rec: RawRecord, block: Block, what: string): void {
    this.usedFeatures |= bit;
    if ((this.header.features & bit) === 0) {
      this.err("ANMA-V-CAP-001", {
        message: `${what} requires the ${FEATURE_NAMES[bit]} feature, which the header does not declare.`,
        location: recLoc(rec, "record.opcode", block.fn, block.id),
        found: `header features = 0x${this.header.features.toString(16)} (${featureList(this.header.features).join(", ") || "none"})`,
        expected: `feature bit 0x${bit.toString(16)} (${FEATURE_NAMES[bit]}) set in header word 2`,
      });
    }
  }

  /** Read `count` ARG records after position `pos`. Returns [args, nextPos]. */
  private readArgs(pos: number, count: number, owner: RawRecord, block: Block, types: readonly (TypeTag | typeof POISON)[] | null, what: string): [number[], number] {
    const r = this.recs;
    const args: number[] = [];
    if (count > this.limits.paramsPerFunctionOrBlock) {
      this.err("ANMA-V-ARG-004", { message: `${what} declares ${count} arguments.`, location: recLoc(owner, "record.c", block.fn, block.id), expected: `at most ${this.limits.paramsPerFunctionOrBlock}` });
      count = this.limits.paramsPerFunctionOrBlock;
    }
    for (let k = 0; k < count; k++) {
      const a = r[pos];
      if (!a || a.op !== Op.ARG) {
        const missing = count - k;
        this.missingArgRecords += missing;
        const d = this.err("ANMA-V-ARG-001", {
          message: `${OP_BY_CODE.get(owner.op)!.name} declares ${count} argument${count === 1 ? "" : "s"} but is not followed by ${count} ARG record${count === 1 ? "" : "s"}.`,
          location: a ? recLoc(a, "record.opcode", block.fn, block.id) : { byteOffset: HEADER_BYTES + RECORD_BYTES * pos, recordIndex: pos, field: "record.opcode", functionId: block.fn, blockId: block.id },
          found: a ? `record ${pos} is ${disassemble(a)}` : "end of file",
          expected: `record ${pos} must be ARG (opcode 0x44), because record ${owner.index} is ${OP_BY_CODE.get(owner.op)!.name} with argument count ${count}`,
        });
        this.argDiags.push(d);
        return [args, pos];
      }
      this.checkZeroFields(a, ["b", "c"], block.fn, block.id);
      const want = types && k < types.length && (types[k] as number) !== -1 ? (types[k] as TypeTag) : null;
      args.push(this.src(a.a, want, a, "record.a", block, `argument ${k} of ${what}`));
      pos++;
    }
    return [args, pos];
  }

  private parseInstr(pos: number, info: OpInfo, func: Func, block: Block, sig: Sig, pendingEdges: { edge: Edge; rec: RawRecord; which: string; blockId: number }[]): number {
    const rec = this.recs[pos]!;
    const at = pos;
    pos++;
    const zeroFields = (["a", "b", "c"] as const).filter((_, i) => info.fields[i] === "zero");
    this.checkZeroFields(rec, zeroFields, block.fn, block.id);
    const U = TypeTag.U64;
    switch (info.kind) {
      case "const": {
        if (info.code === Op.CONST_U64) {
          const dst = this.dest(rec.a, U, rec, "record.a", block);
          block.instrs.push({ k: "const", op: info.code, dst, value: constFromWords(rec.b, rec.c), rec: at });
        } else {
          if (rec.b !== 0 && rec.b !== 1) {
            this.err("ANMA-V-REC-018", { message: "CONST_BOOL immediate must be 0 or 1.", location: recLoc(rec, "record.b", block.fn, block.id), found: `${rec.b}`, expected: "0 or 1" });
          }
          const dst = this.dest(rec.a, TypeTag.BOOL, rec, "record.a", block);
          block.instrs.push({ k: "const", op: info.code, dst, value: rec.b === 1, rec: at });
        }
        return pos;
      }
      case "binary": {
        const a = this.src(rec.b, U, rec, "record.b", block, "left operand");
        const b = this.src(rec.c, U, rec, "record.c", block, "right operand");
        const dst = this.dest(rec.a, info.result!, rec, "record.a", block);
        block.instrs.push({ k: "bin", op: info.code, dst, a, b, rec: at });
        return pos;
      }
      case "unary": {
        const a = this.src(rec.b, info.operands![0]!, rec, "record.b", block, "operand");
        const dst = this.dest(rec.a, info.result!, rec, "record.a", block);
        block.instrs.push({ k: "un", op: info.code, dst, a, rec: at });
        return pos;
      }
      case "memory": {
        this.requireFeature(Feature.HEAP, rec, block, info.name);
        if (info.code === Op.ALLOC_U64 || info.code === Op.ALLOC_U8) {
          const count = this.src(rec.b, U, rec, "record.b", block, "element count");
          const dst = this.dest(rec.a, info.result!, rec, "record.a", block);
          block.instrs.push({ k: "alloc", op: info.code, dst, count, rec: at });
        } else if (info.code === Op.LOAD_U64 || info.code === Op.LOAD_U8) {
          const handle = this.src(rec.b, info.operands![0]!, rec, "record.b", block, "handle");
          const index = this.src(rec.c, U, rec, "record.c", block, "index");
          const dst = this.dest(rec.a, U, rec, "record.a", block);
          block.instrs.push({ k: "load", op: info.code, dst, handle, index, rec: at });
        } else {
          const handle = this.src(rec.a, info.operands![0]!, rec, "record.a", block, "handle");
          const index = this.src(rec.b, U, rec, "record.b", block, "index");
          const value = this.src(rec.c, U, rec, "record.c", block, "stored value");
          block.instrs.push({ k: "store", op: info.code, handle, index, value, rec: at });
        }
        return pos;
      }
      case "call": {
        const callee = this.sigs[rec.b];
        if (!callee) {
          this.err("ANMA-V-ID-004", { message: `CALL targets fn${rec.b}, which does not exist.`, location: recLoc(rec, "record.b", block.fn, block.id), found: disassemble(rec), expected: `a function ID in fn0..fn${this.sigs.length - 1}` });
        }
        const [args, next] = this.readArgs(pos, rec.c, rec, block, callee ? callee.params : null, `CALL fn${rec.b}`);
        if (callee && args.length === rec.c && rec.c !== callee.params.length) {
          this.err("ANMA-V-TYPE-003", {
            message: `CALL passes ${rec.c} arguments but fn${rec.b} takes ${callee.params.length}.`,
            location: recLoc(rec, "record.c", block.fn, block.id),
            found: disassemble(rec),
            expected: `fn${rec.b}(${callee.params.map((t) => tname(t)).join(", ")})`,
          });
        }
        let dst: number | null = null;
        if (rec.a === UNIT_SENTINEL) {
          if (callee && callee.ret !== TypeTag.UNIT && (callee.ret as number) !== -1) {
            this.err("ANMA-V-ID-006", { message: `fn${rec.b} returns ${tname(callee.ret)}, so the CALL needs a destination value, not the unit sentinel.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: `destination v${block.types.length}` });
            block.types.push(callee.ret);
          }
        } else if (callee && callee.ret === TypeTag.UNIT) {
          this.err("ANMA-V-ID-006", { message: `fn${rec.b} returns unit, so the CALL destination must be the unit sentinel 0xffffffff.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: "(CALL _ …)" });
        } else {
          dst = this.dest(rec.a, callee ? callee.ret : POISON, rec, "record.a", block);
        }
        block.instrs.push({ k: "call", dst, fn: rec.b, args, rec: at });
        return next;
      }
      case "host": {
        const imp = IMPORTS[rec.b];
        if (!imp) {
          this.err("ANMA-V-ID-005", { message: `HOST import ${rec.b} does not exist.`, location: recLoc(rec, "record.b", block.fn, block.id), found: disassemble(rec), expected: `an import ID in 0..${IMPORTS.length - 1} (${IMPORTS.map((i) => `${i.id} ${i.name}`).join(", ")})` });
        } else this.requireFeature(imp.feature, rec, block, `HOST ${imp.name}`);
        const [args, next] = this.readArgs(pos, rec.c, rec, block, imp ? imp.params : null, imp ? imp.name : `import ${rec.b}`);
        if (imp && args.length === rec.c && rec.c !== imp.params.length) {
          this.err("ANMA-V-TYPE-005", {
            message: `${imp.name} takes ${imp.params.length} argument${imp.params.length === 1 ? "" : "s"} but HOST declares ${rec.c}.`,
            location: recLoc(rec, "record.c", block.fn, block.id),
            found: disassemble(rec),
            expected: `(HOST ${imp.result === TypeTag.UNIT ? "_" : "vN"} ${imp.name} ${imp.params.length}) then ${imp.params.length} ARG records: ${imp.paramNames.join(", ") || "none"}`,
          });
        }
        let dst: number | null = null;
        if (rec.a === UNIT_SENTINEL) {
          if (imp && imp.result !== TypeTag.UNIT) {
            this.err("ANMA-V-TYPE-005", { message: `${imp.name} returns ${tname(imp.result)}, so HOST needs a destination value.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: `destination v${block.types.length}` });
            block.types.push(imp.result);
          }
        } else if (imp && imp.result === TypeTag.UNIT) {
          this.err("ANMA-V-TYPE-005", { message: `${imp.name} returns unit, so the HOST destination must be the unit sentinel 0xffffffff.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: `(HOST _ ${imp.name} ${imp.params.length})` });
        } else {
          dst = this.dest(rec.a, imp ? imp.result : POISON, rec, "record.a", block);
        }
        block.instrs.push({ k: "host", dst, imp: rec.b, args, rec: at });
        return next;
      }
      case "terminator": {
        if (info.code === Op.RETURN) {
          let src: number | null = null;
          if (func.ret === TypeTag.UNIT) {
            if (rec.a !== UNIT_SENTINEL) {
              this.err("ANMA-V-ID-006", { message: `fn${func.id} returns unit, so RETURN's source must be the unit sentinel 0xffffffff.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: "(RETURN _)" });
            }
          } else if (rec.a === UNIT_SENTINEL) {
            this.err("ANMA-V-TYPE-004", { message: `fn${func.id} returns ${tname(func.ret)} but RETURN has the unit sentinel.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: `(RETURN vN) with vN : ${tname(func.ret)}` });
          } else {
            src = this.src(rec.a, null, rec, "record.a", block, "returned value");
            const t = block.types[src];
            if (t !== undefined && (t as number) !== -1 && (func.ret as number) !== -1 && t !== func.ret) {
              this.err("ANMA-V-TYPE-004", { message: `RETURN v${src} has type ${tname(t)} but fn${func.id} returns ${tname(func.ret)}.`, location: recLoc(rec, "record.a", block.fn, block.id), found: disassemble(rec), expected: `a ${tname(func.ret)} value` });
            }
          }
          block.term = { k: "ret", src, rec: at };
          return pos;
        }
        if (info.code === Op.JUMP) {
          const [args, next] = this.readArgs(pos, rec.b, rec, block, null, `JUMP block${rec.a}`);
          const edge: Edge = { target: rec.a, args };
          block.term = { k: "jump", edge, rec: at };
          if (args.length === rec.b) pendingEdges.push({ edge, rec, which: "JUMP", blockId: block.id });
          return next;
        }
        // BR_IF
        const cond = this.src(rec.a, TypeTag.BOOL, rec, "record.a", block, "condition");
        const edges: Edge[] = [];
        let p = pos;
        let complete = true;
        for (const [which, target] of [["true", rec.b], ["false", rec.c]] as const) {
          const e = this.recs[p];
          if (!e || e.op !== Op.EDGE_ARGS) {
            const d = this.err("ANMA-V-ARG-003", {
              message: `BR_IF must be followed by EDGE_ARGS for its ${which} edge.`,
              location: e ? recLoc(e, "record.opcode", block.fn, block.id) : { byteOffset: HEADER_BYTES + RECORD_BYTES * p, recordIndex: p, functionId: block.fn, blockId: block.id },
              found: e ? `record ${p} is ${disassemble(e)}` : "end of file",
              expected: `record ${p} must be (EDGE_ARGS <count>) for the ${which} edge to block${target}, even when the count is 0`,
            });
            this.argDiags.push(d);
            this.missingArgRecords += 1;
            edges.push({ target, args: [] });
            complete = false;
            break;
          }
          this.checkZeroFields(e, ["b", "c"], block.fn, block.id);
          p++;
          const [args, next] = this.readArgs(p, e.a, e, block, null, `BR_IF ${which} edge to block${target}`);
          if (args.length !== e.a) complete = false;
          p = next;
          edges.push({ target, args });
          if (!complete) break;
        }
        while (edges.length < 2) edges.push({ target: edges.length === 0 ? rec.b : rec.c, args: [] });
        block.term = { k: "br", cond, t: edges[0]!, f: edges[1]!, rec: at };
        if (complete) {
          pendingEdges.push({ edge: edges[0]!, rec, which: "BR_IF true edge", blockId: block.id });
          pendingEdges.push({ edge: edges[1]!, rec, which: "BR_IF false edge", blockId: block.id });
        }
        return p;
      }
      default:
        throw new Error("unreachable");
    }
  }

  private checkEdge(edge: Edge, rec: RawRecord, func: Func, fromBlock: number, which: string): void {
    const target = func.blocks[edge.target];
    if (!target) {
      this.err("ANMA-V-ID-003", {
        message: `${which} targets block${edge.target}, which does not exist in function ${func.id}.`,
        location: recLoc(rec, which === "BR_IF false edge" ? "record.c" : which === "BR_IF true edge" ? "record.b" : "record.a", func.id, fromBlock),
        found: disassemble(rec),
        expected: `a block ID in block0..block${func.blocks.length - 1}`,
      });
      return;
    }
    const from = func.blocks[fromBlock]!;
    if (edge.args.length !== target.params.length) {
      this.err("ANMA-V-TYPE-002", {
        message: `${which} passes ${edge.args.length} argument${edge.args.length === 1 ? "" : "s"} but block${edge.target} has ${target.params.length} parameter${target.params.length === 1 ? "" : "s"}.`,
        location: recLoc(rec, "record.opcode", func.id, fromBlock),
        found: disassemble(rec),
        expected: `block${edge.target}(${target.params.map(tname).join(", ")})`,
      });
      return;
    }
    edge.args.forEach((a, i) => {
      const at = from.types[a];
      const want = target.params[i]!;
      if (at !== undefined && (at as number) !== -1 && (want as number) !== -1 && at !== want) {
        this.err("ANMA-V-TYPE-002", {
          message: `${which} argument ${i} (v${a} : ${tname(at)}) does not match block${edge.target} parameter ${i} (${tname(want)}).`,
          location: recLoc(rec, "record.opcode", func.id, fromBlock),
          found: disassemble(rec),
          expected: `block${edge.target}(${target.params.map(tname).join(", ")})`,
        });
      }
    });
  }

  private finish(fnCount: number): void {
    const h = this.header;
    const entry = this.funcs[h.entry];
    if (fnCount > 0 && !entry) {
      this.err("ANMA-V-HDR-008", { message: `Entry function fn${h.entry} does not exist.`, location: { byteOffset: 20, field: "header.word5" }, found: `entry = ${h.entry}`, expected: `an ID in fn0..fn${fnCount - 1}`, stage: Stage.HEADER });
    } else if (fnCount === 0) {
      this.err("ANMA-V-HDR-008", { message: "The file declares no functions.", location: { byteOffset: 12, field: "header.word3" }, expected: "at least one FUNC … END_FUNC", stage: Stage.HEADER });
    } else if (entry) {
      entry.params.forEach((t, i) => {
        if (t !== TypeTag.U64 && t !== TypeTag.BOOL && (t as number) !== -1) {
          this.err("ANMA-V-HDR-009", { message: `Entry function parameter ${i} has type ${tname(t)}; public inputs must be u64 or bool.`, location: recLoc(this.recs[entry.rec]!, null, entry.id, 0), expected: "u64 or bool entry parameters" });
        }
      });
    }
    // Host policy.
    if (this.allowed !== undefined) {
      const denied = h.features & ~this.allowed;
      if (denied) {
        this.err("ANMA-V-CAP-002", { message: `The host does not grant the declared feature${featureList(denied).length > 1 ? "s" : ""} ${featureList(denied).join(", ")}.`, location: { byteOffset: 8, field: "header.word2" }, found: `declared 0x${h.features.toString(16)}`, expected: `a subset of granted features 0x${this.allowed.toString(16)} (${featureList(this.allowed).join(", ") || "none"})`, stage: Stage.HEADER });
      }
    }
    // Missing-ARG explanation for header length mismatches.
    if (this.missingArgRecords > 0 && this.recs.length + this.missingArgRecords === h.recordCount) {
      for (const d of this.argDiags) {
        d.derived = `If the missing record${this.missingArgRecords === 1 ? " is" : "s are"} added, the file will hold ${h.recordCount} records, which matches header word 3.`;
      }
    }
    // Warnings (only when structure is sound; otherwise they would be noise).
    if (!this.structuralFailure) {
      const unusedFeatures = h.features & ~this.usedFeatures;
      if (unusedFeatures) {
        this.warn("ANMA-W-002", { message: `Declared feature${featureList(unusedFeatures).length > 1 ? "s" : ""} ${featureList(unusedFeatures).join(", ")} ${featureList(unusedFeatures).length > 1 ? "are" : "is"} never used.`, location: { byteOffset: 8, field: "header.word2" } });
      }
      // Drawing is only visible once presented: display.clear/display.pixel with no display.present
      // anywhere means the screen can never show anything.
      const HOST_OP = 0x60;
      const draws = this.recs.filter((r) => r.op === HOST_OP && (r.b === 2 || r.b === 3));
      if (draws.length && !this.recs.some((r) => r.op === HOST_OP && r.b === 4)) {
        this.warn("ANMA-W-004", {
          message: `The program draws (${draws.length} display.clear/display.pixel call${draws.length === 1 ? "" : "s"}) but never calls display.present, so nothing it draws is ever shown.`,
          location: recLoc(draws[0]!, "record.b", null, null),
          found: "no HOST display.present record",
          expected: "HOST _ display.present 0 after drawing each frame",
        });
      }
      for (const f of this.funcs) {
        const reach = new Set<number>([0]);
        const stack = [0];
        while (stack.length) {
          const b = f.blocks[stack.pop()!];
          if (!b) continue;
          const t = b.term;
          const targets = t.k === "jump" ? [t.edge.target] : t.k === "br" ? [t.t.target, t.f.target] : [];
          for (const x of targets) if (!reach.has(x)) { reach.add(x); stack.push(x); }
        }
        for (const b of f.blocks) {
          if (!reach.has(b.id)) this.warn("ANMA-W-003", { message: `Block ${b.id} of function ${f.id} is unreachable from block 0.`, location: recLoc(this.recs[b.rec]!, null, f.id, b.id) });
          b.uses.forEach((u, v) => {
            if (u === 0 && v >= b.params.length) {
              const def = this.findDef(b, v);
              this.warn("ANMA-W-001", { message: `v${v} in block ${b.id} of function ${f.id} is defined but never used.`, location: def ? recLoc(this.recs[def]!, "record.a", f.id, b.id) : recLoc(this.recs[b.rec]!, null, f.id, b.id) });
            }
          });
        }
      }
    }
  }

  private findDef(b: Block, v: number): number | null {
    for (const ins of b.instrs) if ("dst" in ins && ins.dst === v) return ins.rec;
    return null;
  }

  buildModule(bytes: Uint8Array): Module {
    return {
      byteLength: bytes.length,
      header: this.header,
      features: this.header.features,
      entry: this.header.entry,
      functions: this.funcs,
      data: this.file.data,
      records: this.recs,
    };
  }
}

/** Throws if bytes are invalid; convenience for tests and fixture tooling. */
export function mustValidate(bytes: Uint8Array, opts?: ValidateOptions): Module {
  const r = validateBytes(bytes, opts);
  if (!r.ok || !r.module) {
    const errs = r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.rule} ${d.message}`);
    throw new Error(`invalid ANMA-1 file:\n${errs.join("\n")}`);
  }
  return r.module;
}

export function entrySignature(m: Module): { params: TypeTag[]; ret: TypeTag } {
  const f = m.functions[m.entry]!;
  return { params: f.params, ret: f.ret };
}

export { TYPE_NAMES };
