// The finite-resource machine (PRD Section 12). Every semantic operand read goes through the
// modeled storage path: logical-value directory -> fast slot or bounded backing entry -> latch.
// There is no unbounded value map, and this engine never calls the reference interpreter.
//
// Replacement policy "fifo-v1":
//  - installs/publishes use the lowest-index empty slot first;
//  - then the lowest-index slot whose value has no remaining uses (source/result physical
//    aliasing: safe because every read of this instruction is already latched);
//  - otherwise the longest-resident slot (FIFO by install stamp; hits never promote), whose
//    payload is written to backing first when it is still live.
// Operand occurrences are counted off as they are latched; reclamation (freeing the payload's
// home) happens in the consume step after publish, as Section 12.2 prescribes.

import { DEFAULT_LIMITS, Op, TYPE_NAMES, evalBinary, opName, type Limits } from "@llmtobinary/spec";
import type { Block, Func, Instr, Module } from "@llmtobinary/validate";
import { Devices, Heap, bindInputs, formatRuntimeValue, makeTrap, toGuestValue } from "@llmtobinary/devices";
import type {
  Engine,
  EngineOptions,
  EntryInput,
  MachineConfig,
  MachineCounters,
  MachineSnapshot,
  RunResult,
  RunStatus,
  RuntimeValue,
  SlotView,
  TickEvent,
  Trap,
} from "@llmtobinary/protocol";

export { bindInputs, InputError } from "@llmtobinary/devices";

export const POLICY_ID = "fifo-v1" as const;
/** Modeled bytes of directory metadata per live logical value (location, type, readiness, use count). */
export const METADATA_BYTES_PER_VALUE = 24;
/** Modeled bytes per suspended VM frame (return point, destination reservation, activation ids). */
export const METADATA_BYTES_PER_FRAME = 32;
export const PAYLOAD_BYTES = 8;
const SPAN = 65_536; // value IDs per block activation (limit valuesPerBlock)

export const DEFAULT_CONFIG: MachineConfig = { fastSlots: 16, policy: POLICY_ID, trace: false };

interface DirEntry {
  loc: 0 | 1; // 0 = fast slot, 1 = backing entry
  where: number;
  remaining: number;
  type: number;
  fnAct: number;
  blockAct: number;
  id: number;
}

interface Frame {
  fn: Func;
  block: Block;
  fnAct: number;
  blockAct: number;
  pc: number;
  pendingDst: number | null;
}

class ResourceTrap {
  constructor(readonly trap: Trap) {}
}

function emptyCounters(): MachineCounters {
  return {
    executedInstructions: 0,
    decodedRecords: 0,
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
    peakFrames: 0,
    heapBytes: 0,
    heapAllocations: 0,
    hostCalls: 0,
    hostWallTimeMs: 0,
  };
}

export class FiniteMachine implements Engine {
  readonly config: MachineConfig;
  private readonly limits: Limits;
  readonly devices: Devices;
  private readonly heap: Heap;
  private _status: RunStatus = "ready";
  private trap: Trap | null = null;
  private returnValue: RuntimeValue | null | undefined = undefined;
  readonly counters: MachineCounters = emptyCounters();

  // fast store
  private readonly F: number;
  private slotKey: number[];
  private slotPayload: RuntimeValue[];
  private slotStamp: number[];
  private clock = 0;
  private fastOccupied = 0;
  // backing store
  private readonly backingCapacity: number;
  private backingPayload: RuntimeValue[] = [];
  private backingOwner: number[] = [];
  private backingFree: number[] = [];
  private backingHigh = 0;
  private backingUsed = 0;
  // directory (metadata only; no payloads)
  private dir = new Map<number, DirEntry>();
  // latches
  private A: RuntimeValue | null = null;
  private B: RuntimeValue | null = null;
  private R: RuntimeValue | null = null;
  // bounded argument/return staging
  private staging: RuntimeValue[] = [];
  private readonly stagingCapacity: number;
  // frames
  private frames: Frame[] = [];
  private nextFnAct = 0;
  private nextBlockAct = 0;
  // consume bookkeeping for the current instruction
  private touched: number[] = [];
  // tracing
  private micro: string[] = [];
  private trace: { seq: number; text: string }[] = [];
  private traceSeq = 0;
  private traceTruncated = false;
  private readonly tracing: boolean;
  private startedAt = 0;

