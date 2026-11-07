import { describe, expect, it } from "vitest";
import { Op } from "@llmtobinary/spec";
import { checkCandidate } from "../src/index.ts";

const IMPORT = 0x70;
type Rec = [number, number, number, number];
function file(version: number, recs: Rec[]): Uint8Array {
  const words = [0x414d4e41, version, 0, recs.length, 0, 0, 0, 0, ...recs.flat()];
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0, true));
  return out;
}
const app: Rec[] = [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 2], [Op.CONST_U64, 0, 41, 0], [Op.CALL, 1, 1, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 1, 1], [Op.PARAM, 0, 1, 0]];

describe("ANMA-2 modules in check_candidate", () => {
  it("accepts a module only when asked", async () => {
    expect((await checkCandidate({ bytes: file(2, app) }, { modules: true })).report.ok).toBe(true);
    expect((await checkCandidate({ bytes: file(2, app) })).report.ok).toBe(false);
  });
  it("reports a malformed module as ANMA-K-010", async () => {
    const bad = app.slice();
    bad[7] = [IMPORT, 9, 1, 1];
    const r = await checkCandidate({ bytes: file(2, bad) }, { modules: true });
    expect(r.report.errors.map((e) => e.rule)).toEqual(["ANMA-K-010"]);
    expect(r.report.errors[0]!.message).toContain("next dense ID is 1");
  });
  it("still applies the ordinary validator to the body", async () => {
    const broken = app.slice();
    broken[3] = [Op.CALL, 1, 7, 1];
    expect((await checkCandidate({ bytes: file(2, broken) }, { modules: true })).report.ok).toBe(false);
  });
  it("keeps the hash of the bytes the model wrote", async () => {
    const a = await checkCandidate({ bytes: file(2, app) }, { modules: true });
    expect(a.report.byteLength).toBe(file(2, app).length);
  });
});
