import { describe, expect, it } from "vitest";
import { Feature, Feature2, Op } from "@llmtobinary/spec";
import { mustValidate, validateBytes } from "@llmtobinary/validate";
import { GenStatus, KERNEL_FEATURES, OsMachine, SECTOR_BYTES, TaskStatus, replayGen, type EngineKind } from "../src/index.ts";

type Rec = [number, number, number, number];
const UNIT = 0xffffffff;

function image(version: number, features: number, recs: Rec[]): Uint8Array {
  const words = [0x414d4e41, version, features, recs.length, 0, 0, 0, 0, ...recs.flat()];
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0, true));
  return out;
}
const wrap = (locals: number, body: Rec[], ret = 1): Rec[] => [[Op.FUNC, 0, 0, ret], [Op.BLOCK, 0, 0, locals], ...body, [Op.END_FUNC, 0, 0, 0]];
const host = (dst: number, id: number, args: number[]): Rec[] => [[Op.HOST, dst, id, args.length], ...args.map((a): Rec => [Op.ARG, a, 0, 0])];
const c = (dst: number, v: number): Rec => [Op.CONST_U64, dst, v, 0];

function kernel(recs: Rec[]) {
  return mustValidate(image(2, KERNEL_FEATURES, recs), { anma2: true });
}

// Child programs live on the disk at sector 0.
const trapChild = image(1, 0, wrap(3, [c(0, 1), c(1, 0), [Op.UDIV_U64, 2, 0, 1], [Op.RETURN, 2, 0, 0]]));
const okChild = image(1, 0, wrap(1, [c(0, 7), [Op.RETURN, 0, 0, 0]]));
const spinChild = image(1, 0, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 0], [Op.JUMP, 0, 0, 0], [Op.END_FUNC, 0, 0, 0]]);
const yieldChild = image(2, Feature.HEAP | Feature2.SYSCALL, wrap(6, [c(0, 4), [Op.ALLOC_U8, 1, 0, 0], c(2, 0), c(3, 90), [Op.STORE_U8, 1, 2, 3], c(4, 5), ...host(UNIT, 16, [1, 4]), [Op.LOAD_U8, 5, 1, 2], [Op.RETURN, 5, 0, 0]].map((r) => r) as Rec[]));
const blockChild = image(2, Feature2.BLOCK, wrap(1, [...host(0, 9, []), [Op.RETURN, 0, 0, 0]]));
const genChild = image(2, Feature.HEAP | Feature2.GEN, wrap(3, [c(0, 1), [Op.ALLOC_U8, 1, 0, 0], ...host(2, 17, [1, 0]), [Op.RETURN, 2, 0, 0]]));

const disk = (child: Uint8Array, sectors = 8): Uint8Array => {
  const d = new Uint8Array(sectors * SECTOR_BYTES);
  d.set(child);
  return d;
};

/** Loads the child at sector 0, runs it, and returns task.resume's status word. */
const runner = (length: number, fuel = 100_000): Rec[] =>
  wrap(11, [
    c(0, SECTOR_BYTES), [Op.ALLOC_U8, 1, 0, 0], c(2, 0), ...host(UNIT, 10, [2, 1]),
    c(3, length), ...host(4, 13, [1, 3]),
    c(5, fuel), c(6, 1 << 20), ...host(7, 14, [4, 5, 6]),
    c(8, 4), [Op.ALLOC_U8, 9, 8, 0], ...host(10, 15, [7, 9]),
    [Op.RETURN, 10, 0, 0],
  ]);

const engines: EngineKind[] = ["reference", "finite"];
const finish = (m: OsMachine) => {
  m.run();
  return m.result();
};

