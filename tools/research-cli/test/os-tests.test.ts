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

describe("Break this package", () => {
  const Op = { FUNC: 1, BLOCK: 2, PARAM: 3, END_FUNC: 4, CONST_U64: 0x10, ADD_U64: 0x20, RETURN: 0x43 };
  type Rec = [number, number, number, number];
  const file = (recs: Rec[]): Uint8Array => {
    const words = [0x414d4e41, 1, 0, recs.length, 0, 0, 0, 0, ...recs.flat()];
    const out = new Uint8Array(words.length * 4);
    words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0, true));
    return out;
  };
  // math.gcd that always returns a + b: wrong for most inputs, right when one side is zero.
  const fake = file([[Op.FUNC, 0, 2, 1], [Op.BLOCK, 0, 2, 3], [Op.PARAM, 0, 1, 0], [Op.PARAM, 1, 1, 1], [Op.ADD_U64, 2, 0, 1], [Op.RETURN, 2, 0, 0], [Op.END_FUNC, 0, 0, 0]]);
  const image = async () => {
    const { validateBytes } = await import("@llmtobinary/validate");
    return { module: validateBytes(fake).module!, exportMap: { "math.gcd": 0 } };
  };
  it("confirms a real break, judged by the oracle", async () => {
    const { judgeClaim } = await import("../src/os-tests.ts");
    expect(judgeClaim(await image(), JSON.stringify({ symbol: "math.gcd", args: ["12", "18"] }))).toEqual({ status: "confirmed", got: "30", want: "6" });
  });
  it("rejects a claim where the package is right", async () => {
    const { judgeClaim } = await import("../src/os-tests.ts");
    expect(judgeClaim(await image(), JSON.stringify({ symbol: "math.gcd", args: ["7", "0"] })).status).toBe("rejected");
  });
  it("ignores any answer the claimant supplies", async () => {
    const { judgeClaim } = await import("../src/os-tests.ts");
    expect(judgeClaim(await image(), JSON.stringify({ symbol: "math.gcd", args: ["7", "0"], want: "99" })).status).toBe("rejected");
  });
  it("rejects malformed claims", async () => {
    const { judgeClaim } = await import("../src/os-tests.ts");
    for (const raw of ["not json", "{}", JSON.stringify({ symbol: "math.gcd", args: [{}] }), JSON.stringify({ symbol: "no.such", args: [] })]) expect(judgeClaim(await image(), raw).status).toBe("rejected");
  });
});
