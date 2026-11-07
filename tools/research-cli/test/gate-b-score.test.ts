import { describe, expect, it } from "vitest";
import { Op } from "@llmtobinary/spec";
import { scorePair } from "../src/gate-b-score.ts";
import type { GateInterface } from "../src/gate-b-interfaces.ts";

const IMPORT = 0x70;
type Rec = [number, number, number, number];
function file(entry: number, recs: Rec[]): Uint8Array {
  const words = [0x414d4e41, 2, 0, recs.length, 0, entry, 0, 0, ...recs.flat()];
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0, true));
  return out;
}

const trivial: Rec[] = [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CONST_U64, 0, 0, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0]];
const lib = (add: number) => file(0, [...trivial, [Op.FUNC, 1, 1, 1], [Op.BLOCK, 0, 1, 3], [Op.PARAM, 0, 1, 0], [Op.CONST_U64, 1, add, 0], [Op.ADD_U64, 2, 0, 1], [Op.RETURN, 2, 0, 0], [Op.END_FUNC, 0, 0, 0]]);
const app = file(0, [[Op.FUNC, 0, 1, 1], [Op.BLOCK, 0, 1, 2], [Op.PARAM, 0, 1, 0], [Op.CALL, 1, 1, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 1, 1], [Op.PARAM, 0, 1, 0]]);

const iface: GateInterface = { id: "t", features: 0, exports: [{ symbol: "t.inc", signature: "", behaviour: "", id: 1, params: [1], ret: 1 }], app: { params: ["u64"], signature: "", behaviour: "" }, oracle: ([x]) => x! + 1n, cases: [[0n], [41n], [18446744073709551614n]], fuel: 1000 };

describe("gate b scoring", () => {
  it("passes a correct pair", () => {
    expect(scorePair(iface, lib(1), app).stage).toBe("pass");
  });
  it("fails a linked pair that computes the wrong value", () => {
    const v = scorePair(iface, lib(2), app);
    expect(v.stage).toBe("wrong-result");
    if (v.stage === "wrong-result") expect(v.passedCases).toBe(0);
  });
  it("fails a pair whose signatures disagree", () => {
    const wrong = file(0, [[Op.FUNC, 0, 1, 1], [Op.BLOCK, 0, 1, 2], [Op.PARAM, 0, 1, 0], [Op.CALL, 1, 1, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 0, 1]]);
    expect(scorePair(iface, lib(1), wrong).stage).toBe("link-failed");
  });
  it("fails a program that runs out of fuel instead of hanging", () => {
    const spin = file(0, [...trivial, [Op.FUNC, 1, 1, 1], [Op.BLOCK, 0, 1, 1], [Op.PARAM, 0, 1, 0], [Op.JUMP, 0, 1, 0], [Op.ARG, 0, 0, 0], [Op.END_FUNC, 0, 0, 0]]);
    expect(scorePair(iface, spin, app).stage).toBe("wrong-result");
  });
});
