import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mustValidate, validateBytes } from "@llmtobinary/validate";
import { validateAnmr } from "@llmtobinary/research";
import { parseAnnotations } from "@llmtobinary/annotations";
import { capstoneK } from "../../../tools/fixture-builder/src/fixtures.ts";
import { ModuleBuilder } from "@llmtobinary/fixture-builder";
import { TASKS, TASK_BY_ID, redactForModel, runTaskTests, taskPromptText, capstoneOracle, ringMixOracle, fizzbuzzOracle, holdoutCases } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, root)));
const mod = (name: string) => mustValidate(bytes(name));

describe("oracles are independent of the interpreters and match upstream constants", () => {
  it("capstone", () => {
    expect(capstoneOracle(0x0000123400005678n)).toBe(13514254791259192080n);
    expect(capstoneOracle(1n)).toBe(8313107083524001560n);
  });
  it("ring mix K=2 degenerates exactly like the C source (v_i ^= v_i)", () => {
    // v0 += v1*3; v0 ^= v0 (-> 0); v1 += v0*3; v1 ^= v1 (-> 0); fold = 0
    expect(ringMixOracle(5n, 2)).toBe(0n);
  });
  it("fizzbuzz text", () => {
    expect(fizzbuzzOracle(15n)).toBe("1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n");
  });
  it("holdouts are deterministic from the recorded seed", () => {
    const t = TASK_BY_ID.get("square-plus-two")!;
    expect(holdoutCases(t)).toEqual(holdoutCases(t));
    expect(holdoutCases(t).length).toBe(t.holdout.include.length + t.holdout.count);
  });
});

