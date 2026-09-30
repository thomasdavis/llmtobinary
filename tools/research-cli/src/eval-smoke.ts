// Evaluate a smoke-test submission locally exactly as the browser does (validation, tests, witness).
import { readFileSync } from "node:fs";
import { checkCandidate } from "@llmtobinary/check";
import { TASK_BY_ID, runTaskTests } from "@llmtobinary/tasks";
import { capstoneWitness } from "@llmtobinary/research";

const [file, taskId] = process.argv.slice(2);
const smoke = JSON.parse(readFileSync(file!, "utf8")) as { envelopeText: string };
const task = TASK_BY_ID.get(taskId!)!;
const out = await checkCandidate({ envelopeText: smoke.envelopeText }, { allowedFeatures: task.features });
console.log("valid:", out.report.ok, "bytes:", out.report.byteLength, "sha256:", out.report.sha256, "errors:", out.report.errors.map((d) => d.rule));
if (out.module) {
  const r = runTaskTests(out.module, task, { annotations: out.annotations, witness: (m, p) => { const w = capstoneWitness(m, p.K, p.stride); return { ok: w.ok, diagnostic: w.diagnostic }; } });
  console.log("tests passed:", r.passed, "tier:", r.tier);
  for (const c of r.cases.filter((c) => !c.passed)) console.log("  fail:", c.name, c.diagnostic?.message);
}
