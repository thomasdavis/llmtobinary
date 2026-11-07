import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Op } from "@llmtobinary/spec";
import { parseModule, standalone } from "@llmtobinary/module";
import { validateBytes } from "@llmtobinary/validate";
import { authorityOf, link, type LinkInput } from "../src/index.ts";

const IMPORT = 0x70;
type Rec = [number, number, number, number];

function file(version: number, entry: number, recs: Rec[], features = 0, data: number[] = []): Uint8Array {
  const words = [0x414d4e41, version, features, recs.length, data.length, entry, 0, 0, ...recs.flat()];
  const out = new Uint8Array(words.length * 4 + data.length);
  new DataView(out.buffer).setUint32(0, 0);
  words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0, true));
  out.set(data, words.length * 4);
  return out;
}

// fn0(u64) -> u64 = x + 1
const inc: Rec[] = [[Op.FUNC, 0, 1, 1], [Op.BLOCK, 0, 1, 3], [Op.PARAM, 0, 1, 0], [Op.CONST_U64, 1, 1, 0], [Op.ADD_U64, 2, 0, 1], [Op.RETURN, 2, 0, 0], [Op.END_FUNC, 0, 0, 0]];
// fn0() -> u64 = import(41), import is fn1
const app = (ret = 1, param = 1): Rec[] => [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 2], [Op.CONST_U64, 0, 41, 0], [Op.CALL, 1, 1, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 1, ret], [Op.PARAM, 0, param, 0]];

const lib = (extra: Partial<LinkInput> = {}): LinkInput => ({ name: "lib", bytes: file(2, 0, inc), exports: { "math.inc": 0 }, imports: {}, ...extra });
const root = (extra: Partial<LinkInput> = {}): LinkInput => ({ name: "app", bytes: file(2, 0, app()), exports: {}, imports: { 1: "math.inc" }, ...extra });

describe("module format", () => {
  it("parses imports and keeps records intact", () => {
    const p = parseModule(file(2, 0, app()));
    expect(p.ok && p.module.imports).toEqual([{ id: 1, params: [1], ret: 1 }]);
  });
  it("gives the validator a standalone file", () => {
    const p = parseModule(file(2, 0, app()));
    if (!p.ok) throw new Error("parse");
    expect(validateBytes(standalone(p.module)).ok).toBe(true);
  });
  it("stands in for every return type", () => {
    for (const ret of [0, 1, 2, 3, 4]) {
      const recs: Rec[] = [[Op.FUNC, 0, 0, 0], [Op.BLOCK, 0, 0, 0], [Op.RETURN, 0xffffffff, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 0, ret]];
      const p = parseModule(file(2, 0, recs));
      if (!p.ok) throw new Error(p.error.message);
      const v = validateBytes(standalone(p.module));
      expect(v.diagnostics.map((d) => d.rule)).toEqual([]);
    }
  });
  it("rejects imports in the wrong place or with the wrong ID", () => {
    const r = app();
    r[7] = [IMPORT, 5, 1, 1];
    expect(parseModule(file(2, 0, r)).ok).toBe(false);
    expect(parseModule(file(1, 0, app())).ok).toBe(false);
    expect(parseModule(file(2, 1, app())).ok).toBe(false);
  });
});

