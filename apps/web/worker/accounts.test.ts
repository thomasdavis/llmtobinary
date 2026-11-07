import { env as rawEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import schema from "../migrations/0001_community.sql?raw";
import worker from "./index.ts";
import { MEMBER_DAILY_MICRO_USD, NEW_ACCOUNT_DAILY_MICRO_USD, avatarUrlAllowed, dailyQuotaMicroUsd, fakeOAuthEnabled, finishSignIn, reserveMemberSpend } from "./accounts.ts";
import type { GitHubProfile, Member } from "./accounts.ts";

const env = rawEnv as unknown as Env;
const ORIGIN = "https://example.com";
const call = (path: string, init: RequestInit = {}, e: Env = env) => (worker.fetch as unknown as (r: Request, e: Env) => Promise<Response>)(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), e);
const write = (cookie: string, method = "POST"): RequestInit => ({ method, headers: { origin: ORIGIN, cookie } });

async function signIn(id: number, ageDays = 365): Promise<string> {
  const res = await call(`/api/auth/fake?id=${id}&login=u${id}&ageDays=${ageDays}`);
  expect(res.status).toBe(302);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const body = { task: { taskId: "square-plus-two", description: null, params: ["u64"], returns: "u64", allowedFeatures: 2, requireClaims: false }, mode: "tools", profile: "default" };
const generate = (cookie: string | null, e: Env) => call("/api/generation-sessions", { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) } }, e);

beforeAll(async () => {
  const statements = schema.replace(/--.*$/gm, "").split(";").map((s: string) => s.trim()).filter(Boolean);
  for (const s of statements) await env.COMMUNITY_DB!.prepare(s).run();
});
beforeEach(async () => {
  for (const t of ["generations", "member_spend", "login_sessions", "stars", "comments", "reports", "users"]) await env.COMMUNITY_DB!.prepare(`DELETE FROM ${t}`).run();
});

