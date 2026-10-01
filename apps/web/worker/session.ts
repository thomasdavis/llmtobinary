// GenerationSession Durable Object (PRD Section 8.3): the agentic loop controller for one session.
// It serializes turns, performs the OpenAI streaming requests itself, owns the AbortController
// (client disconnect and cancel abort upstream), persists every event for resumption by sequence
// number, and purges session content with an alarm when the recovery TTL expires.

import { DurableObject } from "cloudflare:workers";
import { FakeModelClient, OpenAIModelClient, MAX_DEBUG_BROWSER_BYTES, buildDebugArchive, cancelSession, createSession, recoverLostAttempt, runAttempt, LoopError, type BudgetGate, type ModelClient, type ModelProfile, type ScriptedTurn, type SessionState } from "@llmtobinary/broker";
import type { AttemptRequest, CreateSessionRequest, LoopBudget, LoopEvent, SessionSummary } from "@llmtobinary/protocol";
import { buildGalleryEntry, putGalleryEntry } from "./gallery.ts";

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

/** Conversation JSON is stored in chunks of this many characters (UTF-16 ≤ 2 bytes each, under 2 MiB). */
const ITEM_CHUNK_CHARS = 900_000;

export class GenerationSession extends DurableObject<Env> {
  private state: SessionState | null = null;
  private running: AbortController | null = null;
  private savedCandidates = new Set<number>();
  private itemChunks = 0;

  private async load(): Promise<SessionState | null> {
    if (this.state) return this.state;
    const s = await this.ctx.storage.get<SessionState & { itemChunks?: number }>("state");
    if (s) {
      const cands = await this.ctx.storage.list<SessionState["candidates"][number]>({ prefix: "c:" });
      s.candidates = [...cands.values()];
      for (const c of s.candidates) this.savedCandidates.add(c.seq);
      if (s.itemChunks) {
        const parts = await this.ctx.storage.get<string>(Array.from({ length: s.itemChunks }, (_, i) => `i:${pad(i)}`));
        s.items = JSON.parse(Array.from({ length: s.itemChunks }, (_, i) => parts.get(`i:${pad(i)}`) ?? "").join(""));
        this.itemChunks = s.itemChunks;
        delete s.itemChunks;
      }
    }
    this.state = s ?? null;
    // A fresh instance never has an attempt in flight: one persisted as running died with a previous
    // instance (a deploy or a platform limit). Record that so the browser can resume the session.
    if (this.state && !this.running) {
      const lost = recoverLostAttempt(this.state, Date.now());
      if (lost) {
        const st = this.state;
        const ev = { type: "attempt.error", sessionId: st.sessionId, attemptId: lost.attemptId, seq: ++st.seq, at: Date.now(), code: "attempt_lost", message: "the server restarted during this attempt; it was stopped at the last saved point and can be resumed", retryable: true } as LoopEvent;
        await this.ctx.storage.put(`e:${pad(ev.seq)}`, ev);
        await this.save();
        log({ event: "attempt-lost", sessionId: st.sessionId, attemptId: lost.attemptId });
        this.ctx.waitUntil(this.archive("lost"));
      }
    }
    return this.state;
  }

