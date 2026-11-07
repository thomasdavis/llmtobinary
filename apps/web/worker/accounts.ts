// GitHub sign-in and member sessions (PRD-OS 6.1). No scopes are requested, the GitHub token is
// dropped as soon as the profile is read, and the session cookie holds a random value whose hash is
// the only thing stored.

import { EMULATOR_AUTHORIZE_PATH, EMULATOR_CLIENT_ID, EMULATOR_TOKEN_URL, EMULATOR_USER_URL, emulatorEnabled, emulatorFetch } from "./github-emulator.ts";
import { HttpError, json } from "./http.ts";

const SESSION_COOKIE = "__Host-lb_session";
const STATE_COOKIE = "__Host-lb_oauth";
const SESSION_MS = 30 * 24 * 3_600_000;
const STATE_SECONDS = 600;
const NEW_ACCOUNT_MS = 30 * 24 * 3_600_000;
export const MEMBER_DAILY_MICRO_USD = 1_000_000;
export const NEW_ACCOUNT_DAILY_MICRO_USD = 200_000;

export interface Member {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: "member" | "curator" | "owner";
  githubCreatedAt: number;
}

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
}

/** The fake provider exists for tests only and cannot be switched on by a deployed environment. */
export const fakeOAuthEnabled = (env: Pick<Env, "ENVIRONMENT" | "TEST_FAKE_OAUTH">): boolean => env.ENVIRONMENT === "test" && env.TEST_FAKE_OAUTH === "1";

export const accountsConfigured = (env: Env): boolean => !!env.COMMUNITY_DB && (fakeOAuthEnabled(env) || emulatorEnabled(env) || (!!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET));

interface OAuthProvider {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  fetch: typeof fetch;
}

/** GitHub, or the emulator while no OAuth App exists. The sign-in code below is the same for both. */
const oauthProvider = (env: Env, origin: string): OAuthProvider =>
  emulatorEnabled(env)
    ? { clientId: EMULATOR_CLIENT_ID, clientSecret: "unused", authorizeUrl: `${origin}${EMULATOR_AUTHORIZE_PATH}`, tokenUrl: EMULATOR_TOKEN_URL, userUrl: EMULATOR_USER_URL, fetch: emulatorFetch(env) }
    : { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, authorizeUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", userUrl: "https://api.github.com/user", fetch: (input, init) => fetch(input, init) };

const randomToken = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number): string => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

async function upsertUser(db: D1Database, p: GitHubProfile, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, login, name, avatar_url, github_created_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT (id) DO UPDATE SET login = ?2, name = ?3, avatar_url = ?4, updated_at = ?6")
    .bind(p.id, p.login, p.name, p.avatar_url, Date.parse(p.created_at) || now, now)
    .run();
}

async function startSession(env: Env, userId: number, now: number): Promise<string> {
  const token = randomToken();
  await env.COMMUNITY_DB!.prepare("INSERT INTO login_sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(await hashToken(token), userId, now, now + SESSION_MS).run();
  return token;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/** Sends the browser to GitHub. A full-page redirect: COOP same-origin cuts the link to a pop-up. */
export function beginSignIn(env: Env, origin: string): Response {
  const provider = oauthProvider(env, origin);
  if (!provider.clientId) throw new HttpError(503, "sign-in is not configured");
  const state = randomToken();
  const u = new URL(provider.authorizeUrl);
  u.searchParams.set("client_id", provider.clientId);
  u.searchParams.set("redirect_uri", `${origin}/api/auth/github/callback`);
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "true");
  return redirect(u.toString(), [setCookie(STATE_COOKIE, state, STATE_SECONDS)]);
}

export type FetchProfile = (code: string, env: Env, origin: string) => Promise<GitHubProfile>;

/** Exchanges the code and reads the public profile. The token never leaves this function. */
export const fetchGitHubProfile: FetchProfile = async (code, env, origin) => {
  const provider = oauthProvider(env, origin);
  const tokenRes = await provider.fetch(provider.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "llmtobinary" },
    body: JSON.stringify({ client_id: provider.clientId, client_secret: provider.clientSecret, code, redirect_uri: `${origin}/api/auth/github/callback` }),
  });
  const t = (await tokenRes.json()) as { access_token?: string };
  if (!t.access_token) throw new HttpError(401, "GitHub did not complete the sign-in");
  const userRes = await provider.fetch(provider.userUrl, { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "llmtobinary" } });
  if (!userRes.ok) throw new HttpError(401, "GitHub did not return a profile");
  const u = (await userRes.json()) as GitHubProfile;
  return { id: u.id, login: u.login, name: u.name ?? null, avatar_url: u.avatar_url ?? null, created_at: u.created_at };
};

export async function finishSignIn(request: Request, env: Env, origin: string, profile: FetchProfile = fetchGitHubProfile): Promise<Response> {
  const url = new URL(request.url);
  const expected = cookie(request, STATE_COOKIE);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!expected || !state || state !== expected || !code) throw new HttpError(400, "sign-in state did not match; please try again");
  const p = await profile(code, env, origin);
  if (!Number.isInteger(p.id) || typeof p.login !== "string") throw new HttpError(401, "GitHub returned an unusable profile");
  const now = Date.now();
  await upsertUser(env.COMMUNITY_DB!, p, now);
  const token = await startSession(env, p.id, now);
  return redirect("/", [setCookie(SESSION_COOKIE, token, SESSION_MS / 1000), setCookie(STATE_COOKIE, "", 0)]);
}

