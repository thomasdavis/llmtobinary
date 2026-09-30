import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { runToCompletion } from "@llmtobinary/reference";
import { ModuleBuilder, type V } from "@llmtobinary/fixture-builder";
import { checkContracts, createContractMonitor, evaluate, parseAnnotations, parseSpec, printSpec, typecheck, type ParsedAnnotations } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const mod = (name: string) => mustValidate(new Uint8Array(readFileSync(new URL(name, root))));
const M = (1n << 64n) - 1n;

const ev = (s: string, vals: Record<string, bigint | boolean> = {}, result: bigint | boolean | null = null) =>
  evaluate(parseSpec(s), new Map(Object.entries(vals)), result, { steps: 0, max: 10_000 });

function ann(partial: Partial<ParsedAnnotations>): ParsedAnnotations {
  const raw = { summary: "", params: [], records: [], contracts: [], invariants: [], examples: [], ...partial };
  const p = parseAnnotations(raw);
  if (!p.ok || !p.annotations) throw new Error("bad annotations");
  return p.annotations;
}

describe("ANMA-Spec", () => {
  it("evaluates with exact ISA semantics", () => {
    expect(ev("(add 18446744073709551615 2)")).toBe(1n);
    expect(ev("(sub 0 1)")).toBe(M);
    expect(ev("(shl 1 64)")).toBe(1n);
    expect(ev("(shr 256 68)")).toBe(16n);
    expect(ev("(rotl 5 0)")).toBe(5n);
    expect(ev("(rotr 1 1)")).toBe(1n << 63n);
    expect(ev("(eq (mul n n) 144)", { n: 12n })).toBe(true);
    expect(ev("(implies false (eq 1 2))")).toBe(true);
    expect(ev("(ite (lt 1 2) 7 8)")).toBe(7n);
    expect(ev("(eq result true)", {}, true)).toBe(true);
  });
  it("division by zero is an evaluation error, never true", () => {
    expect(() => ev("(eq (udiv 1 0) 0)")).toThrow(/by zero/);
    expect(() => ev("(or true (eq (urem 1 0) 0))")).toThrow(/by zero/);
  });
  it("rejects bad syntax, depth, and size with positions", () => {
    expect(() => parseSpec("(add 1)")).toThrow(/takes 2 arguments/);
    expect(() => parseSpec("(frob 1 2)")).toThrow(/unknown operator/);
    expect(() => parseSpec("(add 0x10 1)")).toThrow(/decimal u64 literal/);
    expect(() => parseSpec("(add 1 2")).toThrow(/missing "\)"/);
    expect(() => parseSpec("(not ".repeat(70) + "true" + ")".repeat(70))).toThrow(/deeper than 64/);
    expect(() => parseSpec("(add 1 1)".padEnd(5000, " "))).toThrow(/longer than/);
    expect(printSpec(parseSpec(" ( eq  result (add (mul n n) 2) ) "))).toBe("(eq result (add (mul n n) 2))");
  });
  it("typechecks without implicit conversions", () => {
    const env = { names: new Map([["n", "u64" as const], ["b", "bool" as const], ["h", "handle" as const]]), result: "u64" as const };
    expect(typecheck(parseSpec("(eq result (add n 1))"), env)).toBe("bool");
    expect(() => typecheck(parseSpec("(and n b)"), env)).toThrow(/must be bool/);
    expect(() => typecheck(parseSpec("(eq n b)"), env)).toThrow(/same type/);
    expect(() => typecheck(parseSpec("(eq h 1)"), env)).toThrow(/handle/);
    expect(() => typecheck(parseSpec("(eq result 1)"), { ...env, result: null })).toThrow(/only available in ensures/);
  });
});

