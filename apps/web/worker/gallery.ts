// The public program gallery: sessions whose visitor ticked "publish" and whose program passed are
// stored as gallery/<inverted time>-<sessionId>.json in R2, newest first. The bytes come from the
// server's own record of the model's submission (never from the browser); the browser only names
// which submitted candidate passed, and every visitor's browser re-validates and re-tests on load.

import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { decodeFile, parseEnvelope, parseHex } from "@llmtobinary/decode";
import type { SessionState } from "@llmtobinary/broker";
import { GALLERY_VERSION, type GalleryEntry, type GallerySummary } from "@llmtobinary/protocol";

const PREFIX = "gallery/";
const MAX_TIME = 9_999_999_999_999;
/** R2 custom metadata is capped at 2 KiB per object; the summary stays well under it. */
const META_BUDGET = 1800;

const ID_RE = /^\d{13}-[0-9a-f-]{36}$/;
export const isGalleryId = (id: string) => ID_RE.test(id);

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}…`;
}

/** The program's label: the AI's own one-line summary of it, else the curated title, else the prompt. */
function labelFor(annotations: unknown, taskId: string | null, prompt: string): string {
  const summary = annotations && typeof annotations === "object" ? (annotations as { summary?: unknown }).summary : null;
  if (typeof summary === "string" && summary.trim()) return shorten(summary, 90);
  const task = taskId ? TASK_BY_ID.get(taskId) : undefined;
  if (task) return task.title;
  return shorten(prompt, 70);
}

/** Build the public entry for the candidate the browser reported as passing, or null if it is not one of this session's submissions. */
export function buildGalleryEntry(s: SessionState, passedSha: string, finishedAt: number): GalleryEntry | null {
  if (s.outcome !== "passed" && s.outcome !== "passed-unverified") return null;
  if (s.task.isa === "ANMR-1") return null;
  const cand = s.candidates.find((c) => c.kind === "submit" && c.sha256 === passedSha);
  if (!cand) return null;
  let hex: string;
  let annotations: unknown = null;
  if (s.mode === "raw-hex") {
    hex = cand.rawText;
  } else {
    const env = parseEnvelope(cand.rawText);
    if (!env.ok) return null;
    hex = env.envelope.hex;
    annotations = env.envelope.annotations ?? null;
  }
  const h = parseHex(hex);
  if (!h.ok) return null;
  const decoded = decodeFile(h.bytes);
  const task = s.task.taskId ? TASK_BY_ID.get(s.task.taskId) : undefined;
  const prompt = task ? task.prompt : (s.task.description ?? "");
  const sig = `(${s.task.params.join(", ")}) -> ${s.task.returns}`;
  const id = `${String(MAX_TIME - finishedAt).padStart(13, "0")}-${s.sessionId}`;
  return {
    version: GALLERY_VERSION,
    id,
    sessionId: s.sessionId,
    label: labelFor(annotations, s.task.taskId, prompt),
    prompt,
    taskId: s.task.taskId,
    outcome: s.outcome,
    createdAt: s.createdAt,
    finishedAt,
    bytes: h.bytes.length,
    instructions: decoded.file?.records.length ?? 0,
    model: s.requestedModel,
    reasoningEffort: s.profile.reasoningEffort ?? null,
    turns: s.counters.turns,
    checks: s.counters.checks,
    outputTokens: s.counters.outputTokens,
    features: s.task.allowedFeatures,
    signature: sig,
    hex: Array.from(h.bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    annotations,
    sha256: passedSha,
    candidateSeq: cand.seq,
    attemptId: cand.attemptId,
    mode: s.mode,
    promptVersion: s.promptVersion,
    returnedModels: s.returnedModels,
  };
}

const enc = new TextEncoder();

/** The list fields, packed into R2 custom metadata (string values, under the 2 KiB cap). */
function toMeta(e: GalleryEntry): Record<string, string> {
  const meta: Record<string, string> = {
    v: "1",
    sid: e.sessionId,
    label: e.label,
    task: e.taskId ?? "",
    outcome: e.outcome,
    created: String(e.createdAt),
    finished: String(e.finishedAt),
    bytes: String(e.bytes),
    instr: String(e.instructions),
    model: e.model,
    effort: e.reasoningEffort ?? "",
    turns: String(e.turns),
    checks: String(e.checks),
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

function fromMeta(key: string, m: Record<string, string> | undefined): GallerySummary | null {
  if (!m || m.v !== "1") return null;
  const id = key.slice(PREFIX.length).replace(/\.json$/, "");
  if (!isGalleryId(id)) return null;
  return {
    id,
    sessionId: m.sid ?? "",
    label: m.label ?? "",
    prompt: m.prompt ?? "",
    taskId: m.task || null,
    outcome: m.outcome === "passed" ? "passed" : "passed-unverified",
    createdAt: Number(m.created),
    finishedAt: Number(m.finished),
    bytes: Number(m.bytes),
    instructions: Number(m.instr),
    model: m.model ?? "",
    reasoningEffort: m.effort || null,
    turns: Number(m.turns),
    checks: Number(m.checks),
    outputTokens: Number(m.out),
    features: Number(m.feat),
    signature: m.sig ?? "",
  };
}

export async function putGalleryEntry(bucket: R2Bucket, e: GalleryEntry): Promise<void> {
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
