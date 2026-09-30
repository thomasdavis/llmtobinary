import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mustValidate, type Module } from "@llmtobinary/validate";
import { runToCompletion, createReferenceEngine } from "@llmtobinary/reference";
import { Feature, Op } from "@llmtobinary/spec";
import { ModuleBuilder, type BlockBuilder, type V } from "../../../tools/fixture-builder/src/builder.ts";
import { createFiniteMachine, runFinite } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const mod = (name: string) => mustValidate(new Uint8Array(readFileSync(new URL(name, root))));
const u = (v: string | bigint | number) => ({ t: "u64" as const, v: String(v) });
const M = (1n << 64n) - 1n;
const FS = [1, 4, 8, 16, 32, 64];

function capstone(x: bigint): bigint {
  const v = Array.from({ length: 40 }, (_, i) => (x + BigInt(i)) & M);
  let a = 0n;
  for (let j = 0; j < 40; j++) a = ((a * 3n) & M) ^ v[(17 * j) % 40]!;
  return a;
}

function same(m: Module, inputs: { t: "u64"; v: string }[], fastSlots: number, extra: Parameters<typeof runFinite>[2] = {}) {
  const ref = runToCompletion(m, inputs, extra);
  const fin = runFinite(m, inputs, { ...extra, config: { fastSlots } });
  expect(fin.status).toBe(ref.status);
  expect(fin.returnValue).toEqual(ref.returnValue);
  expect(Array.from(fin.terminal)).toEqual(Array.from(ref.terminal));
  expect(fin.effectsHash).toBe(ref.effectsHash);
  expect(fin.framebufferHash).toBe(ref.framebufferHash);
  expect(fin.trap?.code ?? null).toBe(ref.trap?.code ?? null);
  return { ref, fin };
}

describe("finite machine on the PRD fixtures", () => {
  it.each(FS)("return-42 and square-plus-two at F=%i", (F) => {
    expect(runFinite(mod("return-42.anma"), [], { config: { fastSlots: F } }).returnValue).toEqual(u(42));
    const r = same(mod("square-plus-two.anma"), [u(12)], F);
    expect(new TextDecoder().decode(r.fin.terminal)).toBe("146");
    expect(runFinite(mod("square-plus-two.anma"), [u(4294967296n)], { config: { fastSlots: F } }).returnValue).toEqual(u(2));
  });

  it.each(FS)("capstone at F=%i: exact results and real backing traffic below 40 slots", (F) => {
    const m = mod("upstream-capstone-40.anma");
    for (const x of [0x0000123400005678n, 1n, 0n, (1n << 32n) - 1n, 1n << 32n, 1n << 53n, M]) {
      const { fin } = same(m, [u(x)], F);
      expect(fin.returnValue).toEqual(u(capstone(x)));
      const c = fin.counters;
      if (F < 40) {
        expect(c.backingWrites).toBeGreaterThan(0);
        expect(c.backingReads).toBeGreaterThan(0);
        expect(c.operandMisses).toBeGreaterThan(0);
      } else {
        expect(c.operandMisses).toBe(0);
        expect(c.backingWrites).toBe(0);
      }
      expect(c.peakFastOccupied).toBeLessThanOrEqual(F);
      expect(c.peakLiveValues).toBeGreaterThanOrEqual(40);
    }
  });

  it("the upstream reference constants", () => {
    const m = mod("upstream-capstone-40.anma");
    expect(runFinite(m, [u(0x0000123400005678n)], { config: { fastSlots: 4 } }).returnValue).toEqual(u("13514254791259192080"));
    expect(runFinite(m, [u(1)], { config: { fastSlots: 8 } }).returnValue).toEqual(u("8313107083524001560"));
  });

  it("is deterministic: identical config and inputs give identical counters", () => {
    const m = mod("upstream-capstone-40.anma");
    const a = runFinite(m, [u(7)], { config: { fastSlots: 8 } });
    const b = runFinite(m, [u(7)], { config: { fastSlots: 8 } });
    expect(a.counters).toEqual({ ...b.counters, hostWallTimeMs: a.counters.hostWallTimeMs });
  });
});

// ---------------------------------------------------------------------------
// hand-built programs

function loopSum(): Module {
  // sum 0..n-1 via block parameters; also prints the sum
  const mb = new ModuleBuilder();
  const f = mb.func(["u64"], "u64");
  const b0 = f.block();
  const loop = f.block(["u64", "u64", "u64"]); // i, acc, n
  const done = f.block(["u64"]);
  const zero = b0.const(0);
  const zero2 = b0.const(0);
  b0.jump(loop, [zero, zero2, b0.params[0]!]);
  const [i, acc, n] = loop.params as [V, V, V];
  const cond = loop.lt(i, n);
  const one = loop.const(1);
  const i2 = loop.add(i, one);
  const acc2 = loop.add(acc, i);
  loop.brIf(cond, loop, [i2, acc2, n], done, [acc]);
  done.host("terminal.print_u64", [done.params[0]!]);
  done.ret(done.params[0]!);
  return mustValidate(mb.build());
}

