import { env as rawEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import community from "../../migrations/0001_community.sql?raw";
import registry from "../../migrations/0002_registry.sql?raw";
import board from "../../migrations/0003_os.sql?raw";
import slotEvidence from "../../migrations/0004_slot_evidence.sql?raw";
import packageLinksSql from "../../migrations/0005_package_links.sql?raw";
import { classForSlot, contributions, defaultCandidate, proposeCounterexample, proposeTest, reviewTest, settleCounterexample } from "./board.ts";
import type { Member } from "../accounts.ts";

const env = rawEnv as unknown as Env;
const member = (id: number, role: Member["role"] = "member"): Member => ({ id, login: `u${id}`, name: null, avatarUrl: null, role, githubCreatedAt: 0 });
const cand = (object_id: string, evidence_class: "E2" | "E3" | "E4", records: number, created_at: number, stars = 0) => ({ object_id, evidence_class, records, created_at, retracted: 0, taken_down: 0, stars, verified: 1 });

beforeAll(async () => {
  for (const sql of [community, registry, board, slotEvidence, packageLinksSql]) for (const s of sql.replace(/--.*$/gm, "").split(";").map((x: string) => x.trim()).filter(Boolean)) await env.COMMUNITY_DB!.prepare(s).run().catch((e: Error) => { if (!/already exists|duplicate column/.test(e.message)) throw e; });
});
beforeEach(async () => {
  for (const t of ["counterexamples", "test_proposals", "slot_candidates", "packages", "slots", "users"]) await env.COMMUNITY_DB!.prepare(`DELETE FROM ${t}`).run();
  for (const id of [1, 2, 3]) await env.COMMUNITY_DB!.prepare("INSERT INTO users (id, login, github_created_at, created_at, updated_at) VALUES (?1, ?2, 0, 0, 0)").bind(id, `u${id}`).run();
  await env.COMMUNITY_DB!.prepare("INSERT INTO slots (id, title, kind, features, depends, interface, prompt, position) VALUES ('fs', 'fs', 'library', 0, '[]', '[]', 'p', 0)").run();
});

describe("default candidate", () => {
  it("ranks by evidence, then size, then age", () => {
    expect(defaultCandidate([cand("a", "E2", 10, 1), cand("b", "E3", 900, 2)])!.object_id).toBe("b");
    expect(defaultCandidate([cand("a", "E3", 200, 1), cand("b", "E3", 100, 2)])!.object_id).toBe("b");
    expect(defaultCandidate([cand("a", "E3", 100, 5), cand("b", "E3", 100, 2)])!.object_id).toBe("b");
  });
  it("ignores stars entirely", () => {
    expect(defaultCandidate([cand("popular", "E2", 10, 1, 9999), cand("tested", "E3", 500, 2, 0)])!.object_id).toBe("tested");
  });
  it("skips retracted and taken-down candidates", () => {
    expect(defaultCandidate([{ ...cand("bad", "E4", 1, 1), retracted: 1 }, cand("ok", "E2", 9, 2)])!.object_id).toBe("ok");
    expect(defaultCandidate([{ ...cand("gone", "E4", 1, 1), taken_down: 1 }])).toBeNull();
  });
});

describe("evidence is per slot", () => {
  it("does not let a package verified elsewhere win this slot", () => {
    const real = { ...cand("real", "E3", 182, 1), verified: 1 };
    const elsewhere = { ...cand("elsewhere", "E3", 49, 2), verified: 0 };
    expect(defaultCandidate([real, elsewhere])!.object_id).toBe("real");
  });
  it("caps an unverified candidate at E2 for this slot", () => {
    expect(classForSlot({ evidence_class: "E4", verified: 0 })).toBe("E2");
    expect(classForSlot({ evidence_class: "E3", verified: 1 })).toBe("E3");
    expect(classForSlot({ evidence_class: "E1", verified: 0 })).toBe("E1");
  });
});

describe("Break this package", () => {
  const seed = async () => {
    const db = env.COMMUNITY_DB!;
    await db.prepare("DELETE FROM counterexamples").run();
    for (const [id, deps] of [["str", "[]"], ["fs", '["str"]'], ["kernel", '["fs"]'], ["other", "[]"]] as const) await db.prepare("INSERT OR REPLACE INTO slots (id, title, kind, features, depends, interface, prompt, position) VALUES (?1, ?1, 'library', 0, ?2, '[]', 'p', 0)").bind(id, deps).run();
    for (const s of ["str", "fs", "kernel", "other"]) await db.prepare("INSERT INTO slot_candidates (slot_id, object_id, created_at, verified) VALUES (?1, ?2, 1, 1)").bind(s, `sha256:${s}`).run();
  };
  const verified = async () => Object.fromEntries((await env.COMMUNITY_DB!.prepare("SELECT slot_id, verified FROM slot_candidates").all<{ slot_id: string; verified: number }>()).results.map((r) => [r.slot_id, r.verified]));
  it("a confirmed break demotes the package and everything depending on it, and credits the contributor", async () => {
    await seed();
    const { id } = await proposeCounterexample(env, member(1), "sha256:str" as never, "{}", 1);
    await settleCounterexample(env, id, true);
    expect(await verified()).toEqual({ str: 0, fs: 0, kernel: 0, other: 1 });
    expect((await contributions(env, "u1")).counterexamples).toBe(1);
  });
  it("a rejected claim changes nothing and credits nobody", async () => {
    await seed();
    const { id } = await proposeCounterexample(env, member(2), "sha256:str" as never, "{}", 1);
    await settleCounterexample(env, id, false);
    expect(await verified()).toEqual({ str: 1, fs: 1, kernel: 1, other: 1 });
    expect((await contributions(env, "u2")).counterexamples).toBe(0);
  });
});

describe("test proposals", () => {
  it("only curators decide", async () => {
    const { id } = await proposeTest(env, member(1), "fs", "try an empty name", 1);
    await expect(reviewTest(env, member(2), id, true)).rejects.toThrow(/curators/);
    await reviewTest(env, member(2, "curator"), id, true);
    expect((await env.COMMUNITY_DB!.prepare("SELECT status FROM test_proposals WHERE id = ?1").bind(id).first<{ status: string }>())!.status).toBe("accepted");
  });
  it("an author cannot accept tests for their own package", async () => {
    await env.COMMUNITY_DB!.prepare("INSERT INTO packages (object_id, label, prompt, outcome, model, records, byte_length, author_id, licence, created_at) VALUES ('sha256:x', 'l', 'p', 'passed', 'm', 1, 1, 3, 'CC0-1.0', 1)").run();
    await env.COMMUNITY_DB!.prepare("INSERT INTO slot_candidates (slot_id, object_id, created_at) VALUES ('fs', 'sha256:x', 1)").run();
    const { id } = await proposeTest(env, member(1), "fs", "a test", 1);
    await expect(reviewTest(env, member(3, "curator"), id, true)).rejects.toThrow(/you wrote/);
  });
});
