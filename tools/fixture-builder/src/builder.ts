// DEVELOPER/TEST-ONLY symbolic ANMA-1 builder. It turns a symbolic program (functions, blocks,
// typed instructions) into literal bytes and computes record counts and local value counts.
// It exists so fixtures can be authored by hand-readable code; it must never be reachable from
// the live generation path (PRD Section 6.1, CI check).

import { Feature, HEADER_BYTES, IMPORT_BY_NAME, Op, RECORD_BYTES, TypeTag, UNIT_SENTINEL, wordsFromConst } from "@llmtobinary/spec";

export const BUILDER_VERSION = "fixture-builder/1";

export type TypeName = "u64" | "bool" | "h8" | "h64" | "unit";

const TAG: Record<TypeName, number> = { unit: TypeTag.UNIT, u64: TypeTag.U64, bool: TypeTag.BOOL, h8: TypeTag.HANDLE_U8, h64: TypeTag.HANDLE_U64 };

type Rec = [number, number, number, number];

/** A value handle inside one block (block-local dense ID). */
export type V = number;

export class BlockBuilder {
  readonly params: V[];
  private next: number;
  readonly recs: Rec[] = [];
  terminated = false;

  constructor(
    readonly fn: FuncBuilder,
    readonly id: number,
    readonly paramTypes: TypeName[],
  ) {
    this.params = paramTypes.map((_, i) => i);
    this.next = paramTypes.length;
  }

  get localCount(): number {
    return this.next;
  }

  private def(): V {
    return this.next++;
  }

  private emit(r: Rec): void {
    if (this.terminated) throw new Error(`block ${this.id}: instruction after terminator`);
    this.recs.push(r);
  }

  const(value: bigint | number): V {
    const d = this.def();
    const [lo, hi] = wordsFromConst(BigInt(value));
    this.emit([Op.CONST_U64, d, lo, hi]);
    return d;
  }
  bool(value: boolean): V {
    const d = this.def();
    this.emit([Op.CONST_BOOL, d, value ? 1 : 0, 0]);
    return d;
  }
  bin(op: number, a: V, b: V): V {
    const d = this.def();
    this.emit([op, d, a, b]);
    return d;
  }
  add(a: V, b: V): V { return this.bin(Op.ADD_U64, a, b); }
  sub(a: V, b: V): V { return this.bin(Op.SUB_U64, a, b); }
  mul(a: V, b: V): V { return this.bin(Op.MUL_U64, a, b); }
  udiv(a: V, b: V): V { return this.bin(Op.UDIV_U64, a, b); }
  urem(a: V, b: V): V { return this.bin(Op.UREM_U64, a, b); }
  and(a: V, b: V): V { return this.bin(Op.AND_U64, a, b); }
  or(a: V, b: V): V { return this.bin(Op.OR_U64, a, b); }
  xor(a: V, b: V): V { return this.bin(Op.XOR_U64, a, b); }
  shl(a: V, b: V): V { return this.bin(Op.SHL_U64, a, b); }
  shr(a: V, b: V): V { return this.bin(Op.SHR_U64, a, b); }
  eq(a: V, b: V): V { return this.bin(Op.EQ_U64, a, b); }
  lt(a: V, b: V): V { return this.bin(Op.LT_U64, a, b); }
  le(a: V, b: V): V { return this.bin(Op.LE_U64, a, b); }
  not(a: V): V { const d = this.def(); this.emit([Op.NOT_BOOL, d, a, 0]); return d; }
  boolToU64(a: V): V { const d = this.def(); this.emit([Op.BOOL_TO_U64, d, a, 0]); return d; }
  nonzero(a: V): V { const d = this.def(); this.emit([Op.U64_NONZERO, d, a, 0]); return d; }

  private heap(): void {
    this.fn.module.useFeature(Feature.HEAP);
  }
  allocU64(count: V): V { this.heap(); const d = this.def(); this.emit([Op.ALLOC_U64, d, count, 0]); return d; }
  allocU8(count: V): V { this.heap(); const d = this.def(); this.emit([Op.ALLOC_U8, d, count, 0]); return d; }
  loadU64(h: V, i: V): V { this.heap(); const d = this.def(); this.emit([Op.LOAD_U64, d, h, i]); return d; }
  loadU8(h: V, i: V): V { this.heap(); const d = this.def(); this.emit([Op.LOAD_U8, d, h, i]); return d; }
  storeU64(h: V, i: V, v: V): void { this.heap(); this.emit([Op.STORE_U64, h, i, v]); }
  storeU8(h: V, i: V, v: V): void { this.heap(); this.emit([Op.STORE_U8, h, i, v]); }