describe("every task's developer fixture passes its task", () => {
  const publicTasks = TASKS.filter((t) => t.fixture && !(t.tier === "research" && /k(256|1024|64|96|48)$/.test(t.id)));
  it.each(publicTasks.map((t) => [t.id, t] as const))("%s", (_id, task) => {
    const m = mod(task.fixture!);
    const r = runTaskTests(m, task);
    const failures = r.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.diagnostic?.message}`);
    expect(failures).toEqual([]);
    expect(r.passed).toBe(true);
    if (task.referenceContract) {
      expect(r.contractOwner).toBe("task");
      expect(r.tier).toBe("T2");
    }
  });
  it("research-scale fixtures pass too", () => {
    for (const id of ["capstone-k256", "capstone-k1024", "ring-mix-k48", "ring-mix-k96"]) {
      const t = TASK_BY_ID.get(id)!;
      expect(runTaskTests(mod(t.fixture!), t, { includeHoldout: false }).passed, id).toBe(true);
    }
  });
});

describe("the runner catches wrong programs", () => {
  const task = TASK_BY_ID.get("square-plus-two")!;
  it("wrong arithmetic -> WRONG_RESULT, and the reference contract is violated", () => {
    const b = bytes("square-plus-two.anma");
    b[32 + 5 * 16] = 0x21; // ADD -> SUB
    const r = runTaskTests(mustValidate(b), task);
    expect(r.passed).toBe(false);
    const rules = new Set(r.diagnostics.map((d) => d.rule));
    expect(rules.has("ANMA-K-001")).toBe(true);
    expect(rules.has("ANMA-K-006")).toBe(true);
  });
  it("hard-coded answers pass visible tests but fail holdouts; redaction hides holdout details", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b0 = f.block();
    const v = b0.const(146);
    b0.host("terminal.print_u64", [v]);
    b0.ret(v);
    const r = runTaskTests(mustValidate(mb.build()), task);
    expect(r.passed).toBe(false);
    const red = redactForModel(r);
    const hold = red.cases.filter((c) => c.kind === "holdout" && !c.passed);
    expect(hold.length).toBeGreaterThan(0);
    for (const c of hold) {
      expect(c.inputs).toEqual([]);
      expect(c.expected).toBeNull();
      expect(JSON.stringify(c)).not.toMatch(/18446744073709551615|4294967295/);
    }
  });
  it("framebuffer mismatches get pixel-level diagnostics (count, bounding box, first pixel)", () => {
    const b = bytes("checkerboard.anma");
    const dv = new DataView(b.buffer);
    for (let off = 32; off + 16 <= b.length; off += 16) {
      if (dv.getUint32(off, true) === 0x10 && dv.getUint32(off + 8, true) === 4 && dv.getUint32(off + 12, true) === 0) dv.setUint32(off + 8, 3, true); // cells of 8 instead of 16
    }
    const r = runTaskTests(mustValidate(b), TASK_BY_ID.get("checkerboard")!);
    const d = r.diagnostics.find((x) => x.rule === "ANMA-K-002")!;
    expect(d.message).toMatch(/differs from the task oracle in \d+ of 36864 pixels/);
    expect(d.found).toMatch(/^first difference at \(x=\d+, y=\d+\): your pixel is 0x[0-9a-f]{8}$/);
    expect(d.derived).toMatch(/differences span x \d+\.\.\d+, y \d+\.\.\d+/);
  });

  it("signature mismatch stops early", () => {
    const r = runTaskTests(mod("return-42.anma"), task);
    expect(r.diagnostics[0]!.rule).toBe("ANMA-K-003");
  });
  it("wrong effects: printing twice", () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b = f.block();
    const n = b.params[0]!;
    const r2 = b.add(b.mul(n, n), b.const(2));
    b.host("terminal.print_u64", [r2]);
    b.host("terminal.print_u64", [r2]);
    b.ret(r2);
    const r = runTaskTests(mustValidate(mb.build()), task);
    expect(r.diagnostics.some((d) => d.rule === "ANMA-K-002")).toBe(true);
  });
  it("model examples and contracts feed the report (T2, model owner for open tasks)", () => {
    const m = mod("square-plus-two.anma");
    const p = parseAnnotations({
      summary: "",
      params: [{ function: 0, index: 0, name: "n" }],
      records: [],
      contracts: [{ function: 0, requires: null, ensures: "(eq result (add (mul n n) 2))" }],
      invariants: [],
      examples: [{ inputs: ["3"], result: "11", terminal: "11" }, { inputs: ["4"], result: "99", terminal: null }],
    });
    const r = runTaskTests(m, null, { annotations: p.annotations });
    expect(r.passed).toBe(false);
    expect(r.diagnostics.map((d) => d.rule)).toContain("ANMA-K-005");
    const ok = parseAnnotations({ summary: "", params: [{ function: 0, index: 0, name: "n" }], records: [], contracts: [{ function: 0, requires: null, ensures: "(eq result (add (mul n n) 2))" }], invariants: [], examples: [{ inputs: ["3"], result: "11", terminal: "11" }] });
    const r2 = runTaskTests(m, null, { annotations: ok.annotations, claims: { checked: 10, matched: 10 } });
    expect(r2.passed).toBe(true);
    expect(r2.tier).toBe("T2");
    expect(r2.contractOwner).toBe("model");
    expect(r2.taskId).toBeNull();
  });
});

describe("fixtures and prompts", () => {
  it("capstoneK(40) from the builder is byte-identical to the upstream fixture", () => {
    expect(Array.from(capstoneK(40))).toEqual(Array.from(bytes("upstream-capstone-40.anma")));
  });
  it("committed tool-created fixtures are up to date", () => {
    execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "tools/fixture-builder/src/build-fixtures.ts", "--check"], { cwd: new URL("../../../", import.meta.url) });
  });
  it("every manifest fixture validates and matches its hash", async () => {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
    for (const f of manifest.fixtures) {
      const b = bytes(f.file);
      expect(b.length).toBe(f.bytes);
      expect(f.isa === "ANMR-1" ? validateAnmr(b).ok : validateBytes(b).ok, f.file).toBe(true);
      expect(f.provenance.modelOutput).toBe(false);
    }
  });
  it("prompt text lists signature and devices, never holdouts", () => {
    const t = TASK_BY_ID.get("square-plus-two")!;
    const text = taskPromptText(t, { requireClaims: true });
    expect(text).toContain("fn0(n: u64) -> u64");
    expect(text).toContain("terminal");
    expect(text).toContain("Record claims are required");
    expect(text).not.toContain("18446744073709551615");
  });
});

describe("a program that plays the game but never draws gets a plain diagnosis, not two hashes", () => {
  it("names the missing drawing (the exact failure seen from a live model)", async () => {
    const task = TASK_BY_ID.get("ball-paddle")!;
    const { ballPaddleOracle } = await import("../src/oracles.ts");
    const score = ballPaddleOracle(task.visible[0]!.ticks ?? []).result;
    // Waits for ticks and returns the right score on Escape, but has no display calls at all.
    const mb = new ModuleBuilder();
    const f = mb.func([], "u64");
    const b0 = f.block();
    const loop = f.block();
    const done = f.block();
    b0.jump(loop, []);
    loop.host("input.wait_tick", []);
    const esc = loop.host("input.key_down", [loop.const(6)])!;
    loop.brIf(esc, done, [], loop, []);
    done.ret(done.const(BigInt(score)));
    const report = runTaskTests(mustValidate(mb.build()), task, { includeHoldout: false });
    const d = report.cases[0]!.diagnostic!;
    expect(d.rule).toBe("ANMA-K-002");
    expect(d.message).toContain("never draws");
    expect(d.found).toContain("blank framebuffer");
    expect(d.found).not.toContain("sha256");
  });
});

describe("open tasks: model examples for programs that run until input ends them", () => {
  // Like the visitor's "snake runs forever" prompt: draw, wait for a tick, repeat; never returns.
  const forever = () => {
    const mb = new ModuleBuilder();
    const f = mb.func(["u64"], "u64");
    const b0 = f.block();
    const loop = f.block();
    b0.jump(loop, []);
    loop.host("display.clear", [loop.const(0x000000ff)]);
    loop.host("display.present", []);
    loop.host("input.wait_tick", []);
    loop.jump(loop, []);
    return mustValidate(mb.build());
  };
  const ann = (result: string | null) =>
    parseAnnotations({ summary: "", params: [{ function: 0, index: 0, name: "seed" }], records: [], contracts: [], invariants: [], examples: [{ inputs: ["0"], result, terminal: null }] }).annotations!;

  it("an example that claims nothing holds while the program waits for input", () => {
    const r = runTaskTests(forever(), null, { annotations: ann(null), allowedFeatures: 0xf });
    expect(r.passed).toBe(true);
    expect(r.cases[0]!.actual).toBe("waiting for input");
  });
  it("a claimed result is reported as never returned, with the reason", () => {
    const r = runTaskTests(forever(), null, { annotations: ann("5"), allowedFeatures: 0xf });
    expect(r.passed).toBe(false);
    expect(r.cases[0]!.diagnostic!.message).toContain("still waiting for input (examples run with no input ticks)");
  });
  it("the open-task prompt tells the model how examples run when input is permitted", async () => {
    const { openTaskPromptText } = await import("../src/registry.ts");
    expect(openTaskPromptText("snake", ["u64"], "u64", 0xc)).toContain("NO input ticks");
    expect(openTaskPromptText("digits", ["u64"], "u64", 0x2)).not.toContain("NO input ticks");
  });
});
