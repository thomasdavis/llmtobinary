// The ANMA-2 machine (spec/anma-2.md §5). The host stays a dumb device: it offers keys, sectors,
// validated program loading and isolated tasks. Files, the shell and scheduling are guest bytes.
//
// A task runs in its own engine with its own heap, so a trap ends that engine and nothing else.
// task.resume runs the child synchronously, one instruction at a time, so a yield lands at an exact
// point and a whole session replays identically from its keys, disk image and generation record.

import { Feature, Feature2 } from "@llmtobinary/spec";
import { validateBytes, type Module } from "@llmtobinary/validate";
import type { Heap, HostExtension, HostOutcome } from "@llmtobinary/devices";
import { makeTrap } from "@llmtobinary/devices";
import { ReferenceEngine } from "@llmtobinary/reference";
import { FiniteMachine, createFiniteMachine } from "@llmtobinary/runtime";
import type { RuntimeValue } from "@llmtobinary/protocol";

type Engine = ReferenceEngine | FiniteMachine;
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export const SECTOR_BYTES = 512;
export const TaskStatus = { EXITED: 0, YIELDED: 1, TRAPPED: 2, OUT_OF_FUEL: 3 } as const;
export const GenStatus = { PENDING: 0, READY: 1, FAILED: 2 } as const;

/** What a user program may do. No block device, no task control and no generation. */
const CHILD_FEATURES = Feature.HEAP | Feature.TERMINAL | Feature2.TEXT | Feature2.SYSCALL;
/** The kernel is the one holder of the machine's capabilities. */
export const KERNEL_FEATURES = Feature.HEAP | Feature.TERMINAL | Feature2.TEXT | Feature2.BLOCK | Feature2.TASKS | Feature2.GEN;

export type EngineKind = "reference" | "finite";

export interface GenProvider {
  request(prompt: Uint8Array): number;
  poll(job: number): { status: number; bytes?: Uint8Array };
}

export interface OsOptions {
  kernel: Module;
  disk: Uint8Array;
  keys?: readonly number[];
  engine?: EngineKind;
  fuel?: number;
  gen?: GenProvider;
  onWrite?: (sector: number, disk: Uint8Array) => void;
  /** Test harness only: call one function directly, with arguments built on the kernel's heap. */
  call?: { fn: number; args(heap: Heap): RuntimeValue[] };
  /** Test harness only: features granted to the entry module, instead of the kernel's. */
  features?: number;
}

interface Task {
  engine: Engine;
  fuel: number;
  ext: ChildExt;
  /** The child's own mailbox while it is suspended in task.yield. */
  mailbox: RuntimeValue | null;
  /** How much of the child's terminal has reached the console. */
  printed: number;
  finished: boolean;
}

function readBuffer(heap: Heap, h: RuntimeValue, length: number): Uint8Array | { trap: HostOutcome } {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const r = heap.load("u8", h, BigInt(i));
    if (!r.ok) return { trap: { kind: "trap", trap: r.trap } };
    out[i] = Number(r.value);
  }
  return out;
}

function writeBuffer(heap: Heap, h: RuntimeValue, bytes: Uint8Array): HostOutcome | null {
  for (let i = 0; i < bytes.length; i++) {
    const r = heap.store("u8", h, BigInt(i), BigInt(bytes[i]!));
    if (!r.ok) return { kind: "trap", trap: r.trap };
  }
  return null;
}

const asNumber = (v: RuntimeValue): number | null => (typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null);
const ok = (value: bigint | null = null): HostOutcome => ({ kind: "ok", value });
const bounds = (message: string): HostOutcome => ({ kind: "trap", trap: makeTrap("BOUNDS", message) });

function newEngine(kind: EngineKind, module: Module, fuel: number, features: number, heapBytes?: number, call?: OsOptions["call"]): Engine {
  const opts = { allowedFeatures: features, ...(call ? { call: call as never } : {}), limits: { executedInstructions: fuel, microsteps: Number.MAX_SAFE_INTEGER, ...(heapBytes ? { heapPayloadBytes: heapBytes } : {}) } };
  return kind === "finite" ? createFiniteMachine(module, [], opts) : new ReferenceEngine(module, [], opts);
}

class ChildExt implements HostExtension {
  yielded: { code: number; bytes: Uint8Array } | null = null;
  task: Task | null = null;

  constructor(private readonly machine: OsMachine) {}

  pending(): number {
    return 0;
  }

