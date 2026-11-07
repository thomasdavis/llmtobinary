import { describe, expect, it } from "vitest";
import { rng } from "../src/os-tests.ts";

describe("holdout generator", () => {
  it("stays within 64 bits for a wide seed", () => {
    const r = rng((1n << 127n) | 12345n);
    for (let i = 0; i < 2000; i++) expect(r.next() < 1n << 64n).toBe(true);
  });
  it("is deterministic", () => {
    expect(rng(5n).next()).toBe(rng(5n).next());
  });
});

describe("library oracles", () => {
  it("agree with their own examples and make sound random cases", async () => {
    const { LIBRARY } = await import("../../../os/library.ts");
    expect(LIBRARY.length).toBe(11);
    const r = rng(9n);
    for (const l of LIBRARY) for (const f of l.functions) {
      expect(f.examples.length).toBeGreaterThan(0);
      for (let i = 0; i < 200; i++) {
        const c = f.random(r.next, r.int);
        expect(c.args.length).toBe(f.params.length);
        if (f.ret === 0) expect(c.want).toBeNull();
        else expect(typeof c.want).toBe("bigint");
      }
    }
  });
  it("match published test vectors", async () => {
    const { LIBRARY } = await import("../../../os/library.ts");
    const crc = LIBRARY.find((l) => l.id === "crc-8")!.functions[0]!;
    expect(crc.examples[1]!.want).toBe(0xf4n);
    const fnv = LIBRARY.find((l) => l.id === "hash-fnv")!.functions[0]!;
    expect(fnv.examples[1]!.want).toBe(0xaf63dc4c8601ec8cn);
  });
});