  /**
   * Persist state within Durable Object value limits (2 MiB per value, 128 keys per put):
   * candidates (full raw text) one per key and written once; the conversation (which holds large
   * drafts) as JSON chunks next to a small state record.
   */
  private async save(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const { candidates, items, ...rest } = s;
    const json = JSON.stringify(items);
    const chunks: string[] = [];
    for (let i = 0; i < json.length; i += ITEM_CHUNK_CHARS) chunks.push(json.slice(i, i + ITEM_CHUNK_CHARS));
    const puts: Record<string, unknown> = { state: { ...rest, items: [], candidates: [], itemChunks: chunks.length } };
    chunks.forEach((c, i) => (puts[`i:${pad(i)}`] = c));
    const fresh = candidates.filter((c) => !this.savedCandidates.has(c.seq));
    for (const c of fresh) puts[`c:${pad(c.seq)}`] = c;
    const entries = Object.entries(puts);
    for (let i = 0; i < entries.length; i += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    for (const c of fresh) this.savedCandidates.add(c.seq);
    if (this.itemChunks > chunks.length) await this.ctx.storage.delete(Array.from({ length: this.itemChunks - chunks.length }, (_, k) => `i:${pad(chunks.length + k)}`));
    this.itemChunks = chunks.length;
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
        case "/debug":
          return await this.share(await request.text());
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
    // List it straight away (as in progress), so the program list shows generations as they start.
    const entry = this.env.DEBUG_ARCHIVE ? buildGalleryEntry({ state: this.state, events: [], expired: false, now }) : null;
    if (entry) this.ctx.waitUntil(putGalleryEntry(this.env.DEBUG_ARCHIVE!, entry).catch(() => log({ event: "gallery-failed", sessionId: p.sessionId })));
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
        // A real, stored sequence number: clients drop events that do not advance the sequence.
        const ev = { type: "attempt.error", sessionId: s.sessionId, attemptId: s.attempts.at(-1)?.attemptId ?? "", seq: ++s.seq, at: Date.now(), code: "loop_error", message: msg, retryable: false } as LoopEvent;
        await this.ctx.storage.put(`e:${pad(ev.seq)}`, ev);
        await write(ev);
        if (!(e instanceof LoopError)) log({ event: "loop-exception", sessionId: s.sessionId, name: (e as Error)?.name });
      } finally {
        clearInterval(heartbeat);
        this.running = null;
        await this.save();
        await this.archive(s.status === "stopped" ? `stopped:${s.outcome}` : "attempt-end");
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

  /**
   * Write the debug archive (sessions/<id>.json) to the private R2 bucket, and the session's public
   * program-list entry (gallery/<id>.json). Best-effort: archiving
   * must never break a session, so failures are logged and swallowed.
   */
  private async archive(reason: string): Promise<{ key: string; bytes: number } | null> {
    const bucket = this.env.DEBUG_ARCHIVE;
    const s = await this.load();
    if (!bucket || !s) return null;
    try {
      const evs = await this.ctx.storage.list<LoopEvent>({ prefix: "e:" });
      const sharedAt = (await this.ctx.storage.get<number>("browserSharedAt")) ?? null;
      const body = JSON.stringify(buildDebugArchive({ state: s, events: [...evs.values()], reason, environment: this.env.ENVIRONMENT ?? "unknown", build: this.env.CF_VERSION_METADATA?.id ?? null, archivedAt: Date.now(), browserSharedAt: sharedAt }));
      const key = `sessions/${s.sessionId}.json`;
      await bucket.put(key, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { reason, status: s.status, outcome: s.outcome ?? "" } });
      // Every generation is public: refresh its entry in the program list too.
      const entry = buildGalleryEntry({ state: s, events: [...evs.values()], expired: reason === "purge", now: Date.now() });
      if (entry) await putGalleryEntry(bucket, entry);
      return { key, bytes: body.length };
    } catch (e) {
      log({ event: "archive-failed", sessionId: s.sessionId, reason, name: (e as Error)?.name });
      return null;
    }
  }

  /** "Share for debugging": store the browser's own record next to the server archive. */
  private async share(browserJson: string): Promise<Response> {
    const s = await this.load();
    if (!s) throw new LoopError("no such session", 404);
    if (!this.env.DEBUG_ARCHIVE) throw new LoopError("debug archiving is not configured here", 503);
    if (browserJson.length > MAX_DEBUG_BROWSER_BYTES) throw new LoopError("browser bundle too large", 413);
    try {
      JSON.parse(browserJson);
    } catch {
      throw new LoopError("browser bundle must be JSON", 400);
    }
    await this.env.DEBUG_ARCHIVE.put(`sessions/${s.sessionId}.browser.json`, browserJson, { httpMetadata: { contentType: "application/json" } });
    await this.ctx.storage.put("browserSharedAt", Date.now());
    const a = await this.archive("shared");
    if (!a) throw new LoopError("the debug archive could not be written", 502);
    log({ event: "debug-shared", sessionId: s.sessionId, bytes: a.bytes + browserJson.length });
    return Response.json({ debugId: s.sessionId, environment: this.env.ENVIRONMENT ?? "unknown", archived: true });
  }

  override async alarm(): Promise<void> {
    if (this.running) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    await this.archive("purge");
    log({ event: "purged", sessionId: this.state?.sessionId ?? null });
    this.state = null;
    await this.ctx.storage.deleteAll();
  }
}
