// Capstone pressure witness (PRD Section 18.2). Walks decoded operations and use relationships —
// not names, not numeric results — and either issues a bounded certificate or rejects with
// PRESSURE_STRUCTURE_MISMATCH. It is not a compiler and never changes the program.

import { Op, TypeTag } from "@llmtobinary/spec";
import type { Module } from "@llmtobinary/validate";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";

export interface PressureCertificate {
  kind: "capstone-pressure/1";
  K: number;
  stride: number;
  functionId: number;
  blockId: number;
  /** Producer i = x + i: record position and value ID. */
  producers: { i: number; recordIndex: number; valueId: number }[];
  /** Fold order: which producer each step consumed, and the consuming record. */
  fold: { step: number; producer: number; recordIndex: number }[];
  /** Record of the first fold operation; every producer precedes it. */
  foldStartRecord: number;
  returnRecord: number;
  /** Producers that are simultaneously live (defined, with a future use) when the fold begins. */
  liveAtBoundary: number;
  /** True for the literal first step (0*3) XOR v[0]; false when the fold starts directly from v[0]. */
  literalFirstStep: boolean;
}

export type WitnessResult = { ok: true; certificate: PressureCertificate; diagnostic: null } | { ok: false; certificate: null; diagnostic: Diagnostic };

type Origin =
  | { k: "param" }
  | { k: "const"; v: bigint }
  | { k: "producer"; i: number }
  | { k: "mul3"; of: number; rec: number }
  | { k: "fold"; acc: number; producer: number; rec: number }
  | { k: "other" };

function reject(message: string, recordIndex: number | null = null, derived: string | null = null): WitnessResult {
  return {
    ok: false,
    certificate: null,
    diagnostic: diag("ANMA-K-004", {
      message: `The program does not have the prescribed pressure structure: ${message}.`,
      location: { recordIndex, byteOffset: recordIndex === null ? null : 32 + 16 * recordIndex },
      derived,
      expected: "K separate x+i producers (ADD of the parameter and a constant i), all completed before the fold; fold a = (a*3) XOR v[(stride*j) mod K] consuming each producer exactly once",
      stage: Stage.TASK,
    }),
  };
}

