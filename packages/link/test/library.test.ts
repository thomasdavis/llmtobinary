import { describe, expect, it } from "vitest";
import { Op } from "@llmtobinary/spec";
import { validateBytes } from "@llmtobinary/validate";
import { catalogAccess, eligibleCatalog, linkWithLibrary, renderIndex, searchCatalog, type LibraryEntry } from "../src/library.ts";

const IMPORT = 0x70;
type Rec = [number, number, number, number];

function file(version: number, records: Rec[], features = 1): Uint8Array {
  const out = new Uint8Array(32 + records.length * 16);
  const v = new DataView(out.buffer);
  [0x414d4e41, version, features, records.length, 0, 0, 0, 0].forEach((w, i) => v.setUint32(i * 4, w, true));
  records.forEach((r, i) => r.forEach((w, k) => v.setUint32(32 + i * 16 + k * 4, w, true)));
  return out;
}

/** fn0() -> u64 returning 0, then fn1(a) -> u64 returning a. */
const lib = (): Uint8Array => file(2, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CONST_U64, 0, 0, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0], [Op.FUNC, 1, 1, 1], [Op.BLOCK, 0, 1, 1], [Op.PARAM, 0, 1, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0]]);
/** A library that calls `id.same` through its one import. */
const wrapper = (): Uint8Array => file(2, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CONST_U64, 0, 0, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0], [Op.FUNC, 1, 1, 1], [Op.BLOCK, 0, 1, 2], [Op.PARAM, 0, 1, 0], [Op.CALL, 1, 2, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 2, 1, 1], [Op.PARAM, 0, 1, 0]]);
/** fn0() -> u64 calling its first import with 41, optionally declaring a second import it never calls. */
const app = (extra = false): Uint8Array => file(2, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 2], [Op.CONST_U64, 0, 41, 0], [Op.CALL, 1, 1, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 1, 1], [Op.PARAM, 0, 1, 0], ...(extra ? ([[IMPORT, 2, 1, 1], [Op.PARAM, 0, 1, 0]] as Rec[]) : [])]);

const fn = (symbol: string, behaviour: string) => ({ symbol, signature: "(a: u64) -> u64", behaviour, id: 1, params: [1], ret: 1 });
const entry = (slot: string, symbol: string, o: Partial<LibraryEntry> = {}): LibraryEntry => ({ slot, title: slot, objectId: `sha256:${slot}`, evidence: "E4", features: 1, depends: [], functions: [fn(symbol, `Does ${slot}. More detail follows.`)], ...o });
const catalog = [entry("same", "id.same"), entry("wrap", "id.wrap", { depends: ["same"] })];
const bytes = async (id: string) => (id === "sha256:same" ? lib() : id === "sha256:wrap" ? wrapper() : null);

describe("eligibleCatalog", () => {
  it("keeps only E4 and above, within the task's features", () => {
    const got = eligibleCatalog([entry("a", "a.f"), entry("b", "b.f", { evidence: "E3" }), entry("c", "c.f", { evidence: "E5" }), entry("d", "d.f", { features: 33 })], 15);
    expect(got.map((e) => e.slot)).toEqual(["a", "c"]);
  });
  it("drops a package whose dependency does not qualify, however deep", () => {
    const got = eligibleCatalog([entry("a", "a.f", { evidence: "E2" }), entry("b", "b.f", { depends: ["a"] }), entry("c", "c.f", { depends: ["b"] }), entry("d", "d.f", { depends: ["missing"] })], 15);
    expect(got).toEqual([]);
  });
  it("cannot be fooled by a dependency cycle", () => {
    expect(eligibleCatalog([entry("a", "a.f", { depends: ["b"] }), entry("b", "b.f", { depends: ["a"] })], 15)).toEqual([]);
  });
});

describe("searchCatalog", () => {
  const big = [entry("gcd", "math.gcd", { functions: [fn("math.gcd", "Greatest common divisor of two numbers.")] }), entry("crc", "crc.crc8", { functions: [fn("crc.crc8", "CRC-8 checksum of a buffer.")] })];
  it("ranks a name match first", () => {
    expect(searchCatalog(big, "gcd divisor")[0]!.symbol).toBe("math.gcd");
    expect(searchCatalog(big, "checksum of bytes")[0]!.symbol).toBe("crc.crc8");
  });
  it("lists the library when nothing matches, and gives the import records", () => {
    const got = searchCatalog(big, "zzz");
    expect(got).toHaveLength(2);
    expect(got[0]!.importRecords).toContain("70000000");
    expect(got[0]!.importRecords).toContain("03000000"); // PARAM
  });
  it("respects the limit", () => {
    expect(searchCatalog(big, "", 1)).toHaveLength(1);
  });
});

describe("renderIndex", () => {
  it("shows each function's first sentence", () => {
    const text = renderIndex(catalog);
    expect(text).toContain("id.same(a: u64) -> u64: Does same.");
    expect(text).not.toContain("More detail");
  });
  it("says how much it left out", () => {
    const text = renderIndex(catalog, 50);
    expect(text).toContain("1 more: use search_library");
  });
});

describe("linkWithLibrary", () => {
  it("links a program into one valid plain ANMA-1 file", async () => {
    const r = await linkWithLibrary(catalog, app(), ["id.same"], bytes, 15);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateBytes(r.bytes).ok).toBe(true);
    expect(new DataView(r.bytes.buffer).getUint32(4, true)).toBe(1);
    expect(r.packages).toEqual([{ slot: "same", objectId: "sha256:same", evidence: "E4", symbols: ["id.same"] }]);
    expect(r.uses).toEqual(["id.same"]);
  });
  it("pulls in dependencies the model never named", async () => {
    const r = await linkWithLibrary(catalog, app(), ["id.wrap"], bytes, 15);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.packages.map((p) => p.slot)).toEqual(["wrap", "same"]);
    expect(r.packages[1]!.symbols).toEqual([]);
  });
  it("counts only imports the program calls", async () => {
    const r = await linkWithLibrary(catalog, app(true), ["id.same", "id.wrap"], bytes, 15);
    expect(r.ok && r.uses).toEqual(["id.same"]);
  });
  it("explains a mismatch between IMPORT records and the selection", async () => {
    const r = await linkWithLibrary(catalog, app(), [], bytes, 15);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-MAP");
  });
  it("refuses a symbol outside the catalog, so policy cannot be bypassed", async () => {
    const r = await linkWithLibrary(eligibleCatalog([entry("same", "id.same", { evidence: "E3" })], 15), app(), ["id.same"], bytes, 15);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-UNKNOWN");
  });
  it("refuses a wrong signature", async () => {
    const wrong = file(2, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CALL, 0, 1, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 0, 1]]);
    const r = await linkWithLibrary(catalog, wrong, ["id.same"], bytes, 15);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-TYPE");
  });
  it("fails cleanly when a package's bytes cannot be read", async () => {
    const r = await linkWithLibrary(catalog, app(), ["id.same"], async () => null, 15);
    expect(!r.ok && r.errors[0]!.rule).toBe("LINK-FETCH");
  });
  it("refuses features the task forbids", async () => {
    const r = await linkWithLibrary(catalog, app(), ["id.same"], bytes, 0);
    expect(r.ok).toBe(false);
  });
});

describe("catalogAccess", () => {
  it("reports unknown symbols", async () => {
    const a = catalogAccess(catalog, bytes, 15);
    const got = await a.cards(["id.same", "nope"]);
    expect(got.cards.map((c) => c.symbol)).toEqual(["id.same"]);
    expect(got.unknown).toEqual(["nope"]);
  });
});
