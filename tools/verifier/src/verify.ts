// The verifier's judgement, as a pure function. It trusts nothing it was sent: the bytes must hash
// to the object ID, and the task and its tests come from this process, not from the job.

import { canonicalJson, objectId, statement, type ObjectId, type Statement } from "@llmtobinary/registry";
import { TASK_BY_ID, runTaskTests } from "@llmtobinary/tasks";
import { validateBytes } from "@llmtobinary/validate";

export type VerifyOutcome = { kind: "attest"; statement: Statement } | { kind: "skip"; reason: string };

/** Judges a candidate for an OS slot. Returns null when this verifier has no judge for slots. */
export type SlotJudge = (slot: string, bytes: Uint8Array) => { failures: number; cases: number } | null;

export async function verifyObject(id: ObjectId, bytes: Uint8Array, taskId: string, predicate: "test" | "rerun" = "test", slotJudge?: SlotJudge): Promise<VerifyOutcome> {
  if ((await objectId(bytes)) !== id) return { kind: "skip", reason: "the bytes do not match their object ID" };
  if (taskId.startsWith("slot:")) {
    const r = slotJudge?.(taskId.slice(5), bytes);
    if (!r) return { kind: "skip", reason: `no judge for ${taskId}` };
    const outputHash = (await objectId(new TextEncoder().encode(canonicalJson({ taskId, failures: r.failures })))).slice(7);
    return { kind: "attest", statement: statement(id, predicate, { taskId, passed: r.failures === 0, taskOwned: true, holdouts: true, outputHash, cases: r.cases }) };
  }
  const task = TASK_BY_ID.get(taskId);
  if (!task) return { kind: "skip", reason: `unknown task ${taskId}` };
  const v = validateBytes(bytes);
  if (!v.ok || !v.module) return { kind: "attest", statement: statement(id, predicate, { taskId, taskVersion: task.version, passed: false, taskOwned: true, holdouts: false, reason: "invalid" }) };
  const report = runTaskTests(v.module, task);
  const outputs = report.cases.map((c) => [c.name, c.kind, c.passed, c.actual]);
  const outputHash = (await objectId(new TextEncoder().encode(canonicalJson(outputs)))).slice(7);
  // A task with no inputs has nothing left to hold out: its visible case is the whole domain.
  const holdouts = task.holdout.count > 0 || task.params.length === 0;
  return { kind: "attest", statement: statement(id, predicate, { taskId, taskVersion: task.version, passed: report.passed, taskOwned: true, holdouts, outputHash, cases: report.cases.length }) };
}
