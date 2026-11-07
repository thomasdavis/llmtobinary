// Gate D (docs/os-evidence/gate-d-prereg.md): does a model benefit from choosing its own imports?
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/gate-d.ts --out <file.jsonl> --cache <dir> [--n 5] [--parallel 3]
//   node --experimental-transform-types --no-warnings tools/research-cli/src/gate-d.ts --out <file.jsonl> --report
//
// The library is the live production registry, read over HTTP and checked against its hashes. The
// tools and the linking are the site's own code. No task text names a package.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogAccess, eligibleCatalog, renderIndex, type LibraryEntry, type LibraryFunction } from "@llmtobinary/link/library";
import { objectId } from "@llmtobinary/registry";
import { validateBytes } from "@llmtobinary/validate";
import { invoke, privateSeed, rng, type Failure } from "./os-tests.ts";
import { generate } from "./os-lib.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const REGISTRY = "https://llmtobinary.com";
const FEATURES = 3; // Heap and terminal, as a program inside the OS gets.
const M = (1n << 64n) - 1n;
const MODEL = "gpt-6.1-sol";
const FUEL = 50_000_000;

const digits = (n: bigint): number[] => [...n.toString()].map((c) => c.charCodeAt(0));
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const lcm = (a: bigint, b: bigint): bigint => (a / gcd(a, b)) * b;
function isqrt(n: bigint): bigint {
  let r = 0n;
  while ((r + 1n) * (r + 1n) <= n) r++;
  return r;
}
function fnv(bytes: number[]): bigint {
  let h = 14695981039346656037n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 1099511628211n) & M;
  return h;
}
function crc8(bytes: number[]): bigint {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 7) & 255 : (c << 1) & 255;
  }
  return BigInt(c);
}
function collatz(n: bigint): bigint {
  let steps = 0n;
  while (n !== 1n) {
    n = n % 2n ? 3n * n + 1n : n / 2n;
    steps++;
  }
  return steps;
}
const popcount = (n: bigint): bigint => BigInt(n.toString(2).replace(/0/g, "").length);

interface Task {
  id: string;
  kind: "reuse" | "control";
  arity: number;
  text: string;
  oracle: (a: bigint[]) => bigint;
  visible: bigint[][];
  holdout: (next: () => bigint, int: (n: number) => number) => bigint[];
}

const DECIMAL = "Write n in decimal as ASCII characters, with no leading zeros, and 0 as the single character 0.";
const TASKS: Task[] = [
  { id: "lcm3", kind: "reuse", arity: 3, text: "The inputs are three numbers a, b and c, each from 1 to 1048575. Return their least common multiple.", oracle: ([a, b, c]) => lcm(lcm(a!, b!), c!), visible: [[1n, 1n, 1n], [2n, 3n, 4n], [6n, 10n, 15n], [7n, 7n, 7n], [1048575n, 1048574n, 1n], [12n, 18n, 24n]], holdout: (_, int) => [BigInt(1 + int(1048575)), BigInt(1 + int(1048575)), BigInt(1 + int(1048575))] },
  { id: "isqrt-sum", kind: "reuse", arity: 1, text: "The input is a number n from 0 to 3000. Return the sum of floor(sqrt(i)) for every i from 1 to n.", oracle: ([n]) => { let s = 0n; for (let i = 1n; i <= n!; i++) s += isqrt(i); return s; }, visible: [[0n], [1n], [3n], [4n], [100n], [3000n]], holdout: (_, int) => [BigInt(int(3001))] },
  { id: "digest", kind: "reuse", arity: 1, text: `The input is a number n. ${DECIMAL} Return the 64-bit FNV-1a hash of those characters: start at 14695981039346656037, and for each byte xor it in, then multiply by 1099511628211, wrapping.`, oracle: ([n]) => fnv(digits(n!)), visible: [[0n], [7n], [10n], [12345n], [M], [1000000n]], holdout: (next) => [next()] },
  { id: "crc-sorted", kind: "reuse", arity: 1, text: `The input is a number n. ${DECIMAL} Sort those characters into ascending order. Return their CRC-8, with polynomial 0x07, initial value 0, no reflection and no final xor.`, oracle: ([n]) => crc8(digits(n!).sort((a, b) => a - b)), visible: [[0n], [9n], [21n], [3141592653n], [M], [1000n]], holdout: (next) => [next()] },
  { id: "collatz", kind: "control", arity: 1, text: "The input is a number n from 1 to 4294967295. Return how many steps it takes to reach 1, where a step halves an even number and turns an odd number x into 3x + 1.", oracle: ([n]) => collatz(n!), visible: [[1n], [2n], [3n], [6n], [27n], [97n]], holdout: (_, int) => [BigInt(1 + int(1 << 30))] },
  { id: "popcount-xor", kind: "control", arity: 2, text: "The inputs are two numbers a and b. Return how many 1 bits a XOR b has.", oracle: ([a, b]) => popcount(a! ^ b!), visible: [[0n, 0n], [1n, 0n], [255n, 0n], [M, 0n], [M, M], [5n, 3n]], holdout: (next) => [next(), next()] },
];