/** Test environments only: sign in as a named account without GitHub. */
export async function fakeSignIn(request: Request, env: Env): Promise<Response> {
  if (!fakeOAuthEnabled(env)) throw new HttpError(404, "not found");
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id") ?? "1");
  const now = Date.now();
  const age = Number(url.searchParams.get("ageDays") ?? "365");
  await upsertUser(env.COMMUNITY_DB!, { id, login: url.searchParams.get("login") ?? `user${id}`, name: null, avatar_url: null, created_at: new Date(now - age * 86_400_000).toISOString() }, now);
  const token = await startSession(env, id, now);
  return redirect("/", [setCookie(SESSION_COOKIE, token, SESSION_MS / 1000)]);
}

export async function currentMember(request: Request, env: Env): Promise<Member | null> {
  if (!env.COMMUNITY_DB) return null;
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.COMMUNITY_DB.prepare("SELECT u.id, u.login, u.name, u.avatar_url, u.role, u.github_created_at, s.expires_at FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1").bind(await hashToken(token)).first<{ id: number; login: string; name: string | null; avatar_url: string | null; role: Member["role"]; github_created_at: number; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url, role: row.role, githubCreatedAt: row.github_created_at };
}

export async function requireMember(request: Request, env: Env): Promise<Member> {
  const m = await currentMember(request, env);
  if (!m) throw new HttpError(401, "sign in with GitHub first");
  return m;
}

export async function signOut(request: Request, env: Env): Promise<Response> {
  const token = cookie(request, SESSION_COOKIE);
  if (token && env.COMMUNITY_DB) await env.COMMUNITY_DB.prepare("DELETE FROM login_sessions WHERE token_hash = ?1").bind(await hashToken(token)).run();
  return json({ ok: true }, 200, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
}

/** Ends every session a member has, on every device. */
export async function revokeAllSessions(env: Env, userId: number): Promise<void> {
  await env.COMMUNITY_DB!.prepare("DELETE FROM login_sessions WHERE user_id = ?1").bind(userId).run();
}

/** Removes the account. Published packages stay and show "deleted user". */
export async function deleteAccount(env: Env, userId: number): Promise<Response> {
  const db = env.COMMUNITY_DB!;
  await db.batch([
    db.prepare("DELETE FROM login_sessions WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM stars WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM comments WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM member_spend WHERE user_id = ?1").bind(userId),
    db.prepare("UPDATE generations SET user_id = NULL WHERE user_id = ?1").bind(userId),
    db.prepare("UPDATE reports SET user_id = NULL WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
  return json({ deleted: true }, 200, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
}

export const dailyQuotaMicroUsd = (m: Pick<Member, "githubCreatedAt">, now: number): number => (now - m.githubCreatedAt < NEW_ACCOUNT_MS ? NEW_ACCOUNT_DAILY_MICRO_USD : MEMBER_DAILY_MICRO_USD);

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

export async function quotaRemaining(env: Env, m: Member, now: number): Promise<number> {
  const row = await env.COMMUNITY_DB!.prepare("SELECT micro_usd FROM member_spend WHERE user_id = ?1 AND day = ?2").bind(m.id, today(now)).first<{ micro_usd: number }>();
  return Math.max(0, dailyQuotaMicroUsd(m, now) - (row?.micro_usd ?? 0));
}

/**
 * Reserves spend atomically: one conditional upsert, so concurrent sessions cannot pass the limit
 * together. Returns false when the reservation would exceed the member's daily quota.
 */
export async function reserveMemberSpend(env: Env, m: Member, microUsd: number, now: number): Promise<boolean> {
  const limit = dailyQuotaMicroUsd(m, now);
  if (microUsd > limit) return false;
  const r = await env.COMMUNITY_DB!.prepare("INSERT INTO member_spend (user_id, day, micro_usd) VALUES (?1, ?2, ?3) ON CONFLICT (user_id, day) DO UPDATE SET micro_usd = micro_usd + ?3 WHERE micro_usd + ?3 <= ?4").bind(m.id, today(now), microUsd, limit).run();
  return r.meta.changes === 1;
}

const AVATAR_HOST = "avatars.githubusercontent.com";

/** Same-origin avatar proxy: COEP require-corp and the CSP both block GitHub's image host directly. */
export async function avatar(env: Env, userId: number): Promise<Response> {
  const row = await env.COMMUNITY_DB?.prepare("SELECT avatar_url FROM users WHERE id = ?1").bind(userId).first<{ avatar_url: string | null }>();
  if (!row?.avatar_url) return new Response(null, { status: 404 });
  const upstream = avatarUrlAllowed(row.avatar_url);
  if (!upstream) return new Response(null, { status: 404 });
  const res = await fetch(upstream, { cf: { cacheTtl: 86_400 } } as RequestInit);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/") || Number(res.headers.get("content-length") ?? "0") > 512 * 1024) return new Response(null, { status: 404 });
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "public, max-age=86400", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff" } });
}

/** Only GitHub's avatar host over HTTPS, so the route can never become an open proxy. */
export function avatarUrlAllowed(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === AVATAR_HOST ? u.toString() : null;
  } catch {
    return null;
  }
}
