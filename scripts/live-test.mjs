// Live checks against a deployed Worker (PRD Section 20.2 "on the deployed Worker").
//   node scripts/live-test.mjs <base-url> [--fake]   (--fake: the test deployment with the scripted model)
//   node scripts/live-test.mjs <base-url> --openai <taskId>   (real OpenAI smoke test; spends money)
const base = process.argv[2]?.replace(/\/$/, "");
const fake = process.argv.includes("--fake");
const openaiIdx = process.argv.indexOf("--openai");
const openaiTask = openaiIdx > 0 ? process.argv[openaiIdx + 1] : null;
if (!base) {
  console.error("usage: node scripts/live-test.mjs <base-url> [--fake | --openai <taskId>]");
  process.exit(2);
}
const origin = new URL(base).origin;
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
const ndjson = async (res) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const cfg = await (await fetch(`${base}/api/config`)).json();
ok(cfg.specId === "ANMA-1/prd-3.2" && /^[0-9a-f]{64}$/.test(cfg.specSha256), `config: ${cfg.environment}, build ${cfg.buildCommit}, deployment ${cfg.deploymentId}, live=${cfg.liveGeneration}`);
ok(!JSON.stringify(cfg).match(/sk-[A-Za-z0-9]/), "config exposes no secrets");

const home = await fetch(`${base}/`);
const html = await home.text();
ok(home.ok && html.includes("<title>llmtobinary</title>"), "static assets: / serves the app");
ok((home.headers.get("content-security-policy") ?? "").includes("script-src 'self'") && !(home.headers.get("content-security-policy") ?? "").includes("unsafe-eval"), "CSP from _headers is present and forbids unsafe-eval");
const spa = await fetch(`${base}/some/deep/route`);
ok(spa.ok && (await spa.text()).includes("<title>llmtobinary</title>"), "SPA routes fall back to index.html");
const nf = await fetch(`${base}/api/nope`);
ok(nf.status === 404 && nf.headers.get("content-type")?.includes("application/json"), "/api/* reaches Worker code (JSON 404)");

