// Judges OS packages. Oracles are written from the slot text, before any bytes exist. Holdouts come
// from a private seed, so a model can neither read them nor tailor a program to them.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Feature, Feature2 } from "@llmtobinary/spec";
import { GenStatus, OsMachine, SECTOR_BYTES, type GenProvider } from "@llmtobinary/os";
import type { Heap } from "@llmtobinary/devices";
import type { RuntimeValue } from "@llmtobinary/protocol";
import type { Module } from "@llmtobinary/validate";
import { VISIBLE, type Arg, type OsCall } from "../../../os/slots.ts";
import { LIBRARY, ORACLES } from "../../../os/library.ts";

export const DISK_SECTORS = 129;
export const ALL = Feature.HEAP | Feature.TERMINAL | Feature2.TEXT | Feature2.BLOCK | Feature2.TASKS;
const BUF = 4608;
const enc = new TextEncoder();
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface Image {
  module: Module;
  exportMap: Record<string, number>;
}

export interface CallResult {
  value: bigint | null;
  status: string;
  trap: string | null;
  buffers: Map<number, Uint8Array>;
  terminal: string;
  disk: Uint8Array;
}

export function invoke(img: Image, symbol: string, args: Arg[], opts: { disk?: Uint8Array; keys?: number[]; fuel?: number; gen?: GenProvider } = {}): CallResult {
  const fn = img.exportMap[symbol];
  if (fn === undefined) throw new Error(`no export ${symbol}`);
  const handles = new Map<number, { h: RuntimeValue; length: number }>();
  const build = (heap: Heap): RuntimeValue[] =>
    args.map((a, i) => {
      if (typeof a === "bigint") return a;
      const r = heap.alloc("u8", BigInt(a.length));
      if (!r.ok) throw new Error("alloc failed");
      a.forEach((b, k) => heap.store("u8", r.value, BigInt(k), BigInt(b)));
      handles.set(i, { h: r.value, length: a.length });
      return r.value;
    });
  const m = new OsMachine({ kernel: img.module, disk: opts.disk ?? new Uint8Array(DISK_SECTORS * SECTOR_BYTES), keys: opts.keys ?? [], fuel: opts.fuel ?? 3_000_000, features: opts.gen ? ALL | Feature2.GEN : ALL, ...(opts.gen ? { gen: opts.gen } : {}), call: { fn, args: build } });
  const status = m.run();
  const r = m.result();
  const buffers = new Map<number, Uint8Array>();
  for (const [i, { h, length }] of handles) buffers.set(i, m.buffer(h, length));
  return { value: r.returnValue?.t === "u64" ? BigInt(r.returnValue.v) : null, status, trap: r.trap?.code ?? null, buffers, terminal: m.terminal(), disk: m.disk };
}

export interface Failure {
  name: string;
  detail: string;
  holdout: boolean;
}

/** When set, every observable output is captured, so two verifiers can compare runs bit for bit. */
let recording: unknown[] | null = null;
export function recordOutputs<T>(fn: () => T): { result: T; outputs: unknown[] } {
  recording = [];
  try {
    const result = fn();
    return { result, outputs: recording };
  } finally {
    recording = null;
  }
}

function checkCall(img: Image, c: OsCall, holdout: boolean, out: Failure[], disk?: Uint8Array): CallResult | null {
  const name = `${c.symbol}(${c.args.map((a) => (typeof a === "bigint" ? a.toString() : `<${a.length} bytes>`)).join(", ")})`;
  let r: CallResult;
  try {
    r = invoke(img, c.symbol, c.args, { ...(disk ? { disk } : {}), ...(c.keys ? { keys: c.keys } : {}) });
  } catch (e) {
    out.push({ name, detail: (e as Error).message, holdout });
    return null;
  }
  recording?.push([name, r.status, r.trap, r.value?.toString() ?? null, r.terminal, [...r.buffers.entries()].map(([i, b]) => [i, hexOf(b)])]);
  if (r.status !== "halted") out.push({ name, detail: `did not finish: ${r.status}${r.trap ? ` (${r.trap})` : ""}`, holdout });
  else {
    if (c.want !== undefined && r.value !== c.want) out.push({ name, detail: `returned ${r.value}, expected ${c.want}`, holdout });
    if (c.terminal !== undefined && r.terminal !== c.terminal) out.push({ name, detail: `printed ${JSON.stringify(r.terminal)}, expected ${JSON.stringify(c.terminal)}`, holdout });
    for (const [i, want] of Object.entries(c.buffers ?? {})) {
      const got = r.buffers.get(Number(i));
      if (!got || hexOf(got) !== hexOf(want)) out.push({ name, detail: `argument ${i} holds ${got ? hexOf(got).slice(0, 80) : "nothing"}, expected ${hexOf(want).slice(0, 80)}`, holdout });
    }
  }
  return r;
}

