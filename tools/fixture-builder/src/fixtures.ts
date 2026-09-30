// Developer fixture definitions (tool-created, not model output). Each is independently checked
// against a plain-TypeScript oracle in packages/tasks.

import { Feature } from "@llmtobinary/spec";
import { ModuleBuilder, type BlockBuilder, type V } from "./builder.ts";

const WHITE = 0xffffffffn;
const BLACK = 0x000000ffn;
const DARK = 0x1f2933ffn;
const LIGHT = 0xe4e7ebffn;

/** fn0() -> unit: print "Hello, world!\n" from the data section. */
export function hello(): Uint8Array {
  const mb = new ModuleBuilder();
  const off = mb.data("Hello, world!\n");
  const f = mb.func([], "unit");
  const b = f.block();
  b.host("terminal.print_utf8", [b.const(off), b.const(14)]);
  b.ret(null);
  return mb.build();
}

/** fn0(n: u64) -> unit: FizzBuzz 1..n, one line each. */
export function fizzbuzz(): Uint8Array {
  const mb = new ModuleBuilder();
  mb.data("FizzBuzz\n"); // Fizz=[0,4) Buzz=[4,8) "\n"=[8,9) FizzBuzz\n=[0,9)
  const f = mb.func(["u64"], "unit");
  const b0 = f.block();
  const loop = f.block(["u64", "u64"]);
  const body = f.block(["u64", "u64"]);
  const fb = f.block(["u64", "u64"]);
  const chk3 = f.block(["u64", "u64"]);
  const fizz = f.block(["u64", "u64"]);
  const chk5 = f.block(["u64", "u64"]);
  const buzz = f.block(["u64", "u64"]);
  const num = f.block(["u64", "u64"]);
  const next = f.block(["u64", "u64"]);
  const done = f.block([]);
  b0.jump(loop, [b0.const(1), b0.params[0]!]);
  {
    const [i, n] = loop.params as [V, V];
    loop.brIf(loop.le(i, n), body, [i, n], done, []);
  }
  const divides = (blk: BlockBuilder, k: number, yes: BlockBuilder, no: BlockBuilder) => {
    const [i, n] = blk.params as [V, V];
    blk.brIf(blk.eq(blk.urem(i, blk.const(k)), blk.const(0)), yes, [i, n], no, [i, n]);
  };
  divides(body, 15, fb, chk3);
  const print = (blk: BlockBuilder, off: number, len: number) => blk.host("terminal.print_utf8", [blk.const(off), blk.const(len)]);
  print(fb, 0, 9);
  fb.jump(next, [...fb.params]);
  divides(chk3, 3, fizz, chk5);
  print(fizz, 0, 4);
  print(fizz, 8, 1);
  fizz.jump(next, [...fizz.params]);
  divides(chk5, 5, buzz, num);
  print(buzz, 4, 4);
  print(buzz, 8, 1);
  buzz.jump(next, [...buzz.params]);
  num.host("terminal.print_u64", [num.params[0]!]);
  print(num, 8, 1);
  num.jump(next, [...num.params]);
  {
    const [i, n] = next.params as [V, V];
    next.jump(loop, [next.add(i, next.const(1)), n]);
  }
  done.ret(null);
  return mb.build();
}

/** fn0(n: u64) -> u64: naive recursive Fibonacci (fn1). */
export function fibonacci(): Uint8Array {
  const mb = new ModuleBuilder();
  const main = mb.func(["u64"], "u64");
  const fib = mb.func(["u64"], "u64");
  const m0 = main.block();
  m0.ret(m0.call(fib, [m0.params[0]!])!);
  const f0 = fib.block();
  const base = fib.block(["u64"]);
  const rec = fib.block(["u64"]);
  f0.brIf(f0.lt(f0.params[0]!, f0.const(2)), base, [f0.params[0]!], rec, [f0.params[0]!]);
  base.ret(base.params[0]!);
  const n = rec.params[0]!;
  const a = rec.call(fib, [rec.sub(n, rec.const(1))])!;
  const b = rec.call(fib, [rec.sub(n, rec.const(2))])!;
  rec.ret(rec.add(a, b));
  return mb.build();
}