  constructor(
    private readonly module: Module,
    inputs: readonly EntryInput[],
    opts: EngineOptions & { config?: Partial<MachineConfig> } = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    if (!Number.isInteger(this.config.fastSlots) || this.config.fastSlots < 1 || this.config.fastSlots > 4096) throw new Error("fastSlots must be an integer in 1..4096");
    if (this.config.policy !== POLICY_ID) throw new Error(`unknown replacement policy ${this.config.policy}`);
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.tracing = this.config.trace;
    this.F = this.config.fastSlots;
    this.slotKey = new Array(this.F).fill(-1);
    this.slotPayload = new Array(this.F).fill(0n);
    this.slotStamp = new Array(this.F).fill(0);
    this.backingCapacity = Math.floor(this.limits.backingPayloadBytes / PAYLOAD_BYTES);
    this.stagingCapacity = Math.floor(this.limits.stagingPayloadBytes / PAYLOAD_BYTES);
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
    // Entry arguments arrive through staging like any call.
    try {
      for (const a of args) this.stagePush(a);
      this.pushFrame(entry, null);
    } catch (e) {
      if (e instanceof ResourceTrap) this.fail(e.trap);
      else throw e;
    }
  }

  get status(): RunStatus {
    return this._status;
  }

  // ---------------------------------------------------------------------------
  // tracing helpers

  private m(text: string): void {
    this.counters.microsteps++;
    if (this.tracing && this.micro.length < 64) this.micro.push(text);
  }

  private name(k: number): string {
    const e = this.dir.get(k);
    return e ? `f${e.fnAct}.b${e.blockAct}.v${e.id}` : `#${k}`;
  }

  // ---------------------------------------------------------------------------
  // store primitives

  private checkMetadata(): void {
    const meta = this.dir.size * METADATA_BYTES_PER_VALUE + this.frames.length * METADATA_BYTES_PER_FRAME;
    if (meta > this.limits.metadataBytes) {
      throw new ResourceTrap(makeTrap("RESOURCE_EXHAUSTED", `modeled metadata would exceed ${this.limits.metadataBytes} bytes`, "metadata"));
    }
    if (meta > this.counters.peakMetadataBytes) this.counters.peakMetadataBytes = meta;
  }

  private backingAlloc(): number {
    let idx: number;
    if (this.backingFree.length) idx = this.backingFree.pop()!;
    else if (this.backingHigh < this.backingCapacity) idx = this.backingHigh++;
    else throw new ResourceTrap(makeTrap("RESOURCE_EXHAUSTED", `backing store is full (${this.backingCapacity} entries of 8 bytes)`, "backing"));
    this.backingUsed++;
    if (this.backingUsed > this.counters.peakBackingEntries) this.counters.peakBackingEntries = this.backingUsed;
    return idx;
  }

  private backingRelease(idx: number): void {
    this.backingOwner[idx] = -1;
    this.backingPayload[idx] = 0n;
    this.backingFree.push(idx);
    this.backingUsed--;
  }

  /** Pick a slot for an install/publish; evicts (with write-back when live) if needed. */
  private takeSlot(): number {
    let empty = -1;
    let dead = -1;
    let oldest = -1;
    let oldestStamp = Infinity;
    for (let s = 0; s < this.F; s++) {
      const k = this.slotKey[s]!;
      if (k === -1) {
        empty = s;
        break;
      }
      const e = this.dir.get(k)!;
      if (e.remaining === 0 && dead === -1) dead = s;
      if (this.slotStamp[s]! < oldestStamp) {
        oldestStamp = this.slotStamp[s]!;
        oldest = s;
      }
    }
    if (empty !== -1) return empty;
    if (dead !== -1) {
      // The value has no remaining uses: reclaim now (its payload is already latched if this instruction read it).
      const k = this.slotKey[dead]!;
      this.m(`reclaim ${this.name(k)} from s${dead} (no remaining uses)`);
      this.dir.delete(k);
      this.counters.reclaimed++;
      this.slotKey[dead] = -1;
      this.fastOccupied--;
      return dead;
    }
    // Evict the longest-resident live value to backing.
    const k = this.slotKey[oldest]!;
    const e = this.dir.get(k)!;
    const b = this.backingAlloc();
    this.backingPayload[b] = this.slotPayload[oldest]!;
    this.backingOwner[b] = k;
    e.loc = 1;
    e.where = b;
    this.counters.backingWrites++;
    this.counters.backingBytesWritten += PAYLOAD_BYTES;
    this.counters.evictions++;
    this.m(`evict ${this.name(k)} s${oldest} -> backing[${b}]`);
    this.slotKey[oldest] = -1;
    this.fastOccupied--;
    return oldest;
  }

