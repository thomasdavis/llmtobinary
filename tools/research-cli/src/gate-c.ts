// Gate C (docs/os-evidence/gate-c-prereg.md): does the library make later packages cheaper?
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/gate-c.ts --dir <build dir> --out <file.jsonl> [--n 10] [--parallel 3]

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseModule } from "@llmtobinary/module";
import { Op } from "@llmtobinary/spec";
import { buildDisk, invoke, privateSeed, rng, type Failure } from "./os-tests.ts";
import { DEVICES, bySlot, bytesOf, built, generate, importsOf, linkFor, programFiles, setBuildDir } from "./os-lib.ts";
import type { ExportSpec, Slot } from "../../../os/slots.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const H8 = 3;
const U = 1;
const HEAP = 1;
const BLOCK = 1 << 5;
const enc = new TextEncoder();
const DISK = "The disk has 512-byte sectors. Sector 0 is the directory: 16 entries of 32 bytes. Entry bytes 0 to 15 hold the name, zero padded. Byte 16 is the name length. Byte 17 is 1 when the entry is used. Bytes 18 and 19 are the size, little-endian. File slot i owns sectors 1 + 8*i to 8 + 8*i. block.read transfers one 512-byte sector into a handle<u8> of at least 512 bytes.";

const SUM: ExportSpec = { symbol: "app.sum", signature: "(buf: handle<u8>, n: u64, out: handle<u8>) -> u64", behaviour: "buf[0..n] holds unsigned decimal numbers separated by one or more spaces, possibly with spaces at either end. Adds them, wrapping. Writes the total in decimal ASCII at out[0..], with no leading zeros, and 0 as the digit 0. Returns the digit count. out holds at least 24 bytes.", id: 1, params: [H8, U, H8], ret: U };
const FILESUM: ExportSpec = { symbol: "app.filesum", signature: "(name: handle<u8>, len: u64, out: handle<u8>) -> u64", behaviour: "The len bytes at name[0..] name a file on the disk. Reads it. It holds unsigned decimal numbers separated by one or more spaces. Adds them, wrapping. Writes the total in decimal ASCII at out[0..], with no leading zeros and 0 as the digit 0, and returns the digit count. If there is no such file, returns 0 and writes nothing. out holds at least 24 bytes.", id: 1, params: [H8, U, H8], ret: U };

interface Task {
  id: string;
  export: ExportSpec;
  libs: string[];
  features: number;
  note: string;
}
const TASKS: Task[] = [
  { id: "sum", export: SUM, libs: ["str", "fmt", "parse-dec"], features: HEAP, note: "" },
  { id: "filesum", export: FILESUM, libs: ["str", "fmt", "parse-dec", "fs"], features: HEAP | BLOCK, note: DISK },
];

const slotFor = (t: Task, arm: "library" | "alone"): Slot => ({ id: `c-${t.id}`, kind: "library", features: t.features, depends: arm === "library" ? t.libs : [], exports: [t.export], brief: "" });

function prompt(t: Task, arm: "library" | "alone"): string {
  const s = slotFor(t, arm);
  const TYPE: Record<number, string> = { 0: "0 (unit)", 1: "1 (u64)", 2: "2 (bool)", 3: "3 (handle<u8>)", 4: "4 (handle<u64>)" };
  const imports = importsOf(s).map((e, k) => `import ${k}: ${e.symbol}${e.signature}\n  ${e.behaviour}\n  IMPORT return type ${TYPE[e.ret]}, parameter types ${e.params.map((p) => TYPE[p]).join(", ") || "none"}`).join("\n");
  return `This program is an ANMA-2 module: an ANMA-1 file with these differences.
- Header word 1 (version) is 2. Header word 2 may also set bit 5 (0x20, block).
- After the last END_FUNC it may list IMPORT declarations. Record 0x70 IMPORT has fields: function ID, parameter count, return type. Each IMPORT is immediately followed by its parameter count of PARAM records, where parameter k is PARAM with value ID k, its type tag, and parameter index k.
- Imports take the function IDs right after your defined functions, and CALL reaches them like any function.
- recordCount includes the IMPORT and PARAM records.
- These extra HOST operations exist:
${DEVICES}
${t.note}

Write this library. Declare feature bits 0x${t.features.toString(16)}. It has no read-only data.
Function 0 must be a trivial entry: fn0() -> u64 returning 0. Nothing calls it.
Define this function with this function ID:
function 1: ${t.export.symbol}${t.export.signature}
  ${t.export.behaviour}
Add private helpers after it.${imports ? `\n\nThese libraries are linked in for you. Declare every IMPORT below, in this order, whether or not you call it:\n${imports}` : ""}`;
}

/** Wrapping sum and its decimal text, the oracle for both tasks. */
const total = (nums: bigint[]): string => (nums.reduce((a, b) => a + b, 0n) & ((1n << 64n) - 1n)).toString();