/** fn0() -> unit: 16x16-cell checkerboard over the whole framebuffer, then present. */
export function checkerboard(): Uint8Array {
  const mb = new ModuleBuilder();
  const f = mb.func([], "unit");
  const b0 = f.block();
  const row = f.block(["u64"]); // y
  const col = f.block(["u64", "u64"]); // y, x
  const rowNext = f.block(["u64"]);
  const done = f.block([]);
  b0.jump(row, [b0.const(0)]);
  {
    const y = row.params[0]!;
    row.brIf(row.lt(y, row.const(144)), col, [y, row.const(0)], done, []);
  }
  {
    const [y, x] = col.params as [V, V];
    const four = col.const(4);
    const parity = col.and(col.xor(col.shr(x, four), col.shr(y, four)), col.const(1));
    // colour = DARK + parity * (LIGHT - DARK)  (exact u64 arithmetic)
    const colour = col.add(col.const(DARK), col.mul(parity, col.const(LIGHT - DARK)));
    col.host("display.pixel", [x, y, colour]);
    const x2 = col.add(x, col.const(1));
    col.brIf(col.lt(x2, col.const(256)), col, [y, x2], rowNext, [y]);
  }
  rowNext.jump(row, [rowNext.add(rowNext.params[0]!, rowNext.const(1))]);
  done.host("display.present", []);
  done.ret(null);
  return mb.build();
}

// ---------------------------------------------------------------------------
// Ball and paddle (interactive). State carried through blocks: bx, by, dx, dy, px, score, n.
// Rules (mirrored independently by the oracle in packages/tasks):
//  each tick: wait_tick; Escape ends the game; Left/Right move the paddle 4 px within [0, 232];
//  ball moves by (dx, dy) with dx, dy in {1, 2^64-1}; x bounces at 0 and 254; y bounces at 0;
//  at y = 140 the ball bounces off the paddle when px <= bx < px + 24 (score + 1), else resets
//  to (128, 20) moving down; draw: clear black, paddle rows 142-143, 2x2 ball, present;
//  after 600 ticks the game ends. Returns the score.

export const BALL_TICK_LIMIT = 600;

