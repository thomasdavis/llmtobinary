// ANMR-1: the matched register-control ISA (PRD Section 18.5): decoder, validator, and the static
// pressure witness. Runtime-neutral and safe for the Cloudflare Worker (no execution here; the
// interpreter lives in @llmtobinary/research). It is NOT an ANMA execution backend. One function, one block, one u64 input in register 0,
// mutable registers 0..R-1, private spill slots 0..S-1 with explicit SAVE/RESTORE. No hidden
// spilling, virtual-register expansion, or computation replay.

import { HEADER_BYTES, Op, RECORD_BYTES, TypeTag, constFromWords } from "@llmtobinary/spec";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";

export const ANMR_MAGIC = [0x41, 0x4e, 0x4d, 0x52] as const; // "ANMR"
export const SAVE = 0x70;
export const RESTORE = 0x71;
const ARITH = new Set<number>([Op.ADD_U64, Op.SUB_U64, Op.MUL_U64, Op.XOR_U64]);
export const MAX_REGISTERS = 256;
export const MAX_SPILL_SLOTS = 65_536;

export type AnmrInstr =
  | { k: "const"; rd: number; value: bigint; rec: number }
  | { k: "bin"; op: number; rd: number; ra: number; rb: number; rec: number }
  | { k: "save"; rs: number; slot: number; rec: number }
  | { k: "restore"; rd: number; slot: number; rec: number }
  | { k: "ret"; rs: number; rec: number };

export interface AnmrProgram {
  R: number;
  S: number;
  instrs: AnmrInstr[];
}

export type AnmrValidation = { ok: true; program: AnmrProgram; diagnostics: Diagnostic[] } | { ok: false; program: null; diagnostics: Diagnostic[] };

