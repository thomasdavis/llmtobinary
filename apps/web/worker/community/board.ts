// The OS board (PRD-OS 6.9). A slot's default candidate is chosen by rule, never by popularity:
// highest evidence class, then fewest records, then earliest.

import { atLeast, checkLock, classify, isObjectId, objectId, type EvidenceClass, type LockFile, type ObjectId } from "@llmtobinary/registry";
import { link, type LinkInput } from "@llmtobinary/link";
import { HttpError } from "../http.ts";
import type { Member } from "../accounts.ts";
import type { PackageRow } from "./registry.ts";

export const BUILD_POLICY: EvidenceClass = "E3";
const MAX_PROPOSAL = 8_000;
const MAX_INPUT = 8_000;
const RANK: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4, E5: 5 };

export interface SlotRow {
  id: string;
  title: string;
  kind: string;
  features: number;
  depends: string;
  interface: string;
  prompt: string;
  position: number;
}

type Candidate = Pick<PackageRow, "object_id" | "evidence_class" | "records" | "created_at" | "retracted" | "taken_down"> & { stars?: number; verified?: number };

/**
 * A candidate's class for this slot. Evidence is per slot: passing the tests of another slot proves
 * nothing here, so without a verifier's pass for this slot a candidate cannot count above E2.
 */
export const classForSlot = (c: Pick<Candidate, "evidence_class" | "verified">): EvidenceClass => (c.verified || RANK[c.evidence_class]! < RANK.E3! ? c.evidence_class : "E2");

/** The default candidate. Stars are deliberately not an input. */
export function defaultCandidate(candidates: readonly Candidate[]): Candidate | null {
  const usable = candidates.filter((c) => !c.retracted && !c.taken_down);
  return [...usable].sort((a, b) => RANK[classForSlot(b)]! - RANK[classForSlot(a)]! || a.records - b.records || a.created_at - b.created_at)[0] ?? null;
}

export async function listSlots(env: Env): Promise<{ slots: (Omit<SlotRow, "prompt"> & { candidates: number; winner: Candidate | null; open: boolean })[] }> {
  const db = env.COMMUNITY_DB!;
  const slots = (await db.prepare("SELECT * FROM slots ORDER BY position").all<SlotRow>()).results;
  const rows = (await db.prepare("SELECT c.slot_id, c.verified, p.object_id, p.evidence_class, p.records, p.created_at, p.retracted, p.taken_down FROM slot_candidates c JOIN packages p ON p.object_id = c.object_id").all<Candidate & { slot_id: string }>()).results;
  return {
    slots: slots.map(({ prompt: _prompt, ...s }) => {
      const mine = rows.filter((r) => r.slot_id === s.id);
      const winner = defaultCandidate(mine);
      return { ...s, candidates: mine.length, winner: winner ? { ...winner, evidence_class: classForSlot(winner) } : null, open: !winner || !atLeast(classForSlot(winner), BUILD_POLICY) };
    }),
  };
}

export async function slotCandidates(env: Env, slotId: string): Promise<Candidate[]> {
  const r = await env.COMMUNITY_DB!.prepare("SELECT c.verified, p.object_id, p.evidence_class, p.records, p.created_at, p.retracted, p.taken_down FROM slot_candidates c JOIN packages p ON p.object_id = c.object_id WHERE c.slot_id = ?1 AND p.taken_down = 0 ORDER BY p.created_at DESC LIMIT 50").bind(slotId).all<Candidate>();
  return r.results.map((c) => ({ ...c, evidence_class: classForSlot(c) }));
}

export async function getSlot(env: Env, id: string): Promise<SlotRow | null> {
  return env.COMMUNITY_DB!.prepare("SELECT * FROM slots WHERE id = ?1").bind(id).first<SlotRow>();
}

export async function addCandidate(env: Env, slotId: string, id: ObjectId, now: number): Promise<void> {
  await env.COMMUNITY_DB!.prepare("INSERT OR IGNORE INTO slot_candidates (slot_id, object_id, created_at) VALUES (?1, ?2, ?3)").bind(slotId, id, now).run();
}

