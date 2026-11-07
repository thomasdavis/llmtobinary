// Verifier service. Pulls jobs, reruns them, posts signed results. Run it capped: it shares the box.
//
//   VERIFIER_URL=https://... VERIFIER_ENV=staging node --experimental-transform-types --no-warnings src/main.ts [--once]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { importSigningKey, signStatement, type ObjectId } from "@llmtobinary/registry";
import { verifyObject, type SlotJudge } from "./verify.ts";
import { bySlot, judge, linkFor, setBuildDir } from "../../research-cli/src/os-lib.ts";
import { judgeClaim, privateSeed } from "../../research-cli/src/os-tests.ts";
import { statement } from "@llmtobinary/registry";

const base = (process.env.VERIFIER_URL ?? "").replace(/\/$/, "");
const environment = process.env.VERIFIER_ENV ?? "staging";
if (!base) throw new Error("VERIFIER_URL is required");
const keys = JSON.parse(readFileSync(process.env.VERIFIER_KEYS ?? `${homedir()}/.config/llmtobinary/keys-${environment}.json`, "utf8")) as { verifier: { privateKeyPkcs8Hex: string }; verifierToken: string };
const key = await importSigningKey(`verifier-${environment}-1`, keys.verifier.privateKeyPkcs8Hex);

// A slot candidate is judged exactly as the OS build judged its own packages.
let slotJudge: SlotJudge | undefined;
if (process.env.OS_BUILD_DIR) {
  setBuildDir(process.env.OS_BUILD_DIR);
  const seed = privateSeed();
  slotJudge = (id, bytes) => {
    const slot = bySlot.get(id);
    return slot ? { failures: judge(slot, bytes, seed).length, cases: 1 } : null;
  };
}

async function pass(): Promise<number> {
  const res = await fetch(`${base}/api/verifier/jobs`, { headers: { authorization: `Bearer ${keys.verifierToken}` } });
  if (!res.ok) throw new Error(`jobs: HTTP ${res.status}`);
  const { jobs, counterexamples } = (await res.json()) as { jobs: { objectId: ObjectId; taskId: string }[]; counterexamples: { id: string; objectId: ObjectId; input: string; slot: string | null }[] };
  // "Break this package": the oracle decides, not the claimant.
  for (const x of counterexamples) {
    const slot = x.slot ? bySlot.get(x.slot) : undefined;
    const b = await fetch(`${base}/api/registry/${x.objectId}/bytes`);
    let confirmed = false;
    if (slot && b.ok) {
      const l = linkFor(slot, new Uint8Array(await b.arrayBuffer()));
      if (!("error" in l)) {
        const v = judgeClaim(l.image, x.input);
        confirmed = v.status === "confirmed";
        console.log(`${x.objectId}: claim ${v.status}`);
        if (confirmed) await fetch(`${base}/api/registry/${x.objectId}/attestations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await signStatement(statement(x.objectId, "counterexample", { confirmed: true, input: x.input }), key)) });
      }
    }
    await fetch(`${base}/api/verifier/counterexamples/${x.id}`, { method: "POST", headers: { authorization: `Bearer ${keys.verifierToken}`, "content-type": "application/json" }, body: JSON.stringify({ confirmed }) });
  }
  for (const job of jobs) {
    const b = await fetch(`${base}/api/registry/${job.objectId}/bytes`);
    if (!b.ok) {
      console.log(`${job.objectId}: bytes unavailable (${b.status})`);
      continue;
    }
    const out = await verifyObject(job.objectId, new Uint8Array(await b.arrayBuffer()), job.taskId, "test", slotJudge);
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
