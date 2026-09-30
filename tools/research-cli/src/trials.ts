// Research trial runner (PRD Section 18.6). Runs N independent generation sessions per arm
// against a deployed llmtobinary Worker, validates and tests every submission locally with the
// same code the browser uses, and records the Section 18.6 metrics. It spends real money, so it
// refuses to run without TRIALS_APPROVED=1 and a --budget-usd that covers the worst case.
//
//   TRIALS_APPROVED=1 node --experimental-transform-types --no-warnings tools/research-cli/src/trials.ts \
//     --url https://llmtobinary-research.example.workers.dev --task capstone-40 --arms bare,checked,annotated \
//     --n 20 --budget-usd 25 --session-cap-usd 0.5 --out trials.json

import { writeFileSync } from "node:fs";
import { checkAnmrCandidate, checkCandidate } from "@llmtobinary/check";
import { TASK_BY_ID, capstoneOracle, holdoutCases, runTaskTests, redactForModel } from "@llmtobinary/tasks";
import { anmrWitness, capstoneWitness, runAnmr } from "@llmtobinary/research";
import type { BrowserFeedback, CreateSessionRequest, LoopEvent } from "@llmtobinary/protocol";

type Arm = "bare" | "checked" | "annotated" | "anmr-checked";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`--${name} is required`);
  return (v ?? fallback)!;
}

const url = arg("url").replace(/\/$/, "");
const taskId = arg("task");
const arms = arg("arms", "bare,checked,annotated").split(",") as Arm[];
const n = Number(arg("n", "20"));
const budgetUsd = Number(arg("budget-usd"));
const sessionCapUsd = Number(arg("session-cap-usd", "0.5"));
const outPath = arg("out", `trials-${taskId}-${Date.now()}.json`);
const registers = Number(arg("registers", "8"));
const task = TASK_BY_ID.get(taskId);
if (!task) throw new Error(`unknown task ${taskId}`);
const worstCase = arms.length * n * sessionCapUsd;
if (process.env.TRIALS_APPROVED !== "1") {
  console.error("Refusing to run: trials spend money. Set TRIALS_APPROVED=1 after the budget is approved.");
  process.exit(2);
}
if (!(budgetUsd >= worstCase)) {
  console.error(`Refusing to run: worst case is ${arms.length} arms x ${n} sessions x $${sessionCapUsd} = $${worstCase.toFixed(2)}, above --budget-usd ${budgetUsd}.`);
  process.exit(2);
}

const origin = new URL(url).origin;
const post = (path: string, body: unknown, token?: string) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

async function events(res: Response): Promise<LoopEvent[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LoopEvent);
}

interface SessionMetrics {
  arm: Arm;
  sessionId: string;
  outcome: string | null;
  stopDetail: string | null;
  firstDraftValid: boolean | null;
  firstSubmissionValid: boolean | null;
  firstSubmissionTaskSuccess: boolean | null;
  finalSuccess: boolean;
  checks: number;
  submissions: number;
  turns: number;
  turnsToFirstValid: number | null;
  turnsToSuccess: number | null;
  outputTokens: number;
  inputTokens: number;
  unknownUsageTurns: number;
  responseBytes: number;
  ruleCounts: Record<string, number>;
  ruleFixes: Record<string, { seen: number; fixedNext: number }>;
  annotationMismatches: number;
  pressureCertificate: boolean | null;
}

