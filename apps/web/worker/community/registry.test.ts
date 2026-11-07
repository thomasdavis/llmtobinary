import { env as rawEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, importSigningKey, objectId, signStatement, statement, verifyLog, type LogEntry, type ObjectId, type TrustedKey } from "@llmtobinary/registry";
import type { GalleryEntry } from "@llmtobinary/protocol";
import community from "../../migrations/0001_community.sql?raw";
import registry from "../../migrations/0002_registry.sql?raw";
import worker from "../index.ts";
import { listPackages, publishGeneration, submitAttestation } from "./registry.ts";

const base = rawEnv as unknown as Env;
const ORIGIN = "https://example.com";
const call = (path: string, init: RequestInit = {}, e: Env = base) => (worker.fetch as unknown as (r: Request, e: Env) => Promise<Response>)(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), e);

// return-42
const HEX = "414e4d4101000000000000000500000000000000000000000000000000000000" + "01000000000000000000000001000000" + "02000000000000000000000001000000" + "10000000000000002a00000000000000" + "43000000000000000000000000000000" + "04000000000000000000000000000000";
const bytesOf = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
const entry = (over: Partial<GalleryEntry> = {}): GalleryEntry => ({ version: 2, id: "x", sessionId: "11111111-1111-4111-8111-111111111111", label: "Return 42", prompt: "return 42", taskId: "return-42", outcome: "passed-unverified", program: "passed", checkerOk: null, createdAt: 1000, finishedAt: 2000, updatedAt: 2000, bytes: 112, instructions: 5, model: "m", reasoningEffort: null, turns: 1, checks: 1, submissions: 1, outputTokens: 1, features: 0, signature: "() -> u64", hex: HEX, annotations: null, sha256: null, candidateSeq: null, attemptId: null, mode: "tools", promptVersion: "p", returnedModels: ["m"], stopDetail: null, ...over }) as GalleryEntry;

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let env: Env;
let id: ObjectId;
const passing = { passed: true, taskOwned: true, holdouts: true, outputHash: "abc" };

beforeAll(async () => {
  for (const sql of [community, registry]) for (const s of sql.replace(/--.*$/gm, "").split(";").map((x: string) => x.trim()).filter(Boolean)) await base.COMMUNITY_DB!.prepare(s).run();
  pair = await generateKeyPair();
  const trust: TrustedKey[] = [{ keyid: "verifier-1", publicKeyHex: pair.publicKeyHex, role: "verifier" }];
  env = { ...base, TRUSTED_KEYS: JSON.stringify(trust) };
  id = await objectId(bytesOf(HEX));
});
beforeEach(async () => {
  for (const t of ["verify_jobs", "packages", "generations", "member_spend", "login_sessions", "stars", "comments", "reports", "users"]) await base.COMMUNITY_DB!.prepare(`DELETE FROM ${t}`).run();
  const listed = await base.REGISTRY!.list();
  for (const o of listed.objects) await base.REGISTRY!.delete(o.key);
});

const classOf = async () => ((await (await call(`/api/registry/${id}`, {}, env)).json()) as { package: { evidence_class: string; retracted: number } }).package;

