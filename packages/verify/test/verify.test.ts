import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { DEFAULT_LIMITS } from "@llmtobinary/spec";
import { parseAnnotations, type ParsedAnnotations } from "@llmtobinary/annotations";
import { runToCompletion } from "@llmtobinary/reference";
import { ModuleBuilder, type V } from "@llmtobinary/fixture-builder";
import { TASK_BY_ID, TASK_CONTRACT_LIMITS } from "@llmtobinary/tasks";
import { nodeZ3Backend } from "@llmtobinary/verify/node";
import { generateVcs, verifyFunction } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, root)));
const mod = (name: string) => mustValidate(bytes(name));

function ann(params: string[], ensures: string, extra: Partial<ParsedAnnotations> = {}, fn = 0): ParsedAnnotations {
  const raw = { summary: "", params: params.map((name, index) => ({ function: fn, index, name })), records: [], contracts: [{ function: fn, requires: null, ensures }], invariants: [], examples: [], ...extra };
  const p = parseAnnotations(raw, { ...DEFAULT_LIMITS, annotationBytes: 1 << 22, contractExpressionBytes: 1 << 20 });
  if (!p.ok || !p.annotations) throw new Error(JSON.stringify(p.diagnostics));
  return p.annotations;
}
const taskAnn = (id: string) => {
  const t = TASK_BY_ID.get(id)!;
  return ann(t.paramNames, t.referenceContract!);
};

describe("T3 verification with z3", () => {
  it("proves the reference contracts of return-42 and square-plus-two", async () => {
    const z3 = await nodeZ3Backend();
    for (const [file, id] of [["return-42.anma", "return-42"], ["square-plus-two.anma", "square-plus-two"]] as const) {
      const r = await verifyFunction(mod(file), taskAnn(id), 0, z3, { contractOwner: "task" });
      expect(r.overall, file).toBe("proved");
      expect(r.label).toBe("proved to meet the task specification for all inputs (partial correctness)");
    }
  }, 120_000);

  it("proves the exact capstone against the task's closed-form contract", async () => {
    const z3 = await nodeZ3Backend();
    const r = await verifyFunction(mod("upstream-capstone-40.anma"), taskAnn("capstone-40"), 0, z3, { contractOwner: "task", parseLimits: TASK_CONTRACT_LIMITS, timeoutMs: 60_000 });
    expect(r.overall).toBe("proved");
  }, 180_000);

  it("refutes seeded wrong variants with counterexamples that T2 confirms", async () => {
    const z3 = await nodeZ3Backend();
    const b = bytes("square-plus-two.anma");
    b[32 + 5 * 16] = 0x21; // ADD -> SUB
    const m = mustValidate(b);
    const r = await verifyFunction(m, taskAnn("square-plus-two"), 0, z3, { contractOwner: "task" });
    expect(r.overall).toBe("refuted");
    const cex = r.outcomes.find((o) => o.status === "refuted")!.counterexample!;
    expect(cex).toHaveLength(1);
    const run = runToCompletion(m, [{ t: "u64", v: cex[0]! }]);
    const n = BigInt(cex[0]!);
    expect(run.returnValue).not.toEqual({ t: "u64", v: String((n * n + 2n) & ((1n << 64n) - 1n)) });
    expect(r.diagnostics[0]!.rule).toBe("ANMA-K-007");
    // model-owned label differs from the task label
    const wrongConst = bytes("return-42.anma");
    wrongConst[32 + 2 * 16 + 8] = 21;
    const r2 = await verifyFunction(mustValidate(wrongConst), ann([], "(eq result 42)"), 0, z3, { contractOwner: "model" });
    expect(r2.overall).toBe("refuted");
  }, 120_000);

  it("proves a loop with an inductive invariant and flags a non-inductive one", async () => {
    const z3 = await nodeZ3Backend();
    // acc = 5 * n via a loop: header block1(i, acc, n)
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b0 = f.block();
    const loop = f.block(["u64", "u64", "u64"]);
    const done = f.block(["u64"]);
    b0.jump(loop, [b0.const(0), b0.const(0), b0.params[0]!]);
    const [i, acc, n] = loop.params as [V, V, V];
    loop.brIf(loop.lt(i, n), loop, [loop.add(i, loop.const(1)), loop.add(acc, loop.const(5)), n], done, [acc]);
    done.ret(done.params[0]!);
    const m = mustValidate(mb.build());
    const good = ann(["n"], "(eq result (mul 5 n))", { invariants: [{ function: 0, block: 1, expr: "(and (and (eq bp2 n) (le bp0 bp2)) (eq bp1 (mul 5 bp0)))" }] });
    const r = await verifyFunction(m, good, 0, z3, { contractOwner: "model", timeoutMs: 30_000 });
    expect(["proved", "unknown"]).toContain(r.overall);
    expect(r.overall).toBe("proved");
    const weak = ann(["n"], "(eq result (mul 5 n))", { invariants: [{ function: 0, block: 1, expr: "(eq bp2 n)" }] });
    const r2 = await verifyFunction(m, weak, 0, z3, { contractOwner: "model" });
    expect(r2.overall).toBe("refuted");
    expect(r2.outcomes.some((o) => o.status === "refuted" && !o.concrete)).toBe(true);
  }, 180_000);

  it("reports eligibility honestly", () => {
    expect(generateVcs(mod("fizzbuzz.anma"), ann(["n"], "true"), 0).eligibility.eligible).toBe(false);
    const noInv = generateVcs(mod("ring-mix-k4.anma"), ann(["x"], "true"), 0).eligibility;
    expect(noInv.eligible === false && noInv.reason).toMatch(/loop header without an invariant/);
  });

  it("a timeout is unknown, never proved", async () => {
    const r = await verifyFunction(mod("square-plus-two.anma"), taskAnn("square-plus-two"), 0, { id: "stub", check: async () => ({ status: "unknown" }) }, { contractOwner: "task" });
    expect(r.overall).toBe("unknown");
    expect(r.diagnostics[0]!.rule).toBe("ANMA-K-008");
  });
});
