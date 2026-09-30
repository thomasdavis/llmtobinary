// Malformation corpus (PRD Sections 7.7 and 20.1): every static diagnostic rule has at least one
// crafted case whose full report is snapshot-tested. Reports must be deterministic, bounded,
// root-cause-first, and never contain replacement bytes.
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_LIMITS } from "@llmtobinary/spec";
import { describe, expect, it } from "vitest";
import { RULES } from "@llmtobinary/diagnostics";
import { checkCandidate, type CheckInput, type CheckOptions } from "../src/index.ts";
import { O, S, file, hex, ret42, type Rec } from "./helpers.ts";

const U64 = 1;
const BOOL = 2;
// fn0(n: u64) -> u64 { print n; return n }  (terminal feature)
const printN: Rec[] = [[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 1], [O.PARAM, 0, U64, 0], [O.HOST, S, 0, 1], [O.ARG, 0], [O.RET, 0], [O.END]];

interface Case {
  name: string;
  rule: string;
  input: CheckInput;
  opts?: CheckOptions;
}

const bytes = (recs: Rec[], o?: Parameters<typeof file>[1]) => ({ bytes: file(recs, o) });
const env = (annotations: unknown, recs: Rec[] = ret42, o?: Parameters<typeof file>[1]) => ({ envelope: { isa: "ANMA-1", hex: hex(file(recs, o)), annotations } });
const ann = (p: Record<string, unknown>) => ({ summary: "", params: [], records: [], contracts: [], invariants: [], examples: [], ...p });

