// The public program list: every generation session, whatever its outcome, stored as
// gallery/<inverted creation time>-<sessionId>.json in R2 so a list is newest first. The entry is
// rewritten whenever the session is archived, so a running generation shows up and then updates.
// The bytes come from the server's own record of the model's tool calls (never from the browser);
// the browser only names which submission passed, and every visitor's browser re-validates and
// re-tests the bytes on load.

import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { decodeFile, parseEnvelope, parseHex } from "@llmtobinary/decode";
import type { SessionState } from "@llmtobinary/broker";
import { GALLERY_VERSION, type GalleryEntry, type GalleryOutcome, type GallerySummary, type LoopEvent } from "@llmtobinary/protocol";

const PREFIX = "gallery/";
const MAX_TIME = 9_999_999_999_999;
/** R2 custom metadata is capped at 2 KiB per object; the summary stays well under it. */
const META_BUDGET = 1800;

const ID_RE = /^\d{13}-[0-9a-f-]{36}$/;
export const isGalleryId = (id: string) => ID_RE.test(id);
export const galleryId = (createdAt: number, sessionId: string) => `${String(MAX_TIME - createdAt).padStart(13, "0")}-${sessionId}`;

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?…-]+$/, "")}…`;
}

/** The label: the AI's own one-line summary of its program, else the curated title, else the prompt. */
function labelFor(annotations: unknown, taskId: string | null, prompt: string): string {
  const summary = annotations && typeof annotations === "object" ? (annotations as { summary?: unknown }).summary : null;
  if (typeof summary === "string" && summary.trim()) return shorten(summary, 90);
  const task = taskId ? TASK_BY_ID.get(taskId) : undefined;
  if (task) return task.title;
  return shorten(prompt, 70) || "Untitled program";
}

export interface GalleryInput {
  state: SessionState;
  /** Stored loop events (stream deltas need not be included). */
  events: readonly LoopEvent[];
  /** True when the session is being purged at its recovery TTL (an active one never finished). */
  expired: boolean;
  now: number;
}

export function buildGalleryEntry(i: GalleryInput): GalleryEntry | null {
  const s = i.state;
  if (s.task.isa === "ANMR-1") return null; // research control runs are not programs to show
  const outcome: GalleryOutcome = s.status === "stopped" && s.outcome ? s.outcome : i.expired ? "unfinished" : "in-progress";
  const passed = outcome === "passed" || outcome === "passed-unverified";
  const submits = s.candidates.filter((c) => c.kind === "submit");
  const drafts = s.candidates.filter((c) => c.kind === "check");
  let program: GalleryEntry["program"] = null;
  const passedSha = passed ? passedShaFromDetail(s.stopDetail) : null;
  // The last submission with the passing bytes (an earlier one may carry annotations that failed).
  let cand = passedSha ? submits.findLast((c) => c.sha256 === passedSha) : undefined;
  if (cand) program = "passed";
  else if ((cand = submits.at(-1))) program = "submission";
  else if ((cand = drafts.at(-1))) program = "draft";

  let bytes: Uint8Array | null = null;
  let annotations: unknown = null;
  if (cand) {
    if (s.mode === "raw-hex") {
      const h = parseHex(cand.rawText);
      if (h.ok) bytes = h.bytes;
    } else {
      const env = parseEnvelope(cand.rawText);
      if (env.ok) {
        annotations = env.envelope.annotations ?? null;
        const h = parseHex(env.envelope.hex);
        if (h.ok) bytes = h.bytes;
      }
    }
    if (!bytes) program = null;
  }
  let checkerOk: boolean | null = null;
  if (program === "draft" && cand) {
    const r = i.events.findLast((e) => e.type === "check.result" && e.candidateSeq === cand!.seq) as Extract<LoopEvent, { type: "check.result" }> | undefined;
    checkerOk = r ? r.report.ok : null;
  }
  const task = s.task.taskId ? TASK_BY_ID.get(s.task.taskId) : undefined;
  const prompt = task ? task.prompt : (s.task.description ?? "");
  const stopped = i.events.findLast((e) => e.type === "loop.stopped");
  const lastAt = i.events.at(-1)?.at ?? s.createdAt;
  return {
    version: GALLERY_VERSION,
    id: galleryId(s.createdAt, s.sessionId),
    sessionId: s.sessionId,
    label: labelFor(annotations, s.task.taskId, prompt),
    prompt,
    taskId: s.task.taskId,
    outcome,
    program: bytes ? program : null,
    checkerOk,
    createdAt: s.createdAt,
    finishedAt: stopped?.at ?? null,
    updatedAt: Math.max(lastAt, s.createdAt),
    bytes: bytes?.length ?? 0,
    instructions: bytes ? (decodeFile(bytes).file?.records.length ?? 0) : 0,
    model: s.requestedModel,
    reasoningEffort: s.profile.reasoningEffort ?? null,
    turns: s.counters.turns,
    checks: s.counters.checks,
    submissions: s.counters.submissions,
    outputTokens: s.counters.outputTokens,
    features: s.task.allowedFeatures,
    signature: `(${s.task.params.join(", ")}) -> ${s.task.returns}`,
    hex: bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : "",
    annotations,
    sha256: bytes && cand ? cand.sha256 : null,
    candidateSeq: bytes && cand ? cand.seq : null,
    attemptId: bytes && cand ? cand.attemptId : null,
    mode: s.mode,
    promptVersion: s.promptVersion,
    returnedModels: s.returnedModels,
    stopDetail: s.stopDetail,
  };
}

const enc = new TextEncoder();

/** The list fields, packed into R2 custom metadata (string values, under the 2 KiB cap). */
function toMeta(e: GalleryEntry): Record<string, string> {
  const meta: Record<string, string> = {
    v: "2",
    sid: e.sessionId,
    label: e.label,
    task: e.taskId ?? "",
    outcome: e.outcome,
    prog: e.program ?? "",
    chk: e.checkerOk === null ? "" : e.checkerOk ? "1" : "0",
    created: String(e.createdAt),
    finished: e.finishedAt === null ? "" : String(e.finishedAt),
    updated: String(e.updatedAt),
    bytes: String(e.bytes),
    instr: String(e.instructions),
    model: e.model,
    effort: e.reasoningEffort ?? "",
    turns: String(e.turns),
    checks: String(e.checks),
    subs: String(e.submissions),
    out: String(e.outputTokens),
    feat: String(e.features),
    sig: e.signature,
  };
  const used = Object.entries(meta).reduce((n, [k, v]) => n + enc.encode(k).length + enc.encode(v).length, 0) + 6;
  let prompt = shorten(e.prompt, 400);
  while (prompt.length > 20 && enc.encode(prompt).length > META_BUDGET - used) prompt = shorten(prompt, Math.floor(prompt.length * 0.8));
  meta.prompt = prompt;
  return meta;
}

const num = (v: string | undefined) => (v ? Number(v) : 0);

function fromMeta(key: string, m: Record<string, string> | undefined): GallerySummary | null {
  if (!m || m.v !== "2") return null;
  const id = key.slice(PREFIX.length).replace(/\.json$/, "");
  if (!isGalleryId(id)) return null;
  return {
    id,
    sessionId: m.sid ?? "",
    label: m.label ?? "",
    prompt: m.prompt ?? "",
    taskId: m.task || null,
    outcome: (m.outcome || "in-progress") as GalleryOutcome,
    program: (m.prog || null) as GallerySummary["program"],
    checkerOk: m.chk === "1" ? true : m.chk === "0" ? false : null,
    createdAt: num(m.created),
    finishedAt: m.finished ? Number(m.finished) : null,
    updatedAt: num(m.updated),
    bytes: num(m.bytes),
    instructions: num(m.instr),
    model: m.model ?? "",
    reasoningEffort: m.effort || null,
    turns: num(m.turns),
    checks: num(m.checks),
    submissions: num(m.subs),
    outputTokens: num(m.out),
    features: num(m.feat),
    signature: m.sig ?? "",
  };
}

/** Taken-down sessions leave a marker so later archive writes never list them again. */
const hiddenKey = (sessionId: string) => `gallery-hidden/${sessionId}`;

export async function hideGalleryEntry(bucket: R2Bucket, id: string): Promise<void> {
  await bucket.put(hiddenKey(id.slice(14)), String(Date.now()));
  await bucket.delete(`${PREFIX}${id}.json`);
}

export async function putGalleryEntry(bucket: R2Bucket, e: GalleryEntry): Promise<void> {
  if (await bucket.head(hiddenKey(e.sessionId))) return;
  await bucket.put(`${PREFIX}${e.id}.json`, JSON.stringify(e), { httpMetadata: { contentType: "application/json" }, customMetadata: toMeta(e) });
}

export async function listGallery(bucket: R2Bucket, cursor: string | null, limit: number): Promise<{ items: GallerySummary[]; cursor: string | null }> {
  const r = await bucket.list({ prefix: PREFIX, limit, cursor: cursor ?? undefined, include: ["customMetadata"] });
  const items = r.objects.map((o) => fromMeta(o.key, o.customMetadata)).filter((x): x is GallerySummary => !!x);
  return { items, cursor: r.truncated ? r.cursor : null };
}

export async function getGalleryEntry(bucket: R2Bucket, id: string): Promise<string | null> {
  const o = await bucket.get(`${PREFIX}${id}.json`);
  return o ? await o.text() : null;
}

/** The passing candidate named in a stop detail written by the loop ("candidate <sha> passed…/executed…"). */
export function passedShaFromDetail(detail: string | null): string | null {
  return /^candidate ([0-9a-f]{64}) (passed|executed)/.exec(detail ?? "")?.[1] ?? null;
}

/**
 * Rebuild list entries from debug archives (sessions/<id>.json), a page at a time. Used once to
 * list the generations made before the list existed; safe to repeat (entries are keyed per session).
 */
export async function rebuildFromArchives(bucket: R2Bucket, cursor: string | null, limit: number): Promise<{ written: number; skipped: number; cursor: string | null }> {
  const r = await bucket.list({ prefix: "sessions/", limit, cursor: cursor ?? undefined });
  let written = 0;
  let skipped = 0;
  for (const o of r.objects) {
    if (!/^sessions\/[0-9a-f-]{36}\.json$/.test(o.key)) continue;
    const body = await bucket.get(o.key);
    if (!body) continue;
    try {
      const a = (await body.json()) as { session: Omit<SessionState, "items" | "candidates" | "checkOutputs">; candidates: SessionState["candidates"]; events: LoopEvent[]; reason: string };
      const state = { ...a.session, items: [], candidates: a.candidates, checkOutputs: [] } as unknown as SessionState;
      const e = buildGalleryEntry({ state, events: a.events, expired: a.reason === "purge", now: Date.now() });
      if (e) {
        await putGalleryEntry(bucket, e);
        written++;
      } else skipped++;
    } catch {
      skipped++;
    }
  }
  return { written, skipped, cursor: r.truncated ? r.cursor : null };
}
