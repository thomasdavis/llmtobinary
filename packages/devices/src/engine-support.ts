// Engine-neutral support shared by the reference interpreter and the finite machine:
// the typed run heap (Section 10.5), entry-input binding (Section 11), and value conversion.

import { DEFAULT_LIMITS, TypeTag, formatU64, parseU64Decimal, type Limits } from "@llmtobinary/spec";
import type { Module } from "@llmtobinary/validate";
import type { EntryInput, GuestValue, RuntimeValue, Trap } from "@llmtobinary/protocol";
import { makeTrap } from "./index.ts";

export type HeapResult<T> = { ok: true; value: T } | { ok: false; trap: Trap };

interface Allocation {
  elem: "u8" | "u64";
  u64?: BigUint64Array;
  u8?: Uint8Array;
}

/**
 * Run-owned, typed, zero-initialized heap. Counts and indexes are checked as u64 before
 * conversion. No integer-to-handle casts, raw addresses, or manual free exist.
 */
export class Heap {
  private allocs = new Map<number, Allocation>();
  private nextHandle = 1;
  bytes = 0;
  count = 0;
  private readonly limits: Limits;

  constructor(limits: Partial<Limits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  alloc(elem: "u8" | "u64", n: bigint): HeapResult<RuntimeValue> {
    const size = elem === "u64" ? 8n : 1n;
    if (this.count + 1 > this.limits.heapAllocations) {
      return { ok: false, trap: makeTrap("RESOURCE_EXHAUSTED", `heap allocation count would exceed ${this.limits.heapAllocations}`, "heap-allocations") };
    }
    if (n * size > BigInt(this.limits.heapPayloadBytes - this.bytes)) {
      return { ok: false, trap: makeTrap("RESOURCE_EXHAUSTED", `allocating ${n} ${elem} elements would exceed the ${this.limits.heapPayloadBytes}-byte heap`, "heap-bytes") };
    }
    const len = Number(n);
    const a: Allocation = elem === "u64" ? { elem, u64: new BigUint64Array(len) } : { elem, u8: new Uint8Array(len) };
    const handle = this.nextHandle++;
    this.allocs.set(handle, a);
    this.bytes += len * Number(size);
    this.count++;
    return { ok: true, value: { handle, elem } };
  }

  private get(h: RuntimeValue, elem: "u8" | "u64"): HeapResult<Allocation> {
    if (typeof h !== "object" || h === null) return { ok: false, trap: makeTrap("INVALID_HANDLE", "value is not a handle") };
    const a = this.allocs.get(h.handle);
    if (!a || a.elem !== elem || h.elem !== elem) return { ok: false, trap: makeTrap("INVALID_HANDLE", `handle #${h.handle} is not a live handle<${elem}> of this run`) };
    return { ok: true, value: a };
  }

  private index(a: Allocation, i: bigint): HeapResult<number> {
    const len = a.elem === "u64" ? a.u64!.length : a.u8!.length;
    if (i >= BigInt(len)) return { ok: false, trap: makeTrap("BOUNDS", `index ${i} is outside a ${len}-element handle<${a.elem}> allocation`) };
    return { ok: true, value: Number(i) };
  }

  load(elem: "u8" | "u64", h: RuntimeValue, i: bigint): HeapResult<bigint> {
    const a = this.get(h, elem);
    if (!a.ok) return a;
    const ix = this.index(a.value, i);
    if (!ix.ok) return ix;
    return { ok: true, value: elem === "u64" ? a.value.u64![ix.value]! : BigInt(a.value.u8![ix.value]!) };
  }

  store(elem: "u8" | "u64", h: RuntimeValue, i: bigint, v: bigint): HeapResult<null> {
    const a = this.get(h, elem);
    if (!a.ok) return a;
    const ix = this.index(a.value, i);
    if (!ix.ok) return ix;
    if (elem === "u8") {
      if (v > 255n) return { ok: false, trap: makeTrap("BOUNDS", `u8 store value ${v} is outside 0..255`) };
      a.value.u8![ix.value] = Number(v);
    } else a.value.u64![ix.value] = v;
    return { ok: true, value: null };
  }
}

export class InputError extends Error {}

/** Bind public entry inputs to the entry signature exactly (Section 11). Throws InputError. */
export function bindInputs(module: Module, inputs: readonly EntryInput[]): RuntimeValue[] {
  const entry = module.functions[module.entry];
  if (!entry) throw new InputError("module has no entry function");
  if (inputs.length !== entry.params.length) {
    throw new InputError(`entry function takes ${entry.params.length} input${entry.params.length === 1 ? "" : "s"}; got ${inputs.length}`);
  }
  return entry.params.map((t, i) => {
    const inp = inputs[i]!;
    if (t === TypeTag.U64) {
      if (inp.t !== "u64" || typeof inp.v !== "string") throw new InputError(`input ${i} must be a u64 decimal string`);
      const v = parseU64Decimal(inp.v);
      if (v === null) throw new InputError(`input ${i} (${JSON.stringify(inp.v)}) is not a canonical u64: no signs, fractions, exponents, whitespace, or values above 18446744073709551615`);
      return v;
    }
    if (t === TypeTag.BOOL) {
      if (inp.t !== "bool" || typeof inp.v !== "boolean") throw new InputError(`input ${i} must be a bool`);
      return inp.v;
    }
    throw new InputError(`entry parameter ${i} has a non-public type`);
  });
}

/** Parse loose user text into an EntryInput list for a signature (UI helper). */
export function parseInputs(module: Module, texts: readonly string[]): EntryInput[] {
  const entry = module.functions[module.entry]!;
  return entry.params.map((t, i) => {
    const s = (texts[i] ?? "").trim();
    if (t === TypeTag.BOOL) {
      if (s !== "true" && s !== "false") throw new InputError(`input ${i} must be true or false`);
      return { t: "bool", v: s === "true" };
    }
    return { t: "u64", v: s };
  });
}

export function toGuestValue(v: RuntimeValue | null | undefined): GuestValue {
  if (v === null || v === undefined) return { t: "unit" };
  if (typeof v === "bigint") return { t: "u64", v: formatU64(v) };
  if (typeof v === "boolean") return { t: "bool", v };
  return { t: "handle", elem: v.elem, id: v.handle };
}

export function formatGuestValue(v: GuestValue | null): string {
  if (!v) return "—";
  switch (v.t) {
    case "u64": return v.v;
    case "bool": return String(v.v);
    case "handle": return `handle<${v.elem}>#${v.id}`;
    case "unit": return "()";
  }
}

export function formatRuntimeValue(v: RuntimeValue | undefined | null): string {
  if (v === undefined || v === null) return "∅";
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "boolean") return String(v);
  return `handle<${v.elem}>#${v.handle}`;
}