describe("publishing", () => {
  it("stores bytes under their hash, readable by anyone", async () => {
    expect(await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 })).toBe(id);
    const res = await call(`/api/registry/${id}/bytes`, {}, env);
    expect(res.status).toBe(200);
    expect(await objectId(new Uint8Array(await res.arrayBuffer()))).toBe(id);
  });
  it("is idempotent", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 2 });
    expect((await listPackages(env, { q: null, evidence: null, author: null, before: null, limit: 10 })).items.length).toBe(1);
  });
  it("marks backfills, with no licence and no provenance signature", async () => {
    const key = await generateKeyPair();
    await publishGeneration({ ...env, BROKER_SIGNING_KEY: key.privateKeyPkcs8Hex }, entry(), { backfilled: true, authorId: null, now: 1 });
    const body = (await (await call(`/api/registry/${id}`, {}, env)).json()) as { package: { backfilled: number; licence: string }; attestations: unknown[] };
    expect(body.package.backfilled).toBe(1);
    expect(body.package.licence).toBe("none stated");
    expect(body.attestations).toEqual([]);
  });
  it("signs provenance for a new generation", async () => {
    const key = await generateKeyPair();
    await publishGeneration({ ...env, BROKER_SIGNING_KEY: key.privateKeyPkcs8Hex, BROKER_KEY_ID: "b1", TRUSTED_KEYS: JSON.stringify([{ keyid: "b1", publicKeyHex: key.publicKeyHex, role: "broker" }]) }, entry(), { backfilled: false, authorId: null, now: 1 });
    const body = (await (await call(`/api/registry/${id}`, {}, { ...env, TRUSTED_KEYS: JSON.stringify([{ keyid: "b1", publicKeyHex: key.publicKeyHex, role: "broker" }]) })).json()) as { attestations: { verified: boolean; predicateType: string }[] };
    expect(body.attestations).toEqual([{ predicateType: "llmtobinary/provenance/1", keyid: "b1", verified: true }]);
  });
  it("keeps passed and passed-unverified apart", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await listPackages(env, { q: null, evidence: null, author: null, before: null, limit: 10 })).items[0]!.outcome).toBe("passed-unverified");
  });
  it("records invalid bytes as E0, never deleted", async () => {
    await publishGeneration(env, entry({ hex: "00ff" }), { backfilled: false, authorId: null, now: 1 });
    expect((await listPackages(env, { q: null, evidence: "E0", author: null, before: null, limit: 10 })).items.length).toBe(1);
  });
});

describe("evidence comes only from signatures", () => {
  it("a self-reported pass stops at E2", async () => {
    await publishGeneration(env, entry({ outcome: "passed" as never }), { backfilled: false, authorId: null, now: 1 });
    expect((await classOf()).evidence_class).toBe("E2");
  });
  it("refuses a forged attestation and changes nothing", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    const forger = await generateKeyPair();
    const forged = await signStatement(statement(id, "test", passing), await importSigningKey("verifier-1", forger.privateKeyPkcs8Hex));
    const res = await call(`/api/registry/${id}/attestations`, { method: "POST", body: JSON.stringify(forged) }, env);
    expect(res.status).toBe(403);
    expect((await classOf()).evidence_class).toBe("E2");
  });
  it("accepts a real verifier signature", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    const good = await signStatement(statement(id, "test", passing), await importSigningKey("verifier-1", pair.privateKeyPkcs8Hex));
    expect((await call(`/api/registry/${id}/attestations`, { method: "POST", body: JSON.stringify(good) }, env)).status).toBe(201);
    expect((await classOf()).evidence_class).toBe("E3");
  });
  it("rejects a real signature about a different object", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    const other = await objectId(new TextEncoder().encode("other"));
    const env2 = await signStatement(statement(other, "test", passing), await importSigningKey("verifier-1", pair.privateKeyPkcs8Hex));
    expect((await submitAttestation(env, id, env2, 1)).accepted).toBe(false);
  });
  it("a confirmed counterexample demotes the package", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    const key = await importSigningKey("verifier-1", pair.privateKeyPkcs8Hex);
    await submitAttestation(env, id, await signStatement(statement(id, "test", passing), key), 1);
    await submitAttestation(env, id, await signStatement(statement(id, "counterexample", { confirmed: true }), key), 2);
    const p = await classOf();
    expect(p.evidence_class).toBe("E2");
    expect(p.retracted).toBe(1);
  });
  it("stars cannot change a class", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    const cookie = (await call("/api/auth/fake?id=5", {}, env)).headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(`/api/registry/${id}/star`, { method: "PUT", headers: { origin: ORIGIN, cookie } }, env)).status).toBe(200);
    expect((await classOf()).evidence_class).toBe("E2");
  });
});

