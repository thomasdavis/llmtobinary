// Cloudflare Worker "llmtobinary" (PRD Section 8): /api/* broker routes; every other path is served
// from static assets (run_worker_first covers only /api/*). The Worker never executes guest code.

import { CATALOG_VERSION } from "@llmtobinary/diagnostics";
import { SPEC_ID, SPEC_SHA256, KNOWN_FEATURES } from "@llmtobinary/spec";
import { DEFAULT_BUDGET, MAX_DEBUG_BROWSER_BYTES, PRICE_POLICY_VERSION, PROMPT_VERSION, TOOLS, generationInstructions, profileFromEnv } from "@llmtobinary/broker";
import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { PROTOCOL_VERSION, type ConfigResponse, type CreateSessionRequest, type CreateSessionResponse, type AttemptRequest, type GalleryEntry } from "@llmtobinary/protocol";
import { signToken, verifyToken } from "./auth.ts";
import { HttpError, checkOrigin, errorResponse, json, readJson, API_HEADERS } from "./http.ts";
import type { CreatePayload } from "./session.ts";
import { programPage, sitemap } from "./seo.ts";
import { getGalleryEntry, hideGalleryEntry, isGalleryId, listGallery, rebuildFromArchives } from "./gallery.ts";
import { addComment, addReport, listComments, setStar } from "./community/social.ts";
import { getObject, getPackage, listPackages, loadAttestations, parseObjectId, pendingJobs, publishGeneration, registryConfigured, submitAttestation, takeDown } from "./community/registry.ts";
import type { Envelope, EvidenceClass } from "@llmtobinary/registry";
import { getSlot, listBuilds, listSlots, proposeCounterexample, proposeTest, publishBuild, reviewTest, type BuildRequest } from "./community/board.ts";
import { accountsConfigured, avatar, beginSignIn, currentMember, deleteAccount, fakeOAuthEnabled, fakeSignIn, finishSignIn, quotaRemaining, requireMember, reserveMemberSpend, revokeAllSessions, signOut } from "./accounts.ts";

export { GenerationSession } from "./session.ts";
export { BudgetLedger } from "./ledger.ts";
export { RegistryLog } from "./community/log.ts";

const MAX_CREATE_BODY = 64 * 1024;
const MAX_ATTEMPT_BODY = 1024 * 1024;
const MAX_DESCRIPTION = 16_000;
/** Charged against a member's daily quota per session. The BudgetLedger stays the hard site-wide cap. */
const SESSION_ESTIMATE_MICRO_USD = 50_000;

/** Sign-in is enforced only when switched on and working, so a missing OAuth App cannot stop generation. */
const signInRequired = (env: Env): boolean => env.GENERATION_REQUIRES_SIGN_IN === "true" && accountsConfigured(env);

function buildCommit(): string {
  return typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "unknown";
}

function liveStatus(env: Env): { live: boolean; reason: string | null } {
  if (env.ENVIRONMENT === "test" && env.TEST_FAKE_MODEL === "1") return { live: !!env.SESSION_SIGNING_KEY, reason: env.SESSION_SIGNING_KEY ? null : "SESSION_SIGNING_KEY missing" };
  if (env.LIVE_GENERATION_ENABLED !== "true") return { live: false, reason: "live generation is disabled for this deployment" };
  if (!env.OPENAI_API_KEY) return { live: false, reason: "OPENAI_API_KEY is not configured" };
  if (!env.SESSION_SIGNING_KEY) return { live: false, reason: "SESSION_SIGNING_KEY is not configured" };
  const p = profileFromEnv(env);
  if (!p.ok) return { live: false, reason: p.reason };
  return { live: true, reason: null };
}

function allowedFeatures(env: Env): number {
  const n = Number(env.ALLOWED_FEATURES ?? KNOWN_FEATURES);
  return Number.isInteger(n) ? n & KNOWN_FEATURES : 0;
}

