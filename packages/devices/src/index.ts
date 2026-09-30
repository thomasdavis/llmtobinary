// Virtual peripherals (PRD Section 13) shared by the reference interpreter and the finite machine.
// Host calls are small device operations; algorithms, animation state, and pixel decisions stay
// in guest code. Nothing here can reach the DOM, the network, or JavaScript evaluation.

import { DEFAULT_LIMITS, FRAMEBUFFER_HEIGHT, FRAMEBUFFER_WIDTH, IMPORTS, KEYS, U64_MASK, parseU64Decimal, type Limits } from "@llmtobinary/spec";
import { ruleInfo } from "@llmtobinary/diagnostics";
import type { Effect, TickEvent, Trap, TrapCode } from "@llmtobinary/protocol";
import { Sha256, sha256HexSync } from "./sha256.ts";

export { Sha256, sha256HexSync };

export type HostOutcome = { kind: "ok"; value: bigint | boolean | null } | { kind: "trap"; trap: Trap } | { kind: "wait" };

const RULE_FOR: Record<TrapCode, string> = {
  DIVIDE_BY_ZERO: "ANMA-R-001",
  BOUNDS: "ANMA-R-002",
  INVALID_HANDLE: "ANMA-R-003",
  CAPABILITY_DENIED: "ANMA-R-004",
  RESOURCE_EXHAUSTED: "ANMA-R-005",
  FUEL_EXHAUSTED: "ANMA-R-006",
  INVALID_UTF8: "ANMA-R-007",
};

export function makeTrap(code: TrapCode, message: string, resource?: string): Trap {
  const rule = RULE_FOR[code];
  ruleInfo(rule);
  return { code, rule, message, recordIndex: null, byteOffset: null, functionId: null, blockId: null, ...(resource ? { resource } : {}) };
}

export interface DevicesOptions {
  data: Uint8Array;
  /** Features declared in the header. */
  declaredFeatures: number;
  /** Host policy; defaults to granting every declared feature. */
  allowedFeatures?: number;
  limits?: Partial<Limits>;
  ticks?: TickEvent[];
}

/** Maximum effects retained verbatim for display; the hash always covers every effect. */
export const EFFECTS_RETAINED = 2000;

const FB_BYTES = FRAMEBUFFER_WIDTH * FRAMEBUFFER_HEIGHT * 4;
/** Modeled work charged per 64 pixels touched by a full-buffer operation. */
const PIXELS_PER_WORK_UNIT = 64;

interface QueuedTick {
  tick: bigint;
  keys: number;
}

export class Devices {
  private readonly data: Uint8Array;
  private readonly allowed: number;
  private readonly limits: Limits;
  private terminalChunks: Uint8Array[] = [];
  private terminalLen = 0;
  readonly framebuffer = new Uint8Array(FB_BYTES);
  private presented: Uint8Array | null = null;
  framesPresented = 0;
  private queue: QueuedTick[] = [];
  private lastQueuedTick: bigint | null = null;
  private latchedMask = 0;
  private effectHasher = new Sha256();
  private effectCount = 0;
  private retained: Effect[] = [];
  private pendingWork = 0;
  hostCalls = 0;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(opts: DevicesOptions) {
    this.data = opts.data;
    this.allowed = opts.allowedFeatures ?? opts.declaredFeatures;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    for (const t of opts.ticks ?? []) {
      const err = this.pushTick(t);
      if (err) throw new Error(`invalid recorded tick: ${err}`);
    }
  }

  /** Queue a tick event. Returns an error string when the event is rejected. */
  pushTick(e: TickEvent): string | null {
    const tick = parseU64Decimal(e.tick);
    if (tick === null) return "tick must be a canonical u64 decimal string";
    if (!Number.isInteger(e.keys) || e.keys < 0 || e.keys >= 1 << KEYS.length) return `key mask must be an integer in 0..${(1 << KEYS.length) - 1}`;
    if (this.lastQueuedTick !== null && tick <= this.lastQueuedTick) return "tick numbers must be strictly increasing";
    if (this.queue.length >= this.limits.inputEvents) return `input event queue is full (${this.limits.inputEvents})`;
    this.queue.push({ tick, keys: e.keys });
    this.lastQueuedTick = tick;
    return null;
  }

