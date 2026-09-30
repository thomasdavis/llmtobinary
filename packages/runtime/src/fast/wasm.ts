// A minimal WebAssembly binary encoder: just what the ANMA-1 binary translator emits. No text
// format and no dependencies: bytes in, bytes out.

export const I32 = 0x7f;
export const I64 = 0x7e;
export const FUNCREF = 0x70;

/** Instruction opcodes used by the translator. */
export const W = {
  unreachable: 0x00,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  call: 0x10,
  call_indirect: 0x11,
  drop: 0x1a,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,
  i32_load: 0x28,
  i64_load: 0x29,
  i32_store: 0x36,
  i64_store: 0x37,
  memory_size: 0x3f,
  memory_grow: 0x40,
  i32_const: 0x41,
  i64_const: 0x42,
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_gt_u: 0x4b,
  i32_ge_s: 0x4e,
  i32_ge_u: 0x4f,
  i64_eqz: 0x50,
  i64_eq: 0x51,
  i64_ne: 0x52,
  i64_lt_u: 0x54,
  i64_le_u: 0x58,
  i64_ge_u: 0x5a,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_shl: 0x74,
  i32_shr_u: 0x76,
  i64_add: 0x7c,
  i64_sub: 0x7d,
  i64_mul: 0x7e,
  i64_div_u: 0x80,
  i64_rem_u: 0x82,
  i64_and: 0x83,
  i64_or: 0x84,
  i64_xor: 0x85,
  i64_shl: 0x86,
  i64_shr_u: 0x88,
  i64_rotl: 0x89,
  i64_rotr: 0x8a,
  i32_wrap_i64: 0xa7,
  i64_extend_i32_u: 0xad,
} as const;

/** Growable byte buffer with LEB128 helpers. */
export class Buf {
  private a: number[] = [];

  get length(): number {
    return this.a.length;
  }

  u8(x: number): this {
    this.a.push(x & 0xff);
    return this;
  }

  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.a.push(b[i]! & 0xff);
    return this;
  }

  /** Unsigned LEB128 (u32). */
  u32(x: number): this {
    let v = x >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      this.a.push(byte);
    } while (v !== 0);
    return this;
  }

  /** Signed LEB128 (i32). */
  s32(x: number): this {
    let v = x | 0;
    while (true) {
      const byte = v & 0x7f;
      v >>= 7;
      const done = (v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0);
      this.a.push(done ? byte : byte | 0x80);
      if (done) return this;
    }
  }

  /** Signed LEB128 (i64), from any bigint (taken modulo 2^64 as a two's-complement value). */
  s64(x: bigint): this {
    let v = BigInt.asIntN(64, x);
    while (true) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      const done = (v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0);
      this.a.push(done ? byte : byte | 0x80);
      if (done) return this;
    }
  }

  name(s: string): this {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    return this.bytes(b);
  }

  /** Append another buffer prefixed with its length (sections, bodies, vectors of bytes). */
  sized(b: Buf): this {
    this.u32(b.length);
    this.a.push(...b.a);
    return this;
  }

  op(code: number): this {
    return this.u8(code);
  }

  memarg(align: number, offset: number): this {
    return this.u32(align).u32(offset);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.a);
  }
}

export interface FuncType {
  params: number[];
  results: number[];
}

export interface ModuleSpec {
  types: FuncType[];
  imports: { module: string; name: string; type: number }[];
  /** Type index of each defined function, in order after the imports. */
  functions: number[];
  tableSize: number;
  memoryPages: { min: number; max: number };
  globals: { type: number; init: bigint | number }[];
  exports: { name: string; kind: "func" | "memory" | "global"; index: number }[];
  /** Function indices placed in table 0 starting at slot 0. */
  elements: number[];
  /** Encoded bodies (locals + code, without the size prefix), one per defined function. */
  bodies: Buf[];
}

function section(out: Buf, id: number, content: Buf): void {
  out.u8(id).sized(content);
}

/** Encode a whole module. */
export function encodeModule(m: ModuleSpec): Uint8Array {
  const out = new Buf().bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  {
    const s = new Buf().u32(m.types.length);
    for (const t of m.types) {
      s.u8(0x60).u32(t.params.length);
      for (const p of t.params) s.u8(p);
      s.u32(t.results.length);
      for (const r of t.results) s.u8(r);
    }
    section(out, 1, s);
  }
  {
    const s = new Buf().u32(m.imports.length);
    for (const i of m.imports) s.name(i.module).name(i.name).u8(0x00).u32(i.type);
    section(out, 2, s);
  }
  {
    const s = new Buf().u32(m.functions.length);
    for (const t of m.functions) s.u32(t);
    section(out, 3, s);
  }
  section(out, 4, new Buf().u32(1).u8(FUNCREF).u8(0x01).u32(m.tableSize).u32(m.tableSize));
  section(out, 5, new Buf().u32(1).u8(0x01).u32(m.memoryPages.min).u32(m.memoryPages.max));
  {
    const s = new Buf().u32(m.globals.length);
    for (const g of m.globals) {
      s.u8(g.type).u8(0x01); // mutable
      if (g.type === I64) s.op(W.i64_const).s64(BigInt(g.init));
      else s.op(W.i32_const).s32(Number(g.init));
      s.op(W.end);
    }
    section(out, 6, s);
  }
  {
    const s = new Buf().u32(m.exports.length);
    for (const e of m.exports) s.name(e.name).u8(e.kind === "func" ? 0x00 : e.kind === "memory" ? 0x02 : 0x03).u32(e.index);
    section(out, 7, s);
  }
  {
    const s = new Buf().u32(1).u8(0x00).op(W.i32_const).s32(0).op(W.end).u32(m.elements.length);
    for (const f of m.elements) s.u32(f);
    section(out, 9, s);
  }
  {
    const s = new Buf().u32(m.bodies.length);
    for (const b of m.bodies) s.sized(b);
    section(out, 10, s);
  }
  return out.toBytes();
}