async function runSession(arm: Arm): Promise<SessionMetrics> {
  const req: CreateSessionRequest = {
    task: { taskId: task!.id, description: null, params: task!.params, returns: task!.returns, allowedFeatures: task!.features, requireClaims: arm === "annotated", ...(arm === "anmr-checked" ? { isa: "ANMR-1" as const, registers } : {}) },
    mode: arm === "bare" ? "raw-hex" : "tools",
    profile: "default",
  };
  const created = (await (await post("/api/generation-sessions", req)).json()) as { sessionId: string; token: string; error?: string };
  if (!created.token) throw new Error(`session creation failed: ${created.error}`);
  const m: SessionMetrics = { arm, sessionId: created.sessionId, outcome: null, stopDetail: null, firstDraftValid: null, firstSubmissionValid: null, firstSubmissionTaskSuccess: null, finalSuccess: false, checks: 0, submissions: 0, turns: 0, turnsToFirstValid: null, turnsToSuccess: null, outputTokens: 0, inputTokens: 0, unknownUsageTurns: 0, responseBytes: 0, ruleCounts: {}, ruleFixes: {}, annotationMismatches: 0, pressureCertificate: null };
  let prevRules: Set<string> | null = null;
  let feedback: BrowserFeedback | null = null;
  for (let iteration = 0; iteration < 20; iteration++) {
    const evs = await events(await post(`/api/generation-sessions/${created.sessionId}/attempts`, { idempotencyKey: crypto.randomUUID(), feedback }, created.token));
    let submitted: Extract<LoopEvent, { type: "candidate.submitted" }> | null = null;
    for (const e of evs) {
      if (e.type === "turn.started") m.turns = e.turn;
      if (e.type === "loop.budget") {
        m.outputTokens = e.counters.outputTokens;
        m.inputTokens = e.counters.inputTokens;
        m.unknownUsageTurns = e.counters.unknownUsageTurns;
      }
      if (e.type === "check.result") {
        m.checks++;
        if (m.firstDraftValid === null) m.firstDraftValid = e.report.ok;
        if (e.report.ok && m.turnsToFirstValid === null) m.turnsToFirstValid = m.turns;
        const rules = new Set(e.report.errors.map((d) => d.rule));
        for (const r of rules) m.ruleCounts[r] = (m.ruleCounts[r] ?? 0) + 1;
        if (rules.has("ANMA-A-004")) m.annotationMismatches++;
        if (prevRules) for (const r of prevRules) {
          const f = (m.ruleFixes[r] ??= { seen: 0, fixedNext: 0 });
          f.seen++;
          if (!rules.has(r)) f.fixedNext++;
        }
        prevRules = rules;
      }
      if (e.type === "candidate.submitted") submitted = e;
      if (e.type === "loop.stopped") {
        m.outcome = e.outcome;
        m.stopDetail = e.detail;
      }
    }
    if (m.outcome) break;
    if (!submitted) break;
    m.submissions++;
    m.responseBytes += new TextEncoder().encode(submitted.envelopeText).length;
    if (arm === "anmr-checked") {
      // Matched control: validate and run with the ANMR-1 interpreter against the same oracle.
      const a = await checkAnmrCandidate({ envelopeText: submitted.envelopeText });
      if (m.firstSubmissionValid === null) m.firstSubmissionValid = a.report.ok;
      let passed = false;
      const cases = [...task!.visible, ...holdoutCases(task!)];
      const failures: string[] = [];
      if (a.program && task!.pressure) {
        for (const c of cases) {
          const x = BigInt(c.inputs[0]!);
          const r = runAnmr(a.program, x);
          const want = capstoneOracle(x, task!.pressure.K, task!.pressure.stride);
          if (r.value !== want) failures.push(`${c.name}: ${r.trap ? r.trap.message : `returned ${r.value}, expected ${want}`}`);
        }
        const w = anmrWitness(a.program, task!.pressure.K, task!.pressure.stride);
        m.pressureCertificate = w.ok;
        passed = failures.length === 0 && (task!.id === "capstone-40-unrestricted" || w.ok);
        if (!w.ok && task!.id !== "capstone-40-unrestricted") failures.push(w.diagnostic.message);
      }
      if (m.firstSubmissionTaskSuccess === null) m.firstSubmissionTaskSuccess = passed;
      if (passed) {
        m.finalSuccess = true;
        m.turnsToSuccess = m.turns;
      }
      feedback = {
        candidateSha256: a.report.sha256 ?? "",
        validation: a.report,
        tests: a.program ? { taskId: task!.id, passed, cases: failures.slice(0, 8).map((f) => ({ name: "hidden or visible case", kind: "visible" as const, passed: false, inputs: [], expected: null, actual: f, diagnostic: null })), diagnostics: [], tier: "T0", contractOwner: null } : null,
      };
      continue;
    }
    const out = arm === "bare" ? await checkCandidate({ hex: submitted.envelopeText }, { allowedFeatures: task!.features }) : await checkCandidate({ envelopeText: submitted.envelopeText }, { allowedFeatures: task!.features });
    if (m.firstDraftValid === null) m.firstDraftValid = out.report.ok;
    if (m.firstSubmissionValid === null) m.firstSubmissionValid = out.report.ok;
    if (out.report.ok && m.turnsToFirstValid === null) m.turnsToFirstValid = m.turns;
    let report = null;
    if (out.module) {
      const claims = out.report.annotations.claimsChecked ? { checked: out.report.annotations.claimsChecked, matched: out.report.annotations.claimsMatched } : null;
      report = runTaskTests(out.module, task!, {
        annotations: out.annotations,
        claims,
        witness: (mod, p) => {
          const w = capstoneWitness(mod, p.K, p.stride);
          m.pressureCertificate = w.ok;
          return { ok: w.ok, diagnostic: w.diagnostic };
        },
      });
    }
    if (m.firstSubmissionTaskSuccess === null) m.firstSubmissionTaskSuccess = !!report?.passed;
    if (report?.passed) {
      m.finalSuccess = true;
      m.turnsToSuccess = m.turns;
    }
    feedback = { candidateSha256: out.report.sha256 ?? "", validation: out.report, tests: report ? redactForModel(report) : null };
  }
  return m;
}

const cfg = (await (await fetch(`${url}/api/config`)).json()) as Record<string, unknown>;
const started = new Date().toISOString();
const sessions: SessionMetrics[] = [];
for (let i = 0; i < n; i++) {
  for (const arm of arms) {
    try {
      const s = await runSession(arm);
      sessions.push(s);
      console.log(`${arm} #${i}: ${s.outcome} after ${s.turns} turns, ${s.checks} checks, ${s.submissions} submissions`);
    } catch (e) {
      console.error(`${arm} #${i}: infrastructure failure: ${(e as Error).message}`);
    }
  }
}
const summary = Object.fromEntries(
  arms.map((arm) => {
    const s = sessions.filter((x) => x.arm === arm);
    const rate = (f: (x: SessionMetrics) => boolean | null) => ({ yes: s.filter((x) => f(x) === true).length, of: s.length });
    return [arm, { sessions: s.length, firstDraftValid: rate((x) => x.firstDraftValid), firstSubmissionValid: rate((x) => x.firstSubmissionValid), firstSubmissionTaskSuccess: rate((x) => x.firstSubmissionTaskSuccess), finalSuccess: rate((x) => x.finalSuccess), pressureCertificate: rate((x) => x.pressureCertificate) }];
  }),
);
writeFileSync(outPath, JSON.stringify({ kind: "llmtobinary-trials/1", started, finished: new Date().toISOString(), url, config: cfg, task: { id: task.id, version: task.version }, arms, n, budgetUsd, sessionCapUsd, summary, sessions }, null, 2));
console.log(`wrote ${outPath}; raw denominators are in the summary (no leaderboard from single sessions)`);
