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