const curated = { task: { taskId: "square-plus-two", description: null, params: ["u64"], returns: "u64", allowedFeatures: 2, requireClaims: false }, mode: "tools", profile: "default" };
ok((await fetch(`${base}/api/generation-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(curated) })).status === 403, "origin-less POST rejected");
ok((await post("/api/generation-sessions", curated, { origin: "https://evil.example" })).status === 403, "cross-origin POST rejected");
ok((await post("/api/generation-sessions", { ...curated, profile: "gpt-anything" })).status === 400, "client cannot choose a model");

if (!cfg.liveGeneration) {
  const r = await post("/api/generation-sessions", curated);
  ok(r.status === 503, `live generation disabled -> 503 (${cfg.liveReason})`);
} else if (fake) {
  const create = async (body = curated) => (await post("/api/generation-sessions", body)).json();
  const a = await create();
  const b = await create();
  ok(typeof a.token === "string", "session created with a signed token");
  ok((await fetch(`${base}/api/generation-sessions/${a.sessionId}`)).status === 401, "session routes require the token");
  ok((await fetch(`${base}/api/generation-sessions/${a.sessionId}`, { headers: { authorization: `Bearer ${b.token}` } })).status === 401, "another session's token is rejected");
  const auth = { authorization: `Bearer ${a.token}` };
  const t0 = Date.now();
  const res = await post(`/api/generation-sessions/${a.sessionId}/attempts`, { idempotencyKey: "live-attempt-1", feedback: null }, auth);
  ok(res.headers.get("content-type")?.includes("application/x-ndjson"), "attempt streams NDJSON through Cloudflare's edge");
  // Incremental delivery: count chunks as they arrive.
  const reader = res.body.getReader();
  let text = "";
  let chunks = 0;
  let firstChunkMs = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    firstChunkMs ??= Date.now() - t0;
    text += new TextDecoder().decode(value);
  }
  const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok(chunks > 1, `events arrived incrementally (${chunks} chunks, first after ${firstChunkMs} ms)`);
  const checks = events.filter((e) => e.type === "check.result");
  ok(checks[0]?.report.errors.map((d) => d.rule).join(",") === "ANMA-V-HDR-004,ANMA-V-ARG-001", "malformed draft -> check report with HDR-004 then ARG-001");
  ok(checks[1]?.report.ok === true, "fixed draft checks clean");
  const sub = events.find((e) => e.type === "candidate.submitted");
  ok(sub?.candidate.sha256 === "d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1", "submission carries the exact candidate hash");
  const resumed = await ndjson(await fetch(`${base}/api/generation-sessions/${a.sessionId}/events?after=2`, { headers: auth }));
  ok(resumed[0]?.seq === 3 && resumed.length === events.length - 2, "events resume by sequence number");
  const replay = await ndjson(await post(`/api/generation-sessions/${a.sessionId}/attempts`, { idempotencyKey: "live-attempt-1", feedback: null }, auth));
  const sum = await (await fetch(`${base}/api/generation-sessions/${a.sessionId}`, { headers: auth })).json();
  ok(replay.length === events.length && sum.counters.turns === 3, "idempotent replay returns stored events and buys no turn");
  const validation = { ok: true, byteLength: 192, sha256: sub.candidate.sha256, errors: [], warnings: [], suppressed: 0, omitted: 0, listing: null, listingTruncated: false, annotations: { present: false, records: 0, claimsChecked: 0, claimsMatched: 0, contracts: 0, invariants: 0, examples: 0, sha256: null }, catalogVersion: "anma-diagnostics/1" };
  const end = await ndjson(await post(`/api/generation-sessions/${a.sessionId}/attempts`, { idempotencyKey: "live-attempt-2", feedback: { candidateSha256: sub.candidate.sha256, validation, tests: { taskId: "square-plus-two", passed: true, cases: [], diagnostics: [], tier: "T0", contractOwner: null } } }, auth));
  ok(end.find((e) => e.type === "loop.stopped")?.outcome === "passed", "browser pass closes the loop as passed");

  const h = await create({ task: { taskId: null, description: "fake:hang", params: [], returns: "u64", allowedFeatures: 0, requireClaims: false }, mode: "tools", profile: "default" });
  const hauth = { authorization: `Bearer ${h.token}` };
  const pending = await post(`/api/generation-sessions/${h.sessionId}/attempts`, { idempotencyKey: "live-hang-1", feedback: null }, hauth);
  const hr = pending.body.getReader();
  await hr.read();
  const c = await post(`/api/generation-sessions/${h.sessionId}/cancel`, {}, hauth);
  let htext = "";
  while (true) {
    const { done, value } = await hr.read();
    if (done) break;
    htext += new TextDecoder().decode(value);
  }
  ok(c.status === 202 && htext.includes('"attempt.cancelled"') && htext.includes('"outcome":"cancelled"'), "cancel propagates to the running upstream request on the deployed Worker");
} else if (openaiTask) {
  const task = openaiTask;
  const body = { task: { taskId: task, description: null, params: ["u64"], returns: "u64", allowedFeatures: 2, requireClaims: false }, mode: "tools", profile: "default" };
  const s = await (await post("/api/generation-sessions", body)).json();
  ok(typeof s.token === "string", `OpenAI session created (${cfg.profiles[0]?.model})`);
  const res = await post(`/api/generation-sessions/${s.sessionId}/attempts`, { idempotencyKey: `smoke-${Date.now()}`, feedback: null }, { authorization: `Bearer ${s.token}` });
  const events = await ndjson(res);
  const types = events.map((e) => e.type);
  console.log(`  events: ${types.filter((t) => !t.startsWith("model.")).join(" ")}`);
  const sub = events.find((e) => e.type === "candidate.submitted");
  ok(!!sub, `the model submitted a candidate (${sub?.candidate.byteLength ?? "?"} bytes, sha ${sub?.candidate.sha256 ?? "none"})`);
  if (sub) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.SMOKE_OUT ?? "smoke-candidate.json", JSON.stringify({ sessionId: s.sessionId, envelopeText: sub.envelopeText, candidate: sub.candidate, events: events.filter((e) => !e.type.startsWith("model.")) }, null, 2));
  }
}

console.log(failures ? `\n${failures} live check(s) failed` : "\nall live checks passed");
process.exit(failures ? 1 : 0);
