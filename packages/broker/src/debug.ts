// Debug archive of one generation session: everything the server knows (task, profile, counters,
// attempts, the model conversation, every draft and submission in full, every loop event except
// per-token stream deltas) plus, when the visitor shares it, what only their browser knows (full
// test reports, the final machine state). Written to private storage; never served publicly.

import type { LoopEvent } from "@llmtobinary/protocol";
import type { SessionState } from "./loop.ts";

export const DEBUG_ARCHIVE_VERSION = "llmtobinary-debug/1";

/** Largest browser bundle accepted with a share (full test reports, machine state, a frame). */
export const MAX_DEBUG_BROWSER_BYTES = 4 * 1024 * 1024;

export interface DebugArchiveInput {
  state: SessionState;
  events: readonly LoopEvent[];
  /** Why this archive was written: "attempt-end", "shared", "lost", "cancelled", "purge". */
  reason: string;
  environment: string;
  build: string | null;
  archivedAt: number;
  /** Present when the visitor pressed "Share for debugging". */
  browserSharedAt: number | null;
}

const STREAM_DELTAS = new Set<string>(["model.tool_args.delta", "model.text.delta", "heartbeat"]);

export function buildDebugArchive(i: DebugArchiveInput): Record<string, unknown> {
  const { items, candidates, checkOutputs, draftCalls, ...session } = i.state;
  const deltaCounts: Record<string, number> = {};
  const events: LoopEvent[] = [];
  for (const e of i.events) {
    if (STREAM_DELTAS.has(e.type)) deltaCounts[e.type] = (deltaCounts[e.type] ?? 0) + 1;
    else events.push(e);
  }
  const at = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
  return {
    kind: DEBUG_ARCHIVE_VERSION,
    reason: i.reason,
    archivedAt: at(i.archivedAt),
    environment: i.environment,
    build: i.build,
    sessionId: i.state.sessionId,
    summary: {
      status: i.state.status,
      outcome: i.state.outcome,
      stopDetail: i.state.stopDetail,
      task: i.state.task,
      model: i.state.profile.model,
      reasoningEffort: i.state.profile.reasoningEffort,
      promptVersion: i.state.promptVersion,
      counters: i.state.counters,
      usdSpent: i.state.usdSpent,
      attempts: i.state.attempts.map((a) => ({ ...a, startedAt: at(a.startedAt), endedAt: at(a.endedAt) })),
      candidates: candidates.map((c) => ({ seq: c.seq, kind: c.kind, attemptId: c.attemptId, sha256: c.sha256, byteLength: c.byteLength })),
      createdAt: at(i.state.createdAt),
      lastEventAt: at(i.events.at(-1)?.at),
      events: i.state.seq,
      streamedDeltaEvents: deltaCounts,
      browserSharedAt: at(i.browserSharedAt),
    },
    session,
    /** Every draft and submission exactly as the model sent it (never elided). */
    candidates,
    /** The model conversation as last sent (old drafts may be elided here; see candidates). */
    conversation: items,
    elision: { checkOutputs, draftCalls: draftCalls ?? [] },
    events,
  };
}
