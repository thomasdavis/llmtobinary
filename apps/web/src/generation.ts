// Browser side of the agentic loop (PRD Sections 5 and 7.6): streams attempts, independently
// validates each submitted candidate, tests it in the machine worker, and automatically posts
// bounded feedback as the next outer iteration under the consent given at the start.

import { checkCandidate } from "@llmtobinary/check";
import { Feature, KEYS } from "@llmtobinary/spec";
import type { BrowserFeedback, CheckReport, CreateSessionRequest, EntryInput, LoopBudget, LoopCounters, LoopEvent, Playtest, StopOutcome, TestReport, TickEvent } from "@llmtobinary/protocol";
import { cancelSession, createSession, resumeEvents, shareDebug, streamAttempt } from "./api.ts";
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
  /** The generation's id in the public program list, once the session exists. */
  programId: string | null;
  events: LoopEvent[];
  preview: string;
  submissions: SubmittedCandidate[];
  outcome: StopOutcome | null;
  stopDetail: string | null;
  error: string | null;
  counters: LoopCounters | null;
  budget: LoopBudget | null;
  reconnects: number;
  /** Everything the model has streamed in the current turn (its draft, as it is written). */
  turnText: string;
  /** Client clock (ms) when the session and the current turn started. */
  startedAt: number | null;
  turnStartedAt: number | null;
  /** Playtests this browser ran, by candidate SHA-256 (frames shown in the generation window). */
  playtests: Record<string, Playtest>;
}

const MAX_EVENTS_KEPT = 4000;