/** Small deterministic generator, so a seed fixes every holdout. */
export function rng(seed: bigint) {
  const M = (1n << 64n) - 1n;
  let x = seed & M || 88172645463325252n;
  const next = (): bigint => {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    return x;
  };
  return { next, int: (n: number): number => Number(next() % BigInt(n)) };
}

export function privateSeed(): bigint {
  const p = process.env.OS_HOLDOUT_SEED_FILE ?? `${homedir()}/.config/llmtobinary/os-holdout-seed`;
  return BigInt(`0x${readFileSync(p, "utf8").trim()}`);
}

function strHoldouts(seed: bigint): OsCall[] {
  const r = rng(seed);
  const out: OsCall[] = [];
  for (let i = 0; i < 40; i++) {
    const len = 4 + r.int(30);
    const a = Uint8Array.from({ length: len }, () => (r.int(3) === 0 ? 32 : 97 + r.int(3)));
    const b = a.slice();
    if (r.int(2)) b[r.int(len)] = 122;
    const n = r.int(len + 1);
    const start = r.int(len);
    let eq = 1n;
    for (let k = 0; k < n; k++) if (a[k] !== b[k]) eq = 0n;
    let we = start;
    while (we < len && a[we] !== 32) we++;
    let ss = start;
    while (ss < len && a[ss] === 32) ss++;
    out.push({ symbol: "str.eq", args: [a, 0n, b, 0n, BigInt(n)], want: eq });
    out.push({ symbol: "str.word_end", args: [a, BigInt(start), BigInt(len)], want: BigInt(we) });
    out.push({ symbol: "str.skip_spaces", args: [a, BigInt(start), BigInt(len)], want: BigInt(ss) });
    const dst = new Uint8Array(len);
    const want = dst.slice();
    want.set(a.subarray(0, n), 0);
    out.push({ symbol: "str.copy", args: [dst, 0n, a, 0n, BigInt(n)], buffers: { 0: want } });
  }
  return out;
}

function fmtHoldouts(seed: bigint): OsCall[] {
  const r = rng(seed ^ 0x5151n);
  return Array.from({ length: 40 }, () => {
    const v = r.next() >> BigInt(r.int(64));
    const at = r.int(4);
    const s = v.toString();
    const want = new Uint8Array(24);
    want.set(enc.encode(s), at);
    return { symbol: "fmt.dec", args: [new Uint8Array(24), BigInt(at), v], want: BigInt(s.length), buffers: { 0: want } };
  });
}

function lineHoldouts(seed: bigint): OsCall[] {
  const r = rng(seed ^ 0x7777n);
  return Array.from({ length: 30 }, () => {
    const cap = 3 + r.int(10);
    const keys: number[] = [];
    let line: number[] = [];
    let echo = "";
    for (let i = 0, n = r.int(20); i < n; i++) {
      const roll = r.int(6);
      const k = roll === 0 ? 8 : roll === 1 ? r.int(32) : 32 + r.int(95);
      if (k === 10) continue;
      keys.push(k);
      if (k === 8) {
        if (line.length) {
          line = line.slice(0, -1);
          echo += "\b \b";
        }
      } else if (k >= 32 && k <= 126 && line.length < cap - 1) {
        line.push(k);
        echo += String.fromCharCode(k);
      }
    }
    return { symbol: "line.read", args: [new Uint8Array(cap), BigInt(cap)], keys: [...keys, 10], want: BigInt(line.length), terminal: `${echo}\n` };
  });
}