  pendingTicks(): number {
    return this.queue.length;
  }

  /** Modeled work units produced since the last call (charged to microsteps by engines). */
  takeWork(): number {
    const w = this.pendingWork;
    this.pendingWork = 0;
    return w;
  }

  private record(importId: number, args: readonly bigint[], result: bigint | boolean | null): void {
    const e: Effect = {
      seq: this.effectCount,
      importId,
      args: args.map((a) => a.toString(10)),
      result: result === null ? null : typeof result === "boolean" ? String(result) : result.toString(10),
    };
    this.effectHasher.update(new TextEncoder().encode(`${e.seq}:${e.importId}:${e.args.join(",")}:${e.result ?? ""}\n`));
    this.effectCount++;
    if (this.retained.length < EFFECTS_RETAINED) this.retained.push(e);
  }

  /**
   * Perform one host call. Arguments are already type-checked u64 values (bool results are
   * returned as booleans). Traps carry no position; engines fill it in.
   */
  call(importId: number, args: readonly bigint[]): HostOutcome {
    const imp = IMPORTS[importId];
    if (!imp) return { kind: "trap", trap: makeTrap("BOUNDS", `unknown import ${importId}`) };
    if ((this.allowed & imp.feature) === 0) {
      return { kind: "trap", trap: makeTrap("CAPABILITY_DENIED", `${imp.name} is not permitted by the host capability policy`) };
    }
    this.hostCalls++;
    switch (importId) {
      case 0: {
        const text = new TextEncoder().encode(args[0]!.toString(10));
        const t = this.writeTerminal(text);
        if (t) return t;
        this.record(importId, args, null);
        return { kind: "ok", value: null };
      }
      case 1: {
        const off = args[0]!;
        const len = args[1]!;
        if (off > BigInt(this.data.length) || len > BigInt(this.data.length) - off) {
          return { kind: "trap", trap: makeTrap("BOUNDS", `print_utf8 range [${off}, ${off + len}) is outside the ${this.data.length}-byte data section`) };
        }
        const slice = this.data.subarray(Number(off), Number(off + len));
        try {
          this.utf8.decode(slice);
        } catch {
          return { kind: "trap", trap: makeTrap("INVALID_UTF8", `data bytes [${off}, ${off + len}) are not valid UTF-8`) };
        }
        const t = this.writeTerminal(slice);
        if (t) return t;
        this.pendingWork += Math.ceil(slice.length / 8);
        this.record(importId, args, null);
        return { kind: "ok", value: null };
      }
      case 2: {
        const rgba = args[0]!;
        if (rgba > 0xffffffffn) return { kind: "trap", trap: makeTrap("BOUNDS", `colour ${rgba} has bits above the low 32`) };
        const c = Number(rgba);
        const r = c >>> 24, g = (c >>> 16) & 255, b = (c >>> 8) & 255, a = c & 255;
        const fb = this.framebuffer;
        for (let i = 0; i < FB_BYTES; i += 4) {
          fb[i] = r;
          fb[i + 1] = g;
          fb[i + 2] = b;
          fb[i + 3] = a;
        }
        this.pendingWork += (FRAMEBUFFER_WIDTH * FRAMEBUFFER_HEIGHT) / PIXELS_PER_WORK_UNIT;
        this.record(importId, args, null);
        return { kind: "ok", value: null };
      }
      case 3: {
        const [x, y, rgba] = args as [bigint, bigint, bigint];
        if (x >= BigInt(FRAMEBUFFER_WIDTH) || y >= BigInt(FRAMEBUFFER_HEIGHT)) {
          return { kind: "trap", trap: makeTrap("BOUNDS", `pixel (${x}, ${y}) is outside the ${FRAMEBUFFER_WIDTH}x${FRAMEBUFFER_HEIGHT} framebuffer`) };
        }
        if (rgba > 0xffffffffn) return { kind: "trap", trap: makeTrap("BOUNDS", `colour ${rgba} has bits above the low 32`) };
        const c = Number(rgba);
        const i = (Number(y) * FRAMEBUFFER_WIDTH + Number(x)) * 4;
        this.framebuffer[i] = c >>> 24;
        this.framebuffer[i + 1] = (c >>> 16) & 255;
        this.framebuffer[i + 2] = (c >>> 8) & 255;
        this.framebuffer[i + 3] = c & 255;
        this.record(importId, args, null);
        return { kind: "ok", value: null };
      }
      case 4: {
        this.presented = this.framebuffer.slice();
        this.framesPresented++;
        this.pendingWork += (FRAMEBUFFER_WIDTH * FRAMEBUFFER_HEIGHT) / PIXELS_PER_WORK_UNIT;
        this.record(importId, args, null);
        return { kind: "ok", value: null };
      }
      case 5: {
        const k = args[0]!;
        if (k >= BigInt(KEYS.length)) return { kind: "trap", trap: makeTrap("BOUNDS", `key ID ${k} is not in the key registry (0..${KEYS.length - 1})`) };
        const down = ((this.latchedMask >>> Number(k)) & 1) === 1;
        this.record(importId, args, down);
        return { kind: "ok", value: down };
      }
      case 6: {
        const ev = this.queue.shift();
        if (!ev) {
          this.hostCalls--; // the call re-executes when an event arrives
          return { kind: "wait" };
        }
        this.latchedMask = ev.keys;
        this.record(importId, args, ev.tick);
        return { kind: "ok", value: ev.tick & U64_MASK };
      }
      default:
        return { kind: "trap", trap: makeTrap("BOUNDS", `unknown import ${importId}`) };
    }
  }

