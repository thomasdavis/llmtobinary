// The fast engine (ANMA-1 translated to WebAssembly) must be architecturally identical to the
// reference engine, and its modeled ticks must be a lower bound on the finite machine's that is
// exact whenever the finite machine had no misses or evictions.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mustValidate, type Module } from "@llmtobinary/validate";
import { runToCompletion } from "@llmtobinary/reference";
import { ModuleBuilder, type V } from "@llmtobinary/fixture-builder";
import { TASK_BY_ID, holdoutCases } from "@llmtobinary/tasks";
import { Op, TypeTag } from "@llmtobinary/spec";
import type { EntryInput, RunResult, TickEvent } from "@llmtobinary/protocol";
import { createFiniteMachine, runFast } from "../src/index.ts";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtures), "utf8")) as { fixtures: { file: string; task: string; isa?: string }[] };

function inputsFor(m: Module, texts: readonly string[]): EntryInput[] {
  const entry = m.functions[m.entry]!;
  return entry.params.map((t, i) => (t === TypeTag.BOOL ? { t: "bool", v: texts[i] === "true" } : { t: "u64", v: texts[i]! }));
}

function same(ref: RunResult, fast: RunResult, label: string): void {
  expect(fast.status, `${label}: status`).toBe(ref.status);
  expect(fast.returnValue, `${label}: return value`).toEqual(ref.returnValue);
  expect(fast.trap?.code ?? null, `${label}: trap code`).toBe(ref.trap?.code ?? null);
  if (ref.trap?.code !== "FUEL_EXHAUSTED") {
    expect(fast.trap?.recordIndex ?? null, `${label}: trap record`).toBe(ref.trap?.recordIndex ?? null);
    expect(fast.trap?.message ?? null, `${label}: trap message`).toBe(ref.trap?.message ?? null);
    expect(fast.counters.executedInstructions, `${label}: executed instructions`).toBe(ref.counters.executedInstructions);
    expect(fast.effectsHash, `${label}: effects hash`).toBe(ref.effectsHash);
    expect(fast.effectCount, `${label}: effect count`).toBe(ref.effectCount);
  }
  expect(Buffer.from(fast.terminal).toString("utf8"), `${label}: terminal`).toBe(Buffer.from(ref.terminal).toString("utf8"));
  expect(fast.framebufferHash, `${label}: framebuffer`).toBe(ref.framebufferHash);
  expect(fast.framesPresented, `${label}: frames`).toBe(ref.framesPresented);
  expect(fast.counters.heapBytes, `${label}: heap bytes`).toBe(ref.counters.heapBytes);
  expect(fast.counters.hostCalls, `${label}: host calls`).toBe(ref.counters.hostCalls);
}

/** Modeled ticks: fast is a lower bound on the finite machine, exact when nothing spilled. */
function ticksAgree(m: Module, inputs: EntryInput[], ticks: TickEvent[] | undefined, fuel: number, label: string): void {
  const fin = createFiniteMachine(m, inputs, { config: { fastSlots: 64 }, limits: { executedInstructions: fuel }, ...(ticks ? { ticks } : {}) });
  while (!["halted", "trapped", "cancelled", "waiting-input"].includes(fin.status)) fin.run(200_000);
  const exact = fin.snapshot().counters;
  const fr = runFast(m, inputs, { limits: { executedInstructions: fuel }, ...(ticks ? { ticks } : {}) });
  if (fin.status === "trapped" && fin.result().trap?.code === "FUEL_EXHAUSTED") return;
  expect(fr.counters.modeledTicks, `${label}: lower bound`).toBeLessThanOrEqual(exact.modeledTicks);
  if (exact.operandMisses === 0 && exact.evictions === 0) expect(fr.counters.modeledTicks, `${label}: exact without spills`).toBe(exact.modeledTicks);
}

describe("fast engine = reference engine on every fixture and task case", () => {
  for (const fx of manifest.fixtures.filter((f) => f.isa !== "ANMR-1")) {
    it(fx.file, () => {
      const m = mustValidate(new Uint8Array(readFileSync(new URL(fx.file, fixtures))));
      const task = TASK_BY_ID.get(fx.task);
      const cases = task ? [...task.visible, ...holdoutCases(task).slice(0, 12)] : [{ name: "no inputs", inputs: [] as string[] }];
      const fuel = task?.fuel ?? 5_000_000;
      for (const c of cases) {
        const inputs = inputsFor(m, c.inputs);
        const ticks = (c as { ticks?: TickEvent[] }).ticks;
        const opts = { limits: { executedInstructions: fuel }, ...(task ? { allowedFeatures: task.features } : {}), ...(ticks ? { ticks } : {}) };
        same(runToCompletion(m, inputs, opts), runFast(m, inputs, opts), `${fx.file} / ${c.name}`);
      }
      const c0 = cases[0]!;
      ticksAgree(m, inputsFor(m, c0.inputs), (c0 as { ticks?: TickEvent[] }).ticks, fuel, fx.file);
    });
  }
});