function config(env: Env): ConfigResponse & { liveReason: string | null; pricePolicy: string; promptVersion: string; accounts: boolean; signInRequired: boolean } {
  const live = liveStatus(env);
  const p = profileFromEnv(env);
  return {
    protocol: PROTOCOL_VERSION,
    specId: SPEC_ID,
    specSha256: SPEC_SHA256,
    catalogVersion: CATALOG_VERSION,
    buildCommit: buildCommit(),
    deploymentId: env.CF_VERSION_METADATA?.id ?? null,
    environment: env.ENVIRONMENT,
    liveGeneration: live.live,
    liveReason: live.reason,
    profiles: p.ok ? [{ id: p.profile.id, label: p.profile.label, model: p.profile.model, reasoningEffort: p.profile.reasoningEffort, openTaskReasoningEffort: p.profile.openTaskReasoningEffort ?? p.profile.reasoningEffort }] : [],
    allowedFeatures: allowedFeatures(env),
    budget: DEFAULT_BUDGET,
    recoveryTtlSeconds: Number(env.RECOVERY_TTL_SECONDS ?? "3600"),
    pricePolicy: PRICE_POLICY_VERSION,
    promptVersion: PROMPT_VERSION,
    accounts: accountsConfigured(env),
    signInRequired: signInRequired(env),
  };
}

/** A generation for an OS slot. Everything comes from the slot, so a client cannot widen it. */
async function slotRequest(env: Env, id: string): Promise<CreateSessionRequest> {
  if (!env.COMMUNITY_DB) throw new HttpError(503, "the OS board is not configured");
  const slot = await getSlot(env, id);
  if (!slot) throw new HttpError(404, "no such slot");
  return { task: { taskId: null, description: slot.prompt, params: [], returns: "u64", allowedFeatures: slot.features, requireClaims: false, module: true, slot: slot.id }, mode: "tools", profile: "default" };
}

function validateCreate(body: unknown, env: Env): CreateSessionRequest {
  const b = body as Partial<CreateSessionRequest> | null;
  if (!b || typeof b !== "object") throw new HttpError(400, "body must be an object");
  if (b.mode !== "tools" && b.mode !== "raw-hex") throw new HttpError(400, 'mode must be "tools" or "raw-hex"');
  if (b.profile !== "default") throw new HttpError(400, "unknown model profile (clients cannot choose models outside the allowlist)");
  const t = b.task as CreateSessionRequest["task"] | undefined;
  if (!t || typeof t !== "object") throw new HttpError(400, "task is required");
  if (t.taskId !== null && (typeof t.taskId !== "string" || !TASK_BY_ID.has(t.taskId))) throw new HttpError(400, "unknown taskId");
  if (t.taskId === null && (typeof t.description !== "string" || !t.description.trim() || t.description.length > MAX_DESCRIPTION)) {
    throw new HttpError(400, `open tasks need a description of 1..${MAX_DESCRIPTION} characters`);
  }
  if (!Array.isArray(t.params) || t.params.length > 8 || !t.params.every((p) => p === "u64" || p === "bool")) throw new HttpError(400, "params must be up to 8 of u64/bool");
  if (t.returns !== "unit" && t.returns !== "u64" && t.returns !== "bool") throw new HttpError(400, "returns must be unit/u64/bool");
  if (!Number.isInteger(t.allowedFeatures) || (t.allowedFeatures & ~allowedFeatures(env)) !== 0) throw new HttpError(400, "allowedFeatures exceeds the host policy");
  if (typeof t.requireClaims !== "boolean") throw new HttpError(400, "requireClaims must be a boolean");
  if (t.isa !== undefined && t.isa !== "ANMA-1" && t.isa !== "ANMR-1") throw new HttpError(400, "isa must be ANMA-1 or ANMR-1");
  // Set by the server for OS slots only.
  if (t.module !== undefined || t.slot !== undefined) throw new HttpError(400, "module and slot cannot be set by a client");
  if (t.isa === "ANMR-1") {
    const spec = t.taskId ? TASK_BY_ID.get(t.taskId) : null;
    if (!spec?.pressure || b.mode !== "tools" || !Number.isInteger(t.registers) || t.registers! < 4 || t.registers! > 32) {
      throw new HttpError(400, "ANMR-1 (research control) needs a capstone task, tools mode, and 4..32 registers");
    }
  }
  // Curated tasks use the registry's own feature set; clients cannot widen it.
  const task = t.taskId ? { ...t, description: null, allowedFeatures: TASK_BY_ID.get(t.taskId)!.features & t.allowedFeatures } : t;
  return { task, mode: b.mode, profile: "default" };
}

