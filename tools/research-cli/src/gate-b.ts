// Gate B runner (docs/os-evidence/gate-b-prereg.md): independent library and application sessions
// against one interface, with static checks only, judged once after linking.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/gate-b.ts \
//     --pairs 5 --parallel 3 --out <file.jsonl> [--interface gcd] [--round 1]

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSession, runAttempt } from "@llmtobinary/broker";
import type { ModelProfile } from "@llmtobinary/broker";
import { checkCandidate } from "@llmtobinary/check";
import { parseHex } from "@llmtobinary/decode";
import type { LoopEvent } from "@llmtobinary/protocol";
import { CODEX_LANE, CodexModelClient } from "./codex-client.ts";
import { INTERFACES, appPrompt, libraryPrompt, type GateInterface } from "./gate-b-interfaces.ts";
import { scorePair } from "./gate-b-score.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const model = arg("model", "gpt-6.1-sol");
const effort = arg("effort", "medium");
const BUDGET = { maxTurns: 24, maxChecks: 16, maxSubmissions: 6, maxWallClockMs: 20 * 60_000 };
const profile: ModelProfile = { id: CODEX_LANE, label: `${model} via codex exec`, model, reasoningEffort: "medium", carryReasoning: false, inputPerMTok: 0, outputPerMTok: 0, maxContextChars: 400_000 };

export interface SideResult {
  bytes: Uint8Array | null;
  sha256: string | null;
  outcome: string | null;
  detail: string | null;
  audit: string[];
  hungCalls: number;
  turns: number;
  checks: number;
  outputTokens: number;
  ms: number;
}

/** One session: ends at its first submission that passes the static check. Nothing is executed. */
async function side(description: string, params: ("u64" | "bool")[], returns: "u64" | "unit", features: number): Promise<SideResult> {
  const client = new CodexModelClient({ model, effort });
  const events: LoopEvent[] = [];
  const state = createSession({ sessionId: randomUUID(), task: { taskId: null, description, params, returns, allowedFeatures: features, requireClaims: false, module: true }, mode: "tools", profile, budget: BUDGET, now: Date.now(), ttlMs: 3_600_000 });
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BUDGET.maxWallClockMs + 60_000);
  const result: SideResult = { bytes: null, sha256: null, outcome: null, detail: null, audit: [], hungCalls: 0, turns: 0, checks: 0, outputTokens: 0, ms: 0 };
  try {
    await runAttempt(state, { idempotencyKey: randomUUID(), feedback: null }, { model: client, ledger: { reserve: async () => ({ ok: true }), reconcile: async () => {} }, emit: async (e) => void events.push(e), now: () => Date.now(), signal: abort.signal, newId: () => randomUUID(), allowedFeatures: features });
    const submitted = events.filter((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted").at(-1);
    if (submitted) {
      const hex = (JSON.parse(submitted.envelopeText) as { hex: string }).hex;
      const h = parseHex(hex);
      const c = await checkCandidate({ envelopeText: submitted.envelopeText }, { allowedFeatures: features, modules: true });
      if (h.ok && c.report.ok) {
        result.bytes = h.bytes;
        result.sha256 = c.report.sha256 ?? null;
      }
    }
  } catch (e) {
    result.detail = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  result.outcome = state.outcome;
  result.detail ??= state.stopDetail;
  result.audit = [...new Set(client.audit.flatMap((a) => a.toolItems))];
  result.hungCalls = client.hungCalls;
  result.turns = state.counters.turns;
  result.checks = state.counters.checks;
  result.outputTokens = state.counters.outputTokens;
  result.ms = Date.now() - started;
  return result;
}

const hexOf = (b: Uint8Array | null): string | null => (b ? Buffer.from(b).toString("hex") : null);

async function pair(i: GateInterface, index: number, round: number): Promise<Record<string, unknown>> {
  const [lib, app] = await Promise.all([side(libraryPrompt(i), [], "u64", i.features), side(appPrompt(i), i.app.params, "u64", i.features)]);
  const audited = lib.audit.length > 0 || app.audit.length > 0;
  const verdict = audited ? { stage: "tool-audit-failed", detail: [...lib.audit, ...app.audit].join(",") } : !lib.bytes || !app.bytes ? { stage: "generation-failed", detail: `lib: ${lib.bytes ? "ok" : `${lib.outcome} ${lib.detail}`}; app: ${app.bytes ? "ok" : `${app.outcome} ${app.detail}`}` } : scorePair(i, lib.bytes, app.bytes);
  const strip = (s: SideResult) => ({ ...s, bytes: undefined, hex: hexOf(s.bytes) });
  return { kind: "gate-b-pair/1", lane: CODEX_LANE, model, effort, round, interface: i.id, index, passed: verdict.stage === "pass", verdict, library: strip(lib), application: strip(app), finishedAt: new Date().toISOString() };
}

const out = arg("out");
const pairsPer = Number(arg("pairs", "5"));
const parallel = Number(arg("parallel", "2"));
const round = Number(arg("round", "1"));
const only = arg("interface", "");
// Plumbing check only: never one of the pre-registered interfaces, never counted.
const SMOKE: GateInterface = { id: "smoke", features: 0, exports: [{ symbol: "t.add3", signature: "(x: u64) -> u64", behaviour: "Returns x + 3, wrapping.", id: 1, params: [1], ret: 1 }], app: { params: ["u64"], signature: "(x: u64) -> u64", behaviour: "Returns t.add3(x) * 2, wrapping." }, oracle: ([x]) => ((x! + 3n) * 2n) & ((1n << 64n) - 1n), cases: [[0n], [5n], [18446744073709551615n]], fuel: 10_000 };
const list = only === "smoke" ? [SMOKE] : only ? INTERFACES.filter((x) => x.id === only) : INTERFACES;
const finished = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l) as { interface: string; index: number }; return `${r.interface}#${r.index}`; }) : []);
const jobs = list.flatMap((i) => Array.from({ length: pairsPer }, (_, index) => ({ i, index }))).filter((j) => !finished.has(`${j.i.id}#${j.index}`));
// Interleave so an early stop still covers every interface.
jobs.sort((a, b) => a.index - b.index);
let next = 0;
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      const r = await pair(j.i, j.index, round);
      appendFileSync(out, `${JSON.stringify(r)}\n`);
      const v = r.verdict as { stage: string; detail?: string };
      console.log(`${j.i.id} #${j.index}: ${v.stage} ${(v.detail ?? "").slice(0, 150)}`);
    }
  }),
);