describe("fast engine on unedited model-generated programs", () => {
  const play = (n: number): TickEvent[] => Array.from({ length: n }, (_, i) => ({ tick: String(i + 1), keys: (i % 40 < 25 ? 2 : 1) | (i % 30 < 3 ? 16 : 0) }));
  for (const name of ["mario-platformer-a.anma", "mario-platformer-b.anma"]) {
    it(`${name}: 60 frames of scripted play`, () => {
      const m = mustValidate(new Uint8Array(readFileSync(new URL(`generated/${name}`, import.meta.url))));
      const inputs = inputsFor(m, ["0"]);
      const opts = { limits: { executedInstructions: 50_000_000 }, ticks: play(60) };
      same(runToCompletion(m, inputs, opts), runFast(m, inputs, opts), name);
      ticksAgree(m, inputs, play(20), 50_000_000, name);
    });
  }
});

describe("fast engine edge cases (builder programs)", () => {
  const run = (bytes: Uint8Array, inputs: EntryInput[] = [], ticks?: TickEvent[], fuel = 1_000_000) => {
    const m = mustValidate(bytes);
    const opts = { limits: { executedInstructions: fuel }, ...(ticks ? { ticks } : {}) };
    same(runToCompletion(m, inputs, opts), runFast(m, inputs, opts), "edge");
    return runFast(m, inputs, opts);
  };

  it("divide and remainder by zero trap at the same record with the same message", () => {
    for (const op of [Op.UDIV_U64, Op.UREM_U64]) {
      const mb = new ModuleBuilder();
      const f = mb.func(["u64"], "u64");
      const b = f.block();
      b.ret(b.bin(op, b.const(7), b.params[0]!));
      expect(run(mb.build(), [{ t: "u64", v: "0" }]).trap?.code).toBe("DIVIDE_BY_ZERO");
      run(mb.build(), [{ t: "u64", v: "3" }]);
    }
  });

  it("shifts and rotates take the count mod 64; comparisons are unsigned", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64", "u64"], "u64");
    const b = f.block();
    const [x, y] = b.params as [V, V];
    const parts = [Op.SHL_U64, Op.SHR_U64, Op.ROTL_U64, Op.ROTR_U64].map((op) => b.bin(op, x, y));
    const cmp = b.boolToU64(b.lt(x, y));
    const le = b.boolToU64(b.le(y, x));
    let acc = b.xor(parts[0]!, b.shl(parts[1]!, b.const(1)));
    acc = b.add(acc, b.mul(parts[2]!, b.const(3)));
    acc = b.xor(acc, parts[3]!);
    b.ret(b.add(b.add(acc, cmp), b.shl(le, b.const(7))));
    for (const [a, c] of [["18446744073709551615", "65"], ["1234567890123", "127"], ["9223372036854775808", "1"], ["5", "0"]]) run(mb.build(), [{ t: "u64", v: a! }, { t: "u64", v: c! }]);
  });

  it("edge arguments bind simultaneously (a swap through block parameters)", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64", "u64"], "u64");
    const b0 = f.block();
    const loop = f.block(["u64", "u64", "u64"]);
    const done = f.block(["u64"]);
    b0.jump(loop, [b0.params[0]!, b0.params[1]!, b0.const(0)]);
    const [p, q, i] = loop.params as [V, V, V];
    loop.brIf(loop.lt(i, loop.const(7)), loop, [q, p, loop.add(i, loop.const(1))], done, [loop.sub(p, q)]);
    done.ret(done.params[0]!);
    run(mb.build(), [{ t: "u64", v: "10" }, { t: "u64", v: "3" }]);
  });

  it("recursion to the frame limit traps identically", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b = f.block();
    const r = b.call(f, [b.add(b.params[0]!, b.const(1))])!;
    b.ret(r);
    const out = run(mb.build(), [{ t: "u64", v: "0" }]);
    expect(out.trap?.code).toBe("RESOURCE_EXHAUSTED");
  });

  it("heap alloc/load/store, including an out-of-bounds trap", () => {
    for (const idx of ["2", "9"]) {
      const mb = new ModuleBuilder();
      const f = mb.func(["u64"], "u64");
      const b = f.block();
      const h64 = b.allocU64(b.const(4));
      const h8 = b.allocU8(b.const(3));
      b.storeU64(h64, b.params[0]!, b.const(123456789));
      b.storeU8(h8, b.const(1), b.const(300));
      b.ret(b.add(b.loadU64(h64, b.params[0]!), b.loadU8(h8, b.const(1))));
      run(mb.build(), [{ t: "u64", v: idx }]);
    }
  });

  it("calls with and without results, unit returns, and wait_tick in the middle of a block", () => {
    const mb = new ModuleBuilder();
    const main = mb.func([], "u64");
    const helper = mb.func(["u64"], "unit");
    const sq = mb.func(["u64"], "u64");
    const hb = helper.block();
    hb.host("terminal.print_u64", [hb.params[0]!]);
    hb.ret(null);
    const sb = sq.block();
    sb.ret(sb.mul(sb.params[0]!, sb.params[0]!));
    const b0 = main.block();
    const loop = main.block(["u64", "u64"]);
    const done = main.block(["u64"]);
    b0.jump(loop, [b0.const(0), b0.const(0)]);
    const [n, acc] = loop.params as [V, V];
    loop.call(helper, [n]);
    loop.host("input.wait_tick", []);
    const k = loop.boolToU64(loop.host("input.key_down", [loop.const(1)])!);
    const next = loop.add(acc, loop.add(loop.call(sq, [n])!, k));
    loop.brIf(loop.lt(n, loop.const(5)), loop, [loop.add(n, loop.const(1)), next], done, [next]);
    done.ret(done.params[0]!);
    const ticks = Array.from({ length: 6 }, (_, i) => ({ tick: String(i + 1), keys: i % 2 ? 2 : 0 }));
    run(mb.build(), [], ticks);
    run(mb.build(), [], ticks.slice(0, 3)); // runs out of ticks: both stop waiting for input
  });

  it("random ALU programs agree bit for bit (property)", () => {
    const ops = [Op.ADD_U64, Op.SUB_U64, Op.MUL_U64, Op.AND_U64, Op.OR_U64, Op.XOR_U64, Op.SHL_U64, Op.SHR_U64, Op.ROTL_U64, Op.ROTR_U64, Op.UDIV_U64, Op.UREM_U64];
    const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom(...ops), fc.nat(40), fc.nat(40)), { minLength: 1, maxLength: 40 }), u64, u64, (prog, x, y) => {
        const mb = new ModuleBuilder();
        const f = mb.func(["u64", "u64"], "u64");
        const b = f.block();
        const vals: V[] = [b.params[0]!, b.params[1]!, b.const(1)];
        for (const [op, i, j] of prog) vals.push(b.bin(op, vals[i % vals.length]!, vals[j % vals.length]!));
        b.ret(vals[vals.length - 1]!);
        const m = mustValidate(mb.build());
        const inputs: EntryInput[] = [{ t: "u64", v: x.toString() }, { t: "u64", v: y.toString() }];
        const ref = runToCompletion(m, inputs);
        const fast = runFast(m, inputs);
        return fast.status === ref.status && JSON.stringify(fast.returnValue) === JSON.stringify(ref.returnValue) && (fast.trap?.recordIndex ?? null) === (ref.trap?.recordIndex ?? null);
      }),
      { numRuns: 300 },
    );
  });
});

describe("effects hash is unchanged by chunked hashing", () => {
  it("equals SHA-256 over the canonical lines, serialized independently", async () => {
    const { sha256HexSync } = await import("@llmtobinary/devices");
    for (const file of ["hello.anma", "fizzbuzz.anma", "checkerboard.anma"]) {
      const m = mustValidate(new Uint8Array(readFileSync(new URL(file, fixtures))));
      const task = TASK_BY_ID.get(file.replace(".anma", ""))!;
      const r = runToCompletion(m, inputsFor(m, task.visible[0]!.inputs), { limits: { executedInstructions: task.fuel } });
      if (r.effectsTruncated) continue;
      const text = r.effects.map((e) => `${e.seq}:${e.importId}:${e.args.join(",")}:${e.result ?? ""}\n`).join("");
      expect(r.effectsHash, file).toBe(sha256HexSync(new TextEncoder().encode(text)));
    }
  });
});