  private install(slot: number, k: number, payload: RuntimeValue): void {
    this.slotKey[slot] = k;
    this.slotPayload[slot] = payload;
    this.slotStamp[slot] = ++this.clock;
    this.fastOccupied++;
    if (this.fastOccupied > this.counters.peakFastOccupied) this.counters.peakFastOccupied = this.fastOccupied;
  }

  /** Resolve an operand through the directory and copy it into a latch; consumes one occurrence. */
  private read(k: number, latch: "A" | "B" | "R"): RuntimeValue {
    const e = this.dir.get(k);
    if (!e) throw new Error(`finite machine invariant: operand ${k} has no home`);
    this.counters.operandReads++;
    let payload: RuntimeValue;
    if (e.loc === 0) {
      this.counters.operandHits++;
      payload = this.slotPayload[e.where]!;
      this.m(`hit ${this.name(k)} s${e.where} -> ${latch}`);
    } else {
      this.counters.operandMisses++;
      const b = e.where;
      payload = this.backingPayload[b]!;
      this.counters.backingReads++;
      this.counters.backingBytesRead += PAYLOAD_BYTES;
      this.m(`miss ${this.name(k)} backing[${b}] -> ${latch}`);
      // The home moves to fast storage; the freed backing entry is available for the exchange.
      this.backingRelease(b);
      e.loc = 0;
      e.where = -1;
      const slot = this.takeSlot(); // may evict into the backing entry just freed (the F=1 exchange)
      this.install(slot, k, payload);
      e.where = slot;
      this.m(`install ${this.name(k)} -> s${slot}`);
    }
    e.remaining--;
    this.touched.push(k);
    if (latch === "A") this.A = payload;
    else if (latch === "B") this.B = payload;
    else this.R = payload;
    return payload;
  }

  /** Publish the R latch as a new logical value. */
  private publish(fnAct: number, blockAct: number, id: number, type: number, uses: number): void {
    if (this.dir.size + 1 > this.limits.activeLogicalValues) {
      throw new ResourceTrap(makeTrap("RESOURCE_EXHAUSTED", `active logical values would exceed ${this.limits.activeLogicalValues}`, "logical-values"));
    }
    const k = blockAct * SPAN + id;
    const slot = this.takeSlot();
    const e: DirEntry = { loc: 0, where: slot, remaining: uses, type, fnAct, blockAct, id };
    this.dir.set(k, e);
    this.install(slot, k, this.R!);
    this.m(`publish R -> ${this.name(k)} s${slot}`);
    this.touched.push(k);
    if (this.dir.size > this.counters.peakLiveValues) this.counters.peakLiveValues = this.dir.size;
    this.checkMetadata();
  }

  /** Step 5: reclaim values with no remaining uses among those touched; clear transients. */
  private consume(): void {
    for (const k of this.touched) {
      const e = this.dir.get(k);
      if (!e || e.remaining > 0) continue;
      this.dir.delete(k);
      this.counters.reclaimed++;
      if (e.loc === 0) {
        this.slotKey[e.where] = -1;
        this.fastOccupied--;
      } else this.backingRelease(e.where);
      this.m(`reclaim ${`f${e.fnAct}.b${e.blockAct}.v${e.id}`}`);
    }
    this.touched.length = 0;
    this.A = this.B = this.R = null;
  }

  private stagePush(v: RuntimeValue): void {
    if (this.staging.length + 1 > this.stagingCapacity) {
      throw new ResourceTrap(makeTrap("RESOURCE_EXHAUSTED", `argument staging would exceed ${this.limits.stagingPayloadBytes} bytes`, "staging"));
    }
    this.staging.push(v);
    this.m(`stage ${formatRuntimeValue(v)}`);
    const bytes = this.staging.length * PAYLOAD_BYTES;
    if (bytes > this.counters.peakStagingBytes) this.counters.peakStagingBytes = bytes;
  }

  /** Release every value of a block activation (block exit). */
  private releaseBlock(f: Frame): void {
    const base = f.blockAct * SPAN;
    const n = f.block.types.length;
    for (let id = 0; id < n; id++) {
      const k = base + id;
      const e = this.dir.get(k);
      if (!e) continue;
      this.dir.delete(k);
      this.counters.reclaimed++;
      if (e.loc === 0) {
        this.slotKey[e.where] = -1;
        this.fastOccupied--;
      } else this.backingRelease(e.where);
      this.m(`release ${`f${e.fnAct}.b${e.blockAct}.v${id}`} (block exit)`);
    }
  }