/** Stateful test: random operations against a model of the file system. */
function fsScenario(img: Image, seed: bigint, holdout: boolean, out: Failure[]): void {
  const r = rng(seed ^ 0xf5n);
  let disk: Uint8Array = new Uint8Array(DISK_SECTORS * SECTOR_BYTES);
  const model = new Map<string, { slot: number; data: Uint8Array }>();
  const mailbox = () => new Uint8Array(BUF);
  const step = (symbol: string, args: Arg[], want: bigint): CallResult | null => {
    const res = checkCall(img, { symbol, args, want }, holdout, out, disk);
    if (res) disk = res.disk;
    return res;
  };
  step("fs.format", [], undefined as never);
  const names = ["a", "boot", "readme", "x1", "sixteen-letters!"];
  const steps = holdout ? 30 : 8;
  for (let i = 0; i < steps && !out.length; i++) {
    const name = names[r.int(names.length)]!;
    const nb = enc.encode(name);
    if (r.int(3) !== 0) {
      const size = r.int(3) === 0 ? r.int(1200) : r.int(40);
      const data = Uint8Array.from({ length: size }, () => r.int(256));
      const src = mailbox();
      src.set(data);
      let slot = model.get(name)?.slot;
      if (slot === undefined) for (slot = 0; [...model.values()].some((m) => m.slot === slot); slot++);
      step("fs.write", [nb, 0n, BigInt(nb.length), src, BigInt(size)], BigInt(slot + 1));
      model.set(name, { slot, data });
    } else {
      const m = model.get(name);
      step("fs.find", [nb, 0n, BigInt(nb.length)], m ? BigInt(m.slot + 1) : 0n);
      if (m) {
        const res = step("fs.read", [BigInt(m.slot + 1), mailbox()], BigInt(m.data.length));
        if (res && hexOf(res.buffers.get(1)!.subarray(0, m.data.length)) !== hexOf(m.data)) out.push({ name: `fs.read of ${name}`, detail: "the bytes differ from what was written", holdout });
      }
    }
  }
  for (const [name, m] of model) {
    const res = checkCall(img, { symbol: "fs.name_at", args: [BigInt(m.slot), new Uint8Array(32)], want: BigInt(name.length) }, holdout, out, disk);
    if (res && new TextDecoder().decode(res.buffers.get(1)!.subarray(0, name.length)) !== name) out.push({ name: `fs.name_at ${m.slot}`, detail: "wrong name", holdout });
  }
  checkCall(img, { symbol: "fs.write", args: [enc.encode("x"), 0n, 0n, mailbox(), 1n], want: 0n }, holdout, out, disk);
  checkCall(img, { symbol: "fs.write", args: [enc.encode("x"), 0n, 1n, mailbox(), 4097n], want: 0n }, holdout, out, disk);
  checkCall(img, { symbol: "fs.write", args: [enc.encode("seventeen-letters"), 0n, 17n, mailbox(), 1n], want: 0n }, holdout, out, disk);
}

function libraryCalls(slot: string, seed: bigint | null): OsCall[] {
  const lib = LIBRARY.find((l) => l.id === slot);
  if (!lib) return [];
  const call = (symbol: string, c: { args: Arg[]; want: bigint | null; buffer?: { index: number; bytes: Uint8Array } }): OsCall => ({ symbol, args: c.args, ...(c.want !== null ? { want: c.want } : {}), ...(c.buffer ? { buffers: { [c.buffer.index]: c.buffer.bytes } } : {}) });
  if (seed === null) return lib.functions.flatMap((f) => f.examples.map((e) => call(f.symbol, e)));
  const r = rng(seed ^ 0x11bn);
  return lib.functions.flatMap((f) => Array.from({ length: 30 }, () => call(f.symbol, f.random(r.next, r.int))));
}

export function runLibraryTests(slot: string, img: Image, seed: bigint | null): Failure[] {
  const out: Failure[] = [];
  for (const c of libraryCalls(slot, null)) checkCall(img, c, false, out);
  for (const c of VISIBLE[slot] ?? []) checkCall(img, c, false, out);
  if (slot === "fs") fsScenario(img, 1n, false, out);
  if (seed === null || out.length) return out;
  const hold = slot === "cmd" || slot === "live" ? [] : slot === "str" ? strHoldouts(seed) : slot === "fmt" ? fmtHoldouts(seed) : slot === "line" ? lineHoldouts(seed) : libraryCalls(slot, seed);
  for (const c of hold) checkCall(img, c, true, out);
  if (slot === "fs") fsScenario(img, seed, true, out);
  return out;
}

/** What the model may see: visible failures in full, and only a count for holdouts. */
export function reportForModel(failures: Failure[]): string {
  const visible = failures.filter((f) => !f.holdout);
  const hidden = failures.length - visible.length;
  const lines = visible.slice(0, 8).map((f) => `${f.name}: ${f.detail}`);
  if (hidden) lines.push(`${hidden} hidden test(s) also failed. Their inputs are private.`);
  return lines.join("\n");
}

