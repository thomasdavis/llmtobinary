// Browser side of the agentic loop (PRD Sections 5 and 7.6): streams attempts, independently
// validates each submitted candidate, tests it in the machine worker, and automatically posts
// bounded feedback as the next outer iteration under the consent given at the start.

import { checkCandidate } from "@llmtobinary/check";
import type { BrowserFeedback, CheckReport, CreateSessionRequest, LoopBudget, LoopCounters, LoopEvent, StopOutcome, TestReport } from "@llmtobinary/protocol";
import { cancelSession, createSession, resumeEvents, streamAttempt } from "./api.ts";
import type { MachineClient } from "./machine-client.ts";

export interface SubmittedCandidate {
  seq: number;
  attemptId: string;
  envelopeText: string;
  sha256: string | null;
  bytes: Uint8Array | null;
  annotations: unknown;
  check: CheckReport;
  test: TestReport | null;
  witness: unknown;
  status: "validating" | "invalid" | "testing" | "task-passed" | "task-failed" | "resource-limited" | "executed-unverified";
}

export interface GenState {
  phase: "idle" | "creating" | "streaming" | "testing" | "stopped" | "error";
  request: CreateSessionRequest | null;
  sessionId: string | null;
  events: LoopEvent[];
  preview: string;
  submissions: SubmittedCandidate[];
  outcome: StopOutcome | null;
  stopDetail: string | null;
  error: string | null;
  counters: LoopCounters | null;
  budget: LoopBudget | null;
  reconnects: number;
}

const MAX_EVENTS_KEPT = 4000;

export class GenerationController {
  state: GenState = { phase: "idle", request: null, sessionId: null, events: [], preview: "", submissions: [], outcome: null, stopDetail: null, error: null, counters: null, budget: null, reconnects: 0 };
  private listeners = new Set<(s: GenState) => void>();
  private abort: AbortController | null = null;
  private token: string | null = null;
  private lastSeq = 0;
  onPassed: ((c: SubmittedCandidate) => void) | null = null;

  constructor(
    private readonly machine: MachineClient,
    private readonly allowedFeatures: () => number,
  ) {}