function judge(t: Task, bytes: Uint8Array, seed: bigint): Failure[] {
  const v = validateBytes(bytes);
  if (!v.ok || !v.module) return [{ name: "validate", detail: "the file is not valid", holdout: false }];
  const image = { module: v.module, exportMap: { main: v.module.entry } };
  const out: Failure[] = [];
  const one = (args: bigint[], holdout: boolean): void => {
    const want = t.oracle(args);
    const got = invoke(image, "main", args, { fuel: FUEL });
    if (got.value !== want) out.push({ name: `(${args.join(", ")})`, detail: holdout ? "a held-out input gave the wrong result" : `expected ${want}, got ${got.value ?? `no result (${got.trap ?? got.status})`}`, holdout });
  };
  for (const a of t.visible) one(a, false);
  if (out.length) return out;
  const r = rng(seed ^ BigInt(TASKS.indexOf(t) + 1));
  for (let i = 0; i < 40; i++) one(t.holdout(r.next, r.int), true);
  return out;
}

async function loadCatalog(cache: string): Promise<{ catalog: LibraryEntry[]; bytes: Map<string, Uint8Array> }> {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, "slots.json");
  if (!existsSync(file)) writeFileSync(file, await (await fetch(`${REGISTRY}/api/slots`)).text());
  const { slots } = JSON.parse(readFileSync(file, "utf8")) as { slots: { id: string; title: string; kind: string; features: number; depends: string; interface: string; winner: { object_id: string; evidence_class: string } | null }[] };
  const all: LibraryEntry[] = slots.filter((s) => s.kind === "library" && s.winner).map((s) => ({ slot: s.id, title: s.title, objectId: s.winner!.object_id, evidence: s.winner!.evidence_class, features: s.features, depends: JSON.parse(s.depends) as string[], functions: JSON.parse(s.interface) as LibraryFunction[] }));
  const catalog = eligibleCatalog(all, FEATURES);
  const bytes = new Map<string, Uint8Array>();
  for (const e of catalog) {
    const path = join(cache, e.objectId.slice(7));
    if (!existsSync(path)) writeFileSync(path, new Uint8Array(await (await fetch(`${REGISTRY}/api/registry/${e.objectId}/bytes`)).arrayBuffer()));
    const b = new Uint8Array(readFileSync(path));
    if ((await objectId(b)) !== e.objectId) throw new Error(`${e.slot}: bytes do not match their ID`);
    bytes.set(e.objectId, b);
  }
  return { catalog, bytes };
}