/** Builds a disk with these files on it, using the fs package under test. */
export function buildDisk(fs: Image, files: Record<string, Uint8Array>): Uint8Array {
  let disk: Uint8Array = invoke(fs, "fs.format", [], {}).disk;
  for (const [name, bytes] of Object.entries(files)) {
    const data = new Uint8Array(BUF);
    data.set(bytes);
    const n = enc.encode(name);
    const r = invoke(fs, "fs.write", [n, 0n, BigInt(n.length), data, BigInt(bytes.length)], { disk });
    disk = r.disk;
  }
  return disk;
}

export function runProcTests(img: Image, programs: Record<string, Uint8Array>): Failure[] {
  const out: Failure[] = [];
  const disk = buildDisk(img, { ...programs, junk: Uint8Array.from([1, 2, 3, 4]) });
  const run = (name: string, want: bigint, terminal?: string) => {
    const n = enc.encode(name);
    const padded = new Uint8Array(n.length + 3);
    padded.set(n, 3);
    checkCall(img, { symbol: "proc.run", args: [padded, 3n, BigInt(n.length)], want, ...(terminal !== undefined ? { terminal } : {}) }, false, out, disk);
  };
  run("hello", 0n, "hello from disk\n");
  run("crash", 3n);
  run("spin", 4n);
  run("missing", 1n);
  run("junk", 2n);
  return out;
}

export function keysFor(lines: string[]): number[] {
  return lines.flatMap((l) => [...enc.encode(l), 10]);
}

/** The expected transcript of a session: boot banner, then each typed line and its output. */
export function transcript(steps: [string, string][]): string {
  return `anma os\n${steps.map(([line, output]) => `> ${line}\n${output}`).join("")}`;
}

export interface Session {
  terminal: string;
  status: string;
  trap: string | null;
  disk: Uint8Array;
}

export function boot(kernel: Module, disk: Uint8Array, lines: string[], gen?: GenProvider): Session {
  const m = new OsMachine({ kernel, disk, keys: keysFor(lines), fuel: 40_000_000, ...(gen ? { gen } : {}) });
  const status = m.run();
  return { terminal: m.terminal(), status, trap: m.result().trap?.code ?? null, disk: m.disk };
}

export const DEMO_STEPS: [string, string][] = [
  ["ls", "hello\ncrash\nspin\n"],
  ["run hello", "hello from disk\nok\n"],
  ["run crash", "trapped\n"],
  ["ls", "hello\ncrash\nspin\n"],
  ["run spin", "out of fuel\n"],
  ["write note hi there", "ok\n"],
  ["cat note", "hi there\n"],
  ["run nothing", "not found\n"],
  ["nonsense", "?\n"],
  ["exit", ""],
];

export function runKernelTests(kernel: Module, disk: Uint8Array, seed: bigint | null): Failure[] {
  const out: Failure[] = [];
  const session = (name: string, startDisk: Uint8Array, steps: [string, string][], holdout: boolean): Session => {
    const s = boot(kernel, startDisk, steps.map(([l]) => l));
    recording?.push([name, s.status, s.trap, s.terminal, hexOf(s.disk)]);
    const want = transcript(steps);
    if (s.terminal !== want) {
      let at = 0;
      while (at < want.length && s.terminal[at] === want[at]) at++;
      out.push({ name, detail: `the transcript differs at character ${at}: got ${JSON.stringify(s.terminal.slice(Math.max(0, at - 20), at + 40))}, expected ${JSON.stringify(want.slice(Math.max(0, at - 20), at + 40))}`, holdout });
    }
    if (s.status !== "halted") out.push({ name, detail: `ended as ${s.status}${s.trap ? ` (${s.trap})` : ""}`, holdout });
    return s;
  };
  const first = session("demo session", disk, DEMO_STEPS, false);
  if (!out.length) session("after reboot", first.disk, [["cat note", "hi there\n"], ["exit", ""]], false);
  if (seed !== null && !out.length) {
    const r = rng(seed ^ 0xabcn);
    const steps: [string, string][] = [];
    const written = new Map<string, string>();
    for (let i = 0; i < 12; i++) {
      const name = `f${r.int(4)}`;
      if (r.int(2)) {
        const text = Array.from({ length: 1 + r.int(30) }, () => String.fromCharCode(97 + r.int(26))).join("");
        steps.push([`write ${name} ${text}`, "ok\n"]);
        written.set(name, text);
      } else steps.push([`cat ${name}`, written.has(name) ? `${written.get(name)}\n` : "not found\n"]);
    }
    session("private session", disk, [...steps, ["exit", ""]], true);
  }
  return out;
}

