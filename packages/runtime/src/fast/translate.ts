// ANMA-1 → WebAssembly binary translator (the fast engine's front end).
//
// Binary in, binary out, the way emulators such as QEMU or Rosetta 2 translate guest machine code:
// no source code is produced or read. The translated code preserves ANMA-1's architectural
// semantics exactly (values, control flow, traps, host and heap effects, executed-instruction
// counts); it does not model the finite machine's storage (fast slots, backing), which the exact
// engine keeps for the chip view.
//
// Shape: each ANMA block is cut into resumable segments (a new segment starts before every
// input.wait_tick call and after every CALL). Every segment becomes one small Wasm function that
// returns the id of the next segment, or a negative status. Frames live in linear memory, so a
// run can stop between segments (instruction budget, waiting for input) and resume later.

import { Op } from "@llmtobinary/spec";
import { Buf, I32, I64, W, encodeModule, type ModuleSpec } from "./wasm.ts";
import { aluTicks, LATENCY } from "../cost.ts";

const LATENCY_HOST_BASE = LATENCY.host;
import type { Block, Edge, Func, Instr, Module } from "@llmtobinary/validate";

/** Frame header layout (bytes from the frame pointer). */
export const FRAME = { prevFp: 0, fnId: 4, resumeAfterCall: 8, pendingDst: 12, blockId: 16, header: 32 } as const;
/** Scratch area for host and heap arguments/results. */
export const SCRATCH = 0;
/** First frame's address. */
export const FRAME_BASE = 4096;

/** Status codes returned by segments (negated) and by run(). */
export const Status = { paused: 0, halted: 1, trapped: 2, waiting: 3 } as const;

/** Trap codes passed to the trap import. */
export const TrapCode = { divideByZero: 1, frames: 2, memory: 3 } as const;

/** Heap operation kinds passed to the heap import. */
export const HeapKind = { allocU64: 0, allocU8: 1, loadU64: 2, loadU8: 3, storeU64: 4, storeU8: 5 } as const;

export interface SegmentInfo {
  fn: number;
  block: number;
  /** Index into block.instrs where the segment starts (instrs.length = the terminator). */
  start: number;
  /** Record index of the first record the segment executes. */
  rec: number;
}

export interface Translation {
  bytes: Uint8Array;
  segments: SegmentInfo[];
  /** Entry segment of block 0 of each function. */
  functionEntry: number[];
  /** Frame size in bytes for each function. */
  frameBytes: number[];
}

const G = { fp: 0, sp: 1, depth: 2, seg: 3, exec: 4, ticks: 5, ret: 6, maxDepth: 7, frameLimit: 8 } as const;
const IMPORT = { host: 0, heap: 1, trap: 2 } as const;
const FIRST_DEFINED = 3; // function index of run(); segments follow

const isWaitTick = (ins: Instr) => ins.k === "host" && ins.imp === 6;

/** Cut a block into segments: before each input.wait_tick and after each CALL. */
function segmentStarts(b: Block): number[] {
  const starts = [0];
  b.instrs.forEach((ins, i) => {
    if (isWaitTick(ins) && i !== starts[starts.length - 1]) starts.push(i);
    if (ins.k === "call") starts.push(i + 1);
  });
  return [...new Set(starts)].sort((x, y) => x - y);
}