/** Constant-time comparison of two strings (via their SHA-256 digests). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function admit(request: Request, env: Env, what: string): Promise<void> {
  if (!env.ADMISSION_LIMITER) return;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.ADMISSION_LIMITER.limit({ key: `${what}:${ip}` });
  if (!success) throw new HttpError(429, "too many requests; try again shortly");
}

async function authorize(request: Request, env: Env, sessionId: string): Promise<void> {
  const secret = env.SESSION_SIGNING_KEY;
  if (!secret) throw new HttpError(503, "sessions are not configured");
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const claims = await verifyToken(token, secret, Date.now());
  if (!claims || claims.sid !== sessionId) throw new HttpError(401, "missing, invalid, or expired session token");
}

function withApiHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(API_HEADERS)) if (k !== "content-type" || !headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  // One public address: page loads on any other host (www, workers.dev) move to the canonical one.
  // API calls are served wherever they arrive, so open tabs and links keep working.
  const canonical = env.CANONICAL_HOST;
  if (canonical && url.hostname !== canonical && !path.startsWith("/api/") && (request.method === "GET" || request.method === "HEAD")) {
    return Response.redirect(`https://${canonical}${path}${url.search}`, 301);
  }
  const siteOrigin = canonical ? `https://${canonical}` : url.origin;
  if (path === "/sitemap.xml" && request.method === "GET") return sitemap(env, siteOrigin);
  if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
    const page = await programPage(request, env, siteOrigin);
    if (env.ENVIRONMENT === "production") return page;
    // Staging and test deployments stay out of search results.
    const headers = new Headers(page.headers);
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(page.body, { status: page.status, headers });
  }
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

  if (path === "/api/config" && request.method === "GET") return json(config(env));

  // GitHub sign-in. Navigation requests, so these answer with redirects rather than JSON.
  if (path === "/api/auth/github" && request.method === "GET") return beginSignIn(env, siteOrigin);
  if (path === "/api/auth/github/callback" && request.method === "GET") {
    if (!accountsConfigured(env)) throw new HttpError(503, "sign-in is not configured");
    return finishSignIn(request, env, siteOrigin);
  }
  if (path === "/api/auth/fake" && request.method === "GET") {
    if (!fakeOAuthEnabled(env)) return json({ error: "not found" }, 404);
    return fakeSignIn(request, env);
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    checkOrigin(request);
    return signOut(request, env);
  }
  if (path === "/api/me" && request.method === "GET") {
    const m = await currentMember(request, env);
    if (!m) return json({ member: null });
    return json({ member: m, quotaMicroUsd: await quotaRemaining(env, m, Date.now()) });
  }
  if (path === "/api/me" && request.method === "DELETE") {
    checkOrigin(request);
    return deleteAccount(env, (await requireMember(request, env)).id);
  }
  if (path === "/api/me/sessions" && request.method === "DELETE") {
    checkOrigin(request);
    await revokeAllSessions(env, (await requireMember(request, env)).id);
    return json({ revoked: true });
  }
  const av = /^\/api\/avatar\/(\d{1,20})$/.exec(path);
  if (av && request.method === "GET") return avatar(env, Number(av[1]));

  // The exact system instructions and tool definitions every generation is given.
  if (path === "/api/system-prompt" && request.method === "GET") {
    return json({ promptVersion: PROMPT_VERSION, instructions: generationInstructions(), tools: TOOLS }, 200, { "cache-control": "public, max-age=300" });
  }

  // Operator only (GALLERY_ADMIN_KEY): rebuild the list from the debug archive, or take an entry down.
  if (path.startsWith("/api/admin/")) {
    const key = env.GALLERY_ADMIN_KEY;
    const auth = request.headers.get("authorization") ?? "";
    if (!key || !env.DEBUG_ARCHIVE || !(await sameSecret(auth, `Bearer ${key}`))) return json({ error: "not found" }, 404);
    if (path === "/api/admin/gallery/rebuild" && request.method === "POST") {
      const cursor = url.searchParams.get("cursor");
      return json(await rebuildFromArchives(env.DEBUG_ARCHIVE, cursor || null, 100));
    }
    if (path === "/api/admin/slots" && request.method === "POST") {
      const slots = await readJson<{ id: string; title: string; kind: string; features: number; depends: string[]; interface: unknown; prompt: string }[]>(request, 256 * 1024);
      const db = env.COMMUNITY_DB!;
      await db.batch(slots.map((s, i) => db.prepare("INSERT INTO slots (id, title, kind, features, depends, interface, prompt, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (id) DO UPDATE SET title = ?2, kind = ?3, features = ?4, depends = ?5, interface = ?6, prompt = ?7, position = ?8").bind(s.id, s.title, s.kind, s.features, JSON.stringify(s.depends), JSON.stringify(s.interface), s.prompt, i)));
      return json({ slots: slots.length });
    }
    if (path === "/api/admin/registry/publish" && request.method === "POST") {
      if (!registryConfigured(env)) throw new HttpError(503, "the registry is not configured");
      const b = await readJson<{ entry: GalleryEntry; slot?: string; attestations?: Envelope[] }>(request, 1024 * 1024);
      const now = Date.now();
      const id = await publishGeneration(env, b.entry, { backfilled: false, authorId: null, now, ...(b.slot ? { slot: b.slot } : {}) });
      if (!id) throw new HttpError(400, "nothing to publish");
      const results = [];
      for (const a of b.attestations ?? []) results.push((await submitAttestation(env, id, a, now)).accepted);
      return json({ id, results });
    }
    if (path === "/api/admin/registry/backfill" && request.method === "POST") {
      if (!registryConfigured(env)) throw new HttpError(503, "the registry is not configured");
      const page = await listGallery(env.DEBUG_ARCHIVE, url.searchParams.get("cursor"), 50);
      let published = 0;
      for (const item of page.items) {
        const body = await getGalleryEntry(env.DEBUG_ARCHIVE, item.id);
        if (body && (await publishGeneration(env, JSON.parse(body), { backfilled: true, authorId: null, now: Date.now() }))) published++;
      }
      return json({ published, seen: page.items.length, cursor: page.cursor });
    }
    const down = /^\/api\/admin\/registry\/(sha256:[0-9a-f]{64})$/.exec(path);
    if (down && request.method === "DELETE" && registryConfigured(env)) {
      const reason = url.searchParams.get("reason") ?? "takedown";
      await takeDown(env, parseObjectId(down[1]!), reason.slice(0, 200), Date.now());
      return json({ takenDown: down[1] });
    }
    const del = /^\/api\/admin\/gallery\/([0-9a-f-]+)$/.exec(path);
    if (del && request.method === "DELETE" && isGalleryId(del[1]!)) {
      // Removes the public entry for good (later archive writes skip it); the private archive is kept.
      await hideGalleryEntry(env.DEBUG_ARCHIVE, del[1]!);
      return json({ deleted: del[1] });
    }
    return json({ error: "not found" }, 404);
  }

  // The public program list: every generation (read-only, cacheable briefly).
  if (path === "/api/gallery" && request.method === "GET") {
    if (!env.DEBUG_ARCHIVE) return json({ items: [], cursor: null });
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "100") || 100, 1), 500);
    return json(await listGallery(env.DEBUG_ARCHIVE, cursor && cursor.length < 1024 ? cursor : null, limit), 200, { "cache-control": "public, max-age=15" });
  }
  const g = /^\/api\/gallery\/([0-9a-f-]+)$/.exec(path);
  if (g && request.method === "GET") {
    if (!env.DEBUG_ARCHIVE || !isGalleryId(g[1]!)) return json({ error: "not found" }, 404);
    const body = await getGalleryEntry(env.DEBUG_ARCHIVE, g[1]!);
    if (!body) return json({ error: "not found" }, 404);
    return new Response(body, { headers: { ...API_HEADERS, "content-type": "application/json", "cache-control": "public, max-age=3600" } });
  }

  if (path.startsWith("/api/registry") || path.startsWith("/api/reports") || path.startsWith("/api/verifier") || path.startsWith("/api/slots") || path.startsWith("/api/builds") || path.startsWith("/api/proposals")) {
    if (!registryConfigured(env)) return json({ error: "the registry is not configured" }, 503);
    return registryRoute(request, env, url, path);
  }

  if (path === "/api/generation-sessions" && request.method === "POST") {
    checkOrigin(request);
    await admit(request, env, "create");
    const member = signInRequired(env) ? await requireMember(request, env) : await currentMember(request, env);
    const body = await readJson<{ slot?: unknown }>(request, MAX_CREATE_BODY);
    const req = typeof body.slot === "string" ? await slotRequest(env, body.slot) : validateCreate({ ...body, slot: undefined }, env);
    const live = liveStatus(env);
    if (!live.live) throw new HttpError(503, `live generation is unavailable: ${live.reason}`);
    if (member && !(await reserveMemberSpend(env, member, SESSION_ESTIMATE_MICRO_USD, Date.now()))) throw new HttpError(429, "you have used today's generation quota; browsing and running still work");
    const profile = profileFromEnv(env);
    const prof = profile.ok ? profile.profile : { id: "default", label: "test", model: "test-model", reasoningEffort: null, carryReasoning: false, inputPerMTok: 1, outputPerMTok: 4, maxContextChars: 600_000 };
    // Visitor-written tasks get their own (usually higher) reasoning effort.
    const sessionProf = req.task.taskId === null && prof.openTaskReasoningEffort && prof.openTaskReasoningEffort !== prof.reasoningEffort ? { ...prof, reasoningEffort: prof.openTaskReasoningEffort } : prof;
    const sessionId = crypto.randomUUID();
    const ttlMs = Number(env.RECOVERY_TTL_SECONDS ?? "3600") * 1000;
    const stub = env.GENERATION_SESSION.get(env.GENERATION_SESSION.idFromName(sessionId));
    const payload: CreatePayload = { sessionId, request: req, profile: sessionProf, budget: {}, ttlMs };
    const res = await stub.fetch("https://session/create", { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) return withApiHeaders(res);
    const created = (await res.json()) as { programId: string; budget: CreateSessionResponse["budget"]; expiresAt: number };
    const token = await signToken({ sid: sessionId, exp: created.expiresAt }, env.SESSION_SIGNING_KEY!);
    if (member) await env.COMMUNITY_DB!.prepare("INSERT INTO generations (session_id, user_id, created_at) VALUES (?1, ?2, ?3)").bind(sessionId, member.id, Date.now()).run();
    return json({ sessionId, programId: created.programId, token, budget: created.budget, expiresAt: created.expiresAt } satisfies CreateSessionResponse, 201);
  }

  const m = /^\/api\/generation-sessions\/([0-9a-f-]{36})(\/attempts|\/events|\/cancel|\/debug)?$/.exec(path);
  if (m) {
    const sessionId = m[1]!;
    const sub = m[2] ?? "";
    await authorize(request, env, sessionId);
    const stub = env.GENERATION_SESSION.get(env.GENERATION_SESSION.idFromName(sessionId));
    if (sub === "/attempts" && request.method === "POST") {
      checkOrigin(request);
      await admit(request, env, "attempt");
      const body = await readJson<AttemptRequest>(request, MAX_ATTEMPT_BODY);
      if (!body || typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 128) throw new HttpError(400, "idempotencyKey (8..128 chars) is required");
      // The client signal propagates: if the browser disconnects, the stream write fails in the DO.
      const res = await stub.fetch("https://session/attempt", { method: "POST", body: JSON.stringify({ idempotencyKey: body.idempotencyKey, feedback: body.feedback ?? null }), signal: request.signal });
      return withApiHeaders(res);
    }
    if (sub === "/events" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "after must be a non-negative integer");
      return withApiHeaders(await stub.fetch(`https://session/events?after=${after}`));
    }
    if (sub === "/cancel" && request.method === "POST") {
      checkOrigin(request);
      return withApiHeaders(await stub.fetch("https://session/cancel", { method: "POST" }));
    }
    if (sub === "/debug" && request.method === "POST") {
      checkOrigin(request);
      const bundle = await readJson<unknown>(request, MAX_DEBUG_BROWSER_BYTES);
      return withApiHeaders(await stub.fetch("https://session/debug", { method: "POST", body: JSON.stringify(bundle) }));
    }
    if (sub === "" && request.method === "GET") return withApiHeaders(await stub.fetch("https://session/summary"));
  }
  return json({ error: "not found" }, 404);
}

const EVIDENCE: readonly string[] = ["E0", "E1", "E2", "E3", "E4", "E5"];
const MAX_ATTESTATION_BODY = 64 * 1024;

async function registryRoute(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const now = Date.now();
  if (path === "/api/registry" && request.method === "GET") {
    const evidence = url.searchParams.get("class");
    const before = url.searchParams.get("before");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 200);
    const q = url.searchParams.get("q");
    return json(await listPackages(env, { q: q ? q.slice(0, 200) : null, evidence: evidence && EVIDENCE.includes(evidence) ? (evidence as EvidenceClass) : null, author: url.searchParams.get("author"), before: before ? Number(before) : null, limit }), 200, { "cache-control": "public, max-age=15" });
  }
  if (path === "/api/reports" && request.method === "POST") {
    checkOrigin(request);
    await admit(request, env, "report");
    const b = await readJson<{ target?: unknown; reason?: unknown }>(request, 8 * 1024);
    await addReport(env, await currentMember(request, env), b.target, b.reason, now);
    return json({ reported: true }, 201);
  }
  if (path === "/api/slots" && request.method === "GET") return json(await listSlots(env), 200, { "cache-control": "public, max-age=15" });
  if (path === "/api/builds" && request.method === "GET") return json({ builds: await listBuilds(env) });
  if (path === "/api/builds" && request.method === "POST") {
    checkOrigin(request);
    await admit(request, env, "build");
    const member = await currentMember(request, env);
    return json(await publishBuild(env, member, await readJson<BuildRequest>(request, 256 * 1024), now), 201);
  }
  const tests = /^\/api\/slots\/([a-z0-9-]{1,40})\/tests$/.exec(path);
  if (tests && request.method === "POST") {
    checkOrigin(request);
    const member = await requireMember(request, env);
    return json(await proposeTest(env, member, tests[1]!, (await readJson<{ body?: unknown }>(request, 16 * 1024)).body, now), 201);
  }
  const review = /^\/api\/proposals\/([0-9a-f-]{36})$/.exec(path);
  if (review && request.method === "POST") {
    checkOrigin(request);
    const member = await requireMember(request, env);
    await reviewTest(env, member, review[1]!, (await readJson<{ accept?: unknown }>(request, 1024)).accept === true);
    return json({ reviewed: true });
  }
  if (path === "/api/verifier/jobs" && request.method === "GET") {
    const auth = request.headers.get("authorization") ?? "";
    if (!env.VERIFIER_TOKEN || !(await sameSecret(auth, `Bearer ${env.VERIFIER_TOKEN}`))) return json({ error: "not found" }, 404);
    return json({ jobs: await pendingJobs(env, 20) });
  }
  const m = /^\/api\/registry\/(sha256:[0-9a-f]{64}|sha256%3A[0-9a-f]{64})(\/bytes|\/attestations|\/comments|\/star|\/counterexamples)?$/.exec(path);
  if (!m) return json({ error: "not found" }, 404);
  const id = parseObjectId(m[1]!);
  const sub = m[2] ?? "";
  if (sub === "" && request.method === "GET") {
    const p = await getPackage(env, id);
    if (!p) return json({ error: "not found" }, 404);
    const attestations = (await loadAttestations(env, id)).map((a) => ({ predicateType: a.verified?.statement.predicateType ?? null, keyid: a.verified?.keyid ?? null, verified: !!a.verified }));
    return json({ package: p, attestations, comments: await listComments(env, id) });
  }
  if (sub === "/bytes" && request.method === "GET") return getObject(env, id);
  if (sub === "/attestations" && request.method === "POST") {
    checkOriginOrToken(request);
    const r = await submitAttestation(env, id, await readJson<Envelope>(request, MAX_ATTESTATION_BODY), now);
    return json(r, r.accepted ? 201 : 403);
  }
  if (sub === "/comments" && request.method === "POST") {
    checkOrigin(request);
    const member = await requireMember(request, env);
    const b = await readJson<{ body?: unknown }>(request, 8 * 1024);
    return json(await addComment(env, member, id, b.body, now), 201);
  }
  if (sub === "/counterexamples" && request.method === "POST") {
    checkOrigin(request);
    const member = await requireMember(request, env);
    return json(await proposeCounterexample(env, member, id, (await readJson<{ input?: unknown }>(request, 16 * 1024)).input, now), 201);
  }
  if (sub === "/star" && (request.method === "PUT" || request.method === "DELETE")) {
    checkOrigin(request);
    await setStar(env, await requireMember(request, env), id, request.method === "PUT", now);
    return json({ starred: request.method === "PUT" });
  }
  return json({ error: "not found" }, 404);
}

/** The verifier posts from outside a browser; its signature, not its origin, is what counts. */
function checkOriginOrToken(request: Request): void {
  if (request.headers.get("origin")) checkOrigin(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(JSON.stringify({ component: "worker", event: "unhandled", path: new URL(request.url).pathname, name: (e as Error)?.name, message: (e as Error)?.message }));
      if (env.ENVIRONMENT === "staging" && !(e instanceof HttpError)) return json({ error: "internal error", detail: `${(e as Error)?.name}: ${(e as Error)?.message}` }, 500);
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;
