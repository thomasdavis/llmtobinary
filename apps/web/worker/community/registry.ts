// The shared registry (PRD-OS 6.4 to 6.6). Every generation becomes an object anyone can read.
// Evidence is computed by @llmtobinary/registry: nothing in this file can raise a package above E2
// except a verifier signature.

import { classify, importSigningKey, isObjectId, objectId, signStatement, statement, verifyEnvelope, type Envelope, type EvidenceClass, type LogEntry, type ObjectId, type TrustedKey, type VerifiedAttestation } from "@llmtobinary/registry";
import { validateBytes } from "@llmtobinary/validate";
import { headerVersion, parseModule, standalone } from "@llmtobinary/module";
import type { GalleryEntry } from "@llmtobinary/protocol";
import { HttpError } from "../http.ts";

export const LICENCE_CC0 = "CC0-1.0";
export const LICENCE_NONE = "none stated";
const OBJECT_PREFIX = "objects/sha256/";
const ATTESTATION_PREFIX = "attestations/";

const objectKey = (id: ObjectId): string => `${OBJECT_PREFIX}${id.slice(7)}`;
const attestationPrefix = (id: ObjectId): string => `${ATTESTATION_PREFIX}${id.slice(7)}/`;
const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

/** An ANMA-2 module is judged as the checker judges it: imports stood in for, ordinary validator. */
export function isValidObject(bytes: Uint8Array): boolean {
  if (headerVersion(bytes) !== 2) return validateBytes(bytes).ok;
  const p = parseModule(bytes);
  return p.ok && validateBytes(standalone(p.module), { anma2: true }).ok;
}

export const registryConfigured = (env: Env): boolean => !!env.REGISTRY && !!env.COMMUNITY_DB;

export function trustedKeys(env: Env): TrustedKey[] {
  try {
    const k = JSON.parse(env.TRUSTED_KEYS ?? "[]") as TrustedKey[];
    return Array.isArray(k) ? k : [];
  } catch {
    return [];
  }
}

export async function logEvent(env: Env, e: Pick<LogEntry, "at" | "kind" | "subject" | "detail">): Promise<void> {
  if (!env.REGISTRY_LOG) return;
  await env.REGISTRY_LOG.get(env.REGISTRY_LOG.idFromName("main")).append(e);
}

export interface PackageRow {
  object_id: string;
  label: string;
  prompt: string;
  task_id: string | null;
  outcome: string;
  model: string;
  records: number;
  byte_length: number;
  session_id: string | null;
  gallery_id: string | null;
  author_id: number | null;
  author_login?: string | null;
  licence: string;
  backfilled: number;
  valid: number;
  self_consistent: number;
  evidence_class: EvidenceClass;
  retracted: number;
  taken_down: number;
  created_at: number;
  stars?: number;
}

/**
 * Publishes a generation's bytes. Idempotent: the same bytes are one object however often they
 * arrive. `outcome` is kept as written, so passed and passed-unverified never merge.
 */