  call(id: number, args: readonly RuntimeValue[], heap: Heap): HostOutcome {
    if (id === 8) return this.machine.printBytes(args, heap);
    if (id === 16) {
      const code = asNumber(args[1]!);
      const size = this.machine.mailboxSize(args[0]!, heap);
      if (code === null || size === null) return bounds("task.yield needs a mailbox and a small code");
      const bytes = readBuffer(heap, args[0]!, size);
      if (!(bytes instanceof Uint8Array)) return bytes.trap;
      this.yielded = { code, bytes };
      this.task!.mailbox = args[0]!;
      return ok();
    }
    return { kind: "trap", trap: makeTrap("CAPABILITY_DENIED", "a user program cannot use this device") };
  }
}

export class OsMachine implements HostExtension {
  private readonly kernel: Engine;
  private readonly keys: number[];
  private readonly modules: Module[] = [];
  private readonly tasks: Task[] = [];
  private readonly kind: EngineKind;
  readonly disk: Uint8Array;
  readonly genLog: { op: "request" | "poll"; job: number; status?: number; bytes?: string }[] = [];
  flushes = 0;

  constructor(private readonly opts: OsOptions) {
    this.kind = opts.engine ?? "reference";
    this.disk = opts.disk.slice();
    this.keys = [...(opts.keys ?? [])];
    this.kernel = newEngine(this.kind, opts.kernel, opts.fuel ?? 50_000_000, opts.features ?? KERNEL_FEATURES, undefined, opts.call);
    this.kernel.devices.ext = this;
  }

  pending(): number {
    return this.keys.length;
  }

  /** Runs until the kernel halts, traps, or waits for a key that has not arrived. */
  run(maxInstructions = 50_000_000): string {
    return this.kernel.run(maxInstructions);
  }

  pushKeys(keys: readonly number[]): void {
    this.keys.push(...keys);
  }

  /** Test harness only: read back a buffer after a run. */
  buffer(h: RuntimeValue, length: number): Uint8Array {
    const r = readBuffer(this.kernel.devices.heap!, h, length);
    return r instanceof Uint8Array ? r : new Uint8Array();
  }

  terminal(): string {
    return new TextDecoder().decode(this.kernel.devices.terminal());
  }

  result() {
    return this.kernel.result();
  }

