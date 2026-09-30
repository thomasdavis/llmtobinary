// T3 verification from the command line (PRD Section 15.5), using the Node z3 backend.
//   node --experimental-transform-types --no-warnings tools/research-cli/src/verify.ts <file.anma | bundle.json> [--task <taskId>]
// With --task, the task author's reference contract is proved ("proved to meet the task
// specification"); otherwise the model's own contracts from the bundle's annotations are used
// ("proved against the model's stated contract"). Partial correctness only.

import { readFileSync } from "node:fs";
import { validateBytes } from "@llmtobinary/validate";
import { parseAnnotations, type ParsedAnnotations } from "@llmtobinary/annotations";
import { TASK_BY_ID, TASK_CONTRACT_LIMITS } from "@llmtobinary/tasks";
import { verifyFunction } from "@llmtobinary/verify";
import { nodeZ3Backend } from "@llmtobinary/verify/node";
import { DEFAULT_LIMITS } from "@llmtobinary/spec";

const path = process.argv[2];
const ti = process.argv.indexOf("--task");
const taskId = ti > 0 ? process.argv[ti + 1] : null;
if (!path) {
  console.error("usage: verify.ts <file.anma | bundle.json> [--task <taskId>]");
  process.exit(2);
}
let bytes: Uint8Array;
let annotationsRaw: unknown = null;
if (path.endsWith(".json")) {
  const b = JSON.parse(readFileSync(path, "utf8")) as { executableBase64: string; annotations: unknown };
  bytes = Uint8Array.from(Buffer.from(b.executableBase64, "base64"));
  annotationsRaw = b.annotations;
} else bytes = new Uint8Array(readFileSync(path));

const v = validateBytes(bytes);
if (!v.ok || !v.module) {
  console.error("invalid executable:", v.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.rule} ${d.message}`).join("; "));
  process.exit(1);
}
let ann: ParsedAnnotations;
let owner: "task" | "model";
if (taskId) {
  const t = TASK_BY_ID.get(taskId);
  if (!t?.referenceContract) {
    console.error(`task ${taskId} has no reference contract`);
    process.exit(2);
  }
  const p = parseAnnotations({ summary: "", params: t.paramNames.map((name, index) => ({ function: v.module!.entry, index, name })), records: [], contracts: [{ function: v.module.entry, requires: null, ensures: t.referenceContract }], invariants: [], examples: [] }, { ...DEFAULT_LIMITS, contractExpressionBytes: 1 << 20, annotationBytes: 1 << 22 });
  ann = p.annotations!;
  owner = "task";
} else {
  const p = parseAnnotations(annotationsRaw);
  if (!p.ok || !p.annotations || !p.annotations.contracts.length) {
    console.error("no model contracts to verify (pass --task <id> to prove the task's reference contract)");
    process.exit(2);
  }
  ann = p.annotations;
  owner = "model";
}
const z3 = await nodeZ3Backend();
const report = await verifyFunction(v.module, ann, v.module.entry, z3, { contractOwner: owner, ...(owner === "task" ? { parseLimits: TASK_CONTRACT_LIMITS } : {}), timeoutMs: 30_000 });
console.log(JSON.stringify({ ...report, outcomes: report.outcomes.map(({ id, kind, status, counterexample, ms }) => ({ id, kind, status, counterexample, ms })) }, null, 2));
console.log(`\n${report.label}`);
process.exit(report.overall === "proved" ? 0 : 1);
