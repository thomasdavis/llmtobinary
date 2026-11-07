// Builds the OS, slot by slot: a model writes each package's bytes through the real loop, the harness
// links it against packages that already passed and judges it. The harness never edits bytes.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/os-build.ts --out <dir> [--slot fs] [--sessions 6]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { checkCandidate } from "@llmtobinary/check";
import { parseModule } from "@llmtobinary/module";
import { CODEX_LANE } from "./codex-client.ts";
import { privateSeed } from "./os-tests.ts";
import { LIBRARY_SLOTS, closure, generate, judge, promptFor, setBuildDir, built, lockPath, type Built } from "./os-lib.ts";
import { SLOTS } from "../../../os/slots.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const dir = arg("out");
const only = arg("slot", "");
const maxSessions = Number(arg("sessions", "6"));
const model = arg("model", "gpt-6.1-sol");
const effort = arg("effort", "medium");
mkdirSync(dir, { recursive: true });
setBuildDir(dir);

const seed = privateSeed();
const log = (s: unknown) => console.log(new Date().toISOString().slice(11, 19), s);
const targets = process.argv.includes("--library") ? LIBRARY_SLOTS : SLOTS;
for (const s of targets) {
  if (only && s.id !== only) continue;
  if (built(s.id)) continue;
  if (closure(s).some((d) => d !== s && !built(d.id))) {
    log(`${s.id}: waiting on dependencies`);
    continue;
  }
  let done = false;
  for (let n = 1; n <= maxSessions && !done; n++) {
    // The kernels are the largest packages: at about 50 tokens a second one turn can outlast the default limit.
    const big = s.kind === "root" || s.id === "cmd" || s.id === "live";
    const r = await generate(s, promptFor(s), (bytes) => judge(s, bytes, seed), { model, effort, ...(big ? { turnTimeoutMs: 600_000, wallClockMs: 90 * 60_000 } : {}) });
    const clean = r.audit.length === 0;
    log(`${s.id} session ${n}: ${r.bytes && clean ? "PASSED" : "failed"}, ${r.submissions} submissions, ${r.outputTokens} tokens, hung ${r.hungCalls}${clean ? "" : ` AUDIT ${r.audit}`}. ${r.bytes ? "" : r.last.slice(0, 200).replace(/\n/g, " | ")}`);
    writeFileSync(`${dir}/attempts.jsonl`, `${JSON.stringify({ slot: s.id, n, passed: !!r.bytes && clean, ...r, bytes: undefined, at: new Date().toISOString() })}\n`, { flag: "a" });
    if (r.bytes && clean) {
      const sha = (await checkCandidate({ bytes: r.bytes }, { modules: true, allowedFeatures: s.features })).report.sha256!;
      const p = parseModule(r.bytes);
      const rec: Built = { slot: s.id, hex: Buffer.from(r.bytes).toString("hex"), sha256: sha, sessionId: r.sessionId, model, lane: CODEX_LANE, sessions: n, submissions: r.submissions, outputTokens: r.outputTokens, records: p.ok ? p.module.recordCount : 0, hungCalls: r.hungCalls, builtAt: new Date().toISOString() };
      writeFileSync(lockPath(s.id), JSON.stringify(rec, null, 2));
      done = true;
    }
  }
  if (!done) {
    log(`${s.id}: no passing candidate after ${maxSessions} sessions`);
    break;
  }
}