function recursiveFib(): Module {
  const mb = new ModuleBuilder();
  const main = mb.func(["u64"], "u64");
  const fib = mb.func(["u64"], "u64");
  const m0 = main.block();
  const r = m0.call(fib, [m0.params[0]!])!;
  const keep = m0.const(1000); // caller value that must survive the recursive calls
  const out = m0.add(r, keep);
  m0.ret(out);
  const f0 = fib.block();
  const base = fib.block(["u64"]);
  const rec = fib.block(["u64"]);
  const two = f0.const(2);
  const small = f0.lt(f0.params[0]!, two);
  f0.brIf(small, base, [f0.params[0]!], rec, [f0.params[0]!]);
  base.ret(base.params[0]!);
  const n = rec.params[0]!;
  const one = rec.const(1);
  const two2 = rec.const(2);
  const a = rec.call(fib, [rec.sub(n, one)])!;
  const b = rec.call(fib, [rec.sub(n, two2)])!;
  rec.ret(rec.add(a, b));
  return mustValidate(mb.build());
}

function heapProgram(): Module {
  const mb = new ModuleBuilder();
  const f = mb.func(["u64"], "u64");
  const b = f.block();
  const n = b.const(4);
  const h = b.allocU64(n);
  const h8 = b.allocU8(n);
  const i1 = b.const(1);
  const i3 = b.const(3);
  b.storeU64(h, i1, b.params[0]!);
  const v255 = b.const(255);
  b.storeU8(h8, i3, v255);
  const x = b.loadU64(h, i1);
  const y = b.loadU8(h8, i3);
  const z = b.loadU64(h, i3); // zero-initialized
  b.ret(b.add(b.add(x, y), z));
  return mustValidate(mb.build());
}

describe("finite machine on loops, calls, heap", () => {
  it.each(FS)("loop sum at F=%i agrees with reference and releases activations", (F) => {
    const { fin } = same(loopSum(), [u(100)], F);
    expect(fin.returnValue).toEqual(u(4950));
    expect(new TextDecoder().decode(fin.terminal)).toBe("4950");
    expect(fin.counters.peakLiveValues).toBeLessThan(20); // old activations are reclaimed
  });

  it.each(FS)("recursive fib at F=%i keeps caller values alive across calls", (F) => {
    const { fin } = same(recursiveFib(), [u(15)], F);
    expect(fin.returnValue).toEqual(u(610 + 1000));
    expect(fin.counters.peakFrames).toBe(16); // main + fib(15)..fib(1)
  });

  it.each(FS)("heap at F=%i", (F) => {
    const { fin } = same(heapProgram(), [u(77)], F);
    expect(fin.returnValue).toEqual(u(77 + 255));
    expect(fin.counters.heapAllocations).toBe(2);
    expect(fin.counters.heapBytes).toBe(4 * 8 + 4);
  });

  it("duplicate operands count as two occurrences (mul v0 v0) and F=1 works", () => {
    const m = mod("square-plus-two.anma");
    const fin = runFinite(m, [u(3)], { config: { fastSlots: 1, trace: true } });
    expect(fin.returnValue).toEqual(u(11));
  });
});

