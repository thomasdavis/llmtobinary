// Stars, comments and reports. None of this touches evidence or a slot's default candidate.

import type { ObjectId } from "@llmtobinary/registry";
import { HttpError } from "../http.ts";
import type { Member } from "../accounts.ts";

export const MAX_COMMENT = 2_000;
export const MAX_REASON = 1_000;
const COMMENTS_PER_HOUR = 20;

export async function setStar(env: Env, m: Member, id: ObjectId, on: boolean, now: number): Promise<void> {
  const db = env.COMMUNITY_DB!;
  if (on) await db.prepare("INSERT OR IGNORE INTO stars (user_id, object_id, created_at) VALUES (?1, ?2, ?3)").bind(m.id, id, now).run();
  else await db.prepare("DELETE FROM stars WHERE user_id = ?1 AND object_id = ?2").bind(m.id, id).run();
}

export async function addComment(env: Env, m: Member, id: ObjectId, body: unknown, now: number): Promise<{ id: string }> {
  if (typeof body !== "string" || !body.trim() || body.length > MAX_COMMENT) throw new HttpError(400, `a comment is 1 to ${MAX_COMMENT} characters`);
  const db = env.COMMUNITY_DB!;
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ?1 AND created_at > ?2").bind(m.id, now - 3_600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= COMMENTS_PER_HOUR) throw new HttpError(429, "too many comments; try again later");
  const cid = crypto.randomUUID();
  await db.prepare("INSERT INTO comments (id, user_id, object_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(cid, m.id, id, body, now).run();
  return { id: cid };
}

export async function listComments(env: Env, id: ObjectId): Promise<{ id: string; body: string; createdAt: number; author: string | null }[]> {
  const r = await env.COMMUNITY_DB!.prepare("SELECT c.id, c.body, c.created_at AS createdAt, u.login AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.object_id = ?1 AND c.hidden = 0 ORDER BY c.created_at LIMIT 200").bind(id).all<{ id: string; body: string; createdAt: number; author: string | null }>();
  return r.results;
}

export async function addReport(env: Env, m: Member | null, target: unknown, reason: unknown, now: number): Promise<void> {
  if (typeof target !== "string" || target.length > 200) throw new HttpError(400, "target is required");
  if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_REASON) throw new HttpError(400, `a reason is 1 to ${MAX_REASON} characters`);
  await env.COMMUNITY_DB!.prepare("INSERT INTO reports (id, user_id, target, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(crypto.randomUUID(), m?.id ?? null, target, reason, now).run();
}