interface Row {
  kind: "gate-d/1";
  task: string;
  taskKind: Task["kind"];
  arm: "search" | "alone";
  index: number;
  passed: boolean;
  outputTokens: number;
  turns: number;
  submissions: number;
  libraryCalls: number;
  uses: string[];
  packages: string[];
  ownRecords: number | null;
  hungCalls: number;
  ms: number;
  sessionId: string;
  last: string;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function report(rows: Row[]): void {
  const of = (arm: string, kind?: string) => rows.filter((r) => r.arm === arm && (!kind || r.taskKind === kind));
  const passes = (x: Row[]) => x.filter((r) => r.passed);
  const line = (label: string, x: Row[]) => console.log(`${label.padEnd(26)} ${passes(x).length}/${x.length} passed, median output tokens ${median(passes(x).map((r) => r.outputTokens))}, median turns ${median(passes(x).map((r) => r.turns))}, median own records ${median(passes(x).map((r) => r.ownRecords ?? 0))}`);
  for (const t of TASKS) for (const arm of ["search", "alone"]) line(`${t.id}/${arm}`, rows.filter((r) => r.task === t.id && r.arm === arm));
  console.log("");
  for (const arm of ["search", "alone"]) {
    line(`${arm} reuse tasks`, of(arm, "reuse"));
    line(`${arm} control tasks`, of(arm, "control"));
    line(`${arm} all`, of(arm));
  }
  const sReuse = of("search", "reuse");
  const aReuse = of("alone", "reuse");
  const sPass = passes(sReuse);
  const edges = sPass.filter((r) => r.uses.length > 0).length;
  const p1 = sPass.length > 0 && edges * 2 >= sPass.length;
  const sTok = median(sPass.map((r) => r.outputTokens));
  const aTok = median(passes(aReuse).map((r) => r.outputTokens));
  const higher = passes(sReuse).length / Math.max(sReuse.length, 1) > passes(aReuse).length / Math.max(aReuse.length, 1);
  const cheaper = sTok !== null && aTok !== null && sTok <= aTok * 0.75;
  const p2 = higher || cheaper;
  const p3 = passes(of("search")).length >= passes(of("alone")).length - 3;
  const controls = passes(of("search", "control"));
  console.log(`\nP1 real reuse: ${edges} of ${sPass.length} passing search sessions on reuse tasks call an import: ${p1 ? "PASS" : "FAIL"}`);
  console.log(`P2 benefit: success ${passes(sReuse).length}/${sReuse.length} against ${passes(aReuse).length}/${aReuse.length}; median tokens ${sTok} against ${aTok}: ${p2 ? "PASS" : "FAIL"}`);
  console.log(`P3 no harm: ${passes(of("search")).length} against ${passes(of("alone")).length} across all sessions: ${p3 ? "PASS" : "FAIL"}`);
  console.log(`Controls: ${controls.filter((r) => r.uses.length).length} of ${controls.length} passing control sessions imported something.`);
  console.log(`\nDECISION: ${p1 && p2 && p3 ? "release" : "do not release"}`);
}

const out = arg("out");
const read = (): Row[] => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []);

if (process.argv.includes("--report")) {
  report(read());
} else {
  const n = Number(arg("n", "5"));
  const parallel = Number(arg("parallel", "3"));
  const { catalog, bytes } = await loadCatalog(arg("cache"));
  console.log(`library: ${catalog.length} packages, ${catalog.reduce((k, e) => k + e.functions.length, 0)} functions`);
  const access = catalogAccess(catalog, async (id) => bytes.get(id) ?? null, FEATURES);
  const index = renderIndex(catalog);
  const seed = privateSeed();
  const done = new Set(read().map((r) => `${r.task}/${r.arm}/${r.index}`));
  const jobs = Array.from({ length: n }, (_, index) => TASKS.flatMap((t) => (["search", "alone"] as const).map((arm) => ({ t, arm, index })))).flat().filter((j) => !done.has(`${j.t.id}/${j.arm}/${j.index}`));
  let next = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      const started = Date.now();
      const r = await generate({ features: FEATURES }, j.t.text, (b) => judge(j.t, b, seed), { model: MODEL, effort: "medium", signature: { params: Array.from({ length: j.t.arity }, () => "u64" as const), returns: "u64" }, plain: j.arm === "alone", ...(j.arm === "search" ? { library: { access, index } } : {}) });
      const row: Row = { kind: "gate-d/1", task: j.t.id, taskKind: j.t.kind, arm: j.arm, index: j.index, passed: !!r.bytes && r.audit.length === 0, outputTokens: r.outputTokens, turns: r.turns, submissions: r.submissions, libraryCalls: r.libraryCalls, uses: r.uses, packages: r.packages, ownRecords: r.ownRecords, hungCalls: r.hungCalls, ms: Date.now() - started, sessionId: r.sessionId, last: r.last.slice(0, 300) };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(`${j.t.id}/${j.arm} #${j.index}: ${row.passed ? "pass" : "fail"} ${row.outputTokens} tokens, ${row.turns} turns, uses [${row.uses.join(" ")}]`);
    }
  }));
  report(read());
}
