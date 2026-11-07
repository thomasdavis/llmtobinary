// Gate A runner: independent in-process sessions through the real loop controller, scored with
// the same validator and task tests the browser uses. Appends every session, failures included.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/gate-a.ts \
//     --task fizzbuzz --bucket 128 --n 20 --parallel 3 --out <file.jsonl>

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSession, runAttempt } from "@llmtobinary/broker";
import type { ModelProfile } from "@llmtobinary/broker";
import { checkCandidate } from "@llmtobinary/check";
import { TASK_BY_ID, redactForModel, runTaskTests } from "@llmtobinary/tasks";
import type { BrowserFeedback, LoopEvent } from "@llmtobinary/protocol";
import { CODEX_LANE, CodexModelClient } from "./codex-client.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const task = TASK_BY_ID.get(arg("task"));
if (!task) throw new Error("unknown task");
const bucket = Number(arg("bucket"));
const n = Number(arg("n", "20"));
const parallel = Number(arg("parallel", "3"));
const out = arg("out");
const model = arg("model", "gpt-6.1-sol");
const effort = arg("effort", "medium");
const BUDGET = { maxTurns: 24, maxChecks: 16, maxSubmissions: 6, maxWallClockMs: 20 * 60_000 };

const profile: ModelProfile = { id: CODEX_LANE, label: `${model} via codex exec`, model, reasoningEffort: "medium", carryReasoning: false, inputPerMTok: 0, outputPerMTok: 0, maxContextChars: 400_000 };

async function session(index: number): Promise<Record<string, unknown>> {
  const client = new CodexModelClient({ model, effort });
  const events: LoopEvent[] = [];
  const state = createSession({
    sessionId: randomUUID(),
    task: { taskId: task!.id, description: null, params: task!.params, returns: task!.returns, allowedFeatures: task!.features, requireClaims: false },
    mode: "tools",
    profile,
    budget: BUDGET,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BUDGET.maxWallClockMs + 60_000);
  const started = Date.now();
  let finalSuccess = false;
  let candidateSha256: string | null = null;
  let hex: string | null = null;
  let infra: string | null = null;
  let feedback: BrowserFeedback | null = null;
  try {
    for (let i = 0; i < BUDGET.maxSubmissions + 1; i++) {
      const before = events.length;
      await runAttempt(state, { idempotencyKey: randomUUID(), feedback }, {
        model: client,
        ledger: { reserve: async () => ({ ok: true }), reconcile: async () => {} },
        emit: async (e) => void events.push(e),
        now: () => Date.now(),
        signal: abort.signal,
        newId: () => randomUUID(),
        allowedFeatures: task!.features,
      });
      if (state.status !== "active") break;
      const submitted = events.slice(before).filter((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted").at(-1);
      if (!submitted) break;
      const checked = await checkCandidate({ envelopeText: submitted.envelopeText }, { allowedFeatures: task!.features });
      const report = checked.module ? runTaskTests(checked.module, task!, { annotations: checked.annotations }) : null;
      candidateSha256 = checked.report.sha256 ?? null;
      hex = (JSON.parse(submitted.envelopeText) as { hex?: string }).hex ?? null;
      if (report?.passed) finalSuccess = true;
      feedback = { candidateSha256: candidateSha256 ?? "", validation: checked.report, tests: report ? redactForModel(report) : null };
      if (finalSuccess) break;
    }
  } catch (e) {
    infra = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  const auditFailed = client.audit.some((a) => a.toolItems.length > 0);
  return {
    kind: "gate-a-session/1", lane: CODEX_LANE, model, effort, bucket, taskId: task!.id, index, sessionId: state.sessionId,
    finalSuccess: finalSuccess && !auditFailed, rawSuccess: finalSuccess, auditFailed, auditItems: [...new Set(client.audit.flatMap((a) => a.toolItems))],
    hungCalls: client.hungCalls, outcome: state.outcome, stopDetail: state.stopDetail, infra, counters: state.counters, candidateSha256, hex, ms: Date.now() - started, finishedAt: new Date().toISOString(),
  };
}

const done = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).length : 0;
let next = done;
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next < n) {
      const i = next++;
      const r = await session(i);
      appendFileSync(out, `${JSON.stringify(r)}\n`);
      console.log(`${task.id} #${i}: success=${r.finalSuccess} outcome=${r.outcome} audit=${r.auditFailed} infra=${r.infra ?? "-"} ${Math.round(Number(r.ms) / 1000)}s`);
    }
  }),
);
