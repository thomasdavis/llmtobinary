// Browser client for the llmtobinary Worker API (PRD Section 8.1). Streamed POST responses are read
// with fetch (EventSource cannot send a request body). Reconnects resume by sequence number and
// never start a new turn.

import type { AttemptRequest, ConfigResponse, CreateSessionRequest, CreateSessionResponse, LoopEvent } from "@llmtobinary/protocol";

export type Config = ConfigResponse & { liveReason?: string | null; pricePolicy?: string; promptVersion?: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function getConfig(): Promise<Config> {
  return jsonOrThrow<Config>(await fetch("/api/config"));
}

export async function createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
  return jsonOrThrow<CreateSessionResponse>(await fetch("/api/generation-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }));
}

async function readNdjson(res: Response, onEvent: (e: LoopEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as LoopEvent);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as LoopEvent);
}

/** Start one outer-loop iteration and stream its events until the attempt ends or the stream breaks. */
export async function streamAttempt(sessionId: string, token: string, req: AttemptRequest, onEvent: (e: LoopEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`/api/generation-sessions/${sessionId}/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) await jsonOrThrow(res);
  await readNdjson(res, onEvent);
}

/** Owner-only resumption after a reconnect. */
export async function resumeEvents(sessionId: string, token: string, after: number): Promise<{ events: LoopEvent[]; running: boolean; status: string }> {
  const res = await fetch(`/api/generation-sessions/${sessionId}/events?after=${after}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) await jsonOrThrow(res);
  const events: LoopEvent[] = [];
  await readNdjson(res, (e) => events.push(e));
  return { events, running: res.headers.get("x-attempt-running") === "1", status: res.headers.get("x-session-status") ?? "active" };
}

export async function cancelSession(sessionId: string, token: string): Promise<void> {
  await fetch(`/api/generation-sessions/${sessionId}/cancel`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
}

export async function sessionSummary(sessionId: string, token: string): Promise<Record<string, unknown>> {
  return jsonOrThrow(await fetch(`/api/generation-sessions/${sessionId}`, { headers: { authorization: `Bearer ${token}` } }));
}

/** "Share for debugging": upload the browser's own record; the server archives the whole session. */
export async function shareDebug(sessionId: string, token: string, bundle: unknown): Promise<{ debugId: string; environment: string }> {
  return jsonOrThrow(await fetch(`/api/generation-sessions/${sessionId}/debug`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(bundle) }));
}