function cases(seed: bigint): string[] {
  const r = rng(seed);
  const out = ["", "   ", "0", "7", " 12  30 ", "18446744073709551615 1", "1 2 3 4 5 6 7 8 9 10"];
  for (let i = 0; i < 12; i++) out.push(Array.from({ length: 1 + r.int(12) }, () => `${" ".repeat(r.int(3))}${r.next() >> BigInt(r.int(60))}`).join(" "));
  return out;
}
const numbers = (s: string): bigint[] => s.split(" ").filter(Boolean).map(BigInt);

function test(t: Task, arm: "library" | "alone", bytes: Uint8Array, seed: bigint): Failure[] {
  const l = linkFor(slotFor(t, arm), bytes);
  if ("error" in l) return [{ name: "link", detail: l.error, holdout: false }];
  const out: Failure[] = [];
  const fsImage = linkFor(bySlot.get("fs")!, bytesOf(built("fs")!.hex));
  if ("error" in fsImage) throw new Error(fsImage.error);
  const run = (text: string, holdout: boolean) => {
    const want = total(numbers(text));
    const input = enc.encode(text);
    const r = t.id === "sum"
      ? invoke(l.image, "app.sum", [Uint8Array.from([...input, 0]), BigInt(input.length), new Uint8Array(24)])
      : invoke(l.image, "app.filesum", [enc.encode("data"), 4n, new Uint8Array(24)], { disk: buildDisk(fsImage.image, { data: input }) });
    const got = r.value === null ? null : new TextDecoder().decode(r.buffers.get(2)!.subarray(0, Number(r.value)));
    if (got !== want) out.push({ name: holdout ? "hidden case" : `input ${JSON.stringify(text)}`, detail: `gave ${JSON.stringify(got)}${r.trap ? ` (${r.trap})` : ""}, expected ${JSON.stringify(want)}`, holdout });
  };
  for (const c of cases(1n).slice(0, 7)) run(c, false);
  if (!out.length) for (const c of cases(seed)) run(c, true);
  if (t.id === "filesum" && !out.length) {
    const r = invoke(l.image, "app.filesum", [enc.encode("nope"), 4n, new Uint8Array(24)], { disk: buildDisk(fsImage.image, {}) });
    if (r.value !== 0n) out.push({ name: "missing file", detail: `returned ${r.value}, expected 0`, holdout: false });
  }
  return out;
}

/** Calls into imports, read from the bytes. */
function callEdges(bytes: Uint8Array): number {
  const p = parseModule(bytes);
  if (!p.ok) return 0;
  const first = p.module.functions.length;
  const dv = new DataView(p.module.body.buffer, p.module.body.byteOffset, p.module.body.byteLength);
  const seen = new Set<number>();
  for (let at = 0; at < p.module.body.length; at += 16) if (dv.getUint32(at, true) === Op.CALL && dv.getUint32(at + 8, true) >= first) seen.add(dv.getUint32(at + 8, true));
  return seen.size;
}

setBuildDir(arg("dir"));
const out = arg("out");
const n = Number(arg("n", "10"));
const parallel = Number(arg("parallel", "3"));
const seed = privateSeed();
const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l) as { task: string; arm: string; index: number }; return `${r.task}/${r.arm}/${r.index}`; }) : []);
const jobs = Array.from({ length: n }, (_, index) => TASKS.flatMap((t) => (["library", "alone"] as const).map((arm) => ({ t, arm, index })))).flat().filter((j) => !done.has(`${j.t.id}/${j.arm}/${j.index}`));
for (const need of ["str", "fmt", "parse-dec", "fs"]) if (!built(need)) throw new Error(`${need} is not built`);
void programFiles;
let next = 0;
await Promise.all(Array.from({ length: parallel }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++]!;
    const started = Date.now();
    const r = await generate({ features: j.t.features }, prompt(j.t, j.arm), (bytes) => test(j.t, j.arm, bytes, seed), { model: "gpt-6.1-sol", effort: "medium" });
    const p = r.bytes ? parseModule(r.bytes) : null;
    appendFileSync(out, `${JSON.stringify({ kind: "gate-c/1", task: j.t.id, arm: j.arm, index: j.index, passed: !!r.bytes && r.audit.length === 0, outputTokens: r.outputTokens, submissions: r.submissions, hungCalls: r.hungCalls, records: p?.ok ? p.module.recordCount : null, callEdges: r.bytes ? callEdges(r.bytes) : 0, audit: r.audit, last: r.bytes ? null : r.last.slice(0, 200), ms: Date.now() - started, at: new Date().toISOString() })}\n`);
    console.log(`${j.t.id}/${j.arm} #${j.index}: ${r.bytes ? "pass" : "fail"} ${r.outputTokens} tokens`);
  }
}));