function word(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export function validateAnmr(bytes: Uint8Array): AnmrValidation {
  const d: Diagnostic[] = [];
  const bad = (rule: string, message: string, rec: number | null = null) => {
    d.push(diag(rule, { message, location: { recordIndex: rec, byteOffset: rec === null ? null : HEADER_BYTES + RECORD_BYTES * rec }, stage: Stage.RECORDS }));
  };
  if (bytes.length < HEADER_BYTES) {
    bad("ANMR-V-001", `file is ${bytes.length} bytes; the header alone is 32`);
    return { ok: false, program: null, diagnostics: d };
  }
  const magicOk = ANMR_MAGIC.every((m, i) => bytes[i] === m);
  const [version, features, count, dataBytes, entry, R, S] = [4, 8, 12, 16, 20, 24, 28].map((o) => word(bytes, o)) as [number, number, number, number, number, number, number];
  if (!magicOk || version !== 1 || features !== 0 || dataBytes !== 0 || entry !== 0 || R < 1 || R > MAX_REGISTERS || S > MAX_SPILL_SLOTS) {
    bad("ANMR-V-001", `header: magic ${magicOk ? "ok" : "not ANMR"}, version ${version}, features ${features}, data ${dataBytes}, entry ${entry}, R ${R}, S ${S}`);
    return { ok: false, program: null, diagnostics: d };
  }
  if (bytes.length !== HEADER_BYTES + RECORD_BYTES * count) {
    bad("ANMR-V-002", `${bytes.length} bytes but ${count} records need ${HEADER_BYTES + RECORD_BYTES * count}`);
    return { ok: false, program: null, diagnostics: d };
  }
  const rec = (i: number) => [0, 4, 8, 12].map((o) => word(bytes, HEADER_BYTES + RECORD_BYTES * i + o)) as [number, number, number, number];
  const expect = (i: number, want: [number, number, number, number], text: string) => {
    const got = rec(i);
    if (got.some((w, k) => w !== want[k])) bad("ANMR-V-003", `record ${i} must be ${text}`, i);
  };
  if (count < 5) {
    bad("ANMR-V-003", "an ANMR program needs FUNC, BLOCK, PARAM, at least RETURN, and END_FUNC");
    return { ok: false, program: null, diagnostics: d };
  }
  expect(0, [Op.FUNC, 0, 1, TypeTag.U64], "(FUNC fn0 1 u64)");
  expect(1, [Op.BLOCK, 0, 1, 0], "(BLOCK block0 1 0)");
  expect(2, [Op.PARAM, 0, TypeTag.U64, 0], "(PARAM r0 u64 0)");
  expect(count - 1, [Op.END_FUNC, 0, 0, 0], "(END_FUNC)");
  const instrs: AnmrInstr[] = [];
  const reg = (r: number, i: number) => {
    if (r >= R) bad("ANMR-V-004", `register r${r} is outside r0..r${R - 1}`, i);
    return r;
  };
  const slot = (s: number, i: number) => {
    if (s >= S) bad("ANMR-V-005", `spill slot ${s} is outside 0..${S - 1}`, i);
    return s;
  };
  for (let i = 3; i < count - 1; i++) {
    const [op, a, b, c] = rec(i);
    const last = i === count - 2;
    if (op === Op.RETURN) {
      if (!last) bad("ANMR-V-003", "RETURN must be the last instruction before END_FUNC", i);
      if (b || c) bad("ANMR-V-003", "RETURN fields b and c must be zero", i);
      instrs.push({ k: "ret", rs: reg(a, i), rec: i });
    } else if (last) bad("ANMR-V-003", "the last instruction before END_FUNC must be RETURN", i);
    if (op === Op.RETURN) continue;
    if (op === Op.CONST_U64) instrs.push({ k: "const", rd: reg(a, i), value: constFromWords(b, c), rec: i });
    else if (ARITH.has(op)) instrs.push({ k: "bin", op, rd: reg(a, i), ra: reg(b, i), rb: reg(c, i), rec: i });
    else if (op === SAVE) {
      if (c) bad("ANMR-V-003", "SAVE field c must be zero", i);
      instrs.push({ k: "save", rs: reg(a, i), slot: slot(b, i), rec: i });
    } else if (op === RESTORE) {
      if (c) bad("ANMR-V-003", "RESTORE field c must be zero", i);
      instrs.push({ k: "restore", rd: reg(a, i), slot: slot(b, i), rec: i });
    } else bad("ANMR-V-006", `opcode 0x${op.toString(16)} is not part of ANMR-1 (CONST_U64, ADD/SUB/MUL/XOR_U64, SAVE 0x70, RESTORE 0x71, RETURN)`, i);
  }
  if (d.length) return { ok: false, program: null, diagnostics: d };
  return { ok: true, program: { R, S, instrs }, diagnostics: d };
}

// ---------------------------------------------------------------------------
// ANMR pressure witness: dynamic register-write version identities with spill/restore provenance.

export interface AnmrCertificate {
  kind: "anmr-capstone-pressure/1";
  K: number;
  stride: number;
  R: number;
  S: number;
  producers: { i: number; recordIndex: number; version: number }[];
  foldStartRecord: number;
  spills: number;
  restores: number;
}

type VOrigin = { k: "param" } | { k: "const"; v: bigint } | { k: "producer"; i: number } | { k: "mul3"; of: number } | { k: "fold"; acc: number; producer: number; rec: number } | { k: "other" };

export function anmrWitness(p: AnmrProgram, K: number, stride: number): { ok: true; certificate: AnmrCertificate } | { ok: false; diagnostic: Diagnostic } {
  const reject = (message: string, rec: number | null = null) => ({
    ok: false as const,
    diagnostic: diag("ANMA-K-004", { message: `The ANMR program does not have the prescribed pressure structure: ${message}.`, location: { recordIndex: rec }, stage: Stage.TASK }),
  });
  // Each register write creates a new version; SAVE/RESTORE move version identities (provenance).
  const versions: VOrigin[] = [{ k: "param" }];
  const versionRec: number[] = [2];
  const regVer: (number | undefined)[] = new Array(p.R).fill(undefined);
  const slotVer: (number | undefined)[] = new Array(p.S).fill(undefined);
  regVer[0] = 0;
  const producerByI = new Map<number, number>();
  const consumption = new Map<number, number>(); // producer version -> times read by arithmetic
  let spills = 0;
  let restores = 0;
  const isConst = (ver: number | undefined, c: bigint) => {
    const o = ver === undefined ? undefined : versions[ver];
    return o?.k === "const" && o.v === c;
  };
  let retVer: number | undefined;
  for (const ins of p.instrs) {
    if (ins.k === "save") {
      slotVer[ins.slot] = regVer[ins.rs];
      spills++;
      continue;
    }
    if (ins.k === "restore") {
      regVer[ins.rd] = slotVer[ins.slot];
      restores++;
      continue;
    }
    if (ins.k === "ret") {
      retVer = regVer[ins.rs];
      continue;
    }
    let o: VOrigin = { k: "other" };
    if (ins.k === "const") o = { k: "const", v: ins.value };
    else {
      const a = regVer[ins.ra];
      const b = regVer[ins.rb];
      if (a === undefined || b === undefined) return reject("reads an uninitialized register", ins.rec);
      for (const v of [a, b]) if (versions[v]?.k === "producer") consumption.set(v, (consumption.get(v) ?? 0) + 1);
      if (ins.op === Op.ADD_U64) {
        const c = versions[a]?.k === "param" ? b : versions[b]?.k === "param" ? a : null;
        const oc = c === null ? undefined : versions[c];
        if (oc?.k === "const" && oc.v < BigInt(K)) {
          const i = Number(oc.v);
          if (producerByI.has(i)) return reject(`x + ${i} is produced more than once (rematerialization)`, ins.rec);
          o = { k: "producer", i };
        }
      } else if (ins.op === Op.MUL_U64) {
        const other = isConst(b, 3n) ? a : isConst(a, 3n) ? b : null;
        if (other !== null) o = { k: "mul3", of: other };
      } else if (ins.op === Op.XOR_U64) {
        const [oa, ob] = [versions[a], versions[b]];
        if (oa?.k === "mul3" && ob?.k === "producer") o = { k: "fold", acc: oa.of, producer: b, rec: ins.rec };
        else if (ob?.k === "mul3" && oa?.k === "producer") o = { k: "fold", acc: ob.of, producer: a, rec: ins.rec };
      }
    }
    const ver = versions.length;
    versions.push(o);
    versionRec.push(ins.rec);
    if (o.k === "producer") producerByI.set(o.i, ver);
    regVer[ins.rd] = ver;
  }
  if (retVer === undefined) return reject("RETURN reads an uninitialized register");
  const consumed: number[] = [];
  const foldRecs: number[] = [];
  let v = retVer;
  while (versions[v]?.k === "fold") {
    const o = versions[v] as Extract<VOrigin, { k: "fold" }>;
    consumed.unshift(o.producer);
    foldRecs.unshift(o.rec);
    v = o.acc;
  }
  const base = versions[v];
  if (base?.k === "producer") consumed.unshift(v);
  else if (!(base?.k === "const" && base.v === 0n)) return reject("the returned value is not the fold");
  if (consumed.length !== K || producerByI.size !== K) return reject(`the fold consumes ${consumed.length} producers and ${producerByI.size} distinct producers exist; ${K} are required`);
  for (let j = 0; j < K; j++) {
    const got = (versions[consumed[j]!] as Extract<VOrigin, { k: "producer" }>).i;
    if (got !== (stride * j) % K) return reject(`fold step ${j} consumes x + ${got} but the permutation requires x + ${(stride * j) % K}`);
  }
  for (const [i, ver] of producerByI) if (consumption.get(ver) !== 1) return reject(`x + ${i} is read ${consumption.get(ver) ?? 0} times by arithmetic; it must be consumed exactly once`);
  const foldStart = Math.min(...foldRecs);
  const lastProducer = Math.max(...[...producerByI.values()].map((ver) => versionRec[ver]!));
  if (lastProducer > foldStart) return reject("not every producer completes before the fold begins", lastProducer);
  return {
    ok: true,
    certificate: {
      kind: "anmr-capstone-pressure/1",
      K,
      stride,
      R: p.R,
      S: p.S,
      producers: [...producerByI].map(([i, ver]) => ({ i, recordIndex: versionRec[ver]!, version: ver })).sort((a, c) => a.i - c.i),
      foldStartRecord: foldStart,
      spills,
      restores,
    },
  };
}