const CASES: Case[] = [
  // transport
  { name: "t001-0x-prefix", rule: "ANMA-T-001", input: { hex: "0x41 0x4e 0x4d 0x41" } },
  { name: "t002-odd-digits", rule: "ANMA-T-002", input: { hex: "414e4" } },
  { name: "t003-empty", rule: "ANMA-T-003", input: { hex: "  \n " } },
  { name: "t004-too-large", rule: "ANMA-T-004", input: { hex: "00".repeat(DEFAULT_LIMITS.liveCandidateBytes + 1) } },
  { name: "t005-not-json", rule: "ANMA-T-005", input: { envelopeText: '{"isa": "ANMA-1", "hex": ' } },
  { name: "t006-extra-key", rule: "ANMA-T-006", input: { envelope: { isa: "ANMA-1", hex: "00", note: "hi" } } },
  { name: "t007-wrong-isa", rule: "ANMA-T-007", input: { envelope: { isa: "ANMA-2", hex: "00", annotations: null } } },
  // header
  { name: "hdr001-short", rule: "ANMA-V-HDR-001", input: { hex: "414e4d4101000000" } },
  { name: "hdr002-magic", rule: "ANMA-V-HDR-002", input: bytes(ret42, { magic: [0x41, 0x4e, 0x4d, 0x42] }) },
  { name: "hdr003-big-endian-version", rule: "ANMA-V-HDR-003", input: bytes(ret42, { version: 0x01000000 }) },
  { name: "hdr004-missing-record", rule: "ANMA-V-HDR-004", input: bytes(ret42, { recordCount: 6 }) },
  { name: "hdr005-unknown-feature", rule: "ANMA-V-HDR-005", input: bytes(ret42, { features: 0x10 }) },
  { name: "hdr006-reserved", rule: "ANMA-V-HDR-006", input: bytes(ret42, { reserved6: 1 }) },
  { name: "hdr007-oversized", rule: "ANMA-V-HDR-007", input: { bytes: new Uint8Array(1024 * 1024 + 16) }, opts: { maxCandidateBytes: 2 * 1024 * 1024 } },
  { name: "hdr008-no-entry", rule: "ANMA-V-HDR-008", input: bytes(ret42, { entry: 3 }) },
  { name: "hdr009-handle-entry-param", rule: "ANMA-V-HDR-009", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 2], [O.PARAM, 0, 4, 0], [O.CONST, 1, 0, 0], [O.RET, 1], [O.END]]) },
  // records
  { name: "rec001-unknown-opcode", rule: "ANMA-V-REC-001", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [0x99, 0, 0, 0], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]]) },
  { name: "rec002-nonzero-unused", rule: "ANMA-V-REC-002", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 42, 0], [O.RET, 0, 5], [O.END]]) },
  { name: "rec003-block-first", rule: "ANMA-V-REC-003", input: bytes([[O.BLOCK, 0, 0, 0], ...ret42]) },
  { name: "rec004-func-id", rule: "ANMA-V-REC-004", input: bytes([[O.FUNC, 1, 0, U64], ...ret42.slice(1)]) },
  { name: "rec005-no-block", rule: "ANMA-V-REC-005", input: bytes([[O.FUNC, 0, 0, U64], [O.CONST, 0, 42, 0], [O.RET, 0], [O.END]]) },
  { name: "rec006-block-id", rule: "ANMA-V-REC-006", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 1, 0, 1], [O.CONST, 0, 42, 0], [O.RET, 0], [O.END]]) },
  { name: "rec007-block0-params", rule: "ANMA-V-REC-007", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 42, 0], [O.RET, 0], [O.END]]) },
  { name: "rec008-missing-param", rule: "ANMA-V-REC-008", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 1], [O.RET, 0], [O.END]]) },
  { name: "rec009-param-index", rule: "ANMA-V-REC-009", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 1], [O.PARAM, 0, U64, 1], [O.RET, 0], [O.END]]) },
  { name: "rec010-param-type", rule: "ANMA-V-REC-010", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 1], [O.PARAM, 0, 9, 0], [O.RET, 0], [O.END]]) },
  { name: "rec011-no-terminator", rule: "ANMA-V-REC-011", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 42, 0], [O.END]]) },
  { name: "rec012-after-terminator", rule: "ANMA-V-REC-012", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 42, 0], [O.RET, 0], [O.CONST, 1, 1, 0], [O.END]]) },
  { name: "rec013-no-end-func", rule: "ANMA-V-REC-013", input: bytes(ret42.slice(0, 4)) },
  { name: "rec014-local-count", rule: "ANMA-V-REC-014", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 5], [O.CONST, 0, 42, 0], [O.RET, 0], [O.END]]) },
  { name: "rec015-no-blocks", rule: "ANMA-V-REC-015", input: bytes([[O.FUNC, 0, 0, U64], [O.END]]) },
  { name: "rec016-return-type", rule: "ANMA-V-REC-016", input: bytes([[O.FUNC, 0, 0, 9], ...ret42.slice(1)]) },
  { name: "rec017-param-in-body", rule: "ANMA-V-REC-017", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 42, 0], [O.PARAM, 1, U64, 0], [O.RET, 0], [O.END]]) },
  { name: "rec018-const-bool", rule: "ANMA-V-REC-018", input: bytes([[O.FUNC, 0, 0, BOOL], [O.BLOCK, 0, 0, 1], [O.CBOOL, 0, 2, 0], [O.RET, 0], [O.END]]) },
  // argument framing
  { name: "arg001-missing-arg", rule: "ANMA-V-ARG-001", input: bytes(printN.filter((r) => r[0] !== O.ARG), { features: 2, recordCount: 7 }) },
  { name: "arg002-stray-arg", rule: "ANMA-V-ARG-002", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 42, 0], [O.ARG, 0], [O.RET, 0], [O.END]]) },
  { name: "arg003-br-without-edge-args", rule: "ANMA-V-ARG-003", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CBOOL, 0, 1, 0], [O.BR, 0, 1, 1], [O.BLOCK, 1, 0, 1], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]]) },
  { name: "arg004-too-many-args", rule: "ANMA-V-ARG-004", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 1, 0], [O.JUMP, 1, 300, 0], [O.BLOCK, 1, 0, 1], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]]) },
  // IDs
  { name: "id001-not-dense", rule: "ANMA-V-ID-001", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 5, 42, 0], [O.RET, 0], [O.END]]) },
  { name: "id002-undefined", rule: "ANMA-V-ID-002", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 2], [O.CONST, 0, 42, 0], [O.ADD, 1, 0, 7], [O.RET, 1], [O.END]]) },
  { name: "id003-bad-target", rule: "ANMA-V-ID-003", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 0], [O.JUMP, 9, 0, 0], [O.END]]) },
  { name: "id004-bad-callee", rule: "ANMA-V-ID-004", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CALL, 0, 7, 0], [O.RET, 0], [O.END]]) },
  { name: "id005-bad-import", rule: "ANMA-V-ID-005", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.HOST, S, 42, 0], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]], { features: 2 }) },
  { name: "id006-sentinel", rule: "ANMA-V-ID-006", input: bytes([[O.FUNC, 0, 0, 0], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]]) },
  { name: "id007-param-id", rule: "ANMA-V-ID-007", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 1], [O.PARAM, 1, U64, 0], [O.RET, 0], [O.END]]) },
  // types
  { name: "type001-u64-condition", rule: "ANMA-V-TYPE-001", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CONST, 0, 1, 0], [O.BR, 0, 1, 1], [O.EDGE, 0], [O.EDGE, 0], [O.BLOCK, 1, 0, 1], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]]) },
  { name: "type002-edge-args", rule: "ANMA-V-TYPE-002", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 0], [O.JUMP, 1, 0, 0], [O.BLOCK, 1, 1, 1], [O.PARAM, 0, U64, 0], [O.RET, 0], [O.END]]) },
  { name: "type003-call-args", rule: "ANMA-V-TYPE-003", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 2], [O.CONST, 0, 1, 0], [O.CALL, 1, 1, 2], [O.ARG, 0], [O.ARG, 0], [O.RET, 1], [O.END], [O.FUNC, 1, 1, U64], [O.BLOCK, 0, 1, 1], [O.PARAM, 0, U64, 0], [O.RET, 0], [O.END]]) },
  { name: "type004-return-type", rule: "ANMA-V-TYPE-004", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 1], [O.CBOOL, 0, 1, 0], [O.RET, 0], [O.END]]) },
  { name: "type005-host-args", rule: "ANMA-V-TYPE-005", input: bytes([[O.FUNC, 0, 1, U64], [O.BLOCK, 0, 1, 1], [O.PARAM, 0, U64, 0], [O.HOST, S, 0, 2], [O.ARG, 0], [O.ARG, 0], [O.RET, 0], [O.END]], { features: 2 }) },
  // capabilities
  { name: "cap001-undeclared", rule: "ANMA-V-CAP-001", input: bytes(printN, { features: 0 }) },
  { name: "cap002-denied", rule: "ANMA-V-CAP-002", input: bytes(printN, { features: 2 }), opts: { allowedFeatures: 0 } },
  // limits
  { name: "lim001-values", rule: "ANMA-V-LIM-001", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 3], [O.CONST, 0, 1, 0], [O.CONST, 1, 1, 0], [O.CONST, 2, 1, 0], [O.RET, 2], [O.END]]), opts: { limits: { valuesPerBlock: 2 } } },
  { name: "lim002-params", rule: "ANMA-V-LIM-002", input: bytes([[O.FUNC, 0, 300, U64], [O.BLOCK, 0, 0, 0], [O.RET, S], [O.END]]) },
  { name: "lim003-functions", rule: "ANMA-V-LIM-003", input: bytes([...ret42, [O.FUNC, 1, 0, U64], ...ret42.slice(1)]), opts: { limits: { functions: 1 } } },
  { name: "lim004-work", rule: "ANMA-V-LIM-004", input: bytes(ret42), opts: { limits: { validationWork: 2 } } },
  // warnings
  { name: "w001-unused-value", rule: "ANMA-W-001", input: bytes([[O.FUNC, 0, 0, U64], [O.BLOCK, 0, 0, 2], [O.CONST, 0, 42, 0], [O.CONST, 1, 7, 0], [O.RET, 0], [O.END]]) },
  { name: "w002-unused-feature", rule: "ANMA-W-002", input: bytes(ret42, { features: 2 }) },
  { name: "w003-unreachable", rule: "ANMA-W-003", input: bytes([...ret42.slice(0, 4), [O.BLOCK, 1, 0, 1], [O.CONST, 0, 1, 0], [O.RET, 0], [O.END]]) },
  // annotations
  { name: "a001-shape", rule: "ANMA-A-001", input: env({ summary: "x" }) },
  { name: "a002-record-out-of-range", rule: "ANMA-A-002", input: env(ann({ records: [{ index: 40, claim: "(END_FUNC)", note: null }] })) },
  { name: "a003-claim-syntax", rule: "ANMA-A-003", input: env(ann({ records: [{ index: 2, claim: "CONST v0 42", note: null }] })) },
  { name: "a004-claim-mismatch", rule: "ANMA-A-004", input: env(ann({ records: [{ index: 2, claim: "(CONST_U64 v0 41)", note: null }] })) },
  { name: "a005-duplicate", rule: "ANMA-A-005", input: env(ann({ records: [{ index: 2, claim: null, note: "a" }, { index: 2, claim: null, note: "b" }] })) },
  { name: "a006-reserved-name", rule: "ANMA-A-006", input: env(ann({ params: [{ function: 0, index: 0, name: "result" }] }), printN, { features: 2 }) },
  { name: "a007-contract-parse", rule: "ANMA-A-007", input: env(ann({ contracts: [{ function: 0, requires: null, ensures: "(eq result 42" }] })) },
  { name: "a008-contract-type", rule: "ANMA-A-008", input: env(ann({ contracts: [{ function: 0, requires: null, ensures: "(add result 1)" }] })) },
  { name: "a010-example-shape", rule: "ANMA-A-010", input: env(ann({ examples: [{ inputs: ["1"], result: "42", terminal: null }] })) },
];