export async function proposeCounterexample(env: Env, m: Member, id: ObjectId, input: unknown, now: number): Promise<{ id: string }> {
  if (typeof input !== "string" || !input.trim() || input.length > MAX_INPUT) throw new HttpError(400, `an input is 1 to ${MAX_INPUT} characters`);
  const cid = crypto.randomUUID();
  await env.COMMUNITY_DB!.prepare("INSERT INTO counterexamples (id, object_id, user_id, input, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(cid, id, m.id, input, now).run();
  return { id: cid };
}

export async function proposeTest(env: Env, m: Member, slotId: string, body: unknown, now: number): Promise<{ id: string }> {
  if (typeof body !== "string" || !body.trim() || body.length > MAX_PROPOSAL) throw new HttpError(400, `a proposal is 1 to ${MAX_PROPOSAL} characters`);
  if (!(await getSlot(env, slotId))) throw new HttpError(404, "no such slot");
  const id = crypto.randomUUID();
  await env.COMMUNITY_DB!.prepare("INSERT INTO test_proposals (id, slot_id, user_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, slotId, m.id, body, now).run();
  return { id };
}

/** Only curators decide, and never for a slot where they wrote a candidate. */
export async function reviewTest(env: Env, reviewer: Member, proposalId: string, accept: boolean): Promise<void> {
  if (reviewer.role !== "curator" && reviewer.role !== "owner") throw new HttpError(403, "only curators accept tests");
  const db = env.COMMUNITY_DB!;
  const p = await db.prepare("SELECT slot_id FROM test_proposals WHERE id = ?1").bind(proposalId).first<{ slot_id: string }>();
  if (!p) throw new HttpError(404, "no such proposal");
  const own = await db.prepare("SELECT COUNT(*) AS n FROM slot_candidates c JOIN packages k ON k.object_id = c.object_id WHERE c.slot_id = ?1 AND k.author_id = ?2").bind(p.slot_id, reviewer.id).first<{ n: number }>();
  if ((own?.n ?? 0) > 0) throw new HttpError(403, "you cannot accept tests for a package you wrote");
  await db.prepare("UPDATE test_proposals SET status = ?2, reviewed_by = ?3 WHERE id = ?1").bind(proposalId, accept ? "accepted" : "rejected", reviewer.id).run();
}

export interface BuildRequest {
  name: string;
  lock: LockFile;
  /** Link metadata per slot: exports and imports by symbol. */
  modules: { slot: string; exports: Record<string, number>; imports: Record<string, string> }[];
  parent?: string;
}

/**
 * Publishes a build. The Worker fetches every pinned object, links them itself and validates the
 * result, so the client's image is never trusted. Linking is static: no guest code runs here.
 */
export async function publishBuild(env: Env, m: Member | null, b: BuildRequest, now: number): Promise<{ id: string; image: string }> {
  if (typeof b?.name !== "string" || !b.name.trim() || b.name.length > 80) throw new HttpError(400, "a build needs a name of 1 to 80 characters");
  if (b.lock?.kind !== "llmtobinary-lock/1" || !b.lock.slots || !Array.isArray(b.modules) || !b.modules.length) throw new HttpError(400, "a build needs a lock file and its modules");
  const db = env.COMMUNITY_DB!;
  const rows = new Map<string, { valid: number; self_consistent: number; evidence_class: EvidenceClass; retracted: number; taken_down: number }>();
  for (const [slot, id] of Object.entries(b.lock.slots)) {
    if (!isObjectId(id)) continue;
    const r = await db.prepare("SELECT p.valid, p.self_consistent, p.evidence_class, p.retracted, p.taken_down, c.verified FROM packages p LEFT JOIN slot_candidates c ON c.object_id = p.object_id AND c.slot_id = ?2 WHERE p.object_id = ?1").bind(id, slot).first<{ valid: number; self_consistent: number; evidence_class: EvidenceClass; retracted: number; taken_down: number; verified: number | null }>();
    if (r) rows.set(`${slot}:${id}`, { ...r, evidence_class: classForSlot({ evidence_class: r.evidence_class, verified: r.verified ?? 0 }) });
  }
  const lock: LockFile = { ...b.lock, policy: { minimumClass: BUILD_POLICY } };
  const problems = Object.entries(lock.slots).flatMap(([slot, id]) =>
    checkLock({ ...lock, slots: { [slot]: id } }, () => {
      const r = rows.get(`${slot}:${id}`);
      return r ? { evidence: { class: r.evidence_class, retracted: !!r.retracted, basis: [] }, takenDown: !!r.taken_down } : null;
    }),
  );
  if (problems.length) throw new HttpError(422, `the build was refused: ${problems.map((p) => `${p.slot} is ${p.problem}`).join(", ")}`);
  const inputs: LinkInput[] = [];
  for (const mod of b.modules) {
    const id = b.lock.slots[mod.slot];
    if (!id) throw new HttpError(422, `${mod.slot} is not in the lock file`);
    const o = await env.REGISTRY!.get(`objects/sha256/${id.slice(7)}`);
    if (!o) throw new HttpError(422, `${mod.slot} has no bytes`);
    const bytes = new Uint8Array(await o.arrayBuffer());
    if ((await objectId(bytes)) !== id) throw new HttpError(422, `${mod.slot} does not match its hash`);
    inputs.push({ name: mod.slot, bytes, exports: mod.exports, imports: Object.fromEntries(Object.entries(mod.imports).map(([k, v]) => [Number(k), v])) });
  }
  const linked = link(inputs);
  if (!linked.ok) throw new HttpError(422, `the build does not link: ${linked.errors.map((e) => e.message).join("; ")}`);
  const image = await objectId(linked.bytes);
  await env.REGISTRY!.put(`objects/sha256/${image.slice(7)}`, linked.bytes);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO builds (id, name, author_id, lock, image_id, parent, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(id, b.name, m?.id ?? null, JSON.stringify(lock), image, b.parent ?? null, now).run();
  return { id, image };
}

export async function listBuilds(env: Env): Promise<unknown[]> {
  const r = await env.COMMUNITY_DB!.prepare("SELECT b.id, b.name, b.image_id, b.parent, b.created_at, u.login AS author FROM builds b LEFT JOIN users u ON u.id = b.author_id ORDER BY b.created_at DESC LIMIT 100").all();
  return r.results;
}

export { classify };