export async function publishGeneration(env: Env, e: GalleryEntry, opts: { backfilled: boolean; authorId: number | null; now: number; slot?: string }): Promise<ObjectId | null> {
  if (!registryConfigured(env) || !e.hex) return null;
  const bytes = hexToBytes(e.hex);
  const id = await objectId(bytes);
  const key = objectKey(id);
  const fresh = !(await env.REGISTRY!.head(key));
  if (fresh) await env.REGISTRY!.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  const valid = isValidObject(bytes);
  const selfConsistent = valid && (e.outcome === "passed" || e.outcome === "passed-unverified");
  const evidence = classify(id, { valid, selfConsistent }, []);
  await env.COMMUNITY_DB!.prepare(
    `INSERT INTO packages (object_id, label, prompt, task_id, outcome, model, records, byte_length, session_id, gallery_id, author_id, licence, backfilled, valid, self_consistent, evidence_class, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
     ON CONFLICT (object_id) DO UPDATE SET outcome = ?5, self_consistent = MAX(self_consistent, ?15), evidence_class = CASE WHEN evidence_class IN ('E3', 'E4', 'E5') THEN evidence_class ELSE ?16 END`,
  )
    .bind(id, e.label, e.prompt, e.taskId, e.outcome, e.model, e.instructions, bytes.length, e.sessionId, e.id, opts.authorId, opts.backfilled ? LICENCE_NONE : LICENCE_CC0, opts.backfilled ? 1 : 0, valid ? 1 : 0, selfConsistent ? 1 : 0, evidence.class, e.createdAt)
    .run();
  if (opts.slot) await env.COMMUNITY_DB!.prepare("INSERT OR IGNORE INTO slot_candidates (slot_id, object_id, created_at) VALUES (?1, ?2, ?3)").bind(opts.slot, id, opts.now).run();
  if (fresh) {
    await logEvent(env, { at: opts.now, kind: "publish", subject: id, detail: { sessionId: e.sessionId, backfilled: opts.backfilled } });
    const job = e.taskId ?? (opts.slot ? `slot:${opts.slot}` : null);
    if (valid && job) await env.COMMUNITY_DB!.prepare("INSERT OR IGNORE INTO verify_jobs (object_id, task_id, created_at) VALUES (?1, ?2, ?3)").bind(id, job, opts.now).run();
    // Signed only at generation time: a backfilled entry can never claim this attestation.
    if (!opts.backfilled && env.BROKER_SIGNING_KEY) {
      const key2 = await importSigningKey(env.BROKER_KEY_ID ?? "broker-1", env.BROKER_SIGNING_KEY);
      const env2 = await signStatement(statement(id, "provenance", { sessionId: e.sessionId, model: e.model, returnedModels: e.returnedModels, promptVersion: e.promptVersion, mode: e.mode, at: opts.now }), key2);
      await storeAttestation(env, id, env2);
    }
  }
  return id;
}

async function storeAttestation(env: Env, id: ObjectId, envelope: Envelope): Promise<string> {
  const body = JSON.stringify(envelope);
  const name = (await objectId(new TextEncoder().encode(body))).slice(7);
  await env.REGISTRY!.put(`${attestationPrefix(id)}${name}.json`, body, { httpMetadata: { contentType: "application/json" } });
  return name;
}

export async function loadAttestations(env: Env, id: ObjectId): Promise<{ envelope: Envelope; verified: VerifiedAttestation | null }[]> {
  const listed = await env.REGISTRY!.list({ prefix: attestationPrefix(id), limit: 200 });
  const trust = trustedKeys(env);
  const out: { envelope: Envelope; verified: VerifiedAttestation | null }[] = [];
  for (const o of listed.objects) {
    const r = await env.REGISTRY!.get(o.key);
    if (!r) continue;
    const envelope = JSON.parse(await r.text()) as Envelope;
    out.push({ envelope, verified: await verifyEnvelope(envelope, trust) });
  }
  return out;
}

/** Recomputes a package's class from its signed evidence, then does the same for anything depending on it. */
export async function recompute(env: Env, id: ObjectId): Promise<void> {
  const row = await env.COMMUNITY_DB!.prepare("SELECT valid, self_consistent FROM packages WHERE object_id = ?1").bind(id).first<{ valid: number; self_consistent: number }>();
  if (!row) return;
  const verified = (await loadAttestations(env, id)).map((a) => a.verified).filter((v): v is VerifiedAttestation => !!v);
  const e = classify(id, { valid: !!row.valid, selfConsistent: !!row.self_consistent }, verified);
  await env.COMMUNITY_DB!.prepare("UPDATE packages SET evidence_class = ?2, retracted = ?3 WHERE object_id = ?1").bind(id, e.class, e.retracted ? 1 : 0).run();
}

/**
 * Accepts a signed attestation. Only a signature from a trusted key changes anything, so this route
 * is safe to expose: a forged envelope is refused and never stored.
 */
export async function submitAttestation(env: Env, id: ObjectId, envelope: Envelope, now: number): Promise<{ accepted: boolean }> {
  const v = await verifyEnvelope(envelope, trustedKeys(env));
  if (!v || !v.statement.subject.some((s) => s.digest.sha256 === id.slice(7))) return { accepted: false };
  await storeAttestation(env, id, envelope);
  await logEvent(env, { at: now, kind: "attest", subject: id, detail: { predicateType: v.statement.predicateType, keyid: v.keyid } });
  await recompute(env, id);
  await env.COMMUNITY_DB!.prepare("UPDATE verify_jobs SET status = 'done' WHERE object_id = ?1").bind(id).run();
  // A pass counts for the slot it was tested against, and no other.
  const p = v.statement.predicate as { taskId?: unknown; passed?: unknown; taskOwned?: unknown; holdouts?: unknown };
  if (v.role === "verifier" && v.statement.predicateType === "llmtobinary/test/1" && p.passed === true && p.taskOwned === true && p.holdouts === true && typeof p.taskId === "string" && p.taskId.startsWith("slot:")) {
    await env.COMMUNITY_DB!.prepare("UPDATE slot_candidates SET verified = 1 WHERE object_id = ?1 AND slot_id = ?2").bind(id, p.taskId.slice(5)).run();
  }
  return { accepted: true };
}

