import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { runFinite } from "@llmtobinary/runtime";
import { TASK_BY_ID, capstoneOracle, ringMixOracle, runTaskTests } from "@llmtobinary/tasks";
import { ModuleBuilder, capstoneK, type V } from "@llmtobinary/fixture-builder";
import { anmrCapstone } from "../../../tools/fixture-builder/src/anmr.ts";
import { anmrWitness, capstoneWitness, runAnmr, runInvariance, validateAnmr } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, root)));
const mod = (name: string) => mustValidate(bytes(name));
const u = (v: string | bigint | number) => ({ t: "u64" as const, v: String(v) });

function streaming(K = 40): ReturnType<typeof mustValidate> {
  // Unrestricted variant: computes x+i inside the fold (no forty-value pressure).
  const mb = new ModuleBuilder();
  const f = mb.func(["u64"], "u64");
  const b = f.block();
  const x = b.params[0]!;
  const three = b.const(3);
  let a = b.const(0);
  for (let j = 0; j < K; j++) a = b.xor(b.mul(a, three), b.add(x, b.const((17 * j) % K)));
  b.ret(a);
  return mustValidate(mb.build());
}

describe("capstone pressure witness", () => {
  it("certifies the exact upstream fixture", () => {
    const w = capstoneWitness(mod("upstream-capstone-40.anma"), 40, 17);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.certificate.producers).toHaveLength(40);
    expect(w.certificate.fold.map((s) => s.producer)).toEqual(Array.from({ length: 40 }, (_, j) => (17 * j) % 40));
    expect(w.certificate.literalFirstStep).toBe(true);
    expect(Math.max(...w.certificate.producers.map((p) => p.recordIndex))).toBeLessThan(w.certificate.foldStartRecord);
  });
  it("certifies generalized presets", () => {
    for (const K of [8, 128, 256, 1024]) expect(capstoneWitness(mod(`capstone-k${K}.anma`), K, 17).ok, `K=${K}`).toBe(true);
  });
  it("rejects the streaming (unrestricted) variant even though its value is right", () => {
    const m = streaming();
    expect(runFinite(m, [u(1)]).returnValue).toEqual(u(capstoneOracle(1n)));
    const w = capstoneWitness(m, 40, 17);
    expect(w.ok).toBe(false);
    expect(w.diagnostic!.rule).toBe("ANMA-K-004");
  });
  it("rejects rematerialization, wrong permutation, and loops", () => {
    // rematerialization: x+0 produced twice
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b = f.block();
    const x = b.params[0]!;
    const v: V[] = [];
    for (let i = 0; i < 8; i++) v.push(b.add(x, b.const(i)));
    const again = b.add(x, b.const(0));
    const three = b.const(3);
    let a = b.const(0);
    for (let j = 0; j < 8; j++) a = b.xor(b.mul(a, three), j === 0 ? again : v[(17 * j) % 8]!);
    b.ret(a);
    expect(capstoneWitness(mustValidate(mb.build()), 8, 17).diagnostic?.message).toMatch(/more than once/);
    // wrong permutation: stride 3 program checked against stride 17
    expect(capstoneWitness(mustValidate(capstoneK(8, 3)), 8, 17).ok).toBe(false);
    // loops
    expect(capstoneWitness(mod("ring-mix-k8.anma"), 8, 17).diagnostic?.message).toMatch(/straight-line/);
  });
  it("accepts a fold that starts directly from v[0]", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b = f.block();
    const x = b.params[0]!;
    const v: V[] = [];
    for (let i = 0; i < 8; i++) v.push(b.add(x, b.const(i)));
    const three = b.const(3);
    let a = v[0]!;
    for (let j = 1; j < 8; j++) a = b.xor(b.mul(a, three), v[(17 * j) % 8]!);
    b.ret(a);
    const m = mustValidate(mb.build());
    expect(runFinite(m, [u(9)]).returnValue).toEqual(u(capstoneOracle(9n, 8)));
    const w = capstoneWitness(m, 8, 17);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.certificate.literalFirstStep).toBe(false);
  });
  it("plugs into the task runner as the witness case", () => {
    const task = TASK_BY_ID.get("capstone-40")!;
    const witness = (m: ReturnType<typeof mustValidate>, p: NonNullable<typeof task.pressure>) => {
      const w = capstoneWitness(m, p.K, p.stride);
      return { ok: w.ok, diagnostic: w.diagnostic };
    };
    expect(runTaskTests(mod("upstream-capstone-40.anma"), task, { witness }).passed).toBe(true);
    const r = runTaskTests(streaming(), task, { witness });
    expect(r.passed).toBe(false);
    expect(r.cases.find((c) => c.kind === "witness")?.passed).toBe(false);
    // the unrestricted task accepts the streaming algorithm and awards no certificate
    expect(runTaskTests(streaming(), TASK_BY_ID.get("capstone-40-unrestricted")!, { witness }).passed).toBe(true);
  });
  it("runtime scale: a 10,000-value capstone generated in-test", () => {
    const K = 10_000;
    const m = mustValidate(capstoneK(K), { limits: { importedExecutableBytes: 1 << 20 } });
    expect(capstoneWitness(m, K, 17).ok).toBe(true);
    const r = runFinite(m, [u(3)], { config: { fastSlots: 64 } });
    expect(r.returnValue).toEqual(u(capstoneOracle(3n, K)));
    expect(r.counters.peakLiveValues).toBeGreaterThanOrEqual(K);
    expect(r.counters.backingWrites).toBeGreaterThan(K - 64);
  });
});

