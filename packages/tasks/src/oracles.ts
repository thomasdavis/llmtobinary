// Independent task oracles (PRD Section 15.2): plain TypeScript/bigint implementations of each
// task's meaning. They never call either interpreter; agreement between two engines on a wrong
// program is not task correctness.

import { FRAMEBUFFER_HEIGHT, FRAMEBUFFER_WIDTH, U64_MASK } from "@llmtobinary/spec";
import { sha256HexSync } from "@llmtobinary/devices";
import type { TickEvent } from "@llmtobinary/protocol";
import type { TaskSpec, TestCase } from "./registry.ts";

export interface OracleOutcome {
  /** Canonical result: decimal u64, "true"/"false", or "unit". */
  result: string;
  terminal: string;
  framebufferHash?: string;
  /** Expected final framebuffer, for pixel-level diagnostics. */
  framebuffer?: Uint8Array;
  framesPresented?: number;
  /** True when the program is expected to still be waiting for input (never in curated tests). */
  waiting?: boolean;
}

const M = U64_MASK;
const W = FRAMEBUFFER_WIDTH;
const H = FRAMEBUFFER_HEIGHT;

function fbFill(fb: Uint8Array, rgba: number): void {
  for (let i = 0; i < fb.length; i += 4) {
    fb[i] = rgba >>> 24;
    fb[i + 1] = (rgba >>> 16) & 255;
    fb[i + 2] = (rgba >>> 8) & 255;
    fb[i + 3] = rgba & 255;
  }
}

function fbSet(fb: Uint8Array, x: number, y: number, rgba: number): void {
  const i = (y * W + x) * 4;
  fb[i] = rgba >>> 24;
  fb[i + 1] = (rgba >>> 16) & 255;
  fb[i + 2] = (rgba >>> 8) & 255;
  fb[i + 3] = rgba & 255;
}

export function capstoneOracle(x: bigint, K = 40, stride = 17): bigint {
  const v: bigint[] = [];
  for (let i = 0; i < K; i++) v.push((x + BigInt(i)) & M);
  let a = 0n;
  for (let j = 0; j < K; j++) a = ((a * 3n) & M) ^ v[(stride * j) % K]!;
  return a;
}

/** Literal transcription of upstream pressure_probe.py gen_c(K). */
export function ringMixOracle(x: bigint, K: number, iterations = 1000): bigint {
  const v: bigint[] = [];
  for (let i = 0; i < K; i++) v.push((x + BigInt(i)) & M);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < K; i++) {
      v[i] = (v[i]! + ((v[(i + 1) % K]! * 3n) & M)) & M;
      v[i] = v[i]! ^ v[(i + 2) % K]!;
    }
  }
  return v.reduce((a, b) => a ^ b, 0n);
}

export function fizzbuzzOracle(n: bigint): string {
  let out = "";
  for (let i = 1n; i <= n; i++) out += i % 15n === 0n ? "FizzBuzz\n" : i % 3n === 0n ? "Fizz\n" : i % 5n === 0n ? "Buzz\n" : `${i}\n`;
  return out;
}

export function fibOracle(n: bigint): bigint {
  let a = 0n;
  let b = 1n;
  for (let i = 0n; i < n; i++) [a, b] = [b, (a + b) & M];
  return a;
}

export function checkerboardFramebuffer(): Uint8Array {
  const fb = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fbSet(fb, x, y, ((x >> 4) ^ (y >> 4)) & 1 ? 0xe4e7ebff : 0x1f2933ff);
  return fb;
}

