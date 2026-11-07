import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { objectId } from "@llmtobinary/registry";
import { verifyObject } from "../src/verify.ts";

const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/${n}`, import.meta.url)));

describe("verifier", () => {
  it("passes a correct program against its task", async () => {
    const b = fixture("fizzbuzz.anma");
    const r = await verifyObject(await objectId(b), b, "fizzbuzz");
    expect(r.kind === "attest" && r.statement.predicate).toMatchObject({ passed: true, taskOwned: true, holdouts: true });
  });
  it("fails a program that does the wrong job", async () => {
    const b = fixture("fibonacci.anma");
    const r = await verifyObject(await objectId(b), b, "fizzbuzz");
    expect(r.kind === "attest" && r.statement.predicate.passed).toBe(false);
  });
  it("refuses bytes that do not match their ID", async () => {
    const b = fixture("fizzbuzz.anma");
    const id = await objectId(b);
    const tampered = b.slice();
    tampered[40]! ^= 1;
    expect((await verifyObject(id, tampered, "fizzbuzz")).kind).toBe("skip");
  });
  it("refuses an unknown task", async () => {
    const b = fixture("fizzbuzz.anma");
    expect((await verifyObject(await objectId(b), b, "made-up")).kind).toBe("skip");
  });
  it("judges a slot candidate through the slot judge", async () => {
    const b = fixture("fizzbuzz.anma");
    const id = await objectId(b);
    const pass = await verifyObject(id, b, "slot:str", "test", () => ({ failures: 0, cases: 3 }));
    expect(pass.kind === "attest" && pass.statement.predicate).toMatchObject({ passed: true, taskOwned: true, holdouts: true });
    const fail = await verifyObject(id, b, "slot:str", "test", () => ({ failures: 2, cases: 3 }));
    expect(fail.kind === "attest" && fail.statement.predicate.passed).toBe(false);
    expect((await verifyObject(id, b, "slot:str")).kind).toBe("skip");
  });
  it("gives identical output hashes on a rerun", async () => {
    const b = fixture("fizzbuzz.anma");
    const id = await objectId(b);
    const [x, y] = await Promise.all([verifyObject(id, b, "fizzbuzz"), verifyObject(id, b, "fizzbuzz", "rerun")]);
    expect(x.kind === "attest" && y.kind === "attest" && x.statement.predicate.outputHash === y.statement.predicate.outputHash).toBe(true);
  });
});