describe("ANMR-1 matched register control", () => {
  it.each([4, 8, 16, 32])("capstone at R=%i validates, runs, and has the witness", (R) => {
    const b = bytes(`anmr-capstone-r${R}.anmr`);
    expect(Array.from(b)).toEqual(Array.from(anmrCapstone(R)));
    const v = validateAnmr(b);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    for (const x of [1n, 0x0000123400005678n, (1n << 64n) - 1n]) expect(runAnmr(v.program, x).value).toBe(capstoneOracle(x));
    const r = runAnmr(v.program, 7n);
    const spilled = 40 - Math.min(40, R - 4);
    expect(r.counters.saves).toBe(spilled);
    expect(r.counters.restores).toBe(spilled);
    const w = anmrWitness(v.program, 40, 17);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.certificate.spills).toBe(spilled);
  });
  it("traps uninitialized reads and rejects bad registers/slots/opcodes", () => {
    const b = anmrCapstone(4);
    const dv = new DataView(b.buffer);
    const good = validateAnmr(b);
    expect(good.ok).toBe(true);
    const bad = b.slice();
    new DataView(bad.buffer).setUint32(32 + 16 * 4 + 8, 9, true); // ADD r?, r9, r3 with R = 4
    expect(validateAnmr(bad).diagnostics[0]?.rule).toBe("ANMR-V-004");
    const op = b.slice();
    new DataView(op.buffer).setUint32(32 + 16 * 3, 0x99, true);
    expect(validateAnmr(op).diagnostics[0]?.rule).toBe("ANMR-V-006");
    // uninitialized: make the first ADD read r2 (never written yet)
    const un = b.slice();
    new DataView(un.buffer).setUint32(32 + 16 * 4 + 12, 2, true);
    const vu = validateAnmr(un);
    expect(vu.ok).toBe(true);
    if (vu.ok) expect(runAnmr(vu.program, 1n).trap?.rule).toBe("ANMR-R-001");
    void dv;
  });
  it("the ANMR witness tracks spill provenance and rejects recomputation", () => {
    // recompute: replace a RESTORE with a fresh CONST+ADD (x + i recomputed instead of restored)
    const v = validateAnmr(anmrCapstone(4));
    if (!v.ok) throw new Error();
    const p = { ...v.program, instrs: [...v.program.instrs] };
    const idx = p.instrs.findIndex((i) => i.k === "restore");
    const slot = (p.instrs[idx] as { slot: number }).slot;
    p.instrs.splice(idx, 1, { k: "const", rd: 3, value: BigInt(slot), rec: -1 }, { k: "bin", op: 0x20, rd: 3, ra: 0, rb: 3, rec: -1 });
    expect(runAnmr(p, 5n).value).toBe(capstoneOracle(5n)); // same value…
    expect(anmrWitness(p, 40, 17).ok).toBe(false); // …but not the prescribed structure
  });
});

describe("machine-invariance track", () => {
  it("capstone: identical semantics at every F; real backing traffic below the live set", () => {
    const rep = runInvariance(mod("upstream-capstone-40.anma"), [u(0x0000123400005678n)]);
    expect(rep.semanticAgreement).toBe(true);
    expect(rep.reference.returnValue).toBe("13514254791259192080");
    expect(rep.missingBackingActivity).toEqual([]);
    expect(rep.rows.find((r) => r.F === 4)!.counters.backingWrites).toBeGreaterThan(0);
    expect(rep.rows.find((r) => r.F === 64)!.counters.backingWrites).toBe(0);
  });
  it.each([
    ["hello.anma", []],
    ["fizzbuzz.anma", [u(30)]],
    ["fibonacci.anma", [u(12)]],
    ["checkerboard.anma", []],
    ["ring-mix-k40.anma", [u(1)]],
  ] as const)("%s", (file, inputs) => {
    const rep = runInvariance(mod(file), inputs as never);
    expect(rep.semanticAgreement).toBe(true);
    expect(rep.resourceLimited).toEqual([]);
  });
  it("ball/paddle replays identically from recorded ticks at every F", () => {
    const ticks = TASK_BY_ID.get("ball-paddle")!.visible[0]!.ticks!;
    const rep = runInvariance(mod("ball-paddle.anma"), [], { ticks, Fs: [1, 8, 64] });
    expect(rep.semanticAgreement).toBe(true);
    expect(rep.reference.status).toBe("halted");
  });
  it("ring mix matches the upstream oracle across the K set at F=16", () => {
    for (const K of [2, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 96]) {
      const r = runFinite(mod(`ring-mix-k${K}.anma`), [u(1)], { config: { fastSlots: 16 } });
      expect(r.returnValue, `K=${K}`).toEqual(u(ringMixOracle(1n, K)));
      if (K + 1 > 16) expect(r.counters.backingWrites, `K=${K}`).toBeGreaterThan(0);
    }
  });
});