export function ballPaddleOracle(ticks: readonly TickEvent[]): OracleOutcome {
  const fb = new Uint8Array(W * H * 4);
  let bx = 128, by = 20, dx = 1, dy = 1, px = 116, score = 0, n = 0, frames = 0;
  const done = () => ({ result: String(score), terminal: "", framebufferHash: sha256HexSync(fb), framebuffer: fb.slice(), framesPresented: frames });
  for (const t of ticks) {
    const keys = t.keys;
    if ((keys >> 6) & 1) return done();
    if (keys & 1 && px >= 4) px -= 4;
    if ((keys >> 1) & 1 && px <= 228) px += 4;
    const nx = bx + dx;
    if (nx === 0 || nx === 254) dx = -dx;
    const ny = by + dy;
    if (ny === 140) {
      if (px <= nx && nx < px + 24) {
        dy = -1;
        score++;
        bx = nx;
        by = ny;
      } else {
        bx = 128;
        by = 20;
        dy = 1;
      }
    } else {
      if (ny === 0) dy = 1;
      bx = nx;
      by = ny;
    }
    fbFill(fb, 0x000000ff);
    for (let i = 0; i < 24; i++) {
      fbSet(fb, px + i, 142, 0xffffffff);
      fbSet(fb, px + i, 143, 0xffffffff);
    }
    for (const [x, y] of [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]] as const) fbSet(fb, x, y, 0xffd166ff);
    frames++;
    n++;
    if (n >= 600) return done();
  }
  return { ...done(), waiting: true };
}

/** Evaluate a curated task's oracle on one test case. */
export function oracleFor(task: TaskSpec, c: TestCase): OracleOutcome {
  const arg = (i: number) => BigInt(c.inputs[i]!);
  const id = task.id;
  if (id === "return-42") return { result: "42", terminal: "" };
  if (id === "square-plus-two") {
    const r = (arg(0) * arg(0) + 2n) & M;
    return { result: r.toString(), terminal: r.toString() };
  }
  if (id === "hello") return { result: "unit", terminal: "Hello, world!\n" };
  if (id === "fizzbuzz") return { result: "unit", terminal: fizzbuzzOracle(arg(0)) };
  if (id === "fibonacci") return { result: fibOracle(arg(0)).toString(), terminal: "" };
  if (id === "checkerboard") {
    const fb = checkerboardFramebuffer();
    return { result: "unit", terminal: "", framebufferHash: sha256HexSync(fb), framebuffer: fb, framesPresented: 1 };
  }
  if (id === "ball-paddle") return ballPaddleOracle(c.ticks ?? []);
  if (id === "capstone-40" || id === "capstone-40-unrestricted") return { result: capstoneOracle(arg(0)).toString(), terminal: "" };
  let m = /^capstone-k(\d+)$/.exec(id);
  if (m) return { result: capstoneOracle(arg(0), Number(m[1]), task.pressure?.stride ?? 17).toString(), terminal: "" };
  m = /^ring-mix-k(\d+)$/.exec(id);
  if (m) return { result: ringMixOracle(arg(0), Number(m[1])).toString(), terminal: "" };
  throw new Error(`no oracle for task ${id}`);
}

// ---------------------------------------------------------------------------
// Seeded holdout generation (xorshift64*); the seed is recorded in the registry.

export function* xorshift64star(seed: bigint): Generator<bigint> {
  let s = seed & M || 0x9e3779b97f4a7c15n;
  while (true) {
    s ^= s >> 12n;
    s ^= (s << 25n) & M;
    s ^= s >> 27n;
    yield (s * 0x2545f4914f6cdd1dn) & M;
  }
}

export function holdoutCases(task: TaskSpec): TestCase[] {
  const h = task.holdout;
  const out: TestCase[] = [...h.include];
  if (h.kind === "none" || h.count === 0) return out;
  const g = xorshift64star(BigInt(h.seed));
  for (let i = 0; i < h.count; i++) {
    const r = g.next().value as bigint;
    let v: bigint;
    switch (h.kind) {
      case "u64":
        v = i % 3 === 0 ? r : i % 3 === 1 ? r & 0xffffn : (r & 0xffffffffn) + 0xffff0000n;
        break;
      case "small":
        v = r % 1000n;
        break;
      case "fizzbuzz":
        v = r % 200n;
        break;
      case "fib":
        v = r % 21n;
        break;
    }
    out.push({ name: `holdout #${i} (seed ${h.seed})`, inputs: [v.toString()] });
  }
  return out;
}
