// TEST-ONLY encoder for malformation cases. Never imported by package sources.

export type Rec = [op: number, a?: number, b?: number, c?: number];

export interface FileOpts {
  features?: number;
  entry?: number;
  data?: number[];
  recordCount?: number;
  version?: number;
  magic?: number[];
  reserved6?: number;
  reserved7?: number;
}

export function file(records: Rec[], o: FileOpts = {}): Uint8Array {
  const data = o.data ?? [];
  const out = new Uint8Array(32 + records.length * 16 + data.length);
  const dv = new DataView(out.buffer);
  (o.magic ?? [0x41, 0x4e, 0x4d, 0x41]).forEach((b, i) => (out[i] = b));
  dv.setUint32(4, o.version ?? 1, true);
  dv.setUint32(8, o.features ?? 0, true);
  dv.setUint32(12, o.recordCount ?? records.length, true);
  dv.setUint32(16, data.length, true);
  dv.setUint32(20, o.entry ?? 0, true);
  dv.setUint32(24, o.reserved6 ?? 0, true);
  dv.setUint32(28, o.reserved7 ?? 0, true);
  records.forEach(([op, a = 0, b = 0, c = 0], i) => {
    const off = 32 + i * 16;
    dv.setUint32(off, op >>> 0, true);
    dv.setUint32(off + 4, a >>> 0, true);
    dv.setUint32(off + 8, b >>> 0, true);
    dv.setUint32(off + 12, c >>> 0, true);
  });
  out.set(data, 32 + records.length * 16);
  return out;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const S = 0xffffffff;
export const O = {
  FUNC: 0x01, BLOCK: 0x02, PARAM: 0x03, END: 0x04, CONST: 0x10, CBOOL: 0x11, ADD: 0x20, SUB: 0x21, MUL: 0x22,
  EQ: 0x30, JUMP: 0x40, BR: 0x41, CALL: 0x42, RET: 0x43, ARG: 0x44, EDGE: 0x45, ALLOC: 0x50, HOST: 0x60,
} as const;

/** fn0() -> u64 { return 42 } */
export const ret42: Rec[] = [
  [O.FUNC, 0, 0, 1],
  [O.BLOCK, 0, 0, 1],
  [O.CONST, 0, 42, 0],
  [O.RET, 0],
  [O.END],
];
