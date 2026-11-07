// Builds the OS, slot by slot: a model writes each package's bytes through the real loop, the harness
// links it against packages that already passed and judges it. The harness never edits bytes.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/os-build.ts --out <dir> [--slot fs] [--sessions 6]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSession, runAttempt } from "@llmtobinary/broker";
import type { ModelProfile } from "@llmtobinary/broker";
import { checkCandidate } from "@llmtobinary/check";
import { parseHex } from "@llmtobinary/decode";
import { IMPORTS_V2 } from "@llmtobinary/spec";
import { parseModule } from "@llmtobinary/module";
import type { BrowserFeedback, LoopEvent } from "@llmtobinary/protocol";
import { CODEX_LANE, CodexModelClient } from "./codex-client.ts";
import { privateSeed, reportForModel } from "./os-tests.ts";
import { bytesOf, closure, importsOf, judge, setBuildDir, built, lockPath, type Built } from "./os-lib.ts";
import { SLOTS, type Slot } from "../../../os/slots.ts";

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

const BUDGET = { maxTurns: 40, maxChecks: 24, maxSubmissions: 8, maxWallClockMs: 30 * 60_000 };
const profile: ModelProfile = { id: CODEX_LANE, label: `${model} via codex exec`, model, reasoningEffort: "medium", carryReasoning: false, inputPerMTok: 0, outputPerMTok: 0, maxContextChars: 400_000 };
const TYPE: Record<number, string> = { 0: "0 (unit)", 1: "1 (u64)", 2: "2 (bool)", 3: "3 (handle<u8>)", 4: "4 (handle<u64>)" };

const DEVICES = IMPORTS_V2.slice(7, 16).map((i) => `import ${i.id}: ${i.name}(${i.paramNames.join(", ")}), parameter types ${i.params.map((p) => TYPE[p]).join(", ") || "none"}, returns ${TYPE[i.result]}`).join("\n");

function promptFor(s: Slot): string {
  const list = s.exports.map((e) => `function ${e.id}: ${e.symbol}${e.signature}\n  ${e.behaviour}`).join("\n");
  const imports = importsOf(s).map((e, k) => `import ${k}: ${e.symbol}${e.signature}\n  ${e.behaviour}\n  IMPORT return type ${TYPE[e.ret]}, parameter types ${e.params.map((p) => TYPE[p]).join(", ") || "none"}`).join("\n");
  const module = `This program is an ANMA-2 module: an ANMA-1 file with these differences.
- Header word 1 (version) is 2. Header word 2 may also set bit 4 (0x10, text), bit 5 (0x20, block) and bit 6 (0x40, tasks).
- After the last END_FUNC it may list IMPORT declarations. Record 0x70 IMPORT has fields: function ID, parameter count, return type. Each IMPORT is immediately followed by its parameter count of PARAM records, where parameter k is PARAM with value ID k, its type tag, and parameter index k.
- Imports take the function IDs right after your defined functions, and CALL reaches them like any function.
- recordCount includes the IMPORT and PARAM records.
- These extra HOST operations exist:
${DEVICES}
Read-only data is allowed only in the root module.`;
  if (s.kind === "program") return `${s.brief}\nWrite a plain ANMA-1 program. Declare only the features you use.`;
  if (s.kind === "root") return `${module}\n\nDeclare feature bits 0x${s.features.toString(16)}.\n\n${s.brief}\n\nDeclare every IMPORT below, in this order, whether or not you call it:\n${imports}`;
  return `${module}\n\nWrite this library. It is linked with other modules later and has no read-only data.\nDeclare feature bits 0x${s.features.toString(16)}.\n${s.brief}\n\nFunction 0 must be a trivial entry: fn0() -> u64 returning 0. Nothing calls it.\nDefine exactly these functions with these function IDs:\n${list}\nAdd private helpers after them.${imports ? `\n\nDeclare every IMPORT below, in this order, whether or not you call it:\n${imports}` : ""}`;
}

async function session(s: Slot, seed: bigint): Promise<{ bytes: Uint8Array | null; sessionId: string; submissions: number; outputTokens: number; hungCalls: number; last: string; audit: string[] }> {
  const client = new CodexModelClient({ model, effort });
  const events: LoopEvent[] = [];
  const state = createSession({ sessionId: randomUUID(), task: { taskId: null, description: promptFor(s), params: [], returns: "u64", allowedFeatures: s.features, requireClaims: false, module: true }, mode: "tools", profile, budget: BUDGET, now: Date.now(), ttlMs: 3_600_000 });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BUDGET.maxWallClockMs + 60_000);
  let feedback: BrowserFeedback | null = null;
  let last = "no submission";
  let passed: Uint8Array | null = null;
  try {
    for (let i = 0; i <= BUDGET.maxSubmissions && !passed; i++) {
      const before = events.length;
      await runAttempt(state, { idempotencyKey: randomUUID(), feedback }, { model: client, ledger: { reserve: async () => ({ ok: true }), reconcile: async () => {} }, emit: async (e) => void events.push(e), now: () => Date.now(), signal: abort.signal, newId: () => randomUUID(), allowedFeatures: s.features });
      if (state.status !== "active") {
        last = `${state.outcome}: ${state.stopDetail ?? ""}`.slice(0, 300);
        break;
      }
      const sub = events.slice(before).filter((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted").at(-1);
      if (!sub) break;
      const c = await checkCandidate({ envelopeText: sub.envelopeText }, { allowedFeatures: s.features, modules: true });
      const h = parseHex((JSON.parse(sub.envelopeText) as { hex: string }).hex);
      const failures = h.ok && c.report.ok ? judge(s, h.bytes, seed) : [{ name: "static check", detail: "the file did not pass the static check", holdout: false }];
      if (!failures.length && h.ok) {
        passed = h.bytes;
        break;
      }
      last = reportForModel(failures);
      feedback = { candidateSha256: c.report.sha256 ?? "", validation: c.report, tests: { taskId: null, passed: false, cases: [{ name: "tests", kind: "visible", passed: false, inputs: [], expected: null, actual: last.slice(0, 2000), diagnostic: null }], diagnostics: [], tier: "T0", contractOwner: null } };
    }
  } catch (e) {
    last = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  return { bytes: passed, sessionId: state.sessionId, submissions: state.counters.submissions, outputTokens: state.counters.outputTokens, hungCalls: client.hungCalls, last, audit: [...new Set(client.audit.flatMap((a) => a.toolItems))] };
}

const seed = privateSeed();
const log = (s: unknown) => console.log(new Date().toISOString().slice(11, 19), s);
for (const s of SLOTS) {
  if (only && s.id !== only) continue;
  if (built(s.id)) continue;
  if (closure(s).some((d) => d !== s && !built(d.id))) {
    log(`${s.id}: waiting on dependencies`);
    continue;
  }
  let done = false;
  for (let n = 1; n <= maxSessions && !done; n++) {
    const r = await session(s, seed);
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
