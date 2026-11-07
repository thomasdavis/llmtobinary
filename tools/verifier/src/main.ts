// Verifier service. Pulls jobs, reruns them, posts signed results. Run it capped: it shares the box.
//
//   VERIFIER_URL=https://... VERIFIER_ENV=staging node --experimental-transform-types --no-warnings src/main.ts [--once]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { importSigningKey, signStatement, type ObjectId } from "@llmtobinary/registry";
import { verifyObject } from "./verify.ts";

const base = (process.env.VERIFIER_URL ?? "").replace(/\/$/, "");
const environment = process.env.VERIFIER_ENV ?? "staging";
if (!base) throw new Error("VERIFIER_URL is required");
const keys = JSON.parse(readFileSync(process.env.VERIFIER_KEYS ?? `${homedir()}/.config/llmtobinary/keys-${environment}.json`, "utf8")) as { verifier: { privateKeyPkcs8Hex: string }; verifierToken: string };
const key = await importSigningKey(`verifier-${environment}-1`, keys.verifier.privateKeyPkcs8Hex);

async function pass(): Promise<number> {
  const res = await fetch(`${base}/api/verifier/jobs`, { headers: { authorization: `Bearer ${keys.verifierToken}` } });
  if (!res.ok) throw new Error(`jobs: HTTP ${res.status}`);
  const { jobs } = (await res.json()) as { jobs: { objectId: ObjectId; taskId: string }[] };
  for (const job of jobs) {
    const b = await fetch(`${base}/api/registry/${job.objectId}/bytes`);
    if (!b.ok) {
      console.log(`${job.objectId}: bytes unavailable (${b.status})`);
      continue;
    }
    const out = await verifyObject(job.objectId, new Uint8Array(await b.arrayBuffer()), job.taskId);
    if (out.kind === "skip") {
      console.log(`${job.objectId}: skipped: ${out.reason}`);
      continue;
    }
    const posted = await fetch(`${base}/api/registry/${job.objectId}/attestations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await signStatement(out.statement, key)) });
    console.log(`${job.objectId}: ${out.statement.predicate.passed ? "passed" : "failed"}, posted ${posted.status}`);
  }
  return jobs.length;
}

if (process.argv.includes("--once")) await pass();
else {
  for (;;) {
    const n = await pass().catch((e: Error) => {
      console.error(e.message);
      return 0;
    });
    await new Promise((r) => setTimeout(r, n ? 5_000 : 60_000));
  }
}