export function ballPaddle(): Uint8Array {
  const mb = new ModuleBuilder();
  const f = mb.func([], "u64");
  const S = ["u64", "u64", "u64", "u64", "u64", "u64", "u64"] as const; // bx by dx dy px score n
  const b0 = f.block();
  const frame = f.block([...S]);
  const cont = f.block([...S]);
  const bottom = f.block([...S]);
  const bounce = f.block([...S]);
  const miss = f.block([...S]);
  const other = f.block([...S]);
  const draw = f.block([...S]);
  const pad = f.block([...S, "u64"]); // + i
  const after = f.block([...S]);
  const end = f.block(["u64"]);

  b0.jump(frame, [b0.const(128), b0.const(20), b0.const(1), b0.const(1), b0.const(116), b0.const(0), b0.const(0)]);

  {
    const st = frame.params as V[];
    frame.host("input.wait_tick", []);
    const esc = frame.host("input.key_down", [frame.const(6)])!;
    frame.brIf(esc, end, [st[5]!], cont, st);
  }
  {
    const [bx, by, dx, dy, px, score, n] = cont.params as [V, V, V, V, V, V, V];
    const l = cont.boolToU64(cont.host("input.key_down", [cont.const(0)])!);
    const r = cont.boolToU64(cont.host("input.key_down", [cont.const(1)])!);
    const four = cont.const(4);
    const canL = cont.and(l, cont.boolToU64(cont.le(four, px)));
    const px1 = cont.sub(px, cont.mul(canL, four));
    const canR = cont.and(r, cont.boolToU64(cont.le(px1, cont.const(228))));
    const px2 = cont.add(px1, cont.mul(canR, four));
    // x: bounce at 0 and 254 by negating dx (select without branching)
    const nx = cont.add(bx, dx);
    const hitX = cont.or(cont.boolToU64(cont.eq(nx, cont.const(0))), cont.boolToU64(cont.eq(nx, cont.const(254))));
    const maskX = cont.sub(cont.const(0), hitX);
    const negdx = cont.sub(cont.const(0), dx);
    const dx2 = cont.xor(dx, cont.and(cont.xor(dx, negdx), maskX));
    const ny = cont.add(by, dy);
    cont.brIf(cont.eq(ny, cont.const(140)), bottom, [nx, ny, dx2, dy, px2, score, n], other, [nx, ny, dx2, dy, px2, score, n]);
  }
  {
    const [bx, by, dx, dy, px, score, n] = bottom.params as [V, V, V, V, V, V, V];
    const inL = bottom.boolToU64(bottom.le(px, bx));
    const inR = bottom.boolToU64(bottom.lt(bx, bottom.add(px, bottom.const(24))));
    const hit = bottom.nonzero(bottom.and(inL, inR));
    bottom.brIf(hit, bounce, [bx, by, dx, dy, px, score, n], miss, [bx, by, dx, dy, px, score, n]);
  }
  {
    const [bx, by, dx, , px, score, n] = bounce.params as [V, V, V, V, V, V, V];
    bounce.jump(draw, [bx, by, dx, bounce.const((1n << 64n) - 1n), px, bounce.add(score, bounce.const(1)), n]);
  }
  {
    const [, , dx, , px, score, n] = miss.params as [V, V, V, V, V, V, V];
    miss.jump(draw, [miss.const(128), miss.const(20), dx, miss.const(1), px, score, n]);
  }
  {
    const [bx, by, dx, dy, px, score, n] = other.params as [V, V, V, V, V, V, V];
    // top bounce: when by == 0 the ball moves down (dy = 1); otherwise dy unchanged
    const top = other.boolToU64(other.eq(by, other.const(0)));
    const mask = other.sub(other.const(0), top);
    const dy2 = other.xor(dy, other.and(other.xor(dy, other.const(1)), mask));
    other.jump(draw, [bx, by, dx, dy2, px, score, n]);
  }
  {
    const st = draw.params as V[];
    draw.host("display.clear", [draw.const(BLACK)]);
    draw.jump(pad, [...st, draw.const(0)]);
  }
  {
    const st = pad.params.slice(0, 7) as V[];
    const i = pad.params[7]!;
    const x = pad.add(st[4]!, i);
    pad.host("display.pixel", [x, pad.const(142), pad.const(WHITE)]);
    pad.host("display.pixel", [x, pad.const(143), pad.const(WHITE)]);
    const i2 = pad.add(i, pad.const(1));
    pad.brIf(pad.lt(i2, pad.const(24)), pad, [...st, i2], after, st);
  }
  {
    const [bx, by, dx, dy, px, score, n] = after.params as [V, V, V, V, V, V, V];
    const one = after.const(1);
    const bx1 = after.add(bx, one);
    const by1 = after.add(by, one);
    const c = after.const(0xffd166ffn);
    after.host("display.pixel", [bx, by, c]);
    after.host("display.pixel", [bx1, by, c]);
    after.host("display.pixel", [bx, by1, c]);
    after.host("display.pixel", [bx1, by1, c]);
    after.host("display.present", []);
    const n2 = after.add(n, one);
    after.brIf(after.lt(n2, after.const(BALL_TICK_LIMIT)), frame, [bx, by, dx, dy, px, score, n2], end, [score]);
  }
  end.ret(end.params[0]!);
  return mb.build();
}

// ---------------------------------------------------------------------------
// Research workloads

export function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Stride for the generalized capstone: 17 when coprime with K, else the smallest coprime stride >= 2. */
export function capstoneStride(K: number): number {
  if (gcd(17, K) === 1) return 17;
  for (let s = 2; ; s++) if (gcd(s, K) === 1) return s;
}

/**
 * Generalized capstone for K values, same structure as the upstream 40-value fixture:
 * interleaved CONST i / ADD x,i producers, fold constants 3 then 0, MUL a,3 / XOR t,v[(s*j) mod K].
 * For K = 40 this is NOT presented as the exact upstream fixture (that is the committed 2704-byte file).
 */
