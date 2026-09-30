// Independent semantic interpreter (PRD Section 15.2). Straightforward logical values per block
// activation, an explicit VM frame stack (no JavaScript recursion), exact u64 via bigint.
// It is a separate execution loop from the finite machine and never models storage.

import { DEFAULT_LIMITS, Op, evalBinary, type Limits } from "@llmtobinary/spec";
import type { Block, Func, Instr, Module } from "@llmtobinary/validate";
import { Devices, Heap, bindInputs, makeTrap, toGuestValue } from "@llmtobinary/devices";
import type { Engine, EngineHooks, EngineOptions, EntryInput, RunResult, RunStatus, RuntimeValue, TickEvent, Trap } from "@llmtobinary/protocol";

export { bindInputs, InputError, parseInputs } from "@llmtobinary/devices";

interface Frame {
  fn: Func;
  block: Block;
  vals: (RuntimeValue | undefined)[];
  pc: number;
  entryArgs: RuntimeValue[];
  /** Destination in THIS frame awaiting a callee's return value. */
  pendingDst: number | null;
}

export class ReferenceEngine implements Engine {
  private frames: Frame[] = [];
  private _status: RunStatus = "ready";
  private readonly limits: Limits;
  private readonly hooks: EngineHooks;
  readonly devices: Devices;
  private readonly heap: Heap;
  private executed = 0;
  private peakFrames = 0;
  private returnValue: RuntimeValue | null | undefined = undefined;
  private trap: Trap | null = null;

  constructor(
    private readonly module: Module,
    inputs: readonly EntryInput[],
    opts: EngineOptions = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.hooks = opts.hooks ?? {};
    this.heap = new Heap(this.limits);
    this.devices = new Devices({
      data: module.data,
      declaredFeatures: module.features,
      ...(opts.allowedFeatures !== undefined ? { allowedFeatures: opts.allowedFeatures } : {}),
      limits: this.limits,
      ...(opts.ticks ? { ticks: opts.ticks } : {}),
    });
    const args = bindInputs(module, inputs);
    const entry = module.functions[module.entry]!;
    this.enterFunction(entry, args);
  }

  get status(): RunStatus {
    return this._status;
  }

  private enterFunction(fn: Func, args: RuntimeValue[]): boolean {
    if (this.frames.length >= this.limits.activeFrames) {
      this.fail(makeTrap("RESOURCE_EXHAUSTED", `call depth would exceed ${this.limits.activeFrames} active frames`, "frames"));
      return false;
    }
    const block = fn.blocks[0]!;
    const frame: Frame = { fn, block, vals: new Array(block.types.length), pc: 0, entryArgs: args, pendingDst: null };
    for (let i = 0; i < args.length; i++) frame.vals[i] = args[i];
    this.frames.push(frame);
    this.peakFrames = Math.max(this.peakFrames, this.frames.length);
    this.hooks.onCall?.(fn.id, args, this.frames.length - 1);
    this.hooks.onBlockEnter?.(fn.id, 0, args, args);
    return true;
  }

  private fail(t: Trap): void {
    const f = this.frames[this.frames.length - 1];
    if (f) {
      const rec = f.pc < f.block.instrs.length ? f.block.instrs[f.pc]!.rec : f.block.term.rec;
      t.recordIndex = rec;
      t.byteOffset = 32 + 16 * rec;
      t.functionId = f.fn.id;
      t.blockId = f.block.id;
    }
    this.trap = t;
    this._status = "trapped";
  }

  position() {
    const f = this.frames[this.frames.length - 1];
    if (!f) return null;
    const rec = f.pc < f.block.instrs.length ? f.block.instrs[f.pc]!.rec : f.block.term.rec;
    return { functionId: f.fn.id, blockId: f.block.id, recordIndex: rec, depth: this.frames.length - 1 };
  }

  pushTick(event: TickEvent): void {
    const err = this.devices.pushTick(event);
    if (err) throw new Error(err);
    if (this._status === "waiting-input") this._status = "paused";
  }

  cancel(): void {
    if (this._status !== "halted" && this._status !== "trapped") this._status = "cancelled";
  }

  step(): RunStatus {
    return this.run(1);
  }

  run(maxInstructions: number): RunStatus {
    if (this._status === "halted" || this._status === "trapped" || this._status === "cancelled") return this._status;
    if (this._status === "waiting-input" && this.devices.pendingTicks() === 0) return this._status;
    this._status = "running";
    for (let n = 0; n < maxInstructions; n++) {
      if (this.executed >= this.limits.executedInstructions) {
        this.fail(makeTrap("FUEL_EXHAUSTED", `executed-instruction budget of ${this.limits.executedInstructions} exhausted`, "instructions"));
        return this._status;
      }
      const f = this.frames[this.frames.length - 1]!;
      const ok = f.pc < f.block.instrs.length ? this.exec(f, f.block.instrs[f.pc]!) : this.terminate(f);
      if (!ok) return this._status; // trapped, halted, or waiting
    }
    this._status = "paused";
    return this._status;
  }

  private v(f: Frame, id: number): RuntimeValue {
    return f.vals[id]!;
  }

