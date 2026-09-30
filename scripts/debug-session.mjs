// Fetch a generation session's private debug archive from R2 and print a readable timeline.
//   node scripts/debug-session.mjs <session-id> [production|staging]
//   (accepts the pasted line too: "llmtobinary debug production <session-id>")
// Files are saved under debug-sessions/<env>/<session-id>/ (gitignored).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "llmtobinary" && a !== "debug");
const id = args.find((a) => /^[0-9a-f-]{36}$/.test(a));
const env = args.find((a) => a === "production" || a === "staging") ?? "production";
if (!id) {
  console.error("usage: node scripts/debug-session.mjs <session-id> [production|staging]");
  process.exit(2);
}
const bucket = env === "staging" ? "llmtobinary-debug-staging" : "llmtobinary-debug";
const out = join(root, "debug-sessions", env, id);
mkdirSync(out, { recursive: true });

function fetchObject(key) {
  try {
    return execFileSync("npx", ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--remote", "--pipe"], { cwd: join(root, "apps/web"), maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  } catch {
    return null;
  }
}

const serverText = fetchObject(`sessions/${id}.json`);
if (!serverText) {
  console.error(`no archive for ${id} in ${bucket} (wrong environment, or the session never finished an attempt)`);
  process.exit(1);
}
const browserText = fetchObject(`sessions/${id}.browser.json`);
writeFileSync(join(out, "server.json"), serverText);
if (browserText) writeFileSync(join(out, "browser.json"), browserText);
const a = JSON.parse(serverText);
const b = browserText ? JSON.parse(browserText) : null;

const t0 = a.events[0]?.at ?? 0;
const rel = (t) => `${((t - t0) / 1000).toFixed(1).padStart(7)}s`;
const s = a.summary;
console.log(`session ${id} · ${env} · archived ${a.archivedAt} (${a.reason}) · build ${a.build ?? "?"}`);
console.log(`task: ${s.task.taskId ?? "custom"} — ${(s.task.description ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
console.log(`signature (${s.task.params.join(", ")}) -> ${s.task.returns} · features 0x${s.task.allowedFeatures.toString(16)} · model ${s.model} (${s.reasoningEffort ?? "default"}) · ${s.promptVersion}`);
console.log(`status ${s.status} · outcome ${s.outcome ?? "—"}${s.stopDetail ? ` — ${s.stopDetail}` : ""}`);
console.log(`counters ${JSON.stringify(s.counters)} · $${Number(s.usdSpent).toFixed(4)}`);
console.log(`attempts: ${s.attempts.map((x) => `#${x.iteration} ${x.status} ${x.startedAt?.slice(11, 19)}–${x.endedAt?.slice(11, 19) ?? "…"}`).join(" | ")}`);
console.log(`events ${s.events} (stream deltas omitted: ${JSON.stringify(s.streamedDeltaEvents)}) · last event ${s.lastEventAt}`);
console.log("\ntimeline:");
let prev = t0;
for (const e of a.events) {
  const secs = ((e.at - prev) / 1000).toFixed(0);
  // A long wait that ends in attempt.completed is the model reasoning/streaming; anything else is a stall.
  const gap = e.at - prev > 60_000 ? (e.type === "attempt.completed" || e.type === "attempt.incomplete" ? `   (model worked ${secs}s)` : `   ⚠ ${secs}s gap`) : "";
  prev = e.at;
  let d = "";
  if (e.type === "check.result") d = e.report.ok ? `clean ${e.report.byteLength} B` : `${e.report.errors.length} error(s): ${e.report.errors.map((x) => x.rule).join(", ")}`;
  else if (e.type === "candidate.submitted") d = `${e.candidate.byteLength} B ${e.candidate.sha256?.slice(0, 12)}`;
  else if (e.type === "attempt.error") d = `${e.code}: ${e.message}`;
  else if (e.type === "loop.stopped") d = `${e.outcome}: ${e.detail}`;
  else if (e.type === "loop.elided") d = `checks ${e.elidedChecks}, drafts ${e.elidedDrafts ?? 0}`;
  else if (e.type === "attempt.completed") d = `${e.providerStatus}`;
  else if (e.type === "attempt.incomplete") d = e.reason;
  console.log(`${rel(e.at)}  #${String(e.seq).padStart(5)}  ${e.type}${d ? ` · ${d}` : ""}${gap}`);
}
if (b) {
  const g = b.generation;
  console.log(`\nbrowser (shared ${b.sharedAt}, build ${b.app?.build}): phase ${g.phase} · error ${g.error ?? "—"} · reconnects ${g.reconnects} · last seq seen ${g.lastSeq} (server ${s.events})`);
  for (const c of g.submissions) {
    const diags = [...(c.fullTest?.diagnostics ?? []), ...(c.fullTest?.cases ?? []).map((x) => x.diagnostic).filter(Boolean)];
    console.log(`  submission ${c.seq} ${c.sha256?.slice(0, 12)} · ${c.status}${diags.length ? ` · ${diags.map((d) => `${d.rule} ${d.message}`).join(" | ").slice(0, 400)}` : ""}`);
  }
  const m = b.machine;
  if (m) console.log(`  machine: ${m.status}${m.error ? ` (${m.error})` : ""} · F=${m.F} · ${m.counters?.executedInstructions ?? 0} instructions · ticks ${m.ticksRecorded} · result ${m.result ? JSON.stringify(m.result.returnValue ?? m.result.trap) : "—"}`);
  if (m?.framebufferPng) writeFileSync(join(out, "framebuffer.png"), Buffer.from(m.framebufferPng.split(",")[1], "base64"));
}
console.log(`\nsaved: ${out}`);