export function capstoneWitness(module: Module, K: number, stride: number): WitnessResult {
  const fn = module.functions[module.entry]!;
  if (fn.params.length !== 1 || fn.params[0] !== TypeTag.U64 || fn.ret !== TypeTag.U64) return reject("the entry function must be (x: u64) -> u64");
  if (fn.blocks.length !== 1) return reject(`the computation must be straight-line in one block (found ${fn.blocks.length} blocks)`, null, "Loops recreate values on every iteration, so they cannot hold K distinct producers live at once.");
  const b = fn.blocks[0]!;
  if (b.term.k !== "ret" || b.term.src === null) return reject("block 0 must end with RETURN of the fold result", b.term.rec);

  const origin: Origin[] = [{ k: "param" }];
  const producerByI = new Map<number, number>(); // i -> value id
  const recOf: number[] = [];
  const isConst = (v: number, c: bigint) => {
    const o = origin[v];
    return o?.k === "const" && o.v === c;
  };
  for (const ins of b.instrs) {
    if (ins.k === "host" || ins.k === "store" || ins.k === "call") return reject(`the pure capstone contains a ${ins.k} instruction`, ins.rec);
    if (!("dst" in ins) || ins.dst === null) continue;
    recOf[ins.dst] = ins.rec;
    let o: Origin = { k: "other" };
    if (ins.k === "const" && typeof ins.value === "bigint") o = { k: "const", v: ins.value };
    else if (ins.k === "bin" && ins.op === Op.ADD_U64) {
      const c = origin[ins.a]?.k === "param" ? ins.b : origin[ins.b]?.k === "param" ? ins.a : null;
      const oc = c === null ? undefined : origin[c];
      if (oc?.k === "const" && oc.v < BigInt(K)) {
        const i = Number(oc.v);
        if (producerByI.has(i)) return reject(`x + ${i} is produced more than once (rematerialization)`, ins.rec);
        producerByI.set(i, ins.dst);
        o = { k: "producer", i };
      }
    } else if (ins.k === "bin" && ins.op === Op.MUL_U64) {
      const other = isConst(ins.b, 3n) ? ins.a : isConst(ins.a, 3n) ? ins.b : null;
      if (other !== null) o = { k: "mul3", of: other, rec: ins.rec };
    } else if (ins.k === "bin" && ins.op === Op.XOR_U64) {
      const oa = origin[ins.a];
      const ob = origin[ins.b];
      if (oa?.k === "mul3" && ob?.k === "producer") o = { k: "fold", acc: oa.of, producer: ins.b, rec: ins.rec };
      else if (ob?.k === "mul3" && oa?.k === "producer") o = { k: "fold", acc: ob.of, producer: ins.a, rec: ins.rec };
    }
    origin[ins.dst] = o;
  }

  // Walk the fold chain back from RETURN.
  const chain: { producer: number; rec: number; mulRec: number }[] = [];
  let v = b.term.src;
  while (true) {
    const o = origin[v];
    if (o?.k !== "fold") break;
    // The XOR's other operand is the (acc * 3) value; record its MUL position too.
    const xorIns = b.instrs.find((x) => "dst" in x && x.dst === v)!;
    const mulVal = xorIns.k === "bin" ? (origin[xorIns.a]?.k === "mul3" ? xorIns.a : xorIns.b) : -1;
    const mulOrigin = origin[mulVal] as Extract<Origin, { k: "mul3" }>;
    chain.unshift({ producer: o.producer, rec: o.rec, mulRec: mulOrigin.rec });
    v = o.acc;
  }
  const base = origin[v];
  let literalFirstStep: boolean;
  const consumed: number[] = chain.map((c) => c.producer);
  if (base?.k === "const" && base.v === 0n) literalFirstStep = true;
  else if (base?.k === "producer") {
    literalFirstStep = false;
    consumed.unshift(v);
  } else return reject("the returned value is not a fold ending in RETURN (its chain starts from a value that is neither the constant 0 nor x + 0)", b.term.rec);

  if (consumed.length !== K) return reject(`the fold consumes ${consumed.length} producers; it must consume ${K}`, b.term.rec);
  if (producerByI.size !== K) return reject(`found ${producerByI.size} of ${K} distinct x+i producers`);
  const iOf = (val: number) => (origin[val] as Extract<Origin, { k: "producer" }>).i;
  const foldRecords: number[] = chain.map((c) => c.rec);
  for (let j = 0; j < K; j++) {
    const want = (stride * j) % K;
    const got = iOf(consumed[j]!);
    if (got !== want) return reject(`fold step ${j} consumes x + ${got} but the permutation requires x + ${want}`, j === 0 && !literalFirstStep ? recOf[consumed[0]!]! : foldRecords[j - (literalFirstStep ? 0 : 1)]!);
  }
  for (const [i, val] of producerByI) {
    if (b.uses[val] !== 1) return reject(`x + ${i} has ${b.uses[val]} uses; it must be consumed exactly once, at its fold position`, recOf[val]!);
  }
  const foldStart = Math.min(...chain.map((c) => Math.min(c.rec, c.mulRec)));
  const lastProducer = Math.max(...[...producerByI.values()].map((val) => recOf[val]!));
  if (lastProducer > foldStart) return reject("not every producer completes before the fold begins", lastProducer, `last producer at record ${lastProducer}; first fold operation at record ${foldStart}`);

  return {
    ok: true,
    diagnostic: null,
    certificate: {
      kind: "capstone-pressure/1",
      K,
      stride,
      functionId: fn.id,
      blockId: b.id,
      producers: [...producerByI].map(([i, val]) => ({ i, recordIndex: recOf[val]!, valueId: val })).sort((a, c) => a.i - c.i),
      fold: consumed.map((p, j) => ({ step: j, producer: iOf(p), recordIndex: j === 0 && !literalFirstStep ? recOf[p]! : foldRecords[j - (literalFirstStep ? 0 : 1)]! })),
      foldStartRecord: foldStart,
      returnRecord: b.term.rec,
      liveAtBoundary: K,
      literalFirstStep,
    },
  };
}
