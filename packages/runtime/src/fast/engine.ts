// The fast engine: runs an ANMA-1 module through its WebAssembly translation (see translate.ts).
// Architecturally identical to the reference engine (results, traps, terminal, framebuffer,
// effects, executed-instruction counts); the finite machine's storage is not simulated, so its
// storage counters stay zero and modeled ticks are a lower bound (no misses or evictions). That
// bound equals the exact engine's ticks whenever a run has no misses or evictions.

import { DEFAULT_LIMITS, TypeTag, type Limits } from "@llmtobinary/spec";
import type { Module } from "@llmtobinary/validate";
import { Devices, Heap, bindInputs, makeTrap, toGuestValue } from "@llmtobinary/devices";
import type { EngineOptions, EntryInput, MachineConfig, MachineCounters, MachineSnapshot, MicroEvent, RunResult, RunStatus, RuntimeValue, TickEvent, Trap } from "@llmtobinary/protocol";
import { FRAME, FRAME_BASE, HeapKind, SCRATCH, Status, TrapCode, translate, type Translation } from "./translate.ts";

interface Exports {
  run(stopAt: bigint): number;
  memory: WebAssembly.Memory;
  fp: WebAssembly.Global;
  sp: WebAssembly.Global;
  depth: WebAssembly.Global;
  seg: WebAssembly.Global;
  exec: WebAssembly.Global;
  ticks: WebAssembly.Global;
  ret: WebAssembly.Global;
  maxDepth: WebAssembly.Global;
  frameLimit: WebAssembly.Global;
}

/** Compiled translations, keyed by module identity (a module is immutable once validated). */
const compiled = new WeakMap<Module, { translation: Translation; wasm: WebAssembly.Module }>();

export function compileFast(module: Module): { translation: Translation; wasm: WebAssembly.Module } {
  let c = compiled.get(module);
  if (!c) {
    const translation = translate(module);
    const bytes = new Uint8Array(translation.bytes.length);
    bytes.set(translation.bytes);
    c = { translation, wasm: new WebAssembly.Module(bytes) };
    compiled.set(module, c);
  }
  return c;
}

export class FastMachine {
  readonly devices: Devices;
  readonly engine = "fast" as const;
  private readonly limits: Limits;
  private readonly heap: Heap;
  private readonly x: Exports;
  private readonly t: Translation;
  private readonly handles: RuntimeValue[] = [];
  private readonly recPos: Map<number, { fn: number; block: number }>;
  private _status: RunStatus = "ready";
  private trap: Trap | null = null;
  private deviceWork = 0;
  private initialTicks: number;
  private mem: ArrayBuffer | null = null;
  private u64 = new BigUint64Array(0);
  private i64 = new BigInt64Array(0);

  constructor(
    readonly module: Module,
    inputs: readonly EntryInput[],
    private readonly opts: EngineOptions & { config?: Partial<MachineConfig> } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.heap = new Heap(this.limits);
    this.devices = new Devices({
      data: module.data,
      declaredFeatures: module.features,
      ...(opts.allowedFeatures !== undefined ? { allowedFeatures: opts.allowedFeatures } : {}),
      limits: this.limits,
      ...(opts.ticks ? { ticks: opts.ticks } : {}),
    });
    const c = compileFast(module);
    this.t = c.translation;
    this.recPos = new Map();
    for (const f of module.functions) for (const b of f.blocks) {
      for (const i of b.instrs) this.recPos.set(i.rec, { fn: f.id, block: b.id });
      this.recPos.set(b.term.rec, { fn: f.id, block: b.id });
    }
    const instance = new WebAssembly.Instance(c.wasm, {
      anma: {
        host: (imp: number, rec: number, argc: number) => this.host(imp, rec, argc),
        heap: (kind: number, rec: number) => this.heapOp(kind, rec),
        trap: (code: number, rec: number) => this.trapCode(code, rec),
      },
    });
    this.x = instance.exports as unknown as Exports;
    this.x.frameLimit.value = this.limits.activeFrames;
    // Entry frame, with its arguments installed as block 0 parameters.
    const args = bindInputs(module, inputs);
    const entry = module.functions[module.entry]!;
    const fb = this.t.frameBytes[entry.id]!;
    this.ensureMemory(FRAME_BASE + fb);
    const dv = this.view();
    dv.setInt32(FRAME_BASE + FRAME.prevFp, 0, true);
    dv.setInt32(FRAME_BASE + FRAME.fnId, entry.id, true);
    dv.setInt32(FRAME_BASE + FRAME.pendingDst, -1, true);
    dv.setInt32(FRAME_BASE + FRAME.blockId, 0, true);
    args.forEach((a, i) => dv.setBigInt64(FRAME_BASE + FRAME.header + 8 * i, BigInt.asIntN(64, typeof a === "boolean" ? (a ? 1n : 0n) : (a as bigint)), true));
    this.x.fp.value = FRAME_BASE;
    this.x.sp.value = FRAME_BASE + fb;
    this.x.depth.value = 1;
    this.x.maxDepth.value = 1;
    this.x.seg.value = this.t.functionEntry[entry.id]!;
    // Entry arguments arrive through staging like any call, then are published as parameters.
    this.initialTicks = args.length * 2;
  }