export function capstoneK(K: number, stride = capstoneStride(K)): Uint8Array {
  if (gcd(stride, K) !== 1) throw new Error(`stride ${stride} is not coprime with ${K}`);
  const mb = new ModuleBuilder();
  const f = mb.func(["u64"], "u64");
  const b = f.block();
  const x = b.params[0]!;
  const v: V[] = [];
  for (let i = 0; i < K; i++) v.push(b.add(x, b.const(i)));
  const three = b.const(3);
  let a = b.const(0);
  for (let j = 0; j < K; j++) a = b.xor(b.mul(a, three), v[(stride * j) % K]!);
  b.ret(a);
  return mb.build();
}

/**
 * Upstream ring mix (pressure_probe.py): K values x+i; 1000 iterations of, for i in order,
 * v_i += v_{(i+1)%K} * 3; v_i ^= v_{(i+2)%K}; then XOR all. Representation: the K values are
 * the loop block's parameters (plus the iteration counter), so all K are live across the loop
 * back-edge in the logical-value store; updates inside an iteration are sequential SSA values.
 */
export function ringMix(K: number, iterations = 1000): Uint8Array {
  const mb = new ModuleBuilder();
  const f = mb.func(["u64"], "u64");
  const b0 = f.block();
  const loop = f.block(["u64", ...Array<"u64">(K).fill("u64")]);
  const done = f.block(Array<"u64">(K).fill("u64"));
  const x = b0.params[0]!;
  const init: V[] = [];
  for (let i = 0; i < K; i++) init.push(b0.add(x, b0.const(i)));
  b0.jump(loop, [b0.const(0), ...init]);
  const cur = loop.params.slice(1) as V[];
  const three = loop.const(3);
  for (let i = 0; i < K; i++) {
    // Exactly `v_i += v_{i+1}*3; v_i ^= v_{i+2}` — the second read sees v_i's update when (i+2)%K == i (K = 2).
    cur[i] = loop.add(cur[i]!, loop.mul(cur[(i + 1) % K]!, three));
    cur[i] = loop.xor(cur[i]!, cur[(i + 2) % K]!);
  }
  const it = loop.add(loop.params[0]!, loop.const(1));
  loop.brIf(loop.lt(it, loop.const(iterations)), loop, [it, ...cur], done, cur);
  let acc = done.params[0]!;
  for (let i = 1; i < K; i++) acc = done.xor(acc, done.params[i]!);
  done.ret(acc);
  return mb.build();
}

export const RING_MIX_K = [2, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 96] as const;
export const CAPSTONE_PUBLIC_K = [8, 40, 128] as const;
export const CAPSTONE_RESEARCH_K = [256, 1024, 10000] as const;

export interface FixtureDef {
  file: string;
  task: string;
  build: () => Uint8Array;
  commit: boolean;
  note: string;
}

export const FIXTURES: FixtureDef[] = [
  { file: "hello.anma", task: "hello", build: hello, commit: true, note: "data section + print_utf8" },
  { file: "fizzbuzz.anma", task: "fizzbuzz", build: fizzbuzz, commit: true, note: "branches, loops, urem, exact text" },
  { file: "fibonacci.anma", task: "fibonacci", build: fibonacci, commit: true, note: "recursive calls" },
  { file: "checkerboard.anma", task: "checkerboard", build: checkerboard, commit: true, note: "guest-driven pixels" },
  { file: "ball-paddle.anma", task: "ball-paddle", build: ballPaddle, commit: true, note: "interactive ticks + keys" },
  // K = 40 is served by the exact upstream fixture (capstoneK(40) is byte-identical to it; see tests).
  ...CAPSTONE_PUBLIC_K.filter((K) => K !== 40).map((K) => ({ file: `capstone-k${K}.anma`, task: `capstone-k${K}`, build: () => capstoneK(K), commit: true, note: `generalized capstone, stride ${capstoneStride(K)}` })),
  ...[256, 1024].map((K) => ({ file: `capstone-k${K}.anma`, task: `capstone-k${K}`, build: () => capstoneK(K), commit: true, note: `research-scale generalized capstone, stride ${capstoneStride(K)}` })),
  ...RING_MIX_K.map((K) => ({ file: `ring-mix-k${K}.anma`, task: `ring-mix-k${K}`, build: () => ringMix(K), commit: true, note: "upstream ring-mix workload (research)" })),
];

void Feature;
