import { env as rawEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, importSigningKey, objectId, signStatement, statement, verifyLog, type LogEntry, type ObjectId, type TrustedKey } from "@llmtobinary/registry";
import type { GalleryEntry } from "@llmtobinary/protocol";
import community from "../../migrations/0001_community.sql?raw";
import registry from "../../migrations/0002_registry.sql?raw";
import os from "../../migrations/0003_os.sql?raw";
import slotEvidence from "../../migrations/0004_slot_evidence.sql?raw";
import packageLinksSql from "../../migrations/0005_package_links.sql?raw";
import worker from "../index.ts";
import { listPackages, publishGeneration, submitAttestation } from "./registry.ts";
import { libraryAccess, libraryCatalog, libraryGenerationEnabled } from "./library.ts";

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
  for (const sql of [community, registry, os, slotEvidence, packageLinksSql]) for (const s of sql.replace(/--.*$/gm, "").split(";").map((x: string) => x.trim()).filter(Boolean)) await base.COMMUNITY_DB!.prepare(s).run().catch((e: Error) => { if (!/already exists|duplicate column/.test(e.message)) throw e; });
  pair = await generateKeyPair();
  const trust: TrustedKey[] = [{ keyid: "verifier-1", publicKeyHex: pair.publicKeyHex, role: "verifier" }];
  env = { ...base, TRUSTED_KEYS: JSON.stringify(trust) };
  id = await objectId(bytesOf(HEX));
});
beforeEach(async () => {
  for (const t of ["package_links", "slot_candidates", "slots", "verify_jobs", "packages", "generations", "member_spend", "login_sessions", "stars", "comments", "reports", "users"]) await base.COMMUNITY_DB!.prepare(`DELETE FROM ${t}`).run();
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
  it("a pass counts for its own slot only", async () => {
    const db = base.COMMUNITY_DB!;
    await db.prepare("DELETE FROM slot_candidates").run();
    await db.prepare("DELETE FROM slots").run();
    for (const s of ["a", "b"]) await db.prepare("INSERT INTO slots (id, title, kind, features, depends, interface, prompt, position) VALUES (?1, ?1, 'library', 0, '[]', '[]', 'p', 0)").bind(s).run();
    await publishGeneration(env, entry(), { backfilled: false, authorId: null, now: 1, slot: "a" });
    await db.prepare("INSERT INTO slot_candidates (slot_id, object_id, created_at) VALUES ('b', ?1, 1)").bind(id).run();
    await submitAttestation(env, id, await signStatement(statement(id, "test", { ...passing, taskId: "slot:a" }), await importSigningKey("verifier-1", pair.privateKeyPkcs8Hex)), 2);
    const rows = (await db.prepare("SELECT slot_id, verified FROM slot_candidates ORDER BY slot_id").all<{ slot_id: string; verified: number }>()).results;
    expect(rows).toEqual([{ slot_id: "a", verified: 1 }, { slot_id: "b", verified: 0 }]);
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

describe("the library", () => {
  const fnCard = [{ symbol: "id.same", signature: "() -> u64", behaviour: "Returns 42.", id: 0, params: [], ret: 1 }];
  let distinct = 0;
  async function slot(name: string, evidence: string, o: { features?: number; verified?: number; kind?: string; depends?: string[] } = {}): Promise<ObjectId> {
    const db = base.COMMUNITY_DB!;
    // Each slot gets its own object: return-42 with a different constant.
    const hex = HEX.replace("2a00000000000000", `${(++distinct).toString(16).padStart(2, "0")}00000000000000`);
    const own = (await publishGeneration(env, entry({ hex, id: `slot-${name}` }), { backfilled: false, authorId: null, now: 1 }))!;
    await db.prepare("UPDATE packages SET evidence_class = ?2 WHERE object_id = ?1").bind(own, evidence).run();
    await db.prepare("INSERT INTO slots (id, title, kind, features, depends, interface, prompt, position) VALUES (?1, ?1, ?2, ?3, ?4, ?5, 'p', 0)").bind(name, o.kind ?? "library", o.features ?? 1, JSON.stringify(o.depends ?? []), JSON.stringify(fnCard)).run();
    await db.prepare("INSERT INTO slot_candidates (slot_id, object_id, verified, created_at) VALUES (?1, ?2, ?3, 1)").bind(name, own, o.verified ?? 1).run();
    return own;
  }
  // Tests read the production vars, so "off" must be explicit.
  const on = (): Env => ({ ...env, LIBRARY_GENERATION: "true" });
  const off = (): Env => ({ ...env, LIBRARY_GENERATION: undefined });
  const create = (task: Record<string, unknown>, e: Env) => call("/api/generation-sessions", { method: "POST", body: JSON.stringify({ task: { taskId: null, description: "fake:default", params: [], returns: "u64", allowedFeatures: 3, requireClaims: false, ...task }, mode: "tools", profile: "default" }), headers: { origin: "https://example.com", "content-type": "application/json" } }, e);

  it("is off unless switched on", () => {
    expect(libraryGenerationEnabled(off())).toBe(false);
    expect(libraryGenerationEnabled(on())).toBe(true);
  });
  it("offers only verified E4 library slots within the features", async () => {
    await slot("good", "E4");
    await slot("low", "E3");
    await slot("unverified", "E4", { verified: 0 });
    await slot("needs-disk", "E4", { features: 33 });
    await slot("kernel", "E4", { kind: "root" });
    expect((await libraryCatalog(env, 3)).map((e) => e.slot)).toEqual(["good"]);
  });
  it("links real bytes, and refuses bytes that do not match their ID", async () => {
    const own = await slot("good", "E4");
    const records = [[1, 0, 0, 1], [2, 0, 0, 1], [0x42, 0, 1, 0], [0x43, 0, 0, 0], [4, 0, 0, 0], [0x70, 1, 0, 1]];
    const words = [0x414d4e41, 2, 0, records.length, 0, 0, 0, 0, ...records.flat()];
    const module = new Uint8Array(new Uint32Array(words).buffer);
    const a = await libraryAccess(env, 3);
    const good = await a.link(module, ["id.same"]);
    expect(good).toMatchObject({ ok: true, uses: ["id.same"], packages: [{ slot: "good" }] });
    await base.REGISTRY!.put(`objects/sha256/${own.slice(7)}`, new Uint8Array([1, 2, 3]));
    const bad = await a.link(module, ["id.same"]);
    expect(bad).toMatchObject({ ok: false, errors: [{ rule: "LINK-FETCH" }] });
  });
  it("records what a program reused, and shows a package withdrawn later", async () => {
    const dep = await slot("good", "E4");
    const program = "414e4d4101000000000000000000000000000000000000000000000000000000";
    const pid = await objectId(bytesOf(program));
    await publishGeneration(env, entry({ hex: program, sessionId: "22222222-2222-4222-8222-222222222222", id: "y", links: [{ slot: "good", objectId: dep, evidence: "E4", symbols: ["id.same"] }], uses: ["id.same"] }), { backfilled: false, authorId: null, now: 2 });
    const read = async (x: string) => ((await (await call(`/api/registry/${x}`, {}, env)).json()) as { links: { uses: { slot: string; symbols: string[]; withdrawn: boolean }[]; usedBy: number } }).links;
    expect((await read(pid)).uses).toEqual([expect.objectContaining({ slot: "good", symbols: ["id.same"], withdrawn: false })]);
    expect((await read(dep)).usedBy).toBe(1);
    await base.COMMUNITY_DB!.prepare("UPDATE slot_candidates SET verified = 0 WHERE slot_id = 'good'").run();
    expect((await read(pid)).uses[0]!.withdrawn).toBe(true);
  });
  it("cannot be switched on by a client", async () => {
    expect((await create({ library: true }, on())).status).toBe(400);
  });
  it("gives an open generation the library, and a curated task none", async () => {
    await slot("good", "E4");
    const state = async (r: Response) => {
      const { sessionId } = (await r.json()) as { sessionId: string };
      return (await (await base.GENERATION_SESSION.get(base.GENERATION_SESSION.idFromName(sessionId)).fetch("https://session/summary")).json()) as { promptVersion: string };
    };
    expect((await state(await create({}, on()))).promptVersion).toContain("llmtobinary-library");
    expect((await state(await create({}, off()))).promptVersion).not.toContain("library");
    expect((await state(await create({ taskId: "square-plus-two", description: null, params: ["u64"] }, on()))).promptVersion).not.toContain("library");
  });
  it("falls back to an ordinary session when nothing is importable", async () => {
    const r = await create({}, on());
    expect(r.status).toBe(201);
    const { sessionId } = (await r.json()) as { sessionId: string };
    const s = (await (await base.GENERATION_SESSION.get(base.GENERATION_SESSION.idFromName(sessionId)).fetch("https://session/summary")).json()) as { promptVersion: string };
    expect(s.promptVersion).not.toContain("library");
  });
});

describe("a broken library", () => {
  it("never stops generation: the session falls back to an ordinary one", async () => {
    const db = base.COMMUNITY_DB!;
    await db.prepare("ALTER TABLE slots RENAME TO slots_away").run();
    try {
      const r = await call("/api/generation-sessions", { method: "POST", body: JSON.stringify({ task: { taskId: null, description: "fake:default", params: [], returns: "u64", allowedFeatures: 3, requireClaims: false }, mode: "tools", profile: "default" }), headers: { origin: "https://example.com", "content-type": "application/json" } }, { ...env, LIBRARY_GENERATION: "true" });
      expect(r.status).toBe(201);
      const { sessionId } = (await r.json()) as { sessionId: string };
      const s = (await (await base.GENERATION_SESSION.get(base.GENERATION_SESSION.idFromName(sessionId)).fetch("https://session/summary")).json()) as { promptVersion: string };
      expect(s.promptVersion).not.toContain("library");
    } finally {
      await db.prepare("ALTER TABLE slots_away RENAME TO slots").run();
    }
  });
});