  /** HOST call by import name; returns the destination value, or null for unit imports. */
  host(name: string, args: V[]): V | null {
    const imp = IMPORT_BY_NAME.get(name);
    if (!imp) throw new Error(`unknown import ${name}`);
    this.fn.module.useFeature(imp.feature);
    const d = imp.result === TypeTag.UNIT ? null : this.def();
    this.emit([Op.HOST, d ?? UNIT_SENTINEL, imp.id, args.length]);
    for (const a of args) this.emit([Op.ARG, a, 0, 0]);
    return d;
  }

  call(callee: FuncBuilder, args: V[]): V | null {
    const d = callee.ret === "unit" ? null : this.def();
    this.emit([Op.CALL, d ?? UNIT_SENTINEL, callee.id, args.length]);
    for (const a of args) this.emit([Op.ARG, a, 0, 0]);
    return d;
  }

  jump(target: BlockBuilder, args: V[]): void {
    this.emit([Op.JUMP, target.id, args.length, 0]);
    for (const a of args) this.emit([Op.ARG, a, 0, 0]);
    this.terminated = true;
  }

  brIf(cond: V, t: BlockBuilder, tArgs: V[], f: BlockBuilder, fArgs: V[]): void {
    this.emit([Op.BR_IF, cond, t.id, f.id]);
    this.emit([Op.EDGE_ARGS, tArgs.length, 0, 0]);
    for (const a of tArgs) this.emit([Op.ARG, a, 0, 0]);
    this.emit([Op.EDGE_ARGS, fArgs.length, 0, 0]);
    for (const a of fArgs) this.emit([Op.ARG, a, 0, 0]);
    this.terminated = true;
  }

  ret(v: V | null): void {
    this.emit([Op.RETURN, v ?? UNIT_SENTINEL, 0, 0]);
    this.terminated = true;
  }
}

export class FuncBuilder {
  readonly blocks: BlockBuilder[] = [];
  constructor(
    readonly module: ModuleBuilder,
    readonly id: number,
    readonly paramTypes: TypeName[],
    readonly ret: TypeName,
  ) {}

  /** Create a block. The first block is block 0 and takes the function's parameters. */
  block(params: TypeName[] = []): BlockBuilder {
    const id = this.blocks.length;
    const types = id === 0 ? this.paramTypes : params;
    if (id === 0 && params.length && params.join() !== this.paramTypes.join()) throw new Error("block 0 params are the function params");
    const b = new BlockBuilder(this, id, [...types]);
    this.blocks.push(b);
    return b;
  }
}

export class ModuleBuilder {
  readonly funcs: FuncBuilder[] = [];
  private dataBytes: number[] = [];
  private featureMask = 0;
  private entryId = 0;
  private extraFeatures = 0;

  useFeature(bit: number): void {
    this.featureMask |= bit;
  }
  /** Declare a feature explicitly (e.g. heap). */
  feature(bit: number): this {
    this.extraFeatures |= bit;
    return this;
  }
  func(params: TypeName[], ret: TypeName): FuncBuilder {
    const f = new FuncBuilder(this, this.funcs.length, params, ret);
    this.funcs.push(f);
    return f;
  }
  entry(f: FuncBuilder): this {
    this.entryId = f.id;
    return this;
  }
  /** Append bytes to the read-only data section; returns their offset. */
  data(bytes: Uint8Array | string): number {
    const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const off = this.dataBytes.length;
    this.dataBytes.push(...b);
    return off;
  }

  build(): Uint8Array {
    const recs: Rec[] = [];
    for (const f of this.funcs) {
      if (!f.blocks.length) throw new Error(`fn${f.id} has no blocks`);
      recs.push([Op.FUNC, f.id, f.paramTypes.length, TAG[f.ret]]);
      for (const b of f.blocks) {
        if (!b.terminated) throw new Error(`fn${f.id} block${b.id} has no terminator`);
        recs.push([Op.BLOCK, b.id, b.paramTypes.length, b.localCount]);
        b.paramTypes.forEach((t, i) => recs.push([Op.PARAM, i, TAG[t], i]));
        recs.push(...b.recs);
      }
      recs.push([Op.END_FUNC, 0, 0, 0]);
    }
    const out = new Uint8Array(HEADER_BYTES + RECORD_BYTES * recs.length + this.dataBytes.length);
    const dv = new DataView(out.buffer);
    out.set([0x41, 0x4e, 0x4d, 0x41], 0);
    const words = [1, this.featureMask | this.extraFeatures, recs.length, this.dataBytes.length, this.entryId, 0, 0];
    words.forEach((w, i) => dv.setUint32(4 + 4 * i, w >>> 0, true));
    recs.forEach((r, i) => r.forEach((w, j) => dv.setUint32(HEADER_BYTES + RECORD_BYTES * i + 4 * j, w >>> 0, true)));
    out.set(this.dataBytes, HEADER_BYTES + RECORD_BYTES * recs.length);
    return out;
  }
}
