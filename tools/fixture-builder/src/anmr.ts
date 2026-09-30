// DEVELOPER/TEST-ONLY ANMR-1 fixture builder: the capstone at a given register count R, keeping as
// many producers in registers as fit and spilling the rest with explicit SAVE/RESTORE.

import { HEADER_BYTES, Op, RECORD_BYTES, TypeTag, wordsFromConst } from "@llmtobinary/spec";

type Rec = [number, number, number, number];
const SAVE = 0x70;
const RESTORE = 0x71;

export function anmrCapstone(R: number, K = 40, stride = 17): Uint8Array {
  if (R < 4) throw new Error("the builder's strategy needs R >= 4 (x, accumulator, constant 3, temporary)");
  // r0 = x, r1 = accumulator, r2 = constant 3, r3 = temporary; r4.. hold producers that fit.
  const kept = Math.min(K, R - 4);
  const S = K;
  const recs: Rec[] = [
    [Op.FUNC, 0, 1, TypeTag.U64],
    [Op.BLOCK, 0, 1, 0],
    [Op.PARAM, 0, TypeTag.U64, 0],
  ];
  const home = (i: number): { kind: "reg"; reg: number } | { kind: "slot"; slot: number } => (i < kept ? { kind: "reg", reg: 4 + i } : { kind: "slot", slot: i });
  for (let i = 0; i < K; i++) {
    const [lo, hi] = wordsFromConst(BigInt(i));
    recs.push([Op.CONST_U64, 3, lo, hi]);
    const h = home(i);
    if (h.kind === "reg") recs.push([Op.ADD_U64, h.reg, 0, 3]);
    else {
      recs.push([Op.ADD_U64, 3, 0, 3]);
      recs.push([SAVE, 3, h.slot, 0]);
    }
  }
  recs.push([Op.CONST_U64, 2, 3, 0]);
  recs.push([Op.CONST_U64, 1, 0, 0]);
  for (let j = 0; j < K; j++) {
    const i = (stride * j) % K;
    recs.push([Op.MUL_U64, 1, 1, 2]);
    const h = home(i);
    if (h.kind === "reg") recs.push([Op.XOR_U64, 1, 1, h.reg]);
    else {
      recs.push([RESTORE, 3, h.slot, 0]);
      recs.push([Op.XOR_U64, 1, 1, 3]);
    }
  }
  recs.push([Op.RETURN, 1, 0, 0]);
  recs.push([Op.END_FUNC, 0, 0, 0]);
  const out = new Uint8Array(HEADER_BYTES + RECORD_BYTES * recs.length);
  const dv = new DataView(out.buffer);
  out.set([0x41, 0x4e, 0x4d, 0x52], 0);
  [1, 0, recs.length, 0, 0, R, S].forEach((w, i) => dv.setUint32(4 + 4 * i, w, true));
  recs.forEach((r, i) => r.forEach((w, j) => dv.setUint32(HEADER_BYTES + RECORD_BYTES * i + 4 * j, w >>> 0, true)));
  return out;
}

export const ANMR_REGISTER_COUNTS = [4, 8, 16, 32] as const;