export class GenerationController {
  state: GenState = { phase: "idle", request: null, sessionId: null, programId: null, events: [], preview: "", submissions: [], outcome: null, stopDetail: null, error: null, counters: null, budget: null, reconnects: 0, turnText: "", startedAt: null, turnStartedAt: null, playtests: {} };
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
    if (e.type === "model.tool_args.delta" || e.type === "model.text.delta") {
      // Stream fragments only feed the live preview; keeping them as events would crowd out the
      // checks and submissions the timeline needs.
      this.set({ preview: (this.state.preview + e.delta).slice(-24_000), turnText: this.state.turnText.length < 4_000_000 ? this.state.turnText + e.delta : this.state.turnText });
      return;
    }
    const events = this.state.events.length >= MAX_EVENTS_KEPT ? [...this.state.events.slice(-MAX_EVENTS_KEPT + 1), e] : [...this.state.events, e];
    const p: Partial<GenState> = { events };
    if (e.type === "turn.started") {
      p.turnText = "";
      p.turnStartedAt = Date.now();
    }
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
    this.set({ phase: "creating", request: req, sessionId: null, programId: null, events: [], preview: "", submissions: [], outcome: null, stopDetail: null, error: null, counters: null, budget: null, reconnects: 0, turnText: "", startedAt: Date.now(), turnStartedAt: null, playtests: {} });
    try {
      const s = await createSession(req);
      this.token = s.token;
      this.set({ sessionId: s.sessionId, programId: s.programId, budget: s.budget, phase: "streaming" });
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
          // A visitor's own program that draws is played before it is accepted: the server's
          // reviewer may send the AI back to work, in which case this loop simply continues.
          if (cand.status === "executed-unverified" && cand.bytes && draws(cand.bytes)) {
            feedback.playtest = await this.playtest(cand.bytes, req).catch(() => null);
            if (feedback.playtest && cand.sha256) this.set({ playtests: { ...this.state.playtests, [cand.sha256]: feedback.playtest } });
          }
          this.onPassed?.(cand);
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

  /** Play a passing program that draws: scripted keys, captured frames (PNG), and a no-input comparison. */
  private async playtest(bytes: Uint8Array, req: CreateSessionRequest): Promise<Playtest> {
    const inputs: EntryInput[] = req.task.params.map((p) => (p === "bool" ? { t: "bool", v: false } : { t: "u64", v: "0" }));
    const r = await this.machine.playtest(bytes, inputs, req.task.allowedFeatures || this.allowedFeatures(), PLAYTEST_TICKS, PLAYTEST_FRAMES, 4000);
    const frames: Playtest["frames"] = [];
    for (const f of r.frames) {
      const png = await rgbaToPng(new Uint8ClampedArray(f.rgba));
      if (png) frames.push({ frame: f.frame, png });
    }
    return { script: PLAYTEST_SCRIPT, ticks: PLAYTEST_TICKS.length, framesPresented: r.framesPresented, distinctFrames: r.distinctFrames, inputChangesScreen: r.inputChangesScreen, ended: r.ended, translucentPercent: r.translucentPercent, frames };
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

  /** The loop as this browser saw it (per-token stream deltas omitted), for the debug archive. */
  debugBundle(): Record<string, unknown> {
    const s = this.state;
    return {
      phase: s.phase,
      sessionId: s.sessionId,
      request: s.request,
      outcome: s.outcome,
      stopDetail: s.stopDetail,
      error: s.error,
      reconnects: s.reconnects,
      counters: s.counters,
      budget: s.budget,
      lastSeq: this.lastSeq,
      events: s.events.filter((e) => e.type !== "model.tool_args.delta" && e.type !== "model.text.delta"),
      submissions: s.submissions.map((c) => ({
        seq: c.seq,
        attemptId: c.attemptId,
        sha256: c.sha256,
        status: c.status,
        envelopeText: c.envelopeText,
        byteLength: c.bytes?.length ?? null,
        check: c.check,
        modelTest: c.test,
        fullTest: (c as SubmittedCandidate & { fullTest?: TestReport }).fullTest ?? null,
        witness: c.witness,
      })),
    };
  }

  /** Upload the browser's record for this session; returns the debug ID (the session ID). */
  async share(extra: Record<string, unknown>): Promise<{ debugId: string; environment: string }> {
    if (!this.state.sessionId || !this.token) throw new Error("there is no generation session in this tab to share");
    return shareDebug(this.state.sessionId, this.token, { kind: "llmtobinary-browser/1", sharedAt: new Date().toISOString(), generation: this.debugBundle(), ...extra });
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
    if (this.state.sessionId && this.token) await cancelSession(this.state.sessionId, this.token).catch(() => undefined);
    this.set({ phase: "stopped", outcome: this.state.outcome ?? "cancelled" });
  }
}

// ---------------------------------------------------------------------------
// Playtest: a fixed, generic input script (no knowledge of the program), about ten seconds of ticks.

const key = (name: (typeof KEYS)[number]) => 1 << KEYS.indexOf(name);
const PLAYTEST_TICKS: TickEvent[] = Array.from({ length: 300 }, (_, k) => {
  const t = k + 1;
  let keys = 0;
  if (t > 45 && (t - 46) % 15 < 2) keys |= key("Space");
  if (t >= 100 && t < 160) keys |= key("Right");
  if (t >= 160 && t < 200) keys |= key("Left");
  if (t >= 200 && t < 260 && t % 40 < 3) keys |= key("Up");
  if (t >= 260 && t < 280) keys |= key("Down");
  if (t >= 290 && t < 292) keys |= key("Enter");
  return { tick: String(t), keys };
});
const PLAYTEST_SCRIPT = "300 input ticks (about 10 s at 30 per second): ticks 1-45 no keys; from tick 46 Space tapped for 2 ticks every 15 ticks; Right arrow held 100-159; Left arrow held 160-199; Up arrow tapped every 40 ticks 200-259; Down arrow held 260-279; Enter at 290-291. Programs that read no input simply run.";
const PLAYTEST_FRAMES = [1, 30, 60, 90, 130, 180, 240, 300];

/** The file's feature bitmask (header word 2) says whether the program uses the framebuffer. */
function draws(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const features = (bytes[8]! | (bytes[9]! << 8) | (bytes[10]! << 16) | (bytes[11]! << 24)) >>> 0;
  return (features & Feature.FRAMEBUFFER) !== 0;
}

async function rgbaToPng(rgba: Uint8ClampedArray): Promise<string | null> {
  try {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 144;
    const buf = new Uint8ClampedArray(new ArrayBuffer(rgba.length));
    buf.set(rgba);
    c.getContext("2d")!.putImageData(new ImageData(buf, 256, 144), 0, 0);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}