export function translate(module: Module): Translation {
  const segments: SegmentInfo[] = [];
  const blockSeg = new Map<string, number[]>(); // "fn:block" -> segment ids by start
  const frameBytes: number[] = [];
  for (const f of module.functions) {
    let maxVals = 0;
    for (const b of f.blocks) {
      maxVals = Math.max(maxVals, b.types.length);
      const ids: number[] = [];
      for (const start of segmentStarts(b)) {
        ids.push(segments.length);
        segments.push({ fn: f.id, block: b.id, start, rec: start < b.instrs.length ? b.instrs[start]!.rec : b.term.rec });
      }
      blockSeg.set(`${f.id}:${b.id}`, ids);
    }
    frameBytes.push(FRAME.header + 8 * Math.max(1, maxVals));
  }
  const entrySeg = (fn: number, block: number) => blockSeg.get(`${fn}:${block}`)![0]!;
  const segAfter = (fn: number, block: number, index: number) => {
    const b = module.functions[fn]!.blocks[block]!;
    const starts = segmentStarts(b);
    return blockSeg.get(`${fn}:${block}`)![starts.indexOf(index)]!;
  };
  const functionEntry = module.functions.map((f) => entrySeg(f.id, 0));

  const bodies: Buf[] = [runBody()];
  for (const s of segments) {
    const f = module.functions[s.fn]!;
    const b = f.blocks[s.block]!;
    bodies.push(segmentBody(module, f, b, s, entrySeg, segAfter, frameBytes));
  }
  const spec: ModuleSpec = {
    types: [
      { params: [], results: [I32] }, // 0: segment
      { params: [I64], results: [I32] }, // 1: run(stopAt)
      { params: [I32, I32, I32], results: [I32] }, // 2: host(imp, rec, argc) -> status
      { params: [I32, I32], results: [I32] }, // 3: heap(kind, rec) -> status
      { params: [I32, I32], results: [] }, // 4: trap(code, rec)
    ],
    imports: [
      { module: "anma", name: "host", type: 2 },
      { module: "anma", name: "heap", type: 3 },
      { module: "anma", name: "trap", type: 4 },
    ],
    functions: [1, ...segments.map(() => 0)],
    tableSize: segments.length,
    memoryPages: { min: 2, max: 16384 },
    globals: [
      { type: I32, init: FRAME_BASE }, // fp
      { type: I32, init: FRAME_BASE }, // sp
      { type: I32, init: 0 }, // depth
      { type: I32, init: 0 }, // seg
      { type: I64, init: 0 }, // exec
      { type: I64, init: 0 }, // ticks (static cost model; device work is added by the host)
      { type: I64, init: 0 }, // ret
      { type: I32, init: 0 }, // maxDepth
      { type: I32, init: 256 }, // frameLimit (set by the host from its limits)
    ],
    exports: [
      { name: "run", kind: "func", index: FIRST_DEFINED },
      { name: "memory", kind: "memory", index: 0 },
      { name: "fp", kind: "global", index: G.fp },
      { name: "sp", kind: "global", index: G.sp },
      { name: "depth", kind: "global", index: G.depth },
      { name: "seg", kind: "global", index: G.seg },
      { name: "exec", kind: "global", index: G.exec },
      { name: "ticks", kind: "global", index: G.ticks },
      { name: "ret", kind: "global", index: G.ret },
      { name: "maxDepth", kind: "global", index: G.maxDepth },
      { name: "frameLimit", kind: "global", index: G.frameLimit },
    ],
    elements: segments.map((_, i) => FIRST_DEFINED + 1 + i),
    bodies,
  };
  return { bytes: encodeModule(spec), segments, functionEntry, frameBytes };
}

/** run(stopAt): dispatch segments until exec >= stopAt or a segment reports a status. */
function runBody(): Buf {
  const c = new Buf();
  c.u32(1).u32(1).u8(I32); // one local: next
  c.op(W.loop).u8(0x40);
  // if exec >= stopAt: return paused
  c.op(W.global_get).u32(G.exec).op(W.local_get).u32(0).op(W.i64_ge_u);
  c.op(W.if).u8(0x40).op(W.i32_const).s32(Status.paused).op(W.return).op(W.end);
  // next = table[seg]()
  c.op(W.global_get).u32(G.seg).op(W.call_indirect).u32(0).u32(0);
  c.op(W.local_tee).u32(1).op(W.i32_const).s32(0).op(W.i32_lt_s);
  c.op(W.if).u8(0x40).op(W.i32_const).s32(0).op(W.local_get).u32(1).op(W.i32_sub).op(W.return).op(W.end);
  c.op(W.local_get).u32(1).op(W.global_set).u32(G.seg);
  c.op(W.br).u32(0);
  c.op(W.end);
  c.op(W.unreachable);
  c.op(W.end);
  return c;
}

class Seg {
  readonly c = new Buf();
  /** Executed instructions and modeled ticks not yet added to the globals. */
  pendExec = 0;
  pendTicks = 0;

