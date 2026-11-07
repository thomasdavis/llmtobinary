import { describe, expect, it } from "vitest";
import { appendLog, atLeast, canonicalJson, checkLock, classify, generateKeyPair, importSigningKey, isObjectId, objectId, signStatement, statement, verifyEnvelope, verifyLog } from "../src/index.ts";
import type { LockFile, LogEntry, ObjectId, PredicateType, TrustedKey, VerifiedAttestation } from "../src/index.ts";

const bytes = new TextEncoder().encode("anma");
const att = (subject: ObjectId, type: PredicateType, predicate: Record<string, unknown>, keyid = "v1", role: VerifiedAttestation["role"] = "verifier"): VerifiedAttestation => ({ statement: statement(subject, type, predicate), keyid, role });
const passedTest = { passed: true, taskOwned: true, holdouts: true, outputHash: "abc" };

describe("identity", () => {
  it("hashes exact bytes and names the algorithm", async () => {
    const id = await objectId(bytes);
    expect(isObjectId(id)).toBe(true);
    expect(await objectId(new TextEncoder().encode("anmb"))).not.toBe(id);
  });
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });
});

describe("attestations", () => {
  it("verifies a signature and rejects tampering", async () => {
    const pair = await generateKeyPair();
    const key = await importSigningKey("broker-1", pair.privateKeyPkcs8Hex);
    const trust: TrustedKey[] = [{ keyid: "broker-1", publicKeyHex: pair.publicKeyHex, role: "broker" }];
    const env = await signStatement(statement(await objectId(bytes), "provenance", { model: "m" }), key);
    expect((await verifyEnvelope(env, trust))?.role).toBe("broker");
    const body = JSON.parse(atob(env.payload));
    body.predicate.model = "other";
    expect(await verifyEnvelope({ ...env, payload: btoa(JSON.stringify(body)) }, trust)).toBeNull();
  });
  it("rejects an unknown key", async () => {
    const pair = await generateKeyPair();
    const env = await signStatement(statement(await objectId(bytes), "test", passedTest), await importSigningKey("x", pair.privateKeyPkcs8Hex));
    expect(await verifyEnvelope(env, [])).toBeNull();
  });
});

describe("evidence classes", () => {
  it("never passes E2 on self-reported facts", async () => {
    const id = await objectId(bytes);
    expect(classify(id, { valid: true, selfConsistent: true }, []).class).toBe("E2");
    expect(classify(id, { valid: false, selfConsistent: true }, []).class).toBe("E0");
  });
  it("ignores a test result signed by anything but a verifier", async () => {
    const id = await objectId(bytes);
    for (const role of ["broker", "curator"] as const) expect(classify(id, { valid: true, selfConsistent: true }, [att(id, "test", passedTest, "k", role)]).class).toBe("E2");
  });
  it("needs task-owned tests with holdouts for E3", async () => {
    const id = await objectId(bytes);
    expect(classify(id, { valid: true, selfConsistent: true }, [att(id, "test", { ...passedTest, taskOwned: false })]).class).toBe("E2");
    expect(classify(id, { valid: true, selfConsistent: true }, [att(id, "test", { ...passedTest, holdouts: false })]).class).toBe("E2");
    expect(classify(id, { valid: true, selfConsistent: false }, [att(id, "test", passedTest)]).class).toBe("E3");
  });
  it("needs a second key with identical output for E4", async () => {
    const id = await objectId(bytes);
    const t = att(id, "test", passedTest);
    expect(classify(id, { valid: true, selfConsistent: true }, [t, att(id, "rerun", { outputHash: "abc" })]).class).toBe("E3");
    expect(classify(id, { valid: true, selfConsistent: true }, [t, att(id, "rerun", { outputHash: "zzz" }, "v2")]).class).toBe("E3");
    expect(classify(id, { valid: true, selfConsistent: true }, [t, att(id, "rerun", { outputHash: "abc" }, "v2")]).class).toBe("E4");
  });
  it("needs adequacy for E5", async () => {
    const id = await objectId(bytes);
    const t = att(id, "test", passedTest);
    expect(classify(id, { valid: true, selfConsistent: true }, [t, att(id, "proof", { taskOwned: true, adequate: false })]).class).toBe("E3");
    expect(classify(id, { valid: true, selfConsistent: true }, [t, att(id, "proof", { taskOwned: true, adequate: true })]).class).toBe("E5");
  });
  it("a confirmed counterexample demotes and retracts", async () => {
    const id = await objectId(bytes);
    const e = classify(id, { valid: true, selfConsistent: true }, [att(id, "test", passedTest), att(id, "counterexample", { confirmed: true })]);
    expect(e.class).toBe("E2");
    expect(e.retracted).toBe(true);
  });
  it("ignores attestations about other objects", async () => {
    const id = await objectId(bytes);
    const other = await objectId(new TextEncoder().encode("x"));
    expect(classify(id, { valid: true, selfConsistent: true }, [att(other, "test", passedTest)]).class).toBe("E2");
  });
  it("orders classes", () => {
    expect(atLeast("E4", "E3")).toBe(true);
    expect(atLeast("E2", "E3")).toBe(false);
  });
});

describe("log", () => {
  it("chains and detects rewriting", async () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 4; i++) entries.push(await appendLog(entries.at(-1) ?? null, { at: i, kind: "publish", subject: `s${i}`, detail: {} }));
    expect(await verifyLog(entries)).toBe(-1);
    const forged = entries.map((e) => ({ ...e }));
    forged[2]!.subject = "evil";
    expect(await verifyLog(forged)).toBe(2);
  });
});

describe("lock files", () => {
  const lock = (slots: Record<string, ObjectId>): LockFile => ({ kind: "llmtobinary-lock/1", root: "sha256:" + "0".repeat(64) as ObjectId, specDigest: "s", engineDigest: "e", policy: { minimumClass: "E3" }, slots });
  it("fails closed on unknown, weak, retracted and taken-down pins", async () => {
    const a = await objectId(new TextEncoder().encode("a"));
    const ok = { evidence: { class: "E3" as const, retracted: false, basis: [] }, takenDown: false };
    expect(checkLock(lock({ s: a }), () => ok)).toEqual([]);
    expect(checkLock(lock({ s: a }), () => null)[0]!.problem).toBe("unknown-object");
    expect(checkLock(lock({ s: a }), () => ({ ...ok, evidence: { ...ok.evidence, class: "E2" } }))[0]!.problem).toBe("below-policy");
    expect(checkLock(lock({ s: a }), () => ({ ...ok, evidence: { ...ok.evidence, retracted: true } }))[0]!.problem).toBe("retracted");
    expect(checkLock(lock({ s: a }), () => ({ ...ok, takenDown: true }))[0]!.problem).toBe("taken-down");
    expect(checkLock(lock({ s: "made-up-name" as ObjectId }), () => ok)[0]!.problem).toBe("not-an-id");
  });
});