  /** Enter a block activation, installing parameters from staging. */
  private enterBlock(f: Frame, block: Block): void {
    f.block = block;
    f.blockAct = this.nextBlockAct++;
    f.pc = 0;
    const args = this.staging;
    this.staging = [];
    for (let i = 0; i < args.length; i++) {
      this.R = args[i]!;
      this.publish(f.fnAct, f.blockAct, i, block.params[i]!, block.uses[i]!);
    }
    this.consume();
  }

  private pushFrame(fn: Func, pendingInCaller: number | null): void {
    if (this.frames.length >= this.limits.activeFrames) {
      throw new ResourceTrap(makeTrap("RESOURCE_EXHAUSTED", `call depth would exceed ${this.limits.activeFrames} active frames`, "frames"));
    }
    const caller = this.frames[this.frames.length - 1];
    if (caller) caller.pendingDst = pendingInCaller;
    const f: Frame = { fn, block: fn.blocks[0]!, fnAct: this.nextFnAct++, blockAct: -1, pc: 0, pendingDst: null };
    this.frames.push(f);
    if (this.frames.length > this.counters.peakFrames) this.counters.peakFrames = this.frames.length;
    this.checkMetadata();
    this.enterBlock(f, fn.blocks[0]!);
  }

  // ---------------------------------------------------------------------------
  // execution

  private fail(t: Trap): void {
    const f = this.frames[this.frames.length - 1];
    if (f && t.recordIndex === null) {
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
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      for (let n = 0; n < maxInstructions; n++) {
        if (this.counters.executedInstructions >= this.limits.executedInstructions) {
          this.fail(makeTrap("FUEL_EXHAUSTED", `executed-instruction budget of ${this.limits.executedInstructions} exhausted`, "instructions"));
          break;
        }
        if (this.counters.microsteps >= this.limits.microsteps) {
          this.fail(makeTrap("FUEL_EXHAUSTED", `microstep budget of ${this.limits.microsteps} exhausted`, "microsteps"));
          break;
        }
        const f = this.frames[this.frames.length - 1]!;
        if (this.tracing) this.micro = [];
        let cont: boolean;
        try {
          cont = f.pc < f.block.instrs.length ? this.exec(f, f.block.instrs[f.pc]!) : this.terminate(f);
        } catch (e) {
          if (e instanceof ResourceTrap) {
            this.fail(e.trap);
            break;
          }
          throw e;
        }
        this.counters.microsteps += this.devices.takeWork();
        if (!cont) break;
      }
    } finally {
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      this.counters.hostWallTimeMs += t1 - t0;
    }
    if (this._status === "running") this._status = "paused";
    return this._status;
  }

  private key(f: Frame, id: number): number {
    return f.blockAct * SPAN + id;
  }

  private traceInstr(f: Frame, rec: number): void {
    if (!this.tracing) return;
    const r = this.module.records[rec]!;
    const text = `#${this.counters.executedInstructions} r${rec} fn${f.fn.id}.block${f.block.id} ${opName(r.op)}: ${this.micro.join("; ")}`;
    if (this.trace.length >= this.limits.traceEvents) {
      this.trace.shift();
      this.traceTruncated = true;
    }
    this.trace.push({ seq: this.traceSeq++, text });
  }