describe("sign-in", () => {
  it("signs in, reports the member, and signs out", async () => {
    const cookie = await signIn(7);
    const me = (await (await call("/api/me", { headers: { cookie } })).json()) as { member: Member };
    expect(me.member.login).toBe("u7");
    expect((await call("/api/auth/logout", write(cookie))).status).toBe(200);
    expect(((await (await call("/api/me", { headers: { cookie } })).json()) as { member: unknown }).member).toBeNull();
  });
  it("sets a hardened cookie and stores only a hash of it", async () => {
    const res = await call("/api/auth/fake?id=8");
    const c = res.headers.get("set-cookie")!;
    for (const flag of ["__Host-lb_session=", "Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) expect(c).toContain(flag);
    const value = c.split(";")[0]!.split("=")[1]!;
    const row = await env.COMMUNITY_DB!.prepare("SELECT token_hash FROM login_sessions").first<{ token_hash: string }>();
    expect(row!.token_hash).not.toBe(value);
  });
  it("revokes every session", async () => {
    const a = await signIn(9);
    const b = await signIn(9);
    expect((await call("/api/me/sessions", write(a, "DELETE"))).status).toBe(200);
    for (const cookie of [a, b]) expect(((await (await call("/api/me", { headers: { cookie } })).json()) as { member: unknown }).member).toBeNull();
  });
  it("deletes an account but keeps generation records, unattributed", async () => {
    const cookie = await signIn(10);
    await env.COMMUNITY_DB!.prepare("INSERT INTO generations (session_id, user_id, created_at) VALUES ('s', 10, 1)").run();
    expect((await call("/api/me", write(cookie, "DELETE"))).status).toBe(200);
    expect(await env.COMMUNITY_DB!.prepare("SELECT id FROM users WHERE id = 10").first()).toBeNull();
    expect((await env.COMMUNITY_DB!.prepare("SELECT user_id FROM generations").first<{ user_id: number | null }>())!.user_id).toBeNull();
  });
});

describe("oauth safety", () => {
  const profile = async (): Promise<GitHubProfile> => ({ id: 42, login: "real", name: null, avatar_url: null, created_at: "2020-01-01T00:00:00Z" });
  const req = (url: string, cookie?: string) => new Request(url, { headers: cookie ? { cookie } : {} });
  it("rejects a missing, absent or tampered state", async () => {
    await expect(finishSignIn(req(`${ORIGIN}/cb?code=c&state=abc`), env, ORIGIN, profile)).rejects.toThrow(/state/);
    await expect(finishSignIn(req(`${ORIGIN}/cb?code=c&state=abc`, "__Host-lb_oauth=other"), env, ORIGIN, profile)).rejects.toThrow(/state/);
    await expect(finishSignIn(req(`${ORIGIN}/cb?code=c`, "__Host-lb_oauth=abc"), env, ORIGIN, profile)).rejects.toThrow(/state/);
  });
  it("accepts a matching state and clears it", async () => {
    const res = await finishSignIn(req(`${ORIGIN}/cb?code=c&state=abc`, "__Host-lb_oauth=abc"), env, ORIGIN, profile);
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-lb_oauth=;"))).toBe(true);
  });
  it("stores no GitHub token anywhere", async () => {
    await finishSignIn(req(`${ORIGIN}/cb?code=c&state=abc`, "__Host-lb_oauth=abc"), env, ORIGIN, profile);
    const cols = await env.COMMUNITY_DB!.prepare("SELECT group_concat(name) AS c FROM pragma_table_info('users')").first<{ c: string }>();
    expect(cols!.c).not.toMatch(/token/);
  });
  it("rejects cross-origin writes", async () => {
    const cookie = await signIn(11);
    for (const [path, method] of [["/api/auth/logout", "POST"], ["/api/me", "DELETE"], ["/api/me/sessions", "DELETE"]] as const) {
      expect((await call(path, { method, headers: { origin: "https://evil.example", cookie } })).status).toBe(403);
      expect((await call(path, { method, headers: { cookie } })).status).toBe(403);
    }
  });
  it("the avatar route only accepts GitHub's avatar host", () => {
    expect(avatarUrlAllowed("https://avatars.githubusercontent.com/u/1?v=4")).not.toBeNull();
    for (const bad of ["http://avatars.githubusercontent.com/u/1", "https://evil.example/a.png", "https://avatars.githubusercontent.com.evil.example/a", "not a url", "file:///etc/passwd"]) expect(avatarUrlAllowed(bad)).toBeNull();
  });
  it("the fake provider cannot run outside the test environment", async () => {
    for (const ENVIRONMENT of ["staging", "production", "development", ""]) expect(fakeOAuthEnabled({ ENVIRONMENT, TEST_FAKE_OAUTH: "1" })).toBe(false);
    expect(fakeOAuthEnabled({ ENVIRONMENT: "test", TEST_FAKE_OAUTH: "0" })).toBe(false);
    expect((await call("/api/auth/fake?id=1", {}, { ...env, ENVIRONMENT: "staging" })).status).toBe(404);
    expect((await call("/api/auth/fake?id=1", {}, { ...env, ENVIRONMENT: "production" })).status).toBe(404);
  });
});

describe("generation access", () => {
  const required = { ...env, GENERATION_REQUIRES_SIGN_IN: "true" };
  it("stays open while sign-in is not required", async () => {
    expect((await generate(null, env)).status).toBe(201);
  });
  it("ignores the switch when sign-in is not configured, so generation cannot lock", async () => {
    expect((await generate(null, { ...env, GENERATION_REQUIRES_SIGN_IN: "true", TEST_FAKE_OAUTH: "0", GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined })).status).toBe(201);
  });
  it("needs a member once required, and attributes the session", async () => {
    expect((await generate(null, required)).status).toBe(401);
    const cookie = await signIn(12);
    const res = await generate(cookie, required);
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect((await env.COMMUNITY_DB!.prepare("SELECT user_id FROM generations WHERE session_id = ?1").bind(sessionId).first<{ user_id: number }>())!.user_id).toBe(12);
  });
  it("anonymous visitors can still browse", async () => {
    for (const path of ["/api/config", "/api/gallery"]) expect((await call(path, {}, required)).status).toBe(200);
  });
});

describe("quota", () => {
  const now = Date.now();
  const member = (ageDays: number): Member => ({ id: 20, login: "q", name: null, avatarUrl: null, role: "member", githubCreatedAt: now - ageDays * 86_400_000 });
  it("gives young accounts less", () => {
    expect(dailyQuotaMicroUsd(member(400), now)).toBe(MEMBER_DAILY_MICRO_USD);
    expect(dailyQuotaMicroUsd(member(5), now)).toBe(NEW_ACCOUNT_DAILY_MICRO_USD);
  });
  it("stops at the quota with a clear message", async () => {
    const cookie = await signIn(21);
    await env.COMMUNITY_DB!.prepare("INSERT INTO member_spend (user_id, day, micro_usd) VALUES (21, ?1, ?2)").bind(new Date().toISOString().slice(0, 10), MEMBER_DAILY_MICRO_USD).run();
    const res = await generate(cookie, { ...env, GENERATION_REQUIRES_SIGN_IN: "true" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/quota/);
  });
  it("cannot be passed by concurrent reservations", async () => {
    await signIn(20);
    const m = member(400);
    const amount = 300_000;
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveMemberSpend(env, m, amount, now)));
    expect(results.filter(Boolean).length).toBe(3);
    const row = await env.COMMUNITY_DB!.prepare("SELECT micro_usd FROM member_spend WHERE user_id = 20").first<{ micro_usd: number }>();
    expect(row!.micro_usd).toBe(900_000);
  });
});