describe("social", () => {
  it("needs a member to star or comment", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await call(`/api/registry/${id}/star`, { method: "PUT", headers: { origin: ORIGIN } }, env)).status).toBe(401);
    expect((await call(`/api/registry/${id}/comments`, { method: "POST", body: "{}", headers: { origin: ORIGIN } }, env)).status).toBe(401);
  });
  it("returns hostile text as inert JSON", async () => {
    const evil = `<img src=x onerror=alert(1)></script>`;
    await publishGeneration(env, entry({ label: evil, prompt: evil }), { backfilled: false, authorId: null, now: 1 });
    const cookie = (await call("/api/auth/fake?id=6", {}, env)).headers.get("set-cookie")!.split(";")[0]!;
    await call(`/api/registry/${id}/comments`, { method: "POST", body: JSON.stringify({ body: evil }), headers: { origin: ORIGIN, cookie, "content-type": "application/json" } }, env);
    const res = await call(`/api/registry/${id}`, {}, env);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await res.json()) as { package: { label: string }; comments: { body: string }[] };
    expect(body.package.label).toBe(evil);
    expect(body.comments[0]!.body).toBe(evil);
  });
  it("search treats wildcards as text", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await listPackages(env, { q: "%", evidence: null, author: null, before: null, limit: 10 })).items.length).toBe(0);
    expect((await listPackages(env, { q: "Return", evidence: null, author: null, before: null, limit: 10 })).items.length).toBe(1);
  });
  it("takes reports from anyone", async () => {
    expect((await call("/api/reports", { method: "POST", body: JSON.stringify({ target: id, reason: "spam" }), headers: { origin: ORIGIN, "content-type": "application/json" } }, env)).status).toBe(201);
  });
});

describe("takedown", () => {
  const ADMIN = { authorization: "Bearer test-admin-key-not-a-secret" };
  it("removes the bytes and text and keeps a tombstone", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await call(`/api/admin/registry/${id}?reason=abuse`, { method: "DELETE", headers: ADMIN }, env)).status).toBe(200);
    expect((await call(`/api/registry/${id}/bytes`, {}, env)).status).toBe(451);
    const body = (await (await call(`/api/registry/${id}`, {}, env)).json()) as { package: { prompt: string; taken_down: number; label: string } };
    expect(body.package).toMatchObject({ prompt: "", taken_down: 1, label: "Taken down" });
    expect((await listPackages(env, { q: null, evidence: null, author: null, before: null, limit: 10 })).items).toEqual([]);
  });
  it("needs the admin key", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await call(`/api/admin/registry/${id}`, { method: "DELETE" }, env)).status).toBe(404);
  });
});

describe("log", () => {
  it("chains every event and verifies", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    const stub = base.REGISTRY_LOG!.get(base.REGISTRY_LOG!.idFromName("main"));
    const { entries } = (await stub.page(0, 100)) as unknown as { entries: LogEntry[] };
    expect(entries.length).toBeGreaterThan(0);
    expect(await verifyLog(entries)).toBe(-1);
  });
});

describe("verifier down", () => {
  it("leaves the site working, with the job pending", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await call("/api/registry", {}, env)).status).toBe(200);
    expect((await call(`/api/registry/${id}`, {}, env)).status).toBe(200);
    expect((await call(`/api/registry/${id}/bytes`, {}, env)).status).toBe(200);
    const job = await base.COMMUNITY_DB!.prepare("SELECT status FROM verify_jobs WHERE object_id = ?1").bind(id).first<{ status: string }>();
    expect(job!.status).toBe("pending");
  });
});

describe("takedown and lock files", () => {
  it("a lock pinning a taken-down object fails closed", async () => {
    const { checkLock, classify } = await import("@llmtobinary/registry");
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    await call(`/api/admin/registry/${id}`, { method: "DELETE", headers: { authorization: "Bearer test-admin-key-not-a-secret" } }, env);
    const p = ((await (await call(`/api/registry/${id}`, {}, env)).json()) as { package: { taken_down: number } }).package;
    const problems = checkLock({ kind: "llmtobinary-lock/1", root: id, specDigest: "s", engineDigest: "e", policy: { minimumClass: "E1" }, slots: { a: id } }, () => ({ evidence: classify(id, { valid: true, selfConsistent: false }, []), takenDown: !!p.taken_down }));
    expect(problems).toEqual([{ slot: "a", problem: "taken-down" }]);
  });
});

describe("verifier queue", () => {
  it("is private, and lists a task-linked package", async () => {
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1 });
    expect((await call("/api/verifier/jobs", {}, env)).status).toBe(404);
    const e = { ...env, VERIFIER_TOKEN: "t" };
    const r = (await (await call("/api/verifier/jobs", { headers: { authorization: "Bearer t" } }, e)).json()) as { jobs: { objectId: string }[] };
    expect(r.jobs[0]!.objectId).toBe(id);
  });
});