  private exec(f: Frame, ins: Instr): boolean {
    this.counters.decodedRecords++;
    switch (ins.k) {
      case "const":
        this.R = ins.value;
        this.m(`R = ${formatRuntimeValue(ins.value)}`);
        this.publish(f.fnAct, f.blockAct, ins.dst, f.block.types[ins.dst]!, f.block.uses[ins.dst]!);
        break;
      case "bin": {
        const a = this.read(this.key(f, ins.a), "A") as bigint;
        const b = this.read(this.key(f, ins.b), "B") as bigint;
        const r = evalBinary(ins.op, a, b);
        if (!r.ok) {
          this.fail(makeTrap("DIVIDE_BY_ZERO", `${opName(ins.op)} by zero`));
          return false;
        }
        this.R = r.value;
        this.m(`R = A ${opName(ins.op)} B = ${formatRuntimeValue(r.value)}`);
        this.publish(f.fnAct, f.blockAct, ins.dst, f.block.types[ins.dst]!, f.block.uses[ins.dst]!);
        break;
      }
      case "un": {
        const a = this.read(this.key(f, ins.a), "A");
        this.R = ins.op === Op.NOT_BOOL ? !(a as boolean) : ins.op === Op.BOOL_TO_U64 ? ((a as boolean) ? 1n : 0n) : (a as bigint) !== 0n;
        this.m(`R = ${opName(ins.op)}(A) = ${formatRuntimeValue(this.R)}`);
        this.publish(f.fnAct, f.blockAct, ins.dst, f.block.types[ins.dst]!, f.block.uses[ins.dst]!);
        break;
      }
      case "alloc": {
        const n = this.read(this.key(f, ins.count), "A") as bigint;
        const r = this.heap.alloc(ins.op === Op.ALLOC_U64 ? "u64" : "u8", n);
        if (!r.ok) return this.failWith(r.trap);
        this.counters.heapBytes = this.heap.bytes;
        this.counters.heapAllocations = this.heap.count;
        this.R = r.value;
        this.m(`R = alloc(${n})`);
        this.publish(f.fnAct, f.blockAct, ins.dst, f.block.types[ins.dst]!, f.block.uses[ins.dst]!);
        break;
      }
      case "load": {
        const h = this.read(this.key(f, ins.handle), "A");
        const i = this.read(this.key(f, ins.index), "B") as bigint;
        const r = this.heap.load(ins.op === Op.LOAD_U64 ? "u64" : "u8", h, i);
        if (!r.ok) return this.failWith(r.trap);
        this.R = r.value;
        this.m(`R = heap[A][B] = ${r.value}`);
        this.publish(f.fnAct, f.blockAct, ins.dst, f.block.types[ins.dst]!, f.block.uses[ins.dst]!);
        break;
      }
      case "store": {
        const h = this.read(this.key(f, ins.handle), "A");
        const i = this.read(this.key(f, ins.index), "B") as bigint;
        const v = this.read(this.key(f, ins.value), "R") as bigint;
        const r = this.heap.store(ins.op === Op.STORE_U64 ? "u64" : "u8", h, i, v);
        if (!r.ok) return this.failWith(r.trap);
        this.m(`heap[A][B] = R`);
        break;
      }
      case "host": {
        if (ins.args.length === 0 && ins.imp === 6 && this.devices.pendingTicks() === 0) {
          this._status = "waiting-input";
          return false;
        }
        for (const a of ins.args) this.stagePush(this.read(this.key(f, a), "A"));
        const out = this.devices.call(ins.imp, this.staging.splice(0) as bigint[]);
        this.counters.hostCalls = this.devices.hostCalls;
        if (out.kind === "wait") {
          this._status = "waiting-input";
          return false;
        }
        if (out.kind === "trap") return this.failWith(out.trap);
        if (ins.dst !== null) {
          this.R = out.value as RuntimeValue;
          this.m(`R = ${formatRuntimeValue(this.R)}`);
          this.publish(f.fnAct, f.blockAct, ins.dst, f.block.types[ins.dst]!, f.block.uses[ins.dst]!);
        }
        break;
      }
      case "call": {
        for (const a of ins.args) this.stagePush(this.read(this.key(f, a), "A"));
        this.consume();
        this.traceInstr(f, ins.rec);
        f.pc++;
        this.counters.executedInstructions++;
        this.m(`call fn${ins.fn}${ins.dst !== null ? ` (destination v${ins.dst} reserved)` : ""}`);
        this.pushFrame(this.module.functions[ins.fn]!, ins.dst);
        return true;
      }
    }
    this.consume();
    this.traceInstr(f, ins.rec);
    f.pc++;
    this.counters.executedInstructions++;
    return true;
  }

  private failWith(t: Trap): boolean {
    this.consume();
    this.fail(t);
    return false;
  }