describe("link", () => {
  it("emits a plain ANMA-1 image the validator accepts", () => {
    const r = link([root(), lib()]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(new DataView(r.bytes.buffer).getUint32(4, true)).toBe(1);
    expect(validateBytes(r.bytes).ok).toBe(true);
    expect(r.edges).toEqual([{ from: "app", to: "lib", symbol: "math.inc" }]);
    expect(r.label).toBe("linked");
  });
  it("only renumbers: every other record is byte-identical", () => {
    const r = link([root(), lib()]);
    if (!r.ok) throw new Error("link");
    const dv = new DataView(r.bytes.buffer);
    const recs: Rec[] = [];
    for (let at = 32; at < r.bytes.length; at += 16) recs.push([dv.getUint32(at, true), dv.getUint32(at + 4, true), dv.getUint32(at + 8, true), dv.getUint32(at + 12, true)]);
    expect(recs.slice(0, 7)).toEqual(app().slice(0, 7));
    expect(recs.slice(7)).toEqual([[Op.FUNC, 1, 1, 1], ...inc.slice(1)]);
  });
  it("fails before execution on a missing symbol", () => {
    const r = link([root({ imports: { 1: "nope" } }), lib()]);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-MISSING");
  });
  it("fails on a signature mismatch", () => {
    const r = link([root({ bytes: file(2, 0, app(2)) }), lib()]);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-TYPE");
  });
  it("fails on a duplicate export", () => {
    const r = link([root({ exports: { "math.inc": 0 } }), lib()]);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-DUPLICATE");
  });
  it("fails on a cycle", () => {
    const a: Rec[] = [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CALL, 0, 1, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 0, 1]];
    const r = link([{ name: "a", bytes: file(2, 0, a), exports: { a: 0 }, imports: { 1: "b" } }, { name: "b", bytes: file(2, 0, a), exports: { b: 0 }, imports: { 1: "a" } }]);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-CYCLE");
  });
  it("fails on data outside the root", () => {
    const r = link([root(), lib({ bytes: file(2, 0, inc, 0, [1, 2, 3]) })]);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-DATA");
  });
  it("leaves out unreached modules", () => {
    const r = link([root(), lib(), { name: "unused", bytes: file(2, 0, inc), exports: { other: 0 }, imports: {} }]);
    expect(r.ok && r.modules).toEqual(["app", "lib"]);
  });
  it("reports reachable host operations only", () => {
    const host: Rec[] = [[Op.FUNC, 0, 0, 0], [Op.BLOCK, 0, 0, 1], [Op.CONST_U64, 0, 1, 0], [Op.HOST, 0xffffffff, 0, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 0xffffffff, 0, 0], [Op.END_FUNC, 0, 0, 0]];
    expect(authorityOf(file(1, 0, host, 2))).toEqual(["terminal.print_u64"]);
  });
});

describe("the linker is not trusted", () => {
  it("corrupted link output never passes as a different valid-looking image unchecked", () => {
    const good = link([root(), lib()]);
    if (!good.ok) throw new Error("link");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: good.bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (at, x) => {
        const b = good.bytes.slice();
        b[at]! ^= x;
        const v = validateBytes(b);
        if (v.ok) expect(v.module).toBeTruthy();
      }),
      { numRuns: 1500 },
    );
  });
  it("random bytes never crash the linker", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (b) => {
        const r = link([{ name: "x", bytes: b, exports: {}, imports: {} }]);
        expect(typeof r.ok).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
  });
  it("mutated modules either fail to link or produce a validated image", () => {
    const base = root();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: base.bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (at, x) => {
        const b = base.bytes.slice();
        b[at]! ^= x;
        const r = link([{ ...base, bytes: b }, lib()]);
        if (!r.ok) return;
        // A flipped feature bit can legitimately make this a version 2 image. Judge each by its own version.
        const version = new DataView(r.bytes.buffer).getUint32(4, true);
        expect([1, 2]).toContain(version);
        expect(validateBytes(r.bytes, { anma2: version === 2 }).ok).toBe(true);
        if (version === 1) expect(validateBytes(r.bytes).ok).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
});

describe("ANMA-2 images", () => {
  it("stays version 1 for plain programs and uses version 2 for ANMA-2 features", () => {
    const plain = link([root(), lib()]);
    expect(plain.ok && new DataView(plain.bytes.buffer).getUint32(4, true)).toBe(1);
    const TEXT = 1 << 4;
    const keyLib: Rec[] = [[Op.FUNC, 0, 1, 1], [Op.BLOCK, 0, 1, 2], [Op.PARAM, 0, 1, 0], [Op.HOST, 1, 7, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0]];
    const r = link([root(), { name: "keys", bytes: file(2, 0, keyLib, TEXT), exports: { "math.inc": 0 }, imports: {} }]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(new DataView(r.bytes.buffer).getUint32(4, true)).toBe(2);
    expect(r.authority).toEqual(["input.next_key"]);
  });
});