  flush(): void {
    if (this.pendExec) this.c.op(W.global_get).u32(G.exec).op(W.i64_const).s64(BigInt(this.pendExec)).op(W.i64_add).op(W.global_set).u32(G.exec);
    if (this.pendTicks) this.c.op(W.global_get).u32(G.ticks).op(W.i64_const).s64(BigInt(this.pendTicks)).op(W.i64_add).op(W.global_set).u32(G.ticks);
    this.pendExec = 0;
    this.pendTicks = 0;
  }

  /** Push the value of slot `id` of the current frame (local 0 = fp). */
  load(id: number): void {
    this.c.op(W.local_get).u32(0).op(W.i64_load).memarg(3, FRAME.header + 8 * id);
  }

  /** Begin a store to slot `id`: push the address (the value must follow, then storeEnd). */
  storeBegin(): void {
    this.c.op(W.local_get).u32(0);
  }

  storeEnd(id: number): void {
    this.c.op(W.i64_store).memarg(3, FRAME.header + 8 * id);
  }

  /** Exit with a negative status (pending counts are flushed first). */
  exitStatus(status: number): void {
    this.flush();
    this.c.op(W.i32_const).s32(-status).op(W.return);
  }

  /** Flushes and traps via the host import, then exits trapped. */
  trap(code: number, rec: number): void {
    this.flush();
    this.c.op(W.i32_const).s32(code).op(W.i32_const).s32(rec).op(W.call).u32(IMPORT.trap);
    this.c.op(W.i32_const).s32(-Status.trapped).op(W.return);
  }

  /** Continue at segment `next` (pending counts flushed). */
  goto(next: number): void {
    this.flush();
    this.c.op(W.i32_const).s32(next).op(W.return);
  }
}