  private terminate(f: Frame): boolean {
    const t = f.block.term;
    this.counters.decodedRecords++;
    if (t.k === "jump" || t.k === "br") {
      let edge = t.k === "jump" ? t.edge : null;
      if (t.k === "br") {
        const c = this.read(this.key(f, t.cond), "A") as boolean;
        edge = c ? t.t : t.f;
        this.m(`branch ${c ? "true" : "false"} -> block${edge.target}`);
      }
      for (const a of edge!.args) this.stagePush(this.read(this.key(f, a), "A"));
      this.traceInstr(f, t.rec);
      this.counters.executedInstructions++;
      this.touched.length = 0;
      this.A = this.B = this.R = null;
      this.releaseBlock(f);
      this.enterBlock(f, f.fn.blocks[edge!.target]!);
      return true;
    }
    // RETURN: transfer the result through the return buffer before releasing the callee frame.
    let result: RuntimeValue | null = null;
    if (t.src !== null) {
      result = this.read(this.key(f, t.src), "R");
      this.stagePush(result);
    }
    this.traceInstr(f, t.rec);
    this.counters.executedInstructions++;
    this.touched.length = 0;
    this.A = this.B = this.R = null;
    this.releaseBlock(f);
    this.frames.pop();
    const caller = this.frames[this.frames.length - 1];
    const buffered = this.staging.splice(0);
    if (!caller) {
      this.returnValue = result;
      this._status = "halted";
      return false;
    }
    if (caller.pendingDst !== null) {
      this.R = buffered[0]!;
      const dst = caller.pendingDst;
      this.publish(caller.fnAct, caller.blockAct, dst, caller.block.types[dst]!, caller.block.uses[dst]!);
      this.consume();
    }
    caller.pendingDst = null;
    return true;
  }

  // ---------------------------------------------------------------------------
  // results and inspection (never alter counters)

  result(): RunResult {
    const eff = this.devices.effects();
    const status = this._status === "halted" || this._status === "trapped" || this._status === "cancelled" ? this._status : "cancelled";
    return {
      engine: "finite",
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
      counters: { ...this.counters },
      config: { ...this.config },
      traceTruncated: this.traceTruncated,
    };
  }

  snapshot(): MachineSnapshot {
    const slots: SlotView[] = [];
    for (let s = 0; s < this.F; s++) {
      const k = this.slotKey[s]!;
      const e = k === -1 ? undefined : this.dir.get(k);
      slots.push({
        index: s,
        value: e ? `f${e.fnAct}.b${e.blockAct}.v${e.id}` : null,
        payload: e ? formatRuntimeValue(this.slotPayload[s]) : null,
        type: e ? TYPE_NAMES[e.type as 0 | 1 | 2 | 3 | 4] : null,
        insertedAt: e ? this.slotStamp[s]! : null,
        remainingUses: e ? e.remaining : null,
      });
    }
    const sample: { entry: number; value: string; payload: string }[] = [];
    for (let i = 0; i < this.backingHigh && sample.length < 64; i++) {
      const k = this.backingOwner[i];
      if (k === undefined || k === -1) continue;
      sample.push({ entry: i, value: this.name(k), payload: formatRuntimeValue(this.backingPayload[i]) });
    }
    const liveByAct = new Map<number, number>();
    for (const e of this.dir.values()) liveByAct.set(e.blockAct, (liveByAct.get(e.blockAct) ?? 0) + 1);
    return {
      status: this._status,
      position: this.position(),
      config: { ...this.config },
      slots,
      latches: { A: this.A === null ? null : formatRuntimeValue(this.A), B: this.B === null ? null : formatRuntimeValue(this.B), R: this.R === null ? null : formatRuntimeValue(this.R) },
      backing: { used: this.backingUsed, capacity: this.backingCapacity, sample },
      staging: { usedBytes: this.staging.length * PAYLOAD_BYTES, capacityBytes: this.limits.stagingPayloadBytes },
      frames: this.frames.map((f) => ({ functionId: f.fn.id, blockId: f.block.id, blockActivation: f.blockAct, liveValues: liveByAct.get(f.blockAct) ?? 0 })),
      liveValues: this.dir.size,
      counters: { ...this.counters },
      lastMicrosteps: [...this.micro],
      trace: this.trace.slice(-200),
      traceTruncated: this.traceTruncated || this.trace.length > 200,
    };
  }
}

export function createFiniteMachine(module: Module, inputs: readonly EntryInput[], opts: EngineOptions & { config?: Partial<MachineConfig> } = {}): FiniteMachine {
  return new FiniteMachine(module, inputs, opts);
}

export function runFinite(module: Module, inputs: readonly EntryInput[], opts: EngineOptions & { config?: Partial<MachineConfig> } = {}): RunResult {
  const m = createFiniteMachine(module, inputs, opts);
  while (true) {
    const s = m.run(100_000);
    if (s === "halted" || s === "trapped" || s === "cancelled" || s === "waiting-input") break;
  }
  if (m.status === "waiting-input") m.cancel();
  return m.result();
}