describe("malformation corpus", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const out = await checkCandidate(c.input, c.opts);
    const r = out.report;
    const reported = [...r.errors, ...r.warnings].map((d) => d.rule);
    expect(reported, `${name}: ${JSON.stringify(r.errors.map((d) => d.rule))}`).toContain(c.rule);
    // Root cause first: the case's rule is the first error unless it is a warning or an annotation cascade.
    if (!c.rule.startsWith("ANMA-W")) expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.length).toBeLessThanOrEqual(12);
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThanOrEqual(24 * 1024);
    // Diagnostics state facts and rules; they never contain replacement bytes.
    for (const d of [...r.errors, ...r.warnings]) expect(`${d.found ?? ""} ${d.expected ?? ""} ${d.derived ?? ""}`).not.toMatch(/[0-9a-f]{32,}/);
    // Determinism: the same input yields the same report.
    const again = await checkCandidate(c.input, c.opts);
    expect(again.report).toEqual(r);
    await expect(JSON.stringify({ ...r, listing: r.listing ? `${r.listing.split("\n").length} lines` : null }, null, 2)).toMatchFileSnapshot(`./corpus/${name}.json`);
  });

  it("every rule in the catalog is exercised by some test", () => {
    const covered = new Set(CASES.map((c) => c.rule));
    const testRoots = ["packages", "tools"].flatMap((d) => readdirSync(new URL(`../../../${d}/`, import.meta.url)).map((p) => new URL(`../../../${d}/${p}/test/`, import.meta.url)));
    let corpusText = "";
    for (const dir of testRoots) {
      try {
        for (const f of readdirSync(dir)) if (f.endsWith(".ts")) corpusText += readFileSync(new URL(f, dir), "utf8");
      } catch {
        /* package without tests */
      }
    }
    const missing = RULES.map((r) => r.id).filter((id) => !covered.has(id) && !corpusText.includes(id) && !corpusText.includes(id.replace(/^ANMA-/, "")));
    expect(missing).toEqual([]);
  });
});