function segmentBody(
  module: Module,
  f: Func,
  b: Block,
  s: SegmentInfo,
  entrySeg: (fn: number, block: number) => number,
  segAfter: (fn: number, block: number, index: number) => number,
  frameBytes: number[],
): Buf {
  const g = new Seg();
  const c = g.c;
  // Locals: 0 fp (i32), 1 tmp (i32), 2.. i64 temporaries for simultaneous argument binding.
  let maxArgs = 3;
  for (const ins of b.instrs) if (ins.k === "call") maxArgs = Math.max(maxArgs, ins.args.length);
  const t = b.term;
  if (t.k === "jump") maxArgs = Math.max(maxArgs, t.edge.args.length);
  if (t.k === "br") maxArgs = Math.max(maxArgs, t.t.args.length, t.f.args.length);
  const TMP = 1;
  const A0 = 2;
  const body = new Buf();
  body.u32(2).u32(2).u8(I32).u32(maxArgs).u8(I64);
  c.op(W.global_get).u32(G.fp).op(W.local_set).u32(0);

  const bindEdge = (edge: Edge) => {
    // Bind all arguments simultaneously: read every source first, then write the parameters.
    edge.args.forEach((a, i) => {
      g.load(a);
      c.op(W.local_set).u32(A0 + i);
    });
    edge.args.forEach((_, i) => {
      g.storeBegin();
      c.op(W.local_get).u32(A0 + i);
      g.storeEnd(i);
    });
    c.op(W.local_get).u32(0).op(W.i32_const).s32(edge.target).op(W.i32_store).memarg(2, FRAME.blockId);
  };

  let cut = false;
  for (let i = s.start; i < b.instrs.length; i++) {
    const ins = b.instrs[i]!;
    if (i > s.start && isWaitTick(ins)) {
      g.goto(segAfter(f.id, b.id, i)); // wait_tick always starts its own segment
      cut = true;
      break;
    }
    switch (ins.k) {
      case "const":
        g.storeBegin();
        if (typeof ins.value === "boolean") c.op(W.i64_const).s64(ins.value ? 1n : 0n);
        else c.op(W.i64_const).s64(ins.value);
        g.storeEnd(ins.dst);
        g.pendExec++;
        g.pendTicks += LATENCY.fetch + 1 + LATENCY.publish;
        break;
      case "bin": {
        if (ins.op === Op.UDIV_U64 || ins.op === Op.UREM_U64) {
          g.load(ins.b);
          c.op(W.i64_eqz).op(W.if).u8(0x40);
          const saveE = g.pendExec, saveT = g.pendTicks;
          g.trap(TrapCode.divideByZero, ins.rec);
          g.pendExec = saveE;
          g.pendTicks = saveT;
          c.op(W.end);
        }
        g.storeBegin();
        g.load(ins.a);
        g.load(ins.b);
        switch (ins.op) {
          case Op.ADD_U64: c.op(W.i64_add); break;
          case Op.SUB_U64: c.op(W.i64_sub); break;
          case Op.MUL_U64: c.op(W.i64_mul); break;
          case Op.UDIV_U64: c.op(W.i64_div_u); break;
          case Op.UREM_U64: c.op(W.i64_rem_u); break;
          case Op.AND_U64: c.op(W.i64_and); break;
          case Op.OR_U64: c.op(W.i64_or); break;
          case Op.XOR_U64: c.op(W.i64_xor); break;
          case Op.SHL_U64: c.op(W.i64_shl); break;
          case Op.SHR_U64: c.op(W.i64_shr_u); break;
          case Op.ROTL_U64: c.op(W.i64_rotl); break;
          case Op.ROTR_U64: c.op(W.i64_rotr); break;
          case Op.EQ_U64: c.op(W.i64_eq).op(W.i64_extend_i32_u); break;
          case Op.LT_U64: c.op(W.i64_lt_u).op(W.i64_extend_i32_u); break;
          case Op.LE_U64: c.op(W.i64_le_u).op(W.i64_extend_i32_u); break;
          default: throw new Error(`translate: unexpected binary opcode 0x${ins.op.toString(16)}`);
        }
        g.storeEnd(ins.dst);
        g.pendExec++;
        g.pendTicks += LATENCY.fetch + 2 * LATENCY.hit + aluTicks(ins.op) + LATENCY.publish;
        break;
      }
      case "un":
        g.storeBegin();
        g.load(ins.a);
        if (ins.op === Op.NOT_BOOL) c.op(W.i64_eqz).op(W.i64_extend_i32_u);
        else if (ins.op === Op.U64_NONZERO) c.op(W.i64_const).s64(0n).op(W.i64_ne).op(W.i64_extend_i32_u);
        // BOOL_TO_U64: booleans are already 0 or 1
        g.storeEnd(ins.dst);
        g.pendExec++;
        g.pendTicks += LATENCY.fetch + LATENCY.hit + 1 + LATENCY.publish;
        break;
      case "host": {
        g.flush();
        ins.args.forEach((a, k) => {
          c.op(W.i32_const).s32(SCRATCH);
          g.load(a);
          c.op(W.i64_store).memarg(3, 8 * k);
        });
        c.op(W.i32_const).s32(ins.imp).op(W.i32_const).s32(ins.rec).op(W.i32_const).s32(ins.args.length).op(W.call).u32(IMPORT.host);
        c.op(W.local_tee).u32(TMP).op(W.i32_const).s32(1).op(W.i32_eq);
        c.op(W.if).u8(0x40).op(W.i32_const).s32(-Status.waiting).op(W.return).op(W.end);
        c.op(W.local_get).u32(TMP).op(W.if).u8(0x40).op(W.i32_const).s32(-Status.trapped).op(W.return).op(W.end);
        if (ins.dst !== null) {
          g.storeBegin();
          c.op(W.i32_const).s32(SCRATCH).op(W.i64_load).memarg(3, 0);
          g.storeEnd(ins.dst);
        }
        g.pendExec++;
        g.pendTicks += LATENCY.fetch + ins.args.length * (LATENCY.hit + LATENCY.stage) + LATENCY_HOST_BASE + (ins.dst !== null ? LATENCY.publish : 0);
        break;
      }
      case "alloc":
      case "load":
      case "store": {
        g.flush();
        const srcs = ins.k === "alloc" ? [ins.count] : ins.k === "load" ? [ins.handle, ins.index] : [ins.handle, ins.index, ins.value];
        srcs.forEach((a, k) => {
          c.op(W.i32_const).s32(SCRATCH);
          g.load(a);
          c.op(W.i64_store).memarg(3, 8 * k);
        });
        const kind =
          ins.k === "alloc" ? (ins.op === Op.ALLOC_U64 ? HeapKind.allocU64 : HeapKind.allocU8)
          : ins.k === "load" ? (ins.op === Op.LOAD_U64 ? HeapKind.loadU64 : HeapKind.loadU8)
          : ins.op === Op.STORE_U64 ? HeapKind.storeU64 : HeapKind.storeU8;
        c.op(W.i32_const).s32(kind).op(W.i32_const).s32(ins.rec).op(W.call).u32(IMPORT.heap);
        c.op(W.if).u8(0x40).op(W.i32_const).s32(-Status.trapped).op(W.return).op(W.end);
        if (ins.k !== "store") {
          g.storeBegin();
          c.op(W.i32_const).s32(SCRATCH).op(W.i64_load).memarg(3, 0);
          g.storeEnd(ins.dst);
        }
        g.pendExec++;
        g.pendTicks +=
          LATENCY.fetch + srcs.length * LATENCY.hit + (ins.k === "alloc" ? LATENCY.heapAlloc : LATENCY.heapAccess) + (ins.k === "store" ? 0 : LATENCY.publish);
        break;
      }
      case "call": {
        const callee = module.functions[ins.fn]!;
        // Depth limit (checked before anything is bound, like the reference engine).
        c.op(W.global_get).u32(G.depth).op(W.global_get).u32(G.frameLimit).op(W.i32_ge_u).op(W.if).u8(0x40);
        {
          const saveE = g.pendExec, saveT = g.pendTicks;
          g.trap(TrapCode.frames, ins.rec);
          g.pendExec = saveE;
          g.pendTicks = saveT;
        }
        c.op(W.end);
        const fb = frameBytes[callee.id]!;
        // Grow memory when the new frame would not fit: need = (sp + fb + 65535) >> 16 pages.
        c.op(W.global_get).u32(G.sp).op(W.i32_const).s32(fb + 65535).op(W.i32_add).op(W.i32_const).s32(16).op(W.i32_shr_u);
        c.op(W.local_tee).u32(TMP).op(W.memory_size).u8(0).op(W.i32_gt_u).op(W.if).u8(0x40);
        c.op(W.local_get).u32(TMP).op(W.memory_size).u8(0).op(W.i32_sub).op(W.memory_grow).u8(0).op(W.i32_const).s32(-1).op(W.i32_eq);
        c.op(W.if).u8(0x40);
        {
          const saveE = g.pendExec, saveT = g.pendTicks;
          g.trap(TrapCode.memory, ins.rec);
          g.pendExec = saveE;
          g.pendTicks = saveT;
        }
        c.op(W.end).op(W.end);
        // Read the arguments from the caller frame.
        ins.args.forEach((a, k) => {
          g.load(a);
          c.op(W.local_set).u32(A0 + k);
        });
        // Caller header: where to continue and which slot receives the result.
        c.op(W.local_get).u32(0).op(W.i32_const).s32(segAfter(f.id, b.id, i + 1)).op(W.i32_store).memarg(2, FRAME.resumeAfterCall);
        c.op(W.local_get).u32(0).op(W.i32_const).s32(ins.dst ?? -1).op(W.i32_store).memarg(2, FRAME.pendingDst);
        // New frame at sp.
        c.op(W.global_get).u32(G.sp).op(W.local_set).u32(0);
        c.op(W.local_get).u32(0).op(W.global_get).u32(G.fp).op(W.i32_store).memarg(2, FRAME.prevFp);
        c.op(W.local_get).u32(0).op(W.i32_const).s32(callee.id).op(W.i32_store).memarg(2, FRAME.fnId);
        c.op(W.local_get).u32(0).op(W.i32_const).s32(0).op(W.i32_store).memarg(2, FRAME.blockId);
        c.op(W.local_get).u32(0).op(W.i32_const).s32(-1).op(W.i32_store).memarg(2, FRAME.pendingDst);
        ins.args.forEach((_, k) => {
          g.storeBegin();
          c.op(W.local_get).u32(A0 + k);
          g.storeEnd(k);
        });
        c.op(W.local_get).u32(0).op(W.global_set).u32(G.fp);
        c.op(W.local_get).u32(0).op(W.i32_const).s32(fb).op(W.i32_add).op(W.global_set).u32(G.sp);
        c.op(W.global_get).u32(G.depth).op(W.i32_const).s32(1).op(W.i32_add).op(W.local_tee).u32(TMP).op(W.global_set).u32(G.depth);
        c.op(W.local_get).u32(TMP).op(W.global_get).u32(G.maxDepth).op(W.i32_gt_u).op(W.if).u8(0x40);
        c.op(W.local_get).u32(TMP).op(W.global_set).u32(G.maxDepth).op(W.end);
        g.pendExec++;
        g.pendTicks += LATENCY.fetch + ins.args.length * (LATENCY.hit + LATENCY.stage) + LATENCY.call + ins.args.length * LATENCY.publish;
        g.goto(entrySeg(callee.id, 0));
        return finish(body, c);
      }
    }
  }
  // Reached the end of the instructions (not cut before a wait_tick): run the terminator.
  if (!cut) terminator(g, f, b, entrySeg, bindEdge);
  return finish(body, c);
}