  printBytes(args: readonly RuntimeValue[], heap: Heap): HostOutcome {
    const offset = asNumber(args[1]!);
    const length = asNumber(args[2]!);
    if (offset === null || length === null || length > 1 << 20) return bounds("print_bytes range is too large");
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const r = heap.load("u8", args[0]!, BigInt(offset + i));
      if (!r.ok) return { kind: "trap", trap: r.trap };
      out[i] = Number(r.value);
    }
    return this.kernel.devices.writeBytes(out) ?? ok();
  }

  /** How many bytes a mailbox holds, found by probing, because a handle's length is not a guest value. */
  mailboxSize(h: RuntimeValue, heap: Heap): number | null {
    return heap.lengthOf(h);
  }

  call(id: number, args: readonly RuntimeValue[], heap: Heap): HostOutcome {
    switch (id) {
      case 7: {
        const k = this.keys.shift();
        return k === undefined ? { kind: "wait" } : ok(BigInt(k));
      }
      case 8:
        return this.printBytes(args, heap);
      case 9:
        return ok(BigInt(this.disk.length / SECTOR_BYTES));
      case 10:
      case 11: {
        const sector = asNumber(args[0]!);
        if (sector === null || (sector + 1) * SECTOR_BYTES > this.disk.length) return bounds(`sector ${String(args[0])} is outside the disk`);
        const at = sector * SECTOR_BYTES;
        if (id === 10) return writeBuffer(heap, args[1]!, this.disk.subarray(at, at + SECTOR_BYTES)) ?? ok();
        const bytes = readBuffer(heap, args[1]!, SECTOR_BYTES);
        if (!(bytes instanceof Uint8Array)) return bytes.trap;
        this.disk.set(bytes, at);
        this.opts.onWrite?.(sector, this.disk);
        return ok();
      }
      case 12:
        this.flushes++;
        return ok();
      case 13: {
        const length = asNumber(args[1]!);
        if (length === null || length > 1 << 20) return ok(0n);
        const bytes = readBuffer(heap, args[0]!, length);
        if (!(bytes instanceof Uint8Array)) return bytes.trap;
        const v = validateBytes(bytes, { anma2: true, allowedFeatures: CHILD_FEATURES });
        if (!v.ok || !v.module) return ok(0n);
        this.modules.push(v.module);
        return ok(BigInt(this.modules.length));
      }
      case 14: {
        const module = this.modules[(asNumber(args[0]!) ?? 0) - 1];
        const fuel = asNumber(args[1]!);
        const heapBytes = asNumber(args[2]!);
        if (!module || fuel === null || heapBytes === null) return ok(0n);
        if (module.functions[module.entry]!.params.length !== 0) return ok(0n);
        const ext = new ChildExt(this);
        const engine = newEngine(this.kind, module, fuel, CHILD_FEATURES, heapBytes);
        engine.devices.ext = ext;
        const task: Task = { engine, fuel, ext, mailbox: null, printed: 0, finished: false };
        ext.task = task;
        this.tasks.push(task);
        return ok(BigInt(this.tasks.length));
      }
      case 15:
        return this.resume(args, heap);
      case 17:
      case 18:
      case 19:
        return this.generation(id, args, heap);
      default:
        return { kind: "trap", trap: makeTrap("CAPABILITY_DENIED", `import ${id} is not available to the kernel`) };
    }
  }

  private resume(args: readonly RuntimeValue[], heap: Heap): HostOutcome {
    const task = this.tasks[(asNumber(args[0]!) ?? 0) - 1];
    if (!task) return bounds("task.resume names no task");
    if (task.finished) return ok(BigInt(TaskStatus.EXITED));
    const size = heap.lengthOf(args[1]!);
    if (size === null) return bounds("task.resume needs a mailbox");
    const inbox = readBuffer(heap, args[1]!, size);
    if (!(inbox instanceof Uint8Array)) return inbox.trap;
    if (task.mailbox !== null) {
      const childHeap = task.engine.devices.heap!;
      const limit = Math.min(inbox.length, childHeap.lengthOf(task.mailbox) ?? 0);
      const w = writeBuffer(childHeap, task.mailbox, inbox.subarray(0, limit));
      if (w) return ok(BigInt(TaskStatus.TRAPPED));
    }
    for (;;) {
      const status = task.engine.run(1);
      // A task has its own devices, so its terminal output is carried to the console here.
      if (task.engine.devices.terminalLength() > task.printed) {
        const shown = task.engine.devices.terminal();
        const failed = this.kernel.devices.writeBytes(shown.subarray(task.printed));
        task.printed = shown.length;
        if (failed) return failed;
      }
      if (task.ext.yielded) {
        const y = task.ext.yielded;
        task.ext.yielded = null;
        const w = writeBuffer(heap, args[1]!, y.bytes.subarray(0, size));
        if (w) return w;
        return ok(BigInt(TaskStatus.YIELDED) | (BigInt(y.code) << 8n));
      }
      if (status === "paused" || status === "running") continue;
      task.finished = true;
      if (status === "halted") return ok(BigInt(TaskStatus.EXITED));
      const r = task.engine.result();
      return ok(BigInt(r.trap?.code === "FUEL_EXHAUSTED" ? TaskStatus.OUT_OF_FUEL : TaskStatus.TRAPPED));
    }
  }

  private generation(id: number, args: readonly RuntimeValue[], heap: Heap): HostOutcome {
    const gen = this.opts.gen;
    if (!gen) return ok(id === 17 ? 0n : BigInt(GenStatus.FAILED));
    if (id === 17) {
      const length = asNumber(args[1]!);
      if (length === null || length > 16_000) return ok(0n);
      const prompt = readBuffer(heap, args[0]!, length);
      if (!(prompt instanceof Uint8Array)) return prompt.trap;
      const job = gen.request(prompt);
      this.genLog.push({ op: "request", job });
      return ok(BigInt(job));
    }
    const job = asNumber(args[0]!) ?? 0;
    const r = gen.poll(job);
    this.genLog.push({ op: "poll", job, status: r.status, ...(r.bytes ? { bytes: toHex(r.bytes) } : {}) });
    if (id === 18) return ok(BigInt(r.status));
    if (r.status !== GenStatus.READY || !r.bytes) return ok(0n);
    const w = writeBuffer(heap, args[1]!, r.bytes);
    return w ?? ok(BigInt(r.bytes.length));
  }
}

/** Replays a recorded generation log, so a replay never calls a model. */
export function replayGen(log: OsMachine["genLog"]): GenProvider {
  const queue = [...log];
  return {
    request() {
      return queue.shift()?.job ?? 0;
    },
    poll() {
      const e = queue.shift();
      return { status: e?.status ?? GenStatus.FAILED, ...(e?.bytes ? { bytes: Uint8Array.from(e.bytes.match(/../g) ?? [], (x) => parseInt(x, 16)) } : {}) };
    },
  };
}