describe.each(engines)("ANMA-2 machine on the %s engine", (engine) => {
  it("reads keys and writes computed bytes to the terminal", () => {
    const k = kernel(wrap(7, [c(0, 2), [Op.ALLOC_U8, 1, 0, 0], ...host(2, 7, []), c(3, 0), [Op.STORE_U8, 1, 3, 2], ...host(4, 7, []), c(5, 1), [Op.STORE_U8, 1, 5, 4], c(6, 2), ...host(UNIT, 8, [1, 3, 6]), [Op.RETURN, 3, 0, 0]].map((r) => r) as Rec[]));
    const m = new OsMachine({ kernel: k, disk: disk(new Uint8Array()), keys: [104, 105], engine });
    finish(m);
    expect(m.terminal()).toBe("hi");
  });
  it("waits when out of keys, and carries on when more arrive", () => {
    const k = kernel(wrap(1, [...host(0, 7, []), [Op.RETURN, 0, 0, 0]]));
    const m = new OsMachine({ kernel: k, disk: disk(new Uint8Array()), engine });
    expect(m.run()).toBe("waiting-input");
    m.pushKeys([65]);
    expect(m.run()).toBe("halted");
    expect(m.result().returnValue).toEqual({ t: "u64", v: "65" });
  });
  it("keeps sector writes on the disk", () => {
    const writes: number[] = [];
    const k = kernel(wrap(5, [c(0, SECTOR_BYTES), [Op.ALLOC_U8, 1, 0, 0], c(2, 0), c(3, 77), [Op.STORE_U8, 1, 2, 3], c(4, 3), ...host(UNIT, 11, [4, 1]), ...host(UNIT, 12, []), [Op.RETURN, 2, 0, 0]].map((r) => r) as Rec[]));
    const m = new OsMachine({ kernel: k, disk: disk(new Uint8Array()), engine, onWrite: (s) => writes.push(s) });
    finish(m);
    expect(m.disk[3 * SECTOR_BYTES]).toBe(77);
    expect(writes).toEqual([3]);
    expect(m.flushes).toBe(1);
  });
  it("traps on a sector outside the disk", () => {
    const k = kernel(wrap(3, [c(0, SECTOR_BYTES), [Op.ALLOC_U8, 1, 0, 0], c(2, 999), ...host(UNIT, 10, [2, 1]), [Op.RETURN, 2, 0, 0]].map((r) => r) as Rec[]));
    expect(finish(new OsMachine({ kernel: k, disk: disk(new Uint8Array()), engine })).status).toBe("trapped");
  });
  it("runs a program from disk", () => {
    const m = new OsMachine({ kernel: kernel(runner(okChild.length)), disk: disk(okChild), engine });
    expect(finish(m).returnValue).toEqual({ t: "u64", v: String(TaskStatus.EXITED) });
  });
  it("survives a program that traps", () => {
    const m = new OsMachine({ kernel: kernel(runner(trapChild.length)), disk: disk(trapChild), engine });
    const r = finish(m);
    expect(r.status).toBe("halted");
    expect(r.returnValue).toEqual({ t: "u64", v: String(TaskStatus.TRAPPED) });
  });
  it("stops a program that spins", () => {
    const m = new OsMachine({ kernel: kernel(runner(spinChild.length, 5_000)), disk: disk(spinChild), engine });
    const r = finish(m);
    expect(r.status).toBe("halted");
    expect(r.returnValue).toEqual({ t: "u64", v: String(TaskStatus.OUT_OF_FUEL) });
  });
  it("passes a yield and its code to the kernel", () => {
    const m = new OsMachine({ kernel: kernel(runner(yieldChild.length)), disk: disk(yieldChild), engine });
    expect(finish(m).returnValue).toEqual({ t: "u64", v: String(TaskStatus.YIELDED | (5 << 8)) });
  });
  it("refuses to load a program asking for the block device or generation", () => {
    for (const child of [blockChild, genChild]) {
      const k = kernel(wrap(5, [c(0, SECTOR_BYTES), [Op.ALLOC_U8, 1, 0, 0], c(2, 0), ...host(UNIT, 10, [2, 1]), c(3, child.length), ...host(4, 13, [1, 3]), [Op.RETURN, 4, 0, 0]].map((r) => r) as Rec[]));
      expect(finish(new OsMachine({ kernel: k, disk: disk(child), engine })).returnValue).toEqual({ t: "u64", v: "0" });
    }
  });
  it("delivers a generation and records it for replay", () => {
    const k = kernel(wrap(6, [c(0, 4), [Op.ALLOC_U8, 1, 0, 0], c(2, 4), ...host(3, 17, [1, 2]), ...host(4, 18, [3]), ...host(5, 19, [3, 1]), [Op.RETURN, 5, 0, 0]].map((r) => r) as Rec[]));
    let calls = 0;
    const gen = { request: () => (calls++, 9), poll: () => (calls++, { status: GenStatus.READY, bytes: new Uint8Array([1, 2]) }) };
    const m = new OsMachine({ kernel: k, disk: disk(new Uint8Array()), engine, gen });
    expect(finish(m).returnValue).toEqual({ t: "u64", v: "2" });
    const before = calls;
    const r = new OsMachine({ kernel: k, disk: disk(new Uint8Array()), engine, gen: replayGen(m.genLog) });
    expect(finish(r).returnValue).toEqual({ t: "u64", v: "2" });
    expect(calls).toBe(before);
  });
});

describe("ANMA-1 stays frozen", () => {
  it("rejects version 2 unless asked", () => {
    expect(validateBytes(okChild).ok).toBe(true);
    const v2 = image(2, 0, wrap(1, [c(0, 1), [Op.RETURN, 0, 0, 0]]));
    expect(validateBytes(v2).ok).toBe(false);
    expect(validateBytes(v2, { anma2: true }).ok).toBe(true);
  });
  it("rejects ANMA-2 host operations in a version 1 file", () => {
    expect(validateBytes(image(1, 0, wrap(1, [...host(0, 7, []), [Op.RETURN, 0, 0, 0]])), { anma2: true }).ok).toBe(false);
  });
  it("rejects ANMA-2 feature bits in a version 1 file", () => {
    expect(validateBytes(image(1, Feature2.BLOCK, wrap(1, [c(0, 1), [Op.RETURN, 0, 0, 0]])), { anma2: true }).ok).toBe(false);
  });
});

describe("engines agree", () => {
  it("gives the same result for the same session", () => {
    const run = (engine: EngineKind) => {
      const m = new OsMachine({ kernel: kernel(runner(yieldChild.length)), disk: disk(yieldChild), engine });
      finish(m);
      return JSON.stringify([m.result().returnValue, m.terminal()]);
    };
    expect(run("reference")).toBe(run("finite"));
  });
});

describe("program output", () => {
  // "hi" in read-only data, printed by a child with terminal.print_utf8.
  function printing(): Uint8Array {
    const recs = wrap(2, [c(0, 0), c(1, 2), ...host(UNIT, 1, [0, 1]), [Op.RETURN, 0, 0, 0]].map((r) => r) as Rec[]);
    const words = [0x414d4e41, 1, Feature.TERMINAL, recs.length, 2, 0, 0, 0, ...recs.flat()];
    const out = new Uint8Array(words.length * 4 + 2);
    words.forEach((w, i) => new DataView(out.buffer).setUint32(i * 4, w >>> 0, true));
    out.set([104, 105], words.length * 4);
    return out;
  }
  it.each(engines)("reaches the terminal from a task on the %s engine", (engine) => {
    const child = printing();
    const m = new OsMachine({ kernel: kernel(runner(child.length)), disk: disk(child), engine });
    finish(m);
    expect(m.terminal()).toBe("hi");
  });
});