function terminator(g: Seg, f: Func, b: Block, entrySeg: (fn: number, block: number) => number, bindEdge: (e: Edge) => void): void {
  const c = g.c;
  const t = b.term;
  if (t.k === "jump") {
    bindEdge(t.edge);
    g.pendExec++;
    g.pendTicks += LATENCY.fetch + LATENCY.branch + t.edge.args.length * (LATENCY.hit + LATENCY.stage + LATENCY.publish);
    g.goto(entrySeg(f.id, t.edge.target));
    return;
  }
  if (t.k === "br") {
    g.load(t.cond);
    c.op(W.i32_wrap_i64).op(W.if).u8(0x40);
    const base = LATENCY.fetch + LATENCY.hit + LATENCY.branch;
    for (const edge of [t.t, t.f]) {
      const saveE = g.pendExec, saveT = g.pendTicks;
      bindEdge(edge);
      g.pendExec++;
      g.pendTicks += base + edge.args.length * (LATENCY.hit + LATENCY.stage + LATENCY.publish);
      g.goto(entrySeg(f.id, edge.target));
      g.pendExec = saveE;
      g.pendTicks = saveT;
      if (edge === t.t) c.op(W.else);
    }
    c.op(W.end).op(W.unreachable);
    return;
  }
  // RETURN
  const TMP = 1;
  const A0 = 2;
  if (t.src !== null) g.load(t.src);
  else c.op(W.i64_const).s64(0n);
  c.op(W.local_set).u32(A0);
  g.pendExec++;
  g.pendTicks += LATENCY.fetch + LATENCY.return + (t.src !== null ? LATENCY.hit + LATENCY.stage : 0);
  g.flush();
  // Pop: sp = fp; depth--; fp = prev.
  c.op(W.local_get).u32(0).op(W.global_set).u32(G.sp);
  c.op(W.global_get).u32(G.depth).op(W.i32_const).s32(1).op(W.i32_sub).op(W.local_tee).u32(TMP).op(W.global_set).u32(G.depth);
  c.op(W.local_get).u32(TMP).op(W.i32_eqz).op(W.if).u8(0x40);
  c.op(W.local_get).u32(A0).op(W.global_set).u32(G.ret).op(W.i32_const).s32(-Status.halted).op(W.return);
  c.op(W.end);
  c.op(W.local_get).u32(0).op(W.i32_load).memarg(2, FRAME.prevFp).op(W.local_tee).u32(0).op(W.global_set).u32(G.fp);
  // Caller's pending destination receives the result (one publish).
  c.op(W.local_get).u32(0).op(W.i32_load).memarg(2, FRAME.pendingDst).op(W.local_tee).u32(TMP).op(W.i32_const).s32(0).op(W.i32_ge_s);
  c.op(W.if).u8(0x40);
  c.op(W.local_get).u32(0).op(W.local_get).u32(TMP).op(W.i32_const).s32(3).op(W.i32_shl).op(W.i32_add);
  c.op(W.local_get).u32(A0).op(W.i64_store).memarg(3, FRAME.header);
  c.op(W.global_get).u32(G.ticks).op(W.i64_const).s64(BigInt(LATENCY.publish)).op(W.i64_add).op(W.global_set).u32(G.ticks);
  c.op(W.end);
  c.op(W.local_get).u32(0).op(W.i32_load).memarg(2, FRAME.resumeAfterCall).op(W.return);
}

function finish(body: Buf, c: Buf): Buf {
  c.op(W.unreachable).op(W.end);
  const out = new Buf();
  out.bytes(body.toBytes());
  out.bytes(c.toBytes());
  return out;
}

