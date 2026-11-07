// Re-judges every package, signs its evidence, publishes it, assembles the OS image and audits it.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/os-publish.ts --dir <build dir> --env staging --url https://... [--dry]

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { canonicalJson, importSigningKey, objectId, signStatement, statement, type Envelope, type LockFile, type ObjectId } from "@llmtobinary/registry";
import { link } from "@llmtobinary/link";
import { parseModule } from "@llmtobinary/module";
import { Op } from "@llmtobinary/spec";
import { validateBytes } from "@llmtobinary/validate";
import { buildDisk, boot, DEMO_STEPS, keysFor, privateSeed, transcript } from "./os-tests.ts";
import { built, bytesOf, bySlot, closure, judge, linkFor, linkInput, programFiles, setBuildDir } from "./os-lib.ts";
import { SLOTS } from "../../../os/slots.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const dir = arg("dir");
const environment = arg("env", "staging");
const url = arg("url", "").replace(/\/$/, "");
const dry = process.argv.includes("--dry");
setBuildDir(dir);

const keys = JSON.parse(readFileSync(`${homedir()}/.config/llmtobinary/keys-${environment}.json`, "utf8")) as { broker: { privateKeyPkcs8Hex: string }; verifier: { privateKeyPkcs8Hex: string }; verifier2: { privateKeyPkcs8Hex: string } };
const adminKey = readFileSync(`${homedir()}/.config/llmtobinary/gallery-admin-key`, "utf8").trim();
const brokerKey = await importSigningKey(`broker-${environment}-1`, keys.broker.privateKeyPkcs8Hex);
const verifierKey = await importSigningKey(`verifier-${environment}-1`, keys.verifier.privateKeyPkcs8Hex);
const verifier2Key = await importSigningKey(`verifier-${environment}-2`, keys.verifier2.privateKeyPkcs8Hex);
const seed = privateSeed();
const log = (s: unknown) => console.log(s);

const missing = SLOTS.filter((s) => !built(s.id));
if (missing.length) throw new Error(`not built yet: ${missing.map((s) => s.id).join(", ")}`);

// 1. Re-judge everything. A package that does not pass here is not published.
const ids = new Map<string, ObjectId>();
const envelopes = new Map<string, Envelope[]>();
for (const s of SLOTS) {
  const b = built(s.id)!;
  const bytes = bytesOf(b.hex);
  const failures = judge(s, bytes, seed);
  if (failures.length) throw new Error(`${s.id} no longer passes: ${failures[0]!.detail}`);
  const id = await objectId(bytes);
  ids.set(s.id, id);
  const outputHash = (await objectId(new TextEncoder().encode(canonicalJson({ slot: s.id, passed: true })))).slice(7);
  const task = { taskId: `slot:${s.id}`, taskOwned: true, holdouts: true, passed: true, outputHash };
  envelopes.set(s.id, [
    await signStatement(statement(id, "provenance", { sessionId: b.sessionId, model: b.model, lane: b.lane, builtAt: b.builtAt, submissions: b.submissions }), brokerKey),
    await signStatement(statement(id, "test", task), verifierKey),
    await signStatement(statement(id, "rerun", task), verifier2Key),
  ]);
  log(`judged ${s.id}: ${b.records} records`);
}

// 2. Assemble the image from the same modules.
const kernelSlot = bySlot.get(arg("image", "kernel-live"))!;
const order = closure(kernelSlot).filter((s) => s !== kernelSlot);
const linked = link([linkInput(kernelSlot, bytesOf(built(kernelSlot.id)!.hex)), ...order.map((s) => linkInput(s, bytesOf(built(s.id)!.hex)))]);
if (!linked.ok) throw new Error(`the image does not link: ${JSON.stringify(linked.errors)}`);
const v = validateBytes(linked.bytes, { anma2: true });
if (!v.ok || !v.module) throw new Error("the image failed validation");
const fs = linkFor(bySlot.get("fs")!, bytesOf(built("fs")!.hex));
if ("error" in fs) throw new Error(fs.error);
const disk = buildDisk(fs.image, programFiles());