  get status(): RunStatus {
    return this._status;
  }

  private view(): DataView {
    return new DataView(this.x.memory.buffer);
  }

  private ensureMemory(bytes: number): void {
    const need = Math.ceil(bytes / 65536);
    const have = this.x.memory.buffer.byteLength / 65536;
    if (need > have) this.x.memory.grow(need - have);
  }

  /** Typed views over Wasm memory, refreshed only when memory.grow replaced the buffer. */
  private views(): void {
    const b = this.x.memory.buffer;
    if (b !== this.mem) {
      this.mem = b;
      this.u64 = new BigUint64Array(b);
      this.i64 = new BigInt64Array(b);
    }
  }

  private scratch(i: number): bigint {
    this.views();
    return this.u64[SCRATCH / 8 + i]!;
  }

  private setScratch(v: bigint): void {
    this.views();
    this.i64[SCRATCH / 8] = BigInt.asIntN(64, v);
  }

  private fail(t: Trap, rec: number): void {
    const p = this.recPos.get(rec);
    t.recordIndex = rec;
    t.byteOffset = 32 + 16 * rec;
    t.functionId = p?.fn ?? null;
    t.blockId = p?.block ?? null;
    this.trap = t;
  }

  private host(imp: number, rec: number, argc: number): number {
    const args: bigint[] = [];
    for (let i = 0; i < argc; i++) args.push(this.scratch(i));
    const out = this.devices.call(imp, args);
    if (out.kind === "wait") return 1;
    if (out.kind === "trap") {
      this.fail(out.trap, rec);
      return 2;
    }
    this.deviceWork += this.devices.takeWork();
    const v = out.value;
    if (typeof v === "boolean") this.setScratch(v ? 1n : 0n);
    else if (typeof v === "bigint") this.setScratch(v);
    return 0;
  }

  private heapOp(kind: number, rec: number): number {
    const handle = () => this.handles[Number(this.scratch(0))]!;
    let r;
    switch (kind) {
      case HeapKind.allocU64:
      case HeapKind.allocU8:
        r = this.heap.alloc(kind === HeapKind.allocU64 ? "u64" : "u8", this.scratch(0));
        if (r.ok) {
          this.handles.push(r.value);
          this.setScratch(BigInt(this.handles.length - 1));
        }
        break;
      case HeapKind.loadU64:
      case HeapKind.loadU8:
        r = this.heap.load(kind === HeapKind.loadU64 ? "u64" : "u8", handle(), this.scratch(1));
        if (r.ok) this.setScratch(r.value as bigint);
        break;
      default:
        r = this.heap.store(kind === HeapKind.storeU64 ? "u64" : "u8", handle(), this.scratch(1), this.scratch(2));
    }
    if (!r.ok) {
      this.fail(r.trap, rec);
      return 1;
    }
    return 0;
  }

  private trapCode(code: number, rec: number): void {
    const r = this.module.records[rec]!;
    const t =
      code === TrapCode.divideByZero ? makeTrap("DIVIDE_BY_ZERO", `${r.op === 0x23 ? "UDIV_U64" : "UREM_U64"} by zero`)
      : code === TrapCode.frames ? makeTrap("RESOURCE_EXHAUSTED", `call depth would exceed ${this.limits.activeFrames} active frames`, "frames")
      : makeTrap("RESOURCE_EXHAUSTED", "frame memory could not grow", "frames");
    this.fail(t, rec);
  }

  pushTick(event: TickEvent): void {
    const err = this.devices.pushTick(event);
    if (err) throw new Error(err);
    if (this._status === "waiting-input") this._status = "paused";
  }

  cancel(): void {
    if (this._status !== "halted" && this._status !== "trapped") this._status = "cancelled";
  }

  /** Runs at least one segment (a straight-line stretch of instructions): stepping needs the exact engine. */
  step(): RunStatus {
    return this.run(1);
  }

  run(maxInstructions: number): RunStatus {
    if (this._status === "halted" || this._status === "trapped" || this._status === "cancelled") return this._status;
    if (this._status === "waiting-input" && this.devices.pendingTicks() === 0) return this._status;
    const exec = this.executed();
    if (exec >= this.limits.executedInstructions) {
      this.failAtCurrent(makeTrap("FUEL_EXHAUSTED", `executed-instruction budget of ${this.limits.executedInstructions} exhausted`, "instructions"));
      return this._status;
    }
    const stopAt = Math.min(exec + maxInstructions, this.limits.executedInstructions);
    this._status = "running";
    const s = this.x.run(BigInt(stopAt));
    this._status = s === Status.halted ? "halted" : s === Status.trapped ? "trapped" : s === Status.waiting ? "waiting-input" : "paused";
    return this._status;
  }