describe("resource and control outcomes", () => {
  it("F=1 with a two-entry backing store exhausts with the exact effect prefix", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b = f.block();
    const x = b.params[0]!;
    b.host("terminal.print_u64", [x]);
    const vs: V[] = [];
    for (let i = 0; i < 6; i++) vs.push(b.add(x, b.const(i)));
    let acc = vs[0]!;
    for (let i = 1; i < 6; i++) acc = b.xor(acc, vs[i]!);
    b.ret(acc);
    const m = mustValidate(mb.build());
    const r = runFinite(m, [u(5)], { config: { fastSlots: 1 }, limits: { backingPayloadBytes: 16 } });
    expect(r.status).toBe("trapped");
    expect(r.trap?.code).toBe("RESOURCE_EXHAUSTED");
    expect(r.trap?.resource).toBe("backing");
    expect(new TextDecoder().decode(r.terminal)).toBe("5"); // effects already performed are kept
    // with adequate backing the same bytes complete and agree with the reference
    same(m, [u(5)], 1);
  });

  it("a runaway loop stops on fuel with FUEL_EXHAUSTED in both engines", () => {
    const mb = new ModuleBuilder();
    const f = mb.func([], "u64");
    const b0 = f.block();
    const l = f.block(["u64"]);
    b0.jump(l, [b0.const(0)]);
    l.jump(l, [l.add(l.params[0]!, l.const(1))]);
    const m = mustValidate(mb.build());
    const limits = { executedInstructions: 10_000 };
    const ref = runToCompletion(m, [], { limits });
    const fin = runFinite(m, [], { limits, config: { fastSlots: 2 } });
    expect(ref.trap?.code).toBe("FUEL_EXHAUSTED");
    expect(fin.trap?.code).toBe("FUEL_EXHAUSTED");
    expect(fin.counters.executedInstructions).toBe(10_000);
  });

  it("waits for input without burning fuel, resumes on pushTick, and pauses/steps", () => {
    const mb = new ModuleBuilder();
    const f = mb.func([], "u64");
    const b = f.block();
    const t = b.host("input.wait_tick", [])!;
    const k = b.host("input.key_down", [b.const(1)])!;
    const kv = b.boolToU64(k);
    b.ret(b.add(t, kv));
    const m = mustValidate(mb.build());
    for (const e of [createFiniteMachine(m, [], { config: { fastSlots: 1 } }), createReferenceEngine(m, [])]) {
      expect(e.run(1000)).toBe("waiting-input");
      const before = e.result().counters.executedInstructions;
      expect(e.run(1000)).toBe("waiting-input");
      expect(e.result().counters.executedInstructions).toBe(before);
      e.pushTick({ tick: "41", keys: 0b10 });
      expect(e.step()).toBe("paused");
      expect(e.run(1000)).toBe("halted");
      expect(e.result().returnValue).toEqual(u(42));
    }
  });

  it("traps: divide by zero, u8 range, heap bounds, capability denied, invalid UTF-8", () => {
    const cases: [string, (b: BlockBuilder, mb: ModuleBuilder) => V, string, number?][] = [
      ["div", (b) => b.udiv(b.params[0]!, b.const(0)), "DIVIDE_BY_ZERO"],
      ["rem", (b) => b.urem(b.params[0]!, b.const(0)), "DIVIDE_BY_ZERO"],
      ["u8", (b) => { const h = b.allocU8(b.const(1)); b.storeU8(h, b.const(0), b.const(256)); return b.const(0); }, "BOUNDS"],
      ["oob", (b) => b.loadU64(b.allocU64(b.const(0)), b.const(0)), "BOUNDS"],
      ["cap", (b) => { b.host("terminal.print_u64", [b.params[0]!]); return b.const(0); }, "CAPABILITY_DENIED", 0],
      ["utf8", (b, mb) => { const off = mb.data(new Uint8Array([0xff, 0xfe])); b.host("terminal.print_utf8", [b.const(off), b.const(2)]); return b.const(0); }, "INVALID_UTF8"],
      ["range", (b, mb) => { mb.data("hi"); b.host("terminal.print_utf8", [b.const(1), b.const(5)]); return b.const(0); }, "BOUNDS"],
      ["pixel", (b) => { b.host("display.pixel", [b.const(256), b.const(0), b.const(0)]); return b.const(0); }, "BOUNDS"],
      ["colour", (b) => { b.host("display.clear", [b.const(1n << 32n)]); return b.const(0); }, "BOUNDS"],
      ["key", (b) => b.boolToU64(b.host("input.key_down", [b.const(7)])!), "BOUNDS"],
    ];
    for (const [name, body, code, allowed] of cases) {
      const mb = new ModuleBuilder();
      const f = mb.func(["u64"], "u64");
      const b = f.block();
      b.ret(body(b, mb));
      const m = mustValidate(mb.build());
      const opts = allowed !== undefined ? { allowedFeatures: allowed } : {};
      const ref = runToCompletion(m, [u(9)], opts);
      expect(ref.trap?.code, name).toBe(code);
      for (const F of [1, 3]) {
        const fin = runFinite(m, [u(9)], { ...opts, config: { fastSlots: F } });
        expect(fin.trap?.code, name).toBe(code);
        expect(fin.trap?.recordIndex, name).toBe(ref.trap?.recordIndex);
      }
    }
  });

  it("shifts and rotates mask counts to six bits; rotate by zero is identity", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b = f.block();
    const p = b.params[0]!;
    const s1 = b.shl(p, b.const(65)); // = x << 1
    const s2 = b.shr(p, b.const(64)); // = x
    const r1 = b.bin(Op.ROTL_U64, p, b.const(0));
    const r2 = b.bin(Op.ROTR_U64, p, b.const(68)); // rotr 4
    b.ret(b.xor(b.xor(s1, s2), b.xor(r1, r2)));
    const m = mustValidate(mb.build());
    const x = 0x8000_0000_0000_0001n;
    const rotr4 = ((x >> 4n) | (x << 60n)) & M;
    const want = (((x << 1n) & M) ^ x) ^ (x ^ rotr4);
    expect(runFinite(m, [u(x)], { config: { fastSlots: 2 } }).returnValue).toEqual(u(want));
    expect(runToCompletion(m, [u(x)]).returnValue).toEqual(u(want));
  });

  it("framebuffer effects agree across engines", () => {
    const mb = new ModuleBuilder();
    const f = mb.func([], "unit");
    const b = f.block();
    b.host("display.clear", [b.const(0x000000ff)]);
    b.host("display.pixel", [b.const(3), b.const(4), b.const(0xff0000ff)]);
    b.host("display.present", []);
    b.ret(null);
    const m = mustValidate(mb.build());
    const { fin } = same(m, [], 1);
    expect(fin.framesPresented).toBe(1);
    expect(fin.returnValue).toEqual({ t: "unit" });
    expect(fin.counters.microsteps).toBeGreaterThan(1000); // full-buffer work is charged
    expect(m.features & Feature.FRAMEBUFFER).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// property-based differential testing

const BIN_OPS = [Op.ADD_U64, Op.SUB_U64, Op.MUL_U64, Op.UDIV_U64, Op.UREM_U64, Op.AND_U64, Op.OR_U64, Op.XOR_U64, Op.SHL_U64, Op.SHR_U64, Op.ROTL_U64, Op.ROTR_U64];

interface Gen {
  pre: { op: number; a: number; b: number; c?: bigint }[];
  carry: number[];
  body: { op: number; a: number; b: number }[];
  iters: number;
  prints: number[];
  useCall: boolean;
}

const genArb: fc.Arbitrary<Gen> = fc.record({
  pre: fc.array(fc.record({ op: fc.constantFrom(...BIN_OPS, -1), a: fc.nat(1000), b: fc.nat(1000), c: fc.bigInt(0n, M) }), { minLength: 1, maxLength: 40 }),
  carry: fc.array(fc.nat(1000), { minLength: 1, maxLength: 6 }),
  body: fc.array(fc.record({ op: fc.constantFrom(...BIN_OPS), a: fc.nat(1000), b: fc.nat(1000) }), { minLength: 1, maxLength: 12 }),
  iters: fc.integer({ min: 0, max: 6 }),
  prints: fc.array(fc.nat(1000), { maxLength: 3 }),
  useCall: fc.boolean(),
});

function buildRandom(g: Gen): Module {
  const mb = new ModuleBuilder();
  const main = mb.func(["u64"], "u64");
  const helper = mb.func(["u64", "u64"], "u64");
  const h0 = helper.block();
  h0.ret(h0.xor(h0.mul(h0.params[0]!, h0.const(0x9e3779b97f4a7c15n)), h0.params[1]!));
  const b0 = main.block();
  const vals: V[] = [b0.params[0]!];
  for (const p of g.pre) {
    if (p.op === -1) vals.push(b0.const(p.c ?? 0n));
    else vals.push(b0.bin(p.op, vals[p.a % vals.length]!, vals[p.b % vals.length]!));
  }
  if (g.useCall) vals.push(b0.call(helper, [vals[vals.length - 1]!, vals[0]!])!);
  for (const p of g.prints) {
    b0.host("terminal.print_utf8", [b0.const(0), b0.const(0)]);
    b0.host("terminal.print_u64", [vals[p % vals.length]!]);
  }
  const k = g.carry.length;
  const loop = main.block([...Array(k + 1)].map(() => "u64" as const));
  const exit = main.block(["u64"]);
  b0.jump(loop, [b0.const(0), ...g.carry.map((c) => vals[c % vals.length]!)]);
  const [i, ...carried] = loop.params as V[];
  const lv: V[] = [...carried];
  for (const op of g.body) lv.push(loop.bin(op.op, lv[op.a % lv.length]!, lv[op.b % lv.length]!));
  const next = carried.map((_, j) => lv[lv.length - 1 - (j % lv.length)]!);
  const i2 = loop.add(i!, loop.const(1));
  const cont = loop.lt(i2, loop.const(g.iters));
  let fold = lv[0]!;
  for (let j = 1; j < lv.length; j++) fold = loop.xor(fold, lv[j]!);
  loop.brIf(cont, loop, [i2, ...next], exit, [fold]);
  exit.ret(exit.params[0]!);
  mb.data("");
  return mustValidate(mb.build());
}

describe("differential: finite machine vs reference on random valid programs", () => {
  it("agree on result, terminal, effects, and trap for random F", () => {
    fc.assert(
      fc.property(genArb, fc.bigInt(0n, M), fc.constantFrom(1, 2, 3, 4, 8, 16, 64), (g, x, F) => {
        const m = buildRandom(g);
        same(m, [u(x)], F);
      }),
      { numRuns: 150 },
    );
  });
});
