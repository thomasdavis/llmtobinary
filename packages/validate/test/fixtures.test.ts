import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateBytes } from "../src/index.ts";
import { assemble } from "@llmtobinary/diagnostics";

const root = new URL("../../../fixtures/", import.meta.url);
const load = (name: string) => new Uint8Array(readFileSync(new URL(name, root)));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("bundled fixtures", () => {
  it.each([
    ["return-42.anma", 144, "cb05d607bc9708d41340eb0eadfb80dca4dc8153f23e51af319ad3a6a01e1bd8"],
    ["square-plus-two.anma", 192, "d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1"],
    ["upstream-capstone-40.anma", 2704, "d6e710f149bac62226ad57f9d3a2f4e4bf958cebbf3727994f0ec5477013e88a"],
  ])("%s validates unchanged", (name, len, hash) => {
    const bytes = load(name);
    expect(bytes.length).toBe(len);
    expect(sha(bytes)).toBe(hash);
    const r = validateBytes(bytes);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(sha(bytes)).toBe(hash); // validation never mutates caller bytes
  });

  it("square-plus-two has the expected IR", () => {
    const m = validateBytes(load("square-plus-two.anma")).module!;
    expect(m.functions).toHaveLength(1);
    const b = m.functions[0]!.blocks[0]!;
    expect(b.params).toEqual([1]);
    expect(b.instrs.map((i) => i.k)).toEqual(["bin", "const", "bin", "host"]);
    expect(b.term).toMatchObject({ k: "ret", src: 3 });
    expect(b.uses).toEqual([2, 1, 1, 2]);
  });

  it("capstone has 163 values in one block", () => {
    const m = validateBytes(load("upstream-capstone-40.anma")).module!;
    expect(m.functions[0]!.blocks[0]!.types).toHaveLength(163);
  });
});

describe("PRD 17.2 malformed draft (missing ARG after HOST)", () => {
  const good = load("square-plus-two.anma");
  const bad = new Uint8Array([...good.subarray(0, 144), ...good.subarray(160)]);
  it("reports length mismatch then the missing ARG, root cause first", () => {
    expect(bad.length).toBe(176);
    expect(sha(bad)).toBe("402eb506b64f8dda3e5a9e6397abf73b8c8bad060b9e890643dee3443bb8cce6");
    const r = validateBytes(bad);
    expect(r.ok).toBe(false);
    const rep = assemble(r.diagnostics, { maxErrors: 12, maxBytes: 24_000 });
    expect(rep.errors.map((d) => d.rule)).toEqual(["ANMA-V-HDR-004", "ANMA-V-ARG-001"]);
    expect(rep.errors[0]!.derived).toContain("so the file holds 9 complete records");
    expect(rep.errors[1]!.location).toMatchObject({ byteOffset: 144, recordIndex: 7, functionId: 0, blockId: 0 });
    expect(rep.errors[1]!.found).toBe("record 7 is (RETURN v3)");
    expect(rep.errors[1]!.derived).toContain("matches header word 3");
  });
});