describe("checkContracts", () => {
  const sq = mod("square-plus-two.anma");
  it("accepts the PRD 17.1 annotations", () => {
    const a = ann({
      params: [{ function: 0, index: 0, name: "n" }],
      contracts: [{ function: 0, requires: null, ensures: "(eq result (add (mul n n) 2))" }],
      examples: [{ inputs: ["12"], result: "146", terminal: "146" }, { inputs: ["4294967296"], result: "2", terminal: "2" }],
    });
    expect(checkContracts(a, sq)).toEqual([]);
  });
  it("reports parse, type, reference, and example errors with rule IDs", () => {
    const a = ann({
      params: [{ function: 0, index: 3, name: "q" }],
      contracts: [
        { function: 0, requires: "(lt n", ensures: null },
        { function: 0, requires: null, ensures: "(add result 1)" },
        { function: 9, requires: null, ensures: "true" },
      ],
      invariants: [{ function: 0, block: 5, expr: "true" }],
      examples: [{ inputs: ["-1"], result: "x", terminal: null }],
    });
    const rules = checkContracts(a, sq).map((d) => d.rule).sort();
    expect(rules).toEqual(["ANMA-A-002", "ANMA-A-002", "ANMA-A-002", "ANMA-A-007", "ANMA-A-008", "ANMA-A-010"].sort());
  });
});

describe("T2 runtime monitoring with the reference engine", () => {
  const sq = mod("square-plus-two.anma");
  it("holds on correct programs and counts checks", () => {
    const a = ann({ params: [{ function: 0, index: 0, name: "n" }], contracts: [{ function: 0, requires: "(lt n 100000)", ensures: "(eq result (add (mul n n) 2))" }] });
    const mon = createContractMonitor(a, sq);
    const r = runToCompletion(sq, [{ t: "u64", v: "12" }], { hooks: mon });
    expect(r.returnValue).toEqual({ t: "u64", v: "146" });
    expect(mon.diagnostics()).toEqual([]);
    expect(mon.checks()).toBe(2);
    expect(mon.held()).toBe(2);
  });
  it("reports violations with inputs, activation, and concrete values", () => {
    const a = ann({ params: [{ function: 0, index: 0, name: "n" }], contracts: [{ function: 0, requires: "(lt n 10)", ensures: "(eq result (add (mul n n) 3))" }] });
    const mon = createContractMonitor(a, sq);
    runToCompletion(sq, [{ t: "u64", v: "12" }], { hooks: mon });
    const d = mon.diagnostics();
    expect(d.map((x) => x.rule)).toEqual(["ANMA-K-006", "ANMA-K-006"]);
    expect(d[0]!.message).toContain("precondition excludes an input the task requires");
    expect(d[1]!.derived).toContain("result = 146");
    expect(d[1]!.derived).toContain("n = 12");
  });
  it("checks loop invariants at every block activation", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b0 = f.block();
    const loop = f.block(["u64", "u64", "u64"]);
    const done = f.block(["u64"]);
    b0.jump(loop, [b0.const(0), b0.const(0), b0.params[0]!]);
    const [i, acc, n] = loop.params as [V, V, V];
    const c = loop.lt(i, n);
    loop.brIf(c, loop, [loop.add(i, loop.const(1)), loop.add(acc, i), n], done, [acc]);
    done.ret(done.params[0]!);
    const m = mustValidate(mb.build());
    const good = ann({ params: [{ function: 0, index: 0, name: "n" }], invariants: [{ function: 0, block: 1, expr: "(and (le bp0 (add n 1)) (eq bp2 n))" }] });
    const mon = createContractMonitor(good, m);
    runToCompletion(m, [{ t: "u64", v: "10" }], { hooks: mon });
    expect(mon.diagnostics()).toEqual([]);
    expect(mon.checks()).toBe(11); // loop header activations for i = 0..10
    const bad = ann({ invariants: [{ function: 0, block: 1, expr: "(lt bp0 5)" }] });
    const mon2 = createContractMonitor(bad, m);
    runToCompletion(m, [{ t: "u64", v: "10" }], { hooks: mon2 });
    expect(mon2.diagnostics()[0]!.message).toContain("invariant of fn0 block 1");
  });
  it("is bounded by the contract step budget", () => {
    const a = ann({ contracts: [{ function: 0, requires: null, ensures: "(eq result (add (mul arg0 arg0) 2))" }] });
    const mon = createContractMonitor(a, sq, { maxSteps: 3 });
    runToCompletion(sq, [{ t: "u64", v: "1" }], { hooks: mon });
    expect(mon.diagnostics()[0]!.rule).toBe("ANMA-K-009");
  });
});
