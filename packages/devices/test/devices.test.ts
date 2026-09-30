import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Devices, Heap, sha256HexSync } from "../src/index.ts";

const dev = (data = new Uint8Array(), declared = 0xf, allowed?: number) => new Devices({ data, declaredFeatures: declared, ...(allowed !== undefined ? { allowedFeatures: allowed } : {}) });

describe("runtime trap rules", () => {
  it("maps every runtime trap to its catalog rule", () => {
    const h = new Heap();
    const a = h.alloc("u64", 2n);
    expect(a.ok).toBe(true);
    const load = h.load("u64", { handle: 99, elem: "u64" }, 0n);
    expect(!load.ok && load.trap.rule).toBe("ANMA-R-003"); // INVALID_HANDLE (unreachable from validated guest code)
    const oob = h.load("u64", (a as unknown as { value: never }).value, 5n);
    expect(!oob.ok && oob.trap.rule).toBe("ANMA-R-002"); // BOUNDS
    const tooBig = new Heap({ heapPayloadBytes: 8 }).alloc("u64", 2n);
    expect(!tooBig.ok && tooBig.trap.rule).toBe("ANMA-R-005"); // RESOURCE_EXHAUSTED
    const denied = dev(new Uint8Array(), 0xf, 0).call(0, [1n]);
    expect(denied.kind === "trap" && denied.trap.rule).toBe("ANMA-R-004"); // CAPABILITY_DENIED
    const bad = dev(new Uint8Array([0xff])).call(1, [0n, 1n]);
    expect(bad.kind === "trap" && bad.trap.rule).toBe("ANMA-R-007"); // INVALID_UTF8
    const term = new Devices({ data: new Uint8Array(), declaredFeatures: 2, limits: { terminalBytes: 3 } });
    expect(term.call(0, [12n]).kind).toBe("ok");
    const full = term.call(0, [34n]);
    expect(full.kind === "trap" && full.trap.rule).toBe("ANMA-R-005");
    expect(new TextDecoder().decode(term.terminal())).toBe("12"); // exact prefix kept
  });
  it("ANMA-R-001 / ANMA-R-006 are raised by the engines (see runtime tests) and exist in the catalog", async () => {
    const { ruleInfo } = await import("@llmtobinary/diagnostics");
    expect(ruleInfo("ANMA-R-001").category).toBe("DIVIDE_BY_ZERO");
    expect(ruleInfo("ANMA-R-006").category).toBe("FUEL_EXHAUSTED");
  });
});

describe("devices", () => {
  it("sync SHA-256 matches node:crypto", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const b = new Uint8Array(len).map((_, i) => (i * 31) & 255);
      expect(sha256HexSync(b)).toBe(createHash("sha256").update(b).digest("hex"));
    }
  });
  it("ticks must strictly increase; wait_tick waits then latches the key mask", () => {
    const d = dev();
    expect(d.call(6, []).kind).toBe("wait");
    expect(d.pushTick({ tick: "5", keys: 2 })).toBeNull();
    expect(d.pushTick({ tick: "5", keys: 0 })).toMatch(/strictly increasing/);
    expect(d.pushTick({ tick: "-1", keys: 0 })).toMatch(/canonical/);
    expect(d.call(6, [])).toEqual({ kind: "ok", value: 5n });
    expect(d.call(5, [1n])).toEqual({ kind: "ok", value: true });
    expect(d.call(5, [0n])).toEqual({ kind: "ok", value: false });
  });
  it("effects hash is stable and covers every effect", () => {
    const a = dev();
    const b = dev();
    for (const d of [a, b]) {
      d.call(0, [1n]);
      d.call(3, [1n, 2n, 0xff0000ffn]);
    }
    expect(a.effectsHash()).toBe(b.effectsHash());
    b.call(0, [2n]);
    expect(a.effectsHash()).not.toBe(b.effectsHash());
    expect(a.effectsHash()).toBe(a.effectsHash()); // reading the hash does not disturb it
  });
});
