// GenerationSession Durable Object (PRD Section 8.3): the agentic loop controller for one session.
// It serializes turns, performs the OpenAI streaming requests itself, owns the AbortController
// (client disconnect and cancel abort upstream), persists every event for resumption by sequence
// number, and purges session content with an alarm when the recovery TTL expires.

import { DurableObject } from "cloudflare:workers";
import { FakeModelClient, OpenAIModelClient, cancelSession, createSession, runAttempt, LoopError, type BudgetGate, type ModelClient, type ModelProfile, type ScriptedTurn, type SessionState } from "@llmtobinary/broker";
import type { AttemptRequest, CreateSessionRequest, LoopBudget, LoopEvent, SessionSummary } from "@llmtobinary/protocol";

const enc = new TextEncoder();
const pad = (n: number) => String(n).padStart(10, "0");
const HEARTBEAT_MS = 15_000;

export interface CreatePayload {
  sessionId: string;
  request: CreateSessionRequest;
  profile: ModelProfile;
  budget: Partial<LoopBudget>;
  ttlMs: number;
}

function log(fields: Record<string, unknown>): void {
  // Identifiers, timings, status, and usage only — never prompts, bytes, or keys.
  console.log(JSON.stringify({ component: "generation-session", ...fields }));
}

export class GenerationSession extends DurableObject<Env> {
  private state: SessionState | null = null;
  private running: AbortController | null = null;

  private async load(): Promise<SessionState | null> {
    if (this.state) return this.state;
    const s = await this.ctx.storage.get<SessionState>("state");
    if (s) {
      const cands = await this.ctx.storage.list<SessionState["candidates"][number]>({ prefix: "c:" });
      s.candidates = [...cands.values()];
    }
    this.state = s ?? null;
    return this.state;
  }

  /** Persist state; candidates (which carry full raw text) are stored one per key. */
  private async save(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const { candidates, ...rest } = s;
    const puts: Record<string, unknown> = { state: { ...rest, candidates: [] } };
    for (const c of candidates) puts[`c:${pad(c.seq)}`] = c;
    await this.ctx.storage.put(puts);
  }

  private model(s: SessionState): ModelClient {
    if (this.env.ENVIRONMENT === "test" && this.env.TEST_FAKE_MODEL === "1") {
      // TEST-ONLY: named scripts; an open task described as "fake:<name>" selects one.
      const scripts = JSON.parse(this.env.TEST_FAKE_SCRIPT ?? "{}") as Record<string, ScriptedTurn[]>;
      const name = s.task.description?.startsWith("fake:") ? s.task.description.slice(5) : "default";
      return new FakeModelClient(scripts[name] ?? []);
    }
    if (!this.env.OPENAI_API_KEY) throw new LoopError("live generation is not configured", 503);
    return new OpenAIModelClient({ apiKey: this.env.OPENAI_API_KEY });
  }

