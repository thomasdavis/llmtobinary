import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { runToCompletion } from "@llmtobinary/reference";
import { parseHex, toHex } from "@llmtobinary/decode";
import type { BrowserFeedback, CheckReport, LoopEvent } from "@llmtobinary/protocol";
import { EXAMPLE_A_HEX, EXAMPLE_B_HEX, FakeModelClient, TOOLS, createSession, generationInstructions, runAttempt, type BudgetGate, type ModelProfile, type ScriptedTurn, type SessionState } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const sqHex = toHex(new Uint8Array(readFileSync(new URL("square-plus-two.anma", root))));
const badHex = sqHex.slice(0, 144 * 2) + sqHex.slice(160 * 2); // missing ARG (PRD 17.2)

const profile: ModelProfile = { id: "default", label: "test", model: "test-model", reasoningEffort: null, carryReasoning: false, inputPerMTok: 1, outputPerMTok: 4, maxContextChars: 600_000 };
const env = (hex: string) => ({ isa: "ANMA-1", hex, annotations: null });

function harness(script: ScriptedTurn[], opts: { cap?: number; ledgerLimit?: number } = {}) {
  const model = new FakeModelClient(script);
  const events: LoopEvent[] = [];
  let spent = 0;
  const reservations = new Map<string, number>();
  const ledger: BudgetGate = {
    async reserve(id, usd) {
      if (spent + usd > (opts.ledgerLimit ?? 100)) return { ok: false, reason: "global cap" };
      reservations.set(id, usd);
      spent += usd;
      return { ok: true };
    },
    async reconcile(id, usd) {
      const r = reservations.get(id)!;
      if (usd !== null) spent += usd - r;
    },
  };
  const ac = new AbortController();
  let n = 0;
  let clock = 1_000;
  const deps = { model, ledger, emit: async (e: LoopEvent) => void events.push(e), now: () => (clock += 10), signal: ac.signal, newId: () => `a${n++}`, allowedFeatures: 0xf };
  const state: SessionState = createSession({ sessionId: "s1", task: { taskId: "square-plus-two", description: null, params: ["u64"], returns: "u64", allowedFeatures: 2, requireClaims: false }, mode: "tools", profile, now: 0, ttlMs: 3_600_000, budget: opts.cap ? { maxTurns: opts.cap } : {} });
  return { model, events, state, deps, ac, spent: () => spent };
}

const feedback = (sha: string, passed: boolean): BrowserFeedback => ({
  candidateSha256: sha,
  validation: { ok: true, byteLength: 192, sha256: sha, errors: [], warnings: [], suppressed: 0, omitted: 0, listing: null, listingTruncated: false, annotations: { present: false, records: 0, claimsChecked: 0, claimsMatched: 0, contracts: 0, invariants: 0, examples: 0, sha256: null }, catalogVersion: "x" } as CheckReport,
  tests: { taskId: "square-plus-two", passed, cases: passed ? [] : [{ name: "n = 12", kind: "visible", passed: false, inputs: ["12"], expected: "146", actual: "144", diagnostic: null }], diagnostics: [], tier: "T0", contractOwner: null },
});

describe("manual and tools", () => {
  it("the manual examples decode and run as documented", () => {
    const a = mustValidate(parseHex(EXAMPLE_A_HEX).ok ? (parseHex(EXAMPLE_A_HEX) as { bytes: Uint8Array }).bytes : new Uint8Array());
    expect(runToCompletion(a, [{ t: "u64", v: "5" }, { t: "u64", v: "3" }]).returnValue).toEqual({ t: "u64", v: String((5 ^ 3) + 7) });
    const b = mustValidate((parseHex(EXAMPLE_B_HEX) as { bytes: Uint8Array }).bytes);
    expect(runToCompletion(b, [{ t: "u64", v: "5" }, { t: "u64", v: "9" }]).returnValue).toEqual({ t: "u64", v: "9" });
    expect(runToCompletion(b, [{ t: "u64", v: "9" }, { t: "u64", v: "5" }]).returnValue).toEqual({ t: "u64", v: "9" });
  });
  it("instructions contain the rule catalog and grammar but never fast-slot capacity", () => {
    const text = generationInstructions();
    expect(text).toContain("ANMA-V-ARG-001");
    expect(text).toContain("ANMA-Spec contract language");
    expect(text).not.toMatch(/fast[- ]slot|fastSlots/i);
    expect(TOOLS.map((t) => t.name)).toEqual(["check_candidate", "submit_candidate"]);
    expect(TOOLS.every((t) => t.strict)).toBe(true);
  });
});

