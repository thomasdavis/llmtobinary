import { env as rawEnv, exports as rawExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const env = rawEnv as unknown as Env;
const worker = (rawExports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
const ORIGIN = "https://example.com";
const fetchApi = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetchApi(path, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGIN, "content-type": "application/json", ...headers } });

const curated = { task: { taskId: "square-plus-two", description: null, params: ["u64"], returns: "u64", allowedFeatures: 2, requireClaims: false }, mode: "tools", profile: "default" };

async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function create(body: unknown = curated) {
  const res = await post("/api/generation-sessions", body);
  expect(res.status).toBe(201);
  return (await res.json()) as { sessionId: string; token: string };
}

describe("worker routes", () => {
  it("GET /api/config reports the spec, catalog, budget, and no secrets", async () => {
    const res = await fetchApi("/api/config");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const c = (await res.json()) as Record<string, unknown>;
    expect(c.specId).toBe("ANMA-1/prd-3.2");
    expect(String(c.specSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(c.liveGeneration).toBe(true);
    expect(JSON.stringify(c)).not.toContain("test-signing-key");
  });

  it("rejects origin-less and cross-origin POSTs", async () => {
    expect((await fetchApi("/api/generation-sessions", { method: "POST", body: JSON.stringify(curated) })).status).toBe(403);
    expect((await post("/api/generation-sessions", curated, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("validates session requests (no client-chosen models, unknown tasks, or widened features)", async () => {
    expect((await post("/api/generation-sessions", { ...curated, profile: "gpt-anything" })).status).toBe(400);
    expect((await post("/api/generation-sessions", { ...curated, task: { ...curated.task, taskId: "nope" } })).status).toBe(400);
    expect((await post("/api/generation-sessions", { ...curated, task: { ...curated.task, allowedFeatures: 1 << 9 } })).status).toBe(400);
  });

  it("requires the owner token for session routes", async () => {
    const a = await create();
    const b = await create();
    expect((await fetchApi(`/api/generation-sessions/${a.sessionId}`)).status).toBe(401);
    expect((await fetchApi(`/api/generation-sessions/${a.sessionId}`, { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(401);
    expect((await fetchApi(`/api/generation-sessions/${a.sessionId}`, { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(200);
  });
});

describe("agentic loop through the Durable Object", () => {
  it("streams checks and a submission, resumes by sequence, replays idempotently, and stops on a browser pass", async () => {
    const s = await create();
    const auth = { authorization: `Bearer ${s.token}` };
    const res = await post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: "attempt-0001", feedback: null }, auth);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await ndjson(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("check.result");
    expect(types).toContain("candidate.submitted");
    const first = events.find((e) => e.type === "check.result") as { report: { errors: { rule: string }[] } };
    expect(first.report.errors.map((d) => d.rule)).toEqual(["ANMA-V-HDR-004", "ANMA-V-ARG-001"]);
    const seqs = events.map((e) => e.seq as number);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));

    const resumed = await ndjson(await fetchApi(`/api/generation-sessions/${s.sessionId}/events?after=2`, { headers: auth }));
    expect(resumed[0]!.seq).toBe(3);
    expect(resumed.length).toBe(events.length - 2);

    const replay = await ndjson(await post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: "attempt-0001", feedback: null }, auth));
    expect(replay.map((e) => e.seq)).toEqual(seqs);
    const summary = (await (await fetchApi(`/api/generation-sessions/${s.sessionId}`, { headers: auth })).json()) as { counters: { turns: number } };
    expect(summary.counters.turns).toBe(3); // the replay bought no turn

    const sub = events.find((e) => e.type === "candidate.submitted") as { candidate: { sha256: string } };
    const passed = {
      candidateSha256: sub.candidate.sha256,
      validation: { ok: true, byteLength: 192, sha256: sub.candidate.sha256, errors: [], warnings: [], suppressed: 0, omitted: 0, listing: null, listingTruncated: false, annotations: { present: false, records: 0, claimsChecked: 0, claimsMatched: 0, contracts: 0, invariants: 0, examples: 0, sha256: null }, catalogVersion: "x" },
      tests: { taskId: "square-plus-two", passed: true, cases: [], diagnostics: [], tier: "T0", contractOwner: null },
    };
    const end = await ndjson(await post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: "attempt-0002", feedback: passed }, auth));
    expect(end.find((e) => e.type === "loop.stopped")).toMatchObject({ outcome: "passed" });
  });

  it("lists every generation publicly: in progress at once, then the passing program", async () => {
    const s = await create();
    const auth = { authorization: `Bearer ${s.token}` };
    const find = async () => ((await (await fetchApi("/api/gallery")).json()) as { items: { id: string; sessionId: string; label: string; prompt: string; outcome: string; program: string | null; bytes: number; instructions: number }[] }).items.find((i) => i.sessionId === s.sessionId);
    let item = await find();
    expect(item).toMatchObject({ outcome: "in-progress", program: null, bytes: 0 });
    expect(item!.prompt.length).toBeGreaterThan(0);
    const events = await ndjson(await post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: "gallery-1", feedback: null }, auth));
    const sub = events.find((e) => e.type === "candidate.submitted") as { candidate: { sha256: string } };
    item = await find();
    expect(item).toMatchObject({ outcome: "in-progress", program: "submission", bytes: 192 });
    const fb = {
      candidateSha256: sub.candidate.sha256,
      validation: { ok: true, byteLength: 192, sha256: sub.candidate.sha256, errors: [], warnings: [], suppressed: 0, omitted: 0, listing: null, listingTruncated: false, annotations: { present: false, records: 0, claimsChecked: 0, claimsMatched: 0, contracts: 0, invariants: 0, examples: 0, sha256: null }, catalogVersion: "x" },
      tests: { taskId: "square-plus-two", passed: true, cases: [], diagnostics: [], tier: "T0", contractOwner: null },
    };
    await ndjson(await post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: "gallery-2", feedback: fb }, auth));
    item = await find();
    expect(item).toMatchObject({ outcome: "passed", program: "passed", bytes: 192, instructions: 10 });
    const full = (await (await fetchApi(`/api/gallery/${item!.id}`)).json()) as { hex: string; sha256: string };
    expect(full.sha256).toBe(sub.candidate.sha256);
    const bytes = new Uint8Array(full.hex.match(/../g)!.map((h) => parseInt(h, 16)));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe(sub.candidate.sha256);
    expect((await fetchApi("/api/gallery/not-an-id")).status).toBe(404);
  });

  it("hides the operator rebuild route without the admin key", async () => {
    expect((await post("/api/admin/gallery/rebuild", {})).status).toBe(404);
    expect((await post("/api/admin/gallery/rebuild", {}, { authorization: "Bearer wrong" })).status).toBe(404);
  });

  it("cancel propagates to the running upstream request", async () => {
    const s = await create({ task: { taskId: null, description: "fake:hang", params: [], returns: "u64", allowedFeatures: 0, requireClaims: false }, mode: "tools", profile: "default" });
    const auth = { authorization: `Bearer ${s.token}` };
    const pending = post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: "attempt-hang1", feedback: null }, auth);
    const res = await pending;
    const reader = res.body!.getReader();
    await reader.read(); // attempt.started arrives while the model hangs
    const c = await post(`/api/generation-sessions/${s.sessionId}/cancel`, {}, auth);
    expect(c.status).toBe(202);
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"attempt.cancelled"');
    expect(text).toContain('"outcome":"cancelled"');
  });
});

describe("budget ledger", () => {
  it("is atomic under concurrent reservations", async () => {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName("atomic-test"));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stub.reserve(`s${i}`, `t${i}`, 0.4)));
    expect(results.filter((r: { ok: boolean }) => r.ok).length).toBe(12); // daily cap $5.00 / $0.40
    const sum = await stub.summary();
    expect(sum.committedUsd).toBeCloseTo(4.8, 6);
    await stub.reconcile("t0", 0.1);
    await stub.reconcile("t1", null); // unknown usage stays charged
    const after = await stub.summary();
    expect(after.committedUsd).toBeCloseTo(4.5, 6);
    expect(after.unknownTurns).toBe(1);
  });
  it("enforces the per-session cap", async () => {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName("session-cap"));
    expect((await stub.reserve("one", "a", 0.6)).ok).toBe(true);
    expect((await stub.reserve("one", "b", 0.6)).ok).toBe(false);
  });
});