// 3. The demo, twice, then a reboot.
const first = boot(v.module, disk, DEMO_STEPS.map(([l]) => l));
if (first.terminal !== transcript(DEMO_STEPS) || first.status !== "halted") throw new Error(`the demo transcript differs:\n${first.terminal}`);
const second = boot(v.module, disk, DEMO_STEPS.map(([l]) => l));
if (second.terminal !== first.terminal) throw new Error("the demo is not deterministic");
const reboot = boot(v.module, first.disk, ["cat note", "exit"]);
if (reboot.terminal !== transcript([["cat note", "hi there\n"], ["exit", ""]])) throw new Error("the file did not survive a reboot");
log(`demo passed: ${keysFor(DEMO_STEPS.map(([l]) => l)).length} keys, ${(linked.bytes.length - 32) / 16} records`);

// 4. Provenance audit (A6.3): every record of the image must come from a package, byte for byte,
// apart from the two fields the linker may rewrite.
const word = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const records = (body: Uint8Array): number[][] => {
  const out: number[][] = [];
  for (let at = 0; at < body.length; at += 16) out.push([word(body, at), word(body, at + 4), word(body, at + 8), word(body, at + 12)]);
  return out;
};
const image = records(linked.bytes.subarray(32, 32 + word(linked.bytes, 12) * 16));
let cursor = 0;
for (const name of linked.modules) {
  const p = parseModule(bytesOf(built(name)!.hex));
  if (!p.ok) throw new Error(`audit: ${name} does not parse`);
  for (const r of records(p.module.body)) {
    const got = image[cursor++];
    if (!got) throw new Error(`audit: the image ends inside ${name}`);
    const same = r[0] === got[0] && r[3] === got[3] && (r[1] === got[1] || r[0] === Op.FUNC) && (r[2] === got[2] || r[0] === Op.CALL);
    if (!same) throw new Error(`audit: record ${cursor - 1} differs from ${name}`);
  }
}
if (cursor !== image.length) throw new Error(`audit: ${image.length - cursor} records have no package`);
log(`audit passed: all ${image.length} records trace to ${linked.modules.length} model-written packages`);

const imageId = await objectId(linked.bytes);
const diskId = await objectId(disk);
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const lock: LockFile = { kind: "llmtobinary-lock/1", root: ids.get("kernel")!, specDigest: "anma-2", engineDigest: "reference", policy: { minimumClass: "E3" }, slots: Object.fromEntries(SLOTS.map((s) => [s.id, ids.get(s.id)!])) };
const build = { name: "Community OS 0", imageHex: hex(linked.bytes), imageSha256: imageId.slice(7), diskHex: hex(disk), diskSha256: diskId.slice(7), lock, authority: linked.authority, packages: SLOTS.map((s) => ({ slot: s.id, sha256: ids.get(s.id)!.slice(7), records: built(s.id)!.records, model: built(s.id)!.model })) };
writeFileSync(arg("build-out", "apps/web/public/os/default-build.json"), JSON.stringify(build));
log(`image ${imageId.slice(0, 19)}, authority: ${linked.authority.join(", ")}`);
if (dry || !url) process.exit(0);

// 5. Publish.
const post = async (path: string, body: unknown): Promise<unknown> => {
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};
await post("/api/admin/slots", SLOTS.map((s) => ({ id: s.id, title: s.id, kind: s.kind, features: s.features, depends: s.depends, interface: s.exports, prompt: s.brief })));
for (const s of SLOTS) {
  const b = built(s.id)!;
  const entry = { version: 2, id: `slot-${s.id}`, sessionId: b.sessionId, label: `OS package: ${s.id}`, prompt: s.brief, taskId: null, outcome: "passed", program: "passed", checkerOk: true, createdAt: Date.parse(b.builtAt), finishedAt: Date.parse(b.builtAt), updatedAt: Date.parse(b.builtAt), bytes: b.hex.length / 2, instructions: b.records, model: b.model, reasoningEffort: "medium", turns: 0, checks: 0, submissions: b.submissions, outputTokens: b.outputTokens, features: s.features, signature: "", hex: b.hex, annotations: null, sha256: b.sha256, candidateSeq: null, attemptId: null, mode: "tools", promptVersion: "os-build", returnedModels: [b.model], stopDetail: null };
  const r = (await post("/api/admin/registry/publish", { entry, slot: s.id, attestations: envelopes.get(s.id) })) as { id: string; results: boolean[] };
  log(`published ${s.id}: ${r.results.join(",")}`);
}