  private failAtCurrent(t: Trap): void {
    this.fail(t, this.t.segments[this.x.seg.value as number]!.rec);
    this._status = "trapped";
  }

  private executed(): number {
    return Number(this.x.exec.value as bigint);
  }

  /** Modeled ticks without storage stalls (anma-cost/1): a lower bound on the exact engine's ticks. */
  modeledTicks(): number {
    return this.initialTicks + Number(this.x.ticks.value as bigint) + this.deviceWork;
  }

  // Parity with the finite machine's host-facing API (instrumentation is exact-engine only).
  setEventSink(_fn: ((e: MicroEvent) => void) | null): void {}
  setTracing(_on: boolean): void {}

  position(): MachineSnapshot["position"] {
    if (this._status === "halted") return null;
    const s = this.t.segments[this.x.seg.value as number]!;
    return { functionId: s.fn, blockId: s.block, recordIndex: s.rec, depth: (this.x.depth.value as number) - 1 };
  }

  private counters(): MachineCounters {
    return {
      executedInstructions: this.executed(),
      decodedRecords: this.executed(),
      microsteps: 0,
      operandReads: 0,
      operandHits: 0,
      operandMisses: 0,
      backingReads: 0,
      backingWrites: 0,
      backingBytesRead: 0,
      backingBytesWritten: 0,
      evictions: 0,
      reclaimed: 0,
      peakLiveValues: 0,
      peakFastOccupied: 0,
      peakBackingEntries: 0,
      peakStagingBytes: 0,
      peakMetadataBytes: 0,
      peakFrames: this.x.maxDepth.value as number,
      heapBytes: this.heap.bytes,
      heapAllocations: this.heap.count,
      hostCalls: this.devices.hostCalls,
      hostWallTimeMs: 0, // not measured by the fast engine
      modeledTicks: this.modeledTicks(),
    };
  }

  snapshot(): MachineSnapshot {
    const config: MachineConfig = { fastSlots: this.opts.config?.fastSlots ?? 16, policy: "fifo-v1", trace: false };
    return {
      status: this._status,
      position: this.position(),
      config,
      slots: [],
      latches: { A: null, B: null, R: null },
      backing: { used: 0, capacity: 0, sample: [], highWater: 0, occupied: [] },
      staging: { usedBytes: 0, capacityBytes: 0 },
      frames: [],
      liveValues: 0,
      counters: this.counters(),
      lastMicrosteps: [],
      trace: [],
      traceTruncated: false,
      engine: "fast",
    };
  }

  result(): RunResult {
    const eff = this.devices.effects();
    const status = this._status === "halted" || this._status === "trapped" || this._status === "cancelled" ? this._status : "cancelled";
    const entry = this.module.functions[this.module.entry]!;
    let rv: RuntimeValue | null = null;
    if (this._status === "halted" && entry.ret !== TypeTag.UNIT) {
      const raw = BigInt.asUintN(64, this.x.ret.value as bigint);
      rv = entry.ret === TypeTag.BOOL ? raw !== 0n : raw;
    }
    return {
      engine: "fast",
      status,
      returnValue: this._status === "halted" ? toGuestValue(rv) : null,
      terminal: this.devices.terminal(),
      effects: eff.retained,
      effectCount: eff.count,
      effectsTruncated: eff.truncated,
      effectsHash: this.devices.effectsHash(),
      framebufferHash: this.devices.framebufferHash(),
      finalFramebuffer: (this.module.features & 4) !== 0 ? this.devices.framebuffer.slice() : null,
      framesPresented: this.devices.framesPresented,
      trap: this.trap,
      counters: this.counters(),
      config: null,
      traceTruncated: false,
    };
  }
}

export function createFastMachine(module: Module, inputs: readonly EntryInput[], opts: EngineOptions & { config?: Partial<MachineConfig> } = {}): FastMachine {
  return new FastMachine(module, inputs, opts);
}

/** Run to completion (or until waiting for input with no queued ticks), like runToCompletion. */
export function runFast(module: Module, inputs: readonly EntryInput[], opts: EngineOptions = {}): RunResult {
  const m = createFastMachine(module, inputs, opts);
  while (true) {
    const s = m.run(1_000_000);
    if (s === "halted" || s === "trapped" || s === "cancelled" || s === "waiting-input") break;
  }
  if (m.status === "waiting-input") m.cancel();
  return m.result();
}