  private exec(f: Frame, ins: Instr): boolean {
    switch (ins.k) {
      case "const":
        f.vals[ins.dst] = ins.value;
        break;
      case "bin": {
        const r = evalBinary(ins.op, this.v(f, ins.a) as bigint, this.v(f, ins.b) as bigint);
        if (!r.ok) {
          this.fail(makeTrap("DIVIDE_BY_ZERO", `${ins.op === Op.UDIV_U64 ? "UDIV_U64" : "UREM_U64"} by zero`));
          return false;
        }
        f.vals[ins.dst] = r.value;
        break;
      }
      case "un": {
        const a = this.v(f, ins.a);
        f.vals[ins.dst] = ins.op === Op.NOT_BOOL ? !(a as boolean) : ins.op === Op.BOOL_TO_U64 ? ((a as boolean) ? 1n : 0n) : (a as bigint) !== 0n;
        break;
      }
      case "alloc": {
        const r = this.heap.alloc(ins.op === Op.ALLOC_U64 ? "u64" : "u8", this.v(f, ins.count) as bigint);
        if (!r.ok) return this.failWith(r.trap);
        f.vals[ins.dst] = r.value;
        break;
      }
      case "load": {
        const r = this.heap.load(ins.op === Op.LOAD_U64 ? "u64" : "u8", this.v(f, ins.handle), this.v(f, ins.index) as bigint);
        if (!r.ok) return this.failWith(r.trap);
        f.vals[ins.dst] = r.value;
        break;
      }
      case "store": {
        const r = this.heap.store(ins.op === Op.STORE_U64 ? "u64" : "u8", this.v(f, ins.handle), this.v(f, ins.index) as bigint, this.v(f, ins.value) as bigint);
        if (!r.ok) return this.failWith(r.trap);
        break;
      }
      case "host": {
        const out = this.devices.call(ins.imp, ins.args.map((a) => this.v(f, a) as bigint));
        if (out.kind === "wait") {
          this._status = "waiting-input";
          return false;
        }
        if (out.kind === "trap") return this.failWith(out.trap);
        if (ins.dst !== null) f.vals[ins.dst] = out.value as RuntimeValue;
        break;
      }
      case "call": {
        const callee = this.module.functions[ins.fn]!;
        const args = ins.args.map((a) => this.v(f, a));
        if (this.frames.length >= this.limits.activeFrames) {
          return this.failWith(makeTrap("RESOURCE_EXHAUSTED", `call depth would exceed ${this.limits.activeFrames} active frames`, "frames"));
        }
        f.pendingDst = ins.dst;
        f.pc++;
        this.executed++;
        return this.enterFunction(callee, args);
      }
    }
    f.pc++;
    this.executed++;
    return true;
  }

  private failWith(t: Trap): boolean {
    this.fail(t);
    return false;
  }

  private enterBlock(f: Frame, target: number, args: RuntimeValue[]): void {
    const block = f.fn.blocks[target]!;
    f.block = block;
    f.vals = new Array(block.types.length);
    for (let i = 0; i < args.length; i++) f.vals[i] = args[i];
    f.pc = 0;
    this.hooks.onBlockEnter?.(f.fn.id, block.id, args, f.entryArgs);
  }

  private terminate(f: Frame): boolean {
    const t = f.block.term;
    this.executed++;
    if (t.k === "jump") {
      // Bind all selected arguments simultaneously before leaving the block.
      const args = t.edge.args.map((a) => this.v(f, a));
      this.enterBlock(f, t.edge.target, args);
      return true;
    }
    if (t.k === "br") {
      const edge = (this.v(f, t.cond) as boolean) ? t.t : t.f;
      const args = edge.args.map((a) => this.v(f, a));
      this.enterBlock(f, edge.target, args);
      return true;
    }
    const result = t.src === null ? null : this.v(f, t.src);
    this.hooks.onReturn?.(f.fn.id, f.entryArgs, result);
    this.frames.pop();
    const caller = this.frames[this.frames.length - 1];
    if (!caller) {
      this.returnValue = result;
      this._status = "halted";
      return false;
    }
    if (caller.pendingDst !== null) caller.vals[caller.pendingDst] = result!;
    caller.pendingDst = null;
    return true;
  }

  result(): RunResult {
    const eff = this.devices.effects();
    const status = this._status === "halted" || this._status === "trapped" || this._status === "cancelled" ? this._status : "cancelled";
    return {
      engine: "reference",
      status,
      returnValue: this._status === "halted" ? toGuestValue(this.returnValue ?? null) : null,
      terminal: this.devices.terminal(),
      effects: eff.retained,
      effectCount: eff.count,
      effectsTruncated: eff.truncated,
      effectsHash: this.devices.effectsHash(),
      framebufferHash: this.devices.framebufferHash(),
      finalFramebuffer: (this.module.features & 4) !== 0 ? this.devices.framebuffer.slice() : null,
      framesPresented: this.devices.framesPresented,
      trap: this.trap,
      counters: {
        executedInstructions: this.executed,
        hostCalls: this.devices.hostCalls,
        heapBytes: this.heap.bytes,
        heapAllocations: this.heap.count,
        peakFrames: this.peakFrames,
      },
      config: null,
      traceTruncated: false,
    };
  }

  /** Current activation values, for debuggers (never used as a runtime source elsewhere). */
  peek(): { fn: number; block: number; vals: (RuntimeValue | undefined)[] }[] {
    return this.frames.map((f) => ({ fn: f.fn.id, block: f.block.id, vals: [...f.vals] }));
  }
}

export function createReferenceEngine(module: Module, inputs: readonly EntryInput[], opts?: EngineOptions): ReferenceEngine {
  return new ReferenceEngine(module, inputs, opts);
}

/** Run to completion (or until waiting for input with no queued ticks). */
export function runToCompletion(module: Module, inputs: readonly EntryInput[], opts?: EngineOptions): RunResult {
  const e = createReferenceEngine(module, inputs, opts);
  while (true) {
    const s = e.run(100_000);
    if (s === "halted" || s === "trapped" || s === "cancelled" || s === "waiting-input") break;
  }
  if (e.status === "waiting-input") e.cancel();
  return e.result();
}