/** A provider that stays pending for `pending` polls, then delivers these bytes, or fails. */
export function fakeGen(bytes: Uint8Array | null, pending: number): GenProvider & { requests: string[] } {
  let polls = 0;
  const requests: string[] = [];
  return {
    requests,
    request(prompt) {
      requests.push(new TextDecoder().decode(prompt));
      return 7;
    },
    poll() {
      if (polls++ < pending) return { status: GenStatus.PENDING };
      return bytes ? { status: GenStatus.READY, bytes } : { status: GenStatus.FAILED };
    },
  };
}

/** Live generation: the program arrives mid-session, with no reboot, and the shell never waits. */
export function runLiveTests(kernel: Module, disk: Uint8Array, program: Uint8Array): Failure[] {
  const out: Failure[] = [];
  const check = (name: string, steps: [string, string][], gen: ReturnType<typeof fakeGen>, prompt?: string) => {
    const s = boot(kernel, disk, steps.map(([l]) => l), gen);
    const want = transcript(steps);
    if (s.terminal !== want || s.status !== "halted") {
      let at = 0;
      while (at < want.length && s.terminal[at] === want[at]) at++;
      out.push({ name, detail: `ended ${s.status}; differs at ${at}: got ${JSON.stringify(s.terminal.slice(Math.max(0, at - 24), at + 40))}, expected ${JSON.stringify(want.slice(Math.max(0, at - 24), at + 40))}`, holdout: false });
    }
    if (prompt !== undefined && gen.requests[0] !== prompt) out.push({ name, detail: `requested ${JSON.stringify(gen.requests[0])}, expected ${JSON.stringify(prompt)}`, holdout: false });
  };
  // Each prompt polls once. The job stays pending through two commands, so the shell must not wait.
  check("program arrives mid-session", [
    ["gen tool print a greeting", "started\n"],
    ["ls", "hello\ncrash\nspin\n"],
    ["cat missing", "not found\ngenerated tool\n"],
    ["run tool", "hello from disk\nok\n"],
    ["exit", ""],
  ], fakeGen(program, 2), "print a greeting");
  check("a failed generation leaves the shell running", [
    ["gen tool anything", "started\ngeneration failed\n"],
    ["ls", "hello\ncrash\nspin\n"],
    ["exit", ""],
  ], fakeGen(null, 0));
  check("a second job is refused", [
    ["gen a one", "started\n"],
    ["gen b two", "busy\n"],
    ["exit", ""],
  ], fakeGen(program, 99));
  return out;
}

/** cmd: each command against a real disk. */
export function runCmdTests(img: Image, programs: Record<string, Uint8Array>): Failure[] {
  const out: Failure[] = [];
  const disk = buildDisk(img, programs);
  const line = (t: string): [Uint8Array, bigint] => {
    const b = new Uint8Array(t.length + 2);
    b.set(enc.encode(t));
    return [b, BigInt(t.length)];
  };
  for (const [t, want] of [["", 0n], ["   ", 0n], ["ls", 1n], ["cat x", 2n], ["write a b", 3n], ["run hello", 4n], ["format", 5n], ["exit", 6n], ["gen a b", 7n], ["nonsense", 8n], ["lsx", 8n], ["  ls", 1n]] as [string, bigint][]) checkCall(img, { symbol: "cmd.word", args: line(t), want }, false, out, disk);
  checkCall(img, { symbol: "cmd.ls", args: [], terminal: `${Object.keys(programs).join("\n")}\n` }, false, out, disk);
  checkCall(img, { symbol: "cmd.cat", args: line("cat missing"), want: 1n }, false, out, disk);
  const w = checkCall(img, { symbol: "cmd.write", args: line("write note hi there"), want: 0n }, false, out, disk);
  if (w) checkCall(img, { symbol: "cmd.cat", args: line("cat note"), want: 0n, terminal: "hi there\n" }, false, out, w.disk);
  checkCall(img, { symbol: "cmd.run", args: line("run hello"), want: 0n, terminal: "hello from disk\n" }, false, out, disk);
  checkCall(img, { symbol: "cmd.run", args: line("run nothing"), want: 1n }, false, out, disk);
  checkCall(img, { symbol: "cmd.run", args: line("run crash"), want: 3n }, false, out, disk);
  return out;
}

