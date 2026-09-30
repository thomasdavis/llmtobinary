import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { runToCompletion } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const mod = (name: string) => mustValidate(new Uint8Array(readFileSync(new URL(name, root))));
const u = (v: string | bigint | number) => ({ t: "u64" as const, v: String(v) });
const M = (1n << 64n) - 1n;

function capstone(x: bigint): bigint {
  const v = Array.from({ length: 40 }, (_, i) => (x + BigInt(i)) & M);
  let a = 0n;
  for (let j = 0; j < 40; j++) a = ((a * 3n) & M) ^ v[(17 * j) % 40]!;
  return a;
}

describe("reference engine on the PRD fixtures", () => {
  it("return-42", () => {
    expect(runToCompletion(mod("return-42.anma"), []).returnValue).toEqual(u(42));
  });
  it("square-plus-two", () => {
    const m = mod("square-plus-two.anma");
    const r = runToCompletion(m, [u(12)]);
    expect(r.returnValue).toEqual(u(146));
    expect(new TextDecoder().decode(r.terminal)).toBe("146");
    expect(r.effectCount).toBe(1);
    expect(runToCompletion(m, [u(4294967296n)]).returnValue).toEqual(u(2));
  });
  it("capstone agrees with the upstream constants and an independent oracle", () => {
    const m = mod("upstream-capstone-40.anma");
    expect(runToCompletion(m, [u(0x0000123400005678n)]).returnValue).toEqual(u("13514254791259192080"));
    expect(runToCompletion(m, [u(1)]).returnValue).toEqual(u("8313107083524001560"));
    for (const x of [0n, (1n << 32n) - 1n, 1n << 32n, 1n << 53n, M]) {
      expect(runToCompletion(m, [u(x)]).returnValue).toEqual(u(capstone(x)));
    }
  });
  it("rejects non-canonical inputs instead of wrapping", () => {
    const m = mod("square-plus-two.anma");
    for (const bad of ["-1", "1.5", "18446744073709551616", " 1", "+1", "1e3", ""]) {
      expect(() => runToCompletion(m, [u(bad)])).toThrow();
    }
  });
});
