import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCandidate } from "../src/index.ts";
import { toHex } from "@llmtobinary/decode";

const root = new URL("../../../fixtures/", import.meta.url);
const load = (name: string) => new Uint8Array(readFileSync(new URL(name, root)));

const sq = load("square-plus-two.anma");
const claims = [
  "(FUNC fn0 1 u64)",
  "(BLOCK block0 1 4)",
  "(PARAM v0 u64 0)",
  "(MUL_U64 v1 v0 v0)",
  "(CONST_U64 v2 2)",
  "(ADD_U64 v3 v1 v2)",
  "(HOST _ terminal.print_u64 1)",
  "(ARG v3)",
  "(RETURN v3)",
  "(END_FUNC)",
];
const annotations = {
  summary: "Returns n*n + 2 (mod 2^64) and prints it once.",
  params: [{ function: 0, index: 0, name: "n" }],
  records: claims.map((claim, index) => ({ index, claim, note: null })),
  contracts: [{ function: 0, requires: null, ensures: "(eq result (add (mul n n) 2))" }],
  invariants: [],
  examples: [
    { inputs: ["12"], result: "146", terminal: "146" },
    { inputs: ["4294967296"], result: "2", terminal: "2" },
  ],
};

describe("check_candidate pipeline", () => {
  it("PRD 17.1: the annotated square-plus-two submission is clean and T1 matches every claim", async () => {
    const out = await checkCandidate({ envelopeText: JSON.stringify({ isa: "ANMA-1", hex: toHex(sq), annotations }) });
    expect(out.report.errors).toEqual([]);
    expect(out.report.ok).toBe(true);
    expect(out.report.sha256).toBe("d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1");
    expect(out.report.annotations).toMatchObject({ present: true, claimsChecked: 10, claimsMatched: 10 });
    expect(out.module).not.toBeNull();
    expect(out.report.listing).toContain("(HOST _ terminal.print_u64 1)");
  });

  it("PRD 17.2: missing ARG -> length mismatch, then ARG-001 with the model's claim attached", async () => {
    const bad = new Uint8Array([...sq.subarray(0, 144), ...sq.subarray(160)]);
    const out = await checkCandidate({ envelope: { isa: "ANMA-1", hex: toHex(bad), annotations } });
    const r = out.report;
    expect(r.ok).toBe(false);
    expect(r.byteLength).toBe(176);
    expect(r.errors.map((d) => d.rule)).toEqual(["ANMA-V-HDR-004", "ANMA-V-ARG-001"]);
    expect(r.errors[1]!.claim).toBe("(ARG v3)");
    expect(r.errors[1]!.context).toContain("> 7 @144");
    expect(r.suppressed).toBe(3); // claim 7 and 8 mismatches and claim 9 (no record) are cascades
    expect(JSON.stringify(r)).not.toMatch(/"hex"/);
  });

  it("T1 catches meant-ADD-wrote-SUB even though SUB is valid", async () => {
    const mutated = sq.slice();
    mutated[32 + 5 * 16] = 0x21;
    const out = await checkCandidate({ envelope: { isa: "ANMA-1", hex: toHex(mutated), annotations } });
    expect(out.report.errors.map((d) => d.rule)).toEqual(["ANMA-A-004"]);
    expect(out.report.errors[0]!.derived).toContain("opcode byte is 0x21 (SUB_U64), claim says 0x20 (ADD_U64)");
  });

  it("rejects 0x prefixes, odd digits, and unknown envelope keys without repairing", async () => {
    expect((await checkCandidate({ hex: "0x41 0x4e" })).report.errors[0]!.rule).toBe("ANMA-T-001");
    expect((await checkCandidate({ hex: "414" })).report.errors[0]!.rule).toBe("ANMA-T-002");
    expect((await checkCandidate({ envelope: { isa: "ANMA-1", hex: "00", extra: 1 } })).report.errors[0]!.rule).toBe("ANMA-T-006");
  });
});

describe("misaligned drafts (stray bytes)", () => {
  it("reports the length error and one record hint; later garbage is suppressed as cascade", async () => {
    const sq2 = sq.slice(0, 184);
    const out = await checkCandidate({ bytes: sq2 });
    expect(out.report.errors[0]!.rule).toBe("ANMA-V-HDR-004");
    expect(out.report.errors[0]!.derived).toContain("stray bytes");
    expect(out.report.errors.length).toBeLessThanOrEqual(2);
  });
});

describe("PRD Section 17.2 reproduces exactly", () => {
  it("the report printed in the PRD equals the checker's output", async () => {
    const prd = readFileSync(new URL("../../../PRD.md", import.meta.url), "utf8");
    const at = prd.indexOf("### 17.2 A malformed draft");
    const block = prd.slice(prd.indexOf("```json", at) + 7, prd.indexOf("```", prd.indexOf("```json", at) + 7));
    const printed = JSON.parse(block);
    const bad = new Uint8Array([...sq.subarray(0, 144), ...sq.subarray(160)]);
    const out = await checkCandidate({ envelope: { isa: "ANMA-1", hex: toHex(bad), annotations: { ...annotations, examples: [] } } });
    expect(out.report.errors).toEqual(printed.errors);
    expect(out.report.suppressed).toBe(printed.suppressed);
    expect(out.report.sha256).toBe(printed.sha256);
    expect(out.report.annotations).toEqual(printed.annotations);
  });
});

describe("zero padding", () => {
  it("the length diagnostic says how many decodable records are all zero bytes", async () => {
    const padded = new Uint8Array(sq.length + 48 + 8);
    padded.set(sq);
    const out = await checkCandidate({ bytes: padded });
    expect(out.report.errors[0]!.rule).toBe("ANMA-V-HDR-004");
    expect(out.report.errors[0]!.derived).toContain("3 of the decodable records are all zero bytes");
  });
});
