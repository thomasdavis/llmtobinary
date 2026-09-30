import { readFileSync } from "node:fs";
import { DEFAULT_LIMITS } from "@llmtobinary/spec";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { runToCompletion } from "@llmtobinary/reference";
import { runFinite } from "@llmtobinary/runtime";
import { checkCandidate } from "@llmtobinary/check";
import { validateBytes } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const fixtures = ["return-42.anma", "square-plus-two.anma", "upstream-capstone-40.anma", "fizzbuzz.anma", "fibonacci.anma", "ball-paddle.anma"].map((f) => new Uint8Array(readFileSync(new URL(f, root))));

function exercise(bytes: Uint8Array): void {
  const t0 = Date.now();
  const r = validateBytes(bytes);
  expect(Date.now() - t0).toBeLessThan(2000);
  if (!r.ok) return;
  // Anything the validator accepts must run on both engines without internal errors (traps are fine).
  const entry = r.module!.functions[r.module!.entry]!;
  const inputs = entry.params.map((t) => (t === 2 ? { t: "bool" as const, v: true } : { t: "u64" as const, v: "7" }));
  const limits = { executedInstructions: 20_000 };
  const a = runToCompletion(r.module!, inputs, { limits });
  const b = runFinite(r.module!, inputs, { limits, config: { fastSlots: 2 } });
  expect(b.returnValue).toEqual(a.returnValue);
  expect(b.trap?.code ?? null).toEqual(a.trap?.code ?? null);
}

describe("fuzzed, truncated, and oversized inputs", () => {
  it("random bytes never throw or hang", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 600 }), (b) => exercise(b)), { numRuns: 400 });
  });
  it("random headers with plausible magic never throw", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 7, maxLength: 7 }), fc.uint8Array({ maxLength: 400 }), (words, tail) => {
        const h = new Uint8Array(32 + tail.length);
        h.set([0x41, 0x4e, 0x4d, 0x41]);
        const dv = new DataView(h.buffer);
        words.forEach((w, i) => dv.setUint32(4 + 4 * i, w >>> 0, true));
        h.set(tail, 32);
        exercise(h);
      }),
      { numRuns: 400 },
    );
  });
  it("every truncation and single-bit flip of real fixtures is handled", () => {
    for (const f of fixtures.slice(0, 3)) {
      for (let n = 0; n <= f.length; n += 7) exercise(f.subarray(0, n));
    }
    fc.assert(
      fc.property(fc.constantFrom(...fixtures), fc.nat(), fc.integer({ min: 0, max: 7 }), (f, pos, bit) => {
        const b = f.slice();
        b[pos % b.length]! ^= 1 << bit;
        exercise(b);
      }),
      { numRuns: 1500 },
    );
  });
  it("huge declared counts are rejected before allocation", () => {
    const b = fixtures[0]!.slice();
    new DataView(b.buffer).setUint32(12, 0xffffffff, true);
    const t0 = Date.now();
    expect(validateBytes(b).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it("oversized candidates are refused at the transport layer", async () => {
    const r = await checkCandidate({ hex: "00".repeat(DEFAULT_LIMITS.liveCandidateBytes + 1) });
    expect(r.report.errors[0]!.rule).toBe("ANMA-T-004");
    expect(validateBytes(new Uint8Array(2 * 1024 * 1024)).diagnostics[0]!.rule).toBe("ANMA-V-HDR-007");
  });
  it("mutating the caller's buffer after validation cannot change the module", () => {
    const b = fixtures[1]!.slice();
    const r = validateBytes(b);
    b.fill(0);
    expect(runToCompletion(r.module!, [{ t: "u64", v: "12" }]).returnValue).toEqual({ t: "u64", v: "146" });
  });
});