/** live: start and poll across calls, carrying the state buffer between them. */
export function runLiveLibraryTests(img: Image, program: Uint8Array): Failure[] {
  const out: Failure[] = [];
  const fail = (name: string, detail: string) => out.push({ name, detail, holdout: false });
  const disk = buildDisk(img, {});
  const line = enc.encode("gen tool a program");
  const gen = fakeGen(program, 1);
  let state = new Uint8Array(64);
  const r0 = invoke(img, "live.start", [state, line, BigInt(line.length)], { disk, gen });
  if (r0.value !== 0n) fail("live.start", `returned ${r0.value}${r0.trap ? ` (${r0.trap})` : ""}, expected 0`);
  if (gen.requests[0] !== "a program") fail("live.start", `requested ${JSON.stringify(gen.requests[0])}, expected "a program"`);
  state = r0.buffers.get(0) as Uint8Array<ArrayBuffer>;
  const busy = invoke(img, "live.start", [state, line, BigInt(line.length)], { disk, gen });
  if (busy.value !== 1n) fail("live.start", `a second job returned ${busy.value}, expected 1`);
  const p1 = invoke(img, "live.poll", [state], { disk, gen });
  if (p1.value !== 0n) fail("live.poll", `a pending job returned ${p1.value}, expected 0`);
  const p2 = invoke(img, "live.poll", [state], { disk, gen });
  if (p2.value !== 1n) fail("live.poll", `a ready job returned ${p2.value}${p2.trap ? ` (${p2.trap})` : ""}, expected 1`);
  const name = invoke(img, "live.print_name", [p2.buffers.get(0) ?? state], { disk, gen });
  if (name.terminal !== "tool") fail("live.print_name", `printed ${JSON.stringify(name.terminal)}, expected "tool"`);
  const n = enc.encode("tool");
  const f = invoke(img, "fs.find", [n, 0n, 4n], { disk: p2.disk });
  if (!f.value) fail("live.poll", "the program was not saved to disk");
  else {
    const rd = invoke(img, "fs.read", [f.value, new Uint8Array(4608)], { disk: p2.disk });
    if (rd.value !== BigInt(program.length)) fail("live.poll", `saved ${rd.value} bytes, expected ${program.length}`);
  }
  const bad = fakeGen(null, 0);
  const s0 = invoke(img, "live.start", [new Uint8Array(64), line, BigInt(line.length)], { disk, gen: bad });
  const pf = invoke(img, "live.poll", [s0.buffers.get(0) as Uint8Array<ArrayBuffer>], { disk, gen: bad });
  if (pf.value !== 2n) fail("live.poll", `a failed job returned ${pf.value}, expected 2`);
  return out;
}

export interface Claim {
  symbol: string;
  args: (string | number[])[];
}

export type ClaimVerdict = { status: "confirmed"; got: string; want: string } | { status: "rejected"; reason: string };

const badInput = (reason: string): ClaimVerdict => ({ status: "rejected", reason });

/**
 * Judges a "Break this package" claim. The claimant never states the answer: the oracle does, so a
 * claim is confirmed only if the package disagrees with the oracle on that input.
 */
export function judgeClaim(img: Image, raw: string): ClaimVerdict {
  let c: Claim;
  try {
    c = JSON.parse(raw) as Claim;
  } catch {
    return badInput("the input is not JSON");
  }
  if (typeof c?.symbol !== "string" || !Array.isArray(c.args) || c.args.length > 8) return badInput("the input needs a symbol and args");
  const oracle = ORACLES[c.symbol];
  if (!oracle || img.exportMap[c.symbol] === undefined) return badInput("this function has no oracle");
  let args: Arg[];
  try {
    args = c.args.map((a) => {
      if (typeof a === "string") return BigInt(a);
      if (Array.isArray(a) && a.length <= 4096 && a.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return Uint8Array.from(a);
      throw new Error("bad argument");
    });
  } catch {
    return badInput("an argument is not a u64 string or a byte list");
  }
  const want = oracle(args);
  const r = invoke(img, c.symbol, args, { fuel: 2_000_000 });
  const got = r.status === "halted" ? (r.value?.toString() ?? "unit") : `trap ${r.trap ?? r.status}`;
  return got === String(want) ? { status: "rejected", reason: "the package agrees with the oracle" } : { status: "confirmed", got, want: String(want) };
}