  subscribe(fn: (s: GenState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<GenState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l(this.state);
  }

  private onEvent = (e: LoopEvent) => {
    if (e.seq <= this.lastSeq && e.type !== "heartbeat") return;
    if (e.type !== "heartbeat") this.lastSeq = e.seq;
    else return;
    const events = this.state.events.length >= MAX_EVENTS_KEPT ? [...this.state.events.slice(-MAX_EVENTS_KEPT + 1), e] : [...this.state.events, e];
    const p: Partial<GenState> = { events };
    if (e.type === "model.tool_args.delta" || e.type === "model.text.delta") p.preview = (this.state.preview + e.delta).slice(-24_000);
    if (e.type === "turn.started" || e.type === "check.result" || e.type === "candidate.submitted") p.preview = e.type === "turn.started" ? "" : this.state.preview;
    if (e.type === "loop.budget") {
      p.counters = e.counters;
      p.budget = e.budget;
    }
    if (e.type === "loop.stopped") {
      p.outcome = e.outcome;
      p.stopDetail = e.detail;
      p.phase = "stopped";
    }
    this.set(p);
  };

  /** Stream one attempt; on a broken stream, resume by sequence (never starting a new turn). */
  private async attempt(key: string, feedback: BrowserFeedback | null): Promise<LoopEvent[]> {
    const start = this.state.events.length;
    this.abort = new AbortController();
    let broken = false;
    try {
      await streamAttempt(this.state.sessionId!, this.token!, { idempotencyKey: key, feedback }, this.onEvent, this.abort.signal);
    } catch (e) {
      if (this.abort.signal.aborted) throw e;
      broken = true;
    }
    // A stream can also end cleanly but early (a dropped connection): unless the attempt visibly
    // finished, follow it on the server by sequence until it is no longer running.
    const finished = () => this.state.outcome !== null || this.state.events.slice(start).some((e) => e.type === "candidate.submitted");
    if (broken || !finished()) {
      for (let i = 0; i < 1500; i++) {
        if (this.abort.signal.aborted) break;
        const r = await resumeEvents(this.state.sessionId!, this.token!, this.lastSeq);
        r.events.forEach(this.onEvent);
        if (!r.running) break;
        this.set({ reconnects: this.state.reconnects + 1 });
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    return this.state.events.slice(start);
  }

  async start(req: CreateSessionRequest): Promise<void> {
    this.lastSeq = 0;
    this.set({ phase: "creating", request: req, sessionId: null, events: [], preview: "", submissions: [], outcome: null, stopDetail: null, error: null, counters: null, budget: null, reconnects: 0 });
    try {
      const s = await createSession(req);
      this.token = s.token;
      this.set({ sessionId: s.sessionId, budget: s.budget, phase: "streaming" });
      let feedback: BrowserFeedback | null = null;
      let resumes = 0;
      while (true) {
        this.set({ phase: "streaming" });
        const evs = await this.attempt(crypto.randomUUID(), feedback);
        if (this.state.outcome) return;
        const sub = [...evs].reverse().find((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted");
        if (!sub) {
          const err = [...evs].reverse().find((e): e is Extract<LoopEvent, { type: "attempt.error" }> => e.type === "attempt.error");
          // The server lost the attempt (it restarted mid-attempt): resume from its last saved point.
          if (err?.code === "attempt_lost" && resumes < 2) {
            resumes++;
            continue;
          }
          this.set({ phase: "error", error: err ? `the server stopped this attempt: ${err.message}` : "the attempt ended without a submission or a stop outcome" });
          return;
        }
        this.set({ phase: "testing" });
        const cand = await this.evaluate(sub, req);
        feedback = {
          candidateSha256: cand.sha256 ?? "",
          validation: cand.check,
          tests: cand.test,
        };
        if (cand.status === "task-passed" || cand.status === "executed-unverified") {
          this.onPassed?.(cand);
          await this.attempt(crypto.randomUUID(), feedback); // closes the loop as passed
          return;
        }
      }
    } catch (e) {
      if (this.abort?.signal.aborted) {
        this.set({ phase: "stopped", outcome: this.state.outcome ?? "cancelled" });
        return;
      }
      this.set({ phase: "error", error: (e as Error).message });
    }
  }

  /** Independent browser validation and testing of a submitted candidate. */
  private async evaluate(sub: Extract<LoopEvent, { type: "candidate.submitted" }>, req: CreateSessionRequest): Promise<SubmittedCandidate> {
    const out = req.mode === "raw-hex" ? await checkCandidate({ hex: sub.envelopeText }, { allowedFeatures: req.task.allowedFeatures }) : await checkCandidate({ envelopeText: sub.envelopeText }, { allowedFeatures: req.task.allowedFeatures });
    const cand: SubmittedCandidate = {
      seq: sub.candidate.seq,
      attemptId: sub.attemptId,
      envelopeText: sub.envelopeText,
      sha256: out.report.sha256,
      bytes: out.bytes,
      annotations: out.annotationsRaw,
      check: out.report,
      test: null,
      witness: null,
      status: out.report.ok ? "testing" : "invalid",
    };
    this.set({ submissions: [...this.state.submissions, cand] });
    if (out.report.ok && out.bytes) {
      try {
        const claims = out.report.annotations.claimsChecked ? { checked: out.report.annotations.claimsChecked, matched: out.report.annotations.claimsMatched } : null;
        const t = await this.machine.test(out.bytes, req.task.taskId, out.annotationsRaw, claims, req.task.allowedFeatures || this.allowedFeatures());
        cand.test = t.modelReport; // holdout details are redacted before they can reach the model
        cand.witness = t.witness;
        const limited = t.report.diagnostics.some((d) => d.rule === "ANMA-K-009");
        cand.status = t.report.passed ? (req.task.taskId ? "task-passed" : "executed-unverified") : limited ? "resource-limited" : "task-failed";
        (cand as SubmittedCandidate & { fullTest?: TestReport }).fullTest = t.report;
      } catch (e) {
        cand.status = "task-failed";
        cand.test = { taskId: req.task.taskId, passed: false, cases: [], diagnostics: [], tier: "T0", contractOwner: null };
        this.set({ error: `testing failed: ${(e as Error).message}` });
      }
    }
    this.set({ submissions: this.state.submissions.map((c) => (c.seq === cand.seq ? { ...cand } : c)) });
    return cand;
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
    if (this.state.sessionId && this.token) await cancelSession(this.state.sessionId, this.token).catch(() => undefined);
    this.set({ phase: "stopped", outcome: this.state.outcome ?? "cancelled" });
  }
}