  private ledger(sessionId: string): BudgetGate {
    const stub = this.env.BUDGET_LEDGER.get(this.env.BUDGET_LEDGER.idFromName("global"));
    return {
      reserve: (turnId, usd) => stub.reserve(sessionId, turnId, usd),
      reconcile: (turnId, usd) => stub.reconcile(turnId, usd),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/create":
          return await this.create((await request.json()) as CreatePayload);
        case "/attempt":
          return await this.attempt((await request.json()) as AttemptRequest);
        case "/events":
          return await this.events(Number(url.searchParams.get("after") ?? "0"));
        case "/cancel":
          return await this.cancel();
        case "/summary":
          return await this.summary();
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (e) {
      const status = e instanceof LoopError ? e.status : 500;
      if (status === 500) log({ event: "error", name: (e as Error)?.name });
      return Response.json({ error: status === 500 ? "internal error" : (e as Error).message }, { status });
    }
  }

  private async create(p: CreatePayload): Promise<Response> {
    if (await this.load()) return Response.json({ error: "session exists" }, { status: 409 });
    const now = Date.now();
    this.state = createSession({ sessionId: p.sessionId, task: p.request.task, mode: p.request.mode, profile: p.profile, budget: p.budget, now, ttlMs: p.ttlMs });
    await this.save();
    await this.ctx.storage.setAlarm(this.state.expiresAt);
    log({ event: "created", sessionId: p.sessionId, mode: p.request.mode, task: p.request.task.taskId ?? "open" });
    return Response.json({ sessionId: p.sessionId, budget: this.state.budget, expiresAt: this.state.expiresAt });
  }

  private async attempt(req: AttemptRequest): Promise<Response> {
    const s = await this.load();
    if (!s) throw new LoopError("no such session", 404);
    const existing = s.attempts.find((a) => a.idempotencyKey === req.idempotencyKey);
    if (existing) {
      // Idempotent replay: return that attempt's stored events; never buy another turn.
      const evs = await this.ctx.storage.list<LoopEvent>({ prefix: "e:" });
      const lines = [...evs.values()].filter((e) => e.attemptId === existing.attemptId).map((e) => JSON.stringify(e)).join("\n");
      return new Response(lines ? `${lines}\n` : "", { headers: { "content-type": "application/x-ndjson" } });
    }
    if (this.running) throw new LoopError("an attempt is already running", 409);
    if (s.status !== "active") throw new LoopError(`session is stopped (${s.outcome})`, 409);
    const model = this.model(s);
    const ac = new AbortController();
    this.running = ac;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    let clientGone = false;
    const write = async (obj: unknown) => {
      if (clientGone) return;
      try {
        await writer.write(enc.encode(`${JSON.stringify(obj)}\n`));
      } catch {
        clientGone = true;
        ac.abort(); // client disconnect propagates upstream
      }
    };
    const heartbeat = setInterval(() => {
      void write({ type: "heartbeat", sessionId: s.sessionId, attemptId: "", seq: s.seq, at: Date.now() });
    }, HEARTBEAT_MS);
    const started = Date.now();
    const work = (async () => {
      try {
        await runAttempt(s, req, {
          model,
          ledger: this.ledger(s.sessionId),
          now: () => Date.now(),
          signal: ac.signal,
          newId: () => crypto.randomUUID(),
          allowedFeatures: Number(this.env.ALLOWED_FEATURES ?? "15"),
          emit: async (ev) => {
            await this.ctx.storage.put(`e:${pad(ev.seq)}`, ev);
            if (ev.type === "check.result" || ev.type === "candidate.submitted" || ev.type === "loop.stopped") await this.save();
            await write(ev);
          },
        });
      } catch (e) {
        const msg = e instanceof LoopError ? e.message : "internal error";
        await write({ type: "attempt.error", sessionId: s.sessionId, attemptId: "", seq: s.seq, at: Date.now(), code: "loop_error", message: msg, retryable: false });
        if (!(e instanceof LoopError)) log({ event: "loop-exception", sessionId: s.sessionId, name: (e as Error)?.name });
      } finally {
        clearInterval(heartbeat);
        this.running = null;
        await this.save();
        log({ event: "attempt-end", sessionId: s.sessionId, ms: Date.now() - started, status: s.status, outcome: s.outcome, turns: s.counters.turns, outputTokens: s.counters.outputTokens, inputTokens: s.counters.inputTokens, unknownUsageTurns: s.counters.unknownUsageTurns });
        try {
          await writer.close();
        } catch {
          /* client already gone */
        }
      }
    })();
    this.ctx.waitUntil(work);
    return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  private async events(after: number): Promise<Response> {
    const s = await this.load();
    if (!s) throw new LoopError("no such session", 404);
    const evs = await this.ctx.storage.list<LoopEvent>({ prefix: "e:", start: `e:${pad(Math.max(0, after) + 1)}`, limit: 1000 });
    const body = [...evs.values()].map((e) => JSON.stringify(e)).join("\n");
    return new Response(body ? `${body}\n` : "", { headers: { "content-type": "application/x-ndjson", "x-session-status": s.status, "x-attempt-running": this.running ? "1" : "0" } });
  }

  private async cancel(): Promise<Response> {
    const s = await this.load();
    if (!s) throw new LoopError("no such session", 404);
    if (this.running) {
      this.running.abort();
      return Response.json({ cancelled: true, running: true }, { status: 202 });
    }
    if (s.status === "active") {
      cancelSession(s);
      const ev = { type: "loop.stopped", outcome: "cancelled", detail: "cancelled by the visitor", sessionId: s.sessionId, attemptId: "", seq: ++s.seq, at: Date.now() } as LoopEvent;
      await this.ctx.storage.put(`e:${pad(ev.seq)}`, ev);
      await this.save();
    }
    return Response.json({ cancelled: true, running: false });
  }

  private async summary(): Promise<Response> {
    const s = await this.load();
    if (!s) throw new LoopError("no such session", 404);
    const body: SessionSummary = { sessionId: s.sessionId, status: s.status, outcome: s.outcome, counters: s.counters, budget: s.budget, events: s.seq, expiresAt: s.expiresAt };
    return Response.json({ ...body, attempts: s.attempts, requestedModel: s.requestedModel, returnedModels: s.returnedModels, promptVersion: s.promptVersion, usdSpent: s.usdSpent, unknownUsageTurns: s.usdUnknownTurns });
  }

  override async alarm(): Promise<void> {
    if (this.running) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    log({ event: "purged", sessionId: this.state?.sessionId ?? null });
    this.state = null;
    await this.ctx.storage.deleteAll();
  }
}