  private writeTerminal(bytes: Uint8Array): HostOutcome | null {
    if (this.terminalLen + bytes.length > this.limits.terminalBytes) {
      return { kind: "trap", trap: makeTrap("RESOURCE_EXHAUSTED", `terminal output would exceed ${this.limits.terminalBytes} bytes`, "terminal") };
    }
    this.terminalChunks.push(bytes.slice());
    this.terminalLen += bytes.length;
    return null;
  }

  terminal(): Uint8Array {
    const out = new Uint8Array(this.terminalLen);
    let o = 0;
    for (const c of this.terminalChunks) {
      out.set(c, o);
      o += c.length;
    }
    if (this.terminalChunks.length > 1) this.terminalChunks = [out];
    return out;
  }

  terminalLength(): number {
    return this.terminalLen;
  }

  /** The most recently presented frame (bounded copy), or null. */
  presentedFrame(): Uint8Array | null {
    return this.presented;
  }

  effects(): { retained: Effect[]; count: number; truncated: boolean } {
    return { retained: this.retained, count: this.effectCount, truncated: this.effectCount > this.retained.length };
  }

  /** SHA-256 over the canonical serialization of every effect so far (does not disturb the running hash). */
  effectsHash(): string {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(this.effectHasher)), this.effectHasher) as Sha256;
    // deep-copy internal typed arrays so digest() does not mutate the live hasher
    for (const k of Object.keys(clone) as (keyof Sha256)[]) {
      const v = (clone as unknown as Record<string, unknown>)[k as string];
      if (v instanceof Uint32Array || v instanceof Uint8Array) (clone as unknown as Record<string, unknown>)[k as string] = v.slice();
    }
    let s = "";
    for (const b of clone.digest()) s += b.toString(16).padStart(2, "0");
    return s;
  }

  /** Hash of the authoritative framebuffer (not the presented copy). */
  framebufferHash(): string {
    return sha256HexSync(this.framebuffer);
  }
}

export * from "./engine-support.ts";
