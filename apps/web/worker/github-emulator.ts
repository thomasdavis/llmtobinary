// A stand-in for GitHub's OAuth web flow, used because no OAuth App exists yet. It speaks the same
// protocol, so beginSignIn, finishSignIn and fetchGitHubProfile run unchanged against it. It proves
// the site's side of sign-in. It says nothing about GitHub itself.
//
// Limits that keep it safe on a deployed site:
// - Approval needs the owner's passcode, a secret that only exists where it was set.
// - It can only issue one fixed account. The ID is negative and GitHub's are positive, so it can
//   never match or impersonate a real member. The role stays the default, member.
// - Setting GITHUB_CLIENT_ID turns it off.
// - The token and profile endpoints are called in process and have no public route.

import { HttpError, checkOrigin } from "./http.ts";
import type { GitHubProfile } from "./accounts.ts";

export const EMULATOR_CLIENT_ID = "github-emulator";
export const EMULATOR_AUTHORIZE_PATH = "/api/auth/emulator/authorize";
/** `.invalid` is reserved and never resolves, so these can only be served by emulatorFetch. */
export const EMULATOR_TOKEN_URL = "https://github-emulator.invalid/login/oauth/access_token";
export const EMULATOR_USER_URL = "https://github-emulator.invalid/user";

export const EMULATED_PROFILE: GitHubProfile = { id: -1, login: "emulated-owner", name: "Emulated owner", avatar_url: null, created_at: "2020-01-01T00:00:00.000Z" };

const CODE_SECONDS = 60;
const TOKEN_SECONDS = 60;
const MIN_PASSCODE = 32;
const MAX_PASSCODE = 256;
const ENVIRONMENTS = ["test", "staging", "production"];
const STATE = /^[0-9a-f]{64}$/;

type EmulatorEnv = Pick<Env, "ENVIRONMENT" | "GITHUB_CLIENT_ID" | "GITHUB_EMULATOR_PASSCODE">;

export const emulatorEnabled = (env: EmulatorEnv): boolean => !env.GITHUB_CLIENT_ID && (env.GITHUB_EMULATOR_PASSCODE ?? "").length >= MIN_PASSCODE && ENVIRONMENTS.includes(env.ENVIRONMENT);

const bytes = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s));
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));

const hmacKey = (env: EmulatorEnv): Promise<CryptoKey> => crypto.subtle.importKey("raw", bytes(`github-emulator:${env.GITHUB_EMULATOR_PASSCODE}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** Compares through HMAC, so the check takes the same time wherever the input differs. */
async function passcodeMatches(env: EmulatorEnv, submitted: string): Promise<boolean> {
  const key = await hmacKey(env);
  const expected = await crypto.subtle.sign("HMAC", key, bytes(`passcode:${env.GITHUB_EMULATOR_PASSCODE}`));
  return crypto.subtle.verify("HMAC", key, expected, bytes(`passcode:${submitted}`));
}

async function issue(env: EmulatorEnv, kind: string, seconds: number, binding: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), bytes(`${kind}.${expires}.${binding}`));
  return `${expires}.${hex(mac)}`;
}

async function redeem(env: EmulatorEnv, kind: string, value: string, binding: string): Promise<boolean> {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(env), unhex(m[2]!), bytes(`${kind}.${m[1]}.${binding}`));
}

const callback = (origin: string): string => `${origin}/api/auth/github/callback`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // Not no-referrer: that makes browsers send `Origin: null` on the form post, which checkOrigin refuses.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** The page standing in for GitHub's consent screen. `state` is checked as hex, so it is safe in the HTML. */
export function emulatorForm(request: Request, env: EmulatorEnv, origin: string): Response {
  if (!emulatorEnabled(env)) throw new HttpError(404, "not found");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (!STATE.test(state) || url.searchParams.get("client_id") !== EMULATOR_CLIENT_ID || url.searchParams.get("redirect_uri") !== callback(origin)) throw new HttpError(400, "bad authorization request");
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub emulator</title><h1>GitHub emulator</h1><p>This is not GitHub. It stands in for GitHub sign-in until an OAuth App exists, and only the site owner has the passcode.</p><form method="post" action="${EMULATOR_AUTHORIZE_PATH}"><input type="hidden" name="state" value="${state}"><p><label>Passcode <input type="password" name="passcode" required autocomplete="off"></label></p><p><button type="submit">Sign in as ${EMULATED_PROFILE.login}</button></p></form></html>`;
  return new Response(page, { headers: HEADERS });
}

/** Approves the sign-in and sends the browser to the real callback, as GitHub would. */
export async function emulatorApprove(request: Request, env: EmulatorEnv, origin: string): Promise<Response> {
  if (!emulatorEnabled(env)) throw new HttpError(404, "not found");
  checkOrigin(request);
  const form = await request.formData();
  const state = form.get("state");
  const passcode = form.get("passcode");
  if (typeof state !== "string" || !STATE.test(state) || typeof passcode !== "string" || passcode.length > MAX_PASSCODE) throw new HttpError(400, "bad authorization request");
  if (!(await passcodeMatches(env, passcode))) throw new HttpError(401, "wrong passcode");
  const target = new URL(callback(origin));
  target.searchParams.set("code", await issue(env, "code", CODE_SECONDS, callback(origin)));
  target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stands in for `fetch` when the server calls the provider: the token exchange, then the profile read. */
export const emulatorFetch =
  (env: EmulatorEnv): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === EMULATOR_TOKEN_URL && init?.method === "POST") {
      const b = JSON.parse(String(init.body)) as { client_id?: string; code?: string; redirect_uri?: string };
      const ok = b.client_id === EMULATOR_CLIENT_ID && typeof b.code === "string" && typeof b.redirect_uri === "string" && (await redeem(env, "code", b.code, b.redirect_uri));
      return ok ? reply({ access_token: await issue(env, "token", TOKEN_SECONDS, EMULATOR_CLIENT_ID), token_type: "bearer", scope: "" }) : reply({ error: "bad_verification_code" });
    }
    if (url === EMULATOR_USER_URL) {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      return (await redeem(env, "token", token, EMULATOR_CLIENT_ID)) ? reply(EMULATED_PROFILE) : reply({ message: "Bad credentials" }, 401);
    }
    return reply({ message: "Not Found" }, 404);
  };
