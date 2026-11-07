#!/usr/bin/env node
// Live library check on a deployed site, with the site's own model: node scripts/live-library.mjs <url> <out.jsonl>
// One attempt per prompt (the first submission). Reports what the model searched, chose and reused,
// and whether the linked image it would run is valid. Costs a few cents per prompt, inside the site's caps.
import { appendFileSync } from "node:fs";

const [url, out] = [process.argv[2]?.replace(/\/$/, ""), process.argv[3]];
if (!url || !out) throw new Error("usage: live-library.mjs <url> <out.jsonl>");
const PROMPTS = [
  ["reuse", ["u64", "u64", "u64"], "Return the least common multiple of three numbers a, b and c, each from 1 to 1000000."],
  ["reuse", ["u64"], "Return the 64-bit FNV-1a hash of n written in decimal ASCII digits."],
  ["reuse", ["u64"], "Return the sum of floor(sqrt(i)) for i from 1 to n, where n is at most 3000."],
  ["control", ["u64", "u64"], "Return the larger of a and b."],
];
const headers = { "content-type": "application/json", origin: url };
for (const [kind, params, description] of PROMPTS) {
  const started = Date.now();
  const res = await fetch(`${url}/api/generation-sessions`, { method: "POST", headers, body: JSON.stringify({ task: { taskId: null, description, params, returns: "u64", allowedFeatures: 3, requireClaims: false }, mode: "tools", profile: "default" }) });
  const created = await res.json();
  if (!res.ok) throw new Error(`create failed: ${res.status} ${JSON.stringify(created)}`);
  const run = await fetch(`${url}/api/generation-sessions/${created.sessionId}/attempts`, { method: "POST", headers: { ...headers, authorization: `Bearer ${created.token}` }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), feedback: null }) });
  const events = (await run.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sub = events.findLast((e) => e.type === "candidate.submitted");
  const linked = events.findLast((e) => e.type === "library.linked");
  const hex = sub ? JSON.parse(sub.envelopeText).hex : null;
  const row = {
    kind,
    description,
    sessionId: created.sessionId,
    seconds: Math.round((Date.now() - started) / 1000),
    turns: events.filter((e) => e.type === "turn.started").length,
    searches: events.filter((e) => e.type === "library.searched").map((e) => e.query),
    selected: events.findLast((e) => e.type === "library.selected")?.symbols ?? [],
    uses: linked?.uses ?? [],
    packages: linked?.packages.map((p) => `${p.slot} ${p.evidence}`) ?? [],
    submitted: !!sub,
    version: hex ? parseInt(hex.replace(/\s+/g, "").slice(8, 10), 16) : null,
    stopped: events.findLast((e) => e.type === "loop.stopped")?.detail ?? null,
    errors: events.filter((e) => e.type === "attempt.error").map((e) => e.message),
  };
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}