const PACKAGE_SELECT = `SELECT p.*, u.login AS author_login, (SELECT COUNT(*) FROM stars s WHERE s.object_id = p.object_id) AS stars FROM packages p LEFT JOIN users u ON u.id = p.author_id`;

export interface PackageQuery {
  q: string | null;
  evidence: EvidenceClass | null;
  author: string | null;
  before: number | null;
  limit: number;
}

export async function listPackages(env: Env, f: PackageQuery): Promise<{ items: PackageRow[]; before: number | null }> {
  const where = ["p.taken_down = 0"];
  const args: unknown[] = [];
  if (f.q) {
    args.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(p.label LIKE ?${args.length} ESCAPE '\\' OR p.prompt LIKE ?${args.length} ESCAPE '\\')`);
  }
  if (f.evidence) {
    args.push(f.evidence);
    where.push(`p.evidence_class = ?${args.length}`);
  }
  if (f.author) {
    args.push(f.author);
    where.push(`u.login = ?${args.length}`);
  }
  if (f.before !== null) {
    args.push(f.before);
    where.push(`p.created_at < ?${args.length}`);
  }
  args.push(f.limit + 1);
  const r = await env.COMMUNITY_DB!.prepare(`${PACKAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?${args.length}`).bind(...args).all<PackageRow>();
  const rows = r.results;
  const more = rows.length > f.limit;
  const items = more ? rows.slice(0, f.limit) : rows;
  return { items, before: more ? (items.at(-1)?.created_at ?? null) : null };
}

export async function getPackage(env: Env, id: ObjectId): Promise<PackageRow | null> {
  return env.COMMUNITY_DB!.prepare(`${PACKAGE_SELECT} WHERE p.object_id = ?1`).bind(id).first<PackageRow>();
}

export async function getObject(env: Env, id: ObjectId): Promise<Response> {
  const row = await env.COMMUNITY_DB!.prepare("SELECT taken_down FROM packages WHERE object_id = ?1").bind(id).first<{ taken_down: number }>();
  if (row?.taken_down) return new Response(JSON.stringify({ error: "this object was taken down" }), { status: 451, headers: { "content-type": "application/json" } });
  const o = await env.REGISTRY!.get(objectKey(id));
  if (!o) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(o.body, { headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" } });
}

/** Removes the bytes and text for abuse or legal reasons. The tombstone and log entry stay. */
export async function takeDown(env: Env, id: ObjectId, reason: string, now: number): Promise<void> {
  await env.REGISTRY!.delete(objectKey(id));
  await env.COMMUNITY_DB!.prepare("UPDATE packages SET taken_down = 1, label = 'Taken down', prompt = '' WHERE object_id = ?1").bind(id).run();
  await env.COMMUNITY_DB!.prepare("UPDATE comments SET hidden = 1 WHERE object_id = ?1").bind(id).run();
  await logEvent(env, { at: now, kind: "takedown", subject: id, detail: { reason } });
}

export function parseObjectId(raw: string): ObjectId {
  const s = decodeURIComponent(raw);
  if (!isObjectId(s)) throw new HttpError(400, "not an object ID");
  return s;
}

/** Jobs for the verifier. Prompts are not included: it needs the object and the task only. */
export async function pendingJobs(env: Env, limit: number): Promise<{ objectId: string; taskId: string }[]> {
  const r = await env.COMMUNITY_DB!.prepare("SELECT object_id AS objectId, task_id AS taskId FROM verify_jobs WHERE status = 'pending' ORDER BY created_at LIMIT ?1").bind(limit).all<{ objectId: string; taskId: string }>();
  return r.results;
}