describe("agentic loop", () => {
  it("malformed draft -> check report -> fixed -> submitted -> browser pass", async () => {
    const h = harness([{ kind: "check", envelope: env(badHex) }, { kind: "check", envelope: env(sqHex) }, { kind: "submit", envelope: env(sqHex) }]);
    const a1 = await runAttempt(h.state, { idempotencyKey: "k1", feedback: null }, h.deps);
    expect(a1.status).toBe("awaiting-feedback");
    const results = h.events.filter((e): e is Extract<LoopEvent, { type: "check.result" }> => e.type === "check.result");
    expect(results[0]!.report.errors.map((d) => d.rule)).toEqual(["ANMA-V-HDR-004", "ANMA-V-ARG-001"]);
    expect(results[1]!.report.ok).toBe(true);
    const sub = h.events.find((e) => e.type === "candidate.submitted") as Extract<LoopEvent, { type: "candidate.submitted" }>;
    expect(sub.candidate.sha256).toBe("d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1");
    // the check report reached the model as a function_call_output
    const req3 = h.model.requests[2]!;
    expect(JSON.stringify(req3.input)).toContain("ANMA-V-ARG-001");
    // drafts never become candidates for execution: only the submit event carries an envelope
    expect(h.events.filter((e) => e.type === "candidate.submitted")).toHaveLength(1);
    await runAttempt(h.state, { idempotencyKey: "k2", feedback: feedback(sub.candidate.sha256!, true) }, h.deps);
    expect(h.state.outcome).toBe("passed");
    const seqs = h.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("statically invalid submissions are rejected server-side, answered like a check, and never reach the browser", async () => {
    const h = harness([{ kind: "submit", envelope: env(badHex) }, { kind: "submit", envelope: env(sqHex) }]);
    const a = await runAttempt(h.state, { idempotencyKey: "k1", feedback: null }, h.deps);
    expect(a.status).toBe("awaiting-feedback");
    expect(h.state.counters.submissions).toBe(1);
    expect(h.state.counters.checks).toBe(1);
    const subs = h.events.filter((e) => e.type === "candidate.submitted") as Extract<LoopEvent, { type: "candidate.submitted" }>[];
    expect(subs.map((e) => e.candidate.sha256)).toEqual(["d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1"]);
    expect(JSON.stringify(h.model.requests[1]!.input)).toContain("submission\\\":\\\"rejected");
  });

  it("task-aware check: a submission with the wrong signature and no output is rejected with K-003 and K-002", async () => {
    const r42 = toHex(new Uint8Array(readFileSync(new URL("return-42.anma", root))));
    const h = harness([{ kind: "submit", envelope: env(r42) }, { kind: "submit", envelope: env(sqHex) }]);
    const a = await runAttempt(h.state, { idempotencyKey: "k1", feedback: null }, h.deps);
    expect(a.status).toBe("awaiting-feedback");
    expect(h.state.counters.submissions).toBe(1);
    const reply = JSON.stringify(h.model.requests[1]!.input);
    expect(reply).toContain("submission\\\":\\\"rejected");
    expect(reply).toContain("ANMA-K-003");
    expect(reply).toContain("never calls a terminal.* import");
  });

  it("outer loop: failing browser tests are sent back as untrusted data on the submit call", async () => {
    const wrongHex = sqHex.slice(0, (32 + 5 * 16) * 2) + "21" + sqHex.slice((32 + 5 * 16) * 2 + 2); // ADD -> SUB: valid bytes, wrong answer
    const h = harness([{ kind: "submit", envelope: env(sqHex) }, { kind: "submit", envelope: env(wrongHex) }]);
    await runAttempt(h.state, { idempotencyKey: "k1", feedback: null }, h.deps);
    await runAttempt(h.state, { idempotencyKey: "k2", feedback: feedback("abc", false) }, h.deps);
    const input = h.model.requests[1]!.input as { type?: string; output?: string; call_id?: string }[];
    const out = input.find((i) => i.type === "function_call_output")!;
    expect(out.call_id).toBe("call_1");
    expect(out.output).toContain("untrusted DATA");
    expect(out.output).toContain("n = 12");
  });

  it("idempotent attempts never buy another turn", async () => {
    const h = harness([{ kind: "submit", envelope: env(sqHex) }]);
    const a = await runAttempt(h.state, { idempotencyKey: "same", feedback: null }, h.deps);
    const b = await runAttempt(h.state, { idempotencyKey: "same", feedback: null }, h.deps);
    expect(b).toBe(a);
    expect(h.model.requests).toHaveLength(1);
  });

  it("stalled: the same rule set three times in a row", async () => {
    const h = harness([{ kind: "check", envelope: env(badHex) }, { kind: "check", envelope: env(badHex) }, { kind: "check", envelope: env(badHex) }, { kind: "check", envelope: env(sqHex) }]);
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    expect(h.state.outcome).toBe("stalled");
    expect(h.state.stopDetail).toMatch(/^ANMA-L-002/);
    expect(h.model.requests).toHaveLength(3);
  });

  it("stalled: resubmitting the same candidate", async () => {
    const h = harness([{ kind: "submit", envelope: env(sqHex) }, { kind: "submit", envelope: env(sqHex) }]);
    await runAttempt(h.state, { idempotencyKey: "k1", feedback: null }, h.deps);
    await runAttempt(h.state, { idempotencyKey: "k2", feedback: feedback("x", false) }, h.deps);
    expect(h.state.outcome).toBe("stalled");
  });

  it("budget-exhausted: turns, checks, and spend cap", async () => {
    const turns = harness(Array(5).fill({ kind: "check", envelope: env("zz") }), { cap: 2 });
    turns.state.budget.stallRepeatK = 99;
    await runAttempt(turns.state, { idempotencyKey: "k", feedback: null }, turns.deps);
    expect(turns.state.outcome).toBe("budget-exhausted");
    expect(turns.model.requests).toHaveLength(2);
    expect(turns.state.stopDetail).toMatch(/^ANMA-L-001/);
    const spend = harness([{ kind: "submit", envelope: env(sqHex) }], { ledgerLimit: 0 });
    await runAttempt(spend.state, { idempotencyKey: "k", feedback: null }, spend.deps);
    expect(spend.state.outcome).toBe("budget-exhausted");
    expect(spend.state.stopDetail).toMatch(/spend cap/);
    expect(spend.model.requests).toHaveLength(0);
  });

  it("refused: stops without a bypass prompt", async () => {
    const h = harness([{ kind: "refuse" }, { kind: "submit", envelope: env(sqHex) }]);
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    expect(h.state.outcome).toBe("refused");
    expect(h.model.requests).toHaveLength(1);
  });

  it("incomplete responses are not repaired; the model is asked for a complete candidate", async () => {
    const h = harness([{ kind: "incomplete" }, { kind: "submit", envelope: env(sqHex) }]);
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    expect(h.events.some((e) => e.type === "attempt.incomplete")).toBe(true);
    expect(JSON.stringify(h.model.requests[1]!.input)).toContain("incomplete");
    expect(h.state.counters.submissions).toBe(1);
  });

  it("infrastructure errors: one visible retry, then stop; unknown usage is charged", async () => {
    const h = harness([{ kind: "error", code: "http_503", retryable: true }, { kind: "error", code: "http_503", retryable: true }]);
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    expect(h.state.outcome).toBe("infrastructure-error");
    const errs = h.events.filter((e) => e.type === "attempt.error") as Extract<LoopEvent, { type: "attempt.error" }>[];
    expect(errs.map((e) => e.retryable)).toEqual([true, false]);
    expect(h.state.counters.unknownUsageTurns).toBe(2);
    expect(h.state.usdSpent).toBeGreaterThan(0);
  });

  it("cancelled: abort propagates to the model and the session stops", async () => {
    const h = harness([{ kind: "hang" }]);
    const p = runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    setTimeout(() => h.ac.abort(), 20);
    await p;
    expect(h.state.outcome).toBe("cancelled");
    expect(h.events.some((e) => e.type === "attempt.cancelled")).toBe(true);
  });

  it("passed-unverified for open tasks", async () => {
    const h = harness([{ kind: "submit", envelope: env(sqHex) }]);
    h.state.task = { ...h.state.task, taskId: null, description: "square plus two" };
    await runAttempt(h.state, { idempotencyKey: "k1", feedback: null }, h.deps);
    const fb = feedback("s", true);
    fb.tests!.taskId = null;
    await runAttempt(h.state, { idempotencyKey: "k2", feedback: fb }, h.deps);
    expect(h.state.outcome).toBe("passed-unverified");
  });

  it("deterministic elision of old check outputs keeps the latest", async () => {
    const script: ScriptedTurn[] = [...Array(6).fill({ kind: "check", envelope: env(badHex) }), { kind: "submit", envelope: env(sqHex) }];
    const h = harness(script);
    h.state.budget.stallRepeatK = 99;
    h.state.profile = { ...h.state.profile, maxContextChars: generationInstructions().length + 14_000 };
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    const el = h.events.filter((e) => e.type === "loop.elided");
    expect(el.length).toBeGreaterThan(0);
    const last = JSON.stringify(h.model.requests.at(-1)!.input);
    expect(last).toContain("[elided] draft 1: rules ANMA-V-HDR-004, ANMA-V-ARG-001");
  });

  it("context budget exhausted even after elision stops with ANMA-L-003", async () => {
    const h = harness([{ kind: "submit", envelope: env(sqHex) }]);
    h.state.profile = { ...h.state.profile, maxContextChars: 100 };
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    expect(h.state.outcome).toBe("budget-exhausted");
    expect(h.state.stopDetail).toMatch(/^ANMA-L-003/);
    expect(h.model.requests).toHaveLength(0);
  });

  it("ANMR-1 research control: ANMR tools, manual, and checker", async () => {
    const anmrHex = toHex(new Uint8Array(readFileSync(new URL("anmr-capstone-r8.anmr", root))));
    const h = harness([{ kind: "check", envelope: { isa: "ANMR-1", hex: anmrHex.slice(0, 64), annotations: null } }, { kind: "submit", envelope: { isa: "ANMR-1", hex: anmrHex, annotations: null } }]);
    h.state.task = { ...h.state.task, taskId: "capstone-40", isa: "ANMR-1", registers: 8 };
    h.state.items = [{ role: "user", content: "task" }];
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    expect(h.model.requests[0]!.isa).toBe("ANMR-1");
    expect(h.model.requests[0]!.instructions).toContain("R = 8 registers");
    const chk = h.events.find((e) => e.type === "check.result") as Extract<LoopEvent, { type: "check.result" }>;
    expect(chk.report.errors[0]!.rule).toBe("ANMR-V-002");
    const sub = h.events.find((e) => e.type === "candidate.submitted") as Extract<LoopEvent, { type: "candidate.submitted" }>;
    expect(sub.candidate.byteLength).toBe(anmrHex.length / 2);
  });

  it("raw-hex profile: text output is the submission", async () => {
    const h = harness([{ kind: "text", text: sqHex }]);
    h.state.mode = "raw-hex";
    await runAttempt(h.state, { idempotencyKey: "k", feedback: null }, h.deps);
    const sub = h.events.find((e) => e.type === "candidate.submitted") as Extract<LoopEvent, { type: "candidate.submitted" }>;
    expect(sub.candidate.sha256).toBe("d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1");
  });
});
