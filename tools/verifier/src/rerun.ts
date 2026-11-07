// The second verifier (PRD-OS 6.5, E4). Runs on a different machine with a different key. It knows
// nothing the first verifier computed: it downloads the published bytes, reruns the visible tests,
// and attests only what it observed. If the hashes differ, the registry simply does not raise the class.
//
//   VERIFIER_URL=... VERIFIER2_KEY=<pkcs8 hex> VERIFIER2_KEY_ID=... node ... src/rerun.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSigningKey, isObjectId, objectId, signStatement, statement } from "@llmtobinary/registry";
import { bySlot, outputHashOf, setBuildDir } from "../../research-cli/src/os-lib.ts";

const base = (process.env.VERIFIER_URL ?? "").replace(/\/$/, "");
if (!base || !process.env.VERIFIER2_KEY) throw new Error("VERIFIER_URL and VERIFIER2_KEY are required");
const key = await importSigningKey(process.env.VERIFIER2_KEY_ID ?? "verifier-2", process.env.VERIFIER2_KEY);

const json = async (path: string): Promise<any> => {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

// Rebuild the dependency set from the registry's own winners.
const { slots } = (await json("/api/slots")) as { slots: { id: string; winner: { object_id: string } | null }[] };
const dir = mkdtempSync(join(tmpdir(), "rerun-"));
setBuildDir(dir);
const wins: { id: string; object: string; bytes: Uint8Array }[] = [];
for (const s of slots) {
  if (!s.winner || !isObjectId(s.winner.object_id)) continue;
  const r = await fetch(`${base}/api/registry/${s.winner.object_id}/bytes`);
  if (!r.ok) continue;
  const bytes = new Uint8Array(await r.arrayBuffer());
  if ((await objectId(bytes)) !== s.winner.object_id) throw new Error(`${s.id} does not match its hash`);
  wins.push({ id: s.id, object: s.winner.object_id, bytes });
  writeFileSync(join(dir, `${s.id}.json`), JSON.stringify({ slot: s.id, hex: Buffer.from(bytes).toString("hex"), lane: "registry" }));
}

let matched = 0;
for (const w of wins) {
  const slot = bySlot.get(w.id);
  if (!slot) continue;
  const { hash, failures } = await outputHashOf(slot, w.bytes);
  if (failures) {
    console.log(`${w.id}: ${failures} visible tests failed here, no attestation`);
    continue;
  }
  const env = await signStatement(statement(w.object as `sha256:${string}`, "rerun", { taskId: `slot:${w.id}`, outputHash: hash, machine: process.env.RUNNER_NAME ?? "unknown" }), key);
  const post = await fetch(`${base}/api/registry/${w.object}/attestations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
  console.log(`${w.id}: ${hash.slice(0, 12)} posted ${post.status}`);
  if (post.ok) matched++;
}
console.log(`${matched} of ${wins.length} packages reran here`);
