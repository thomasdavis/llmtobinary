import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { TASK_BY_ID } from "@llmtobinary/tasks";
import type { MicroEvent } from "@llmtobinary/protocol";
import { createFiniteMachine, runFinite, COST_MODEL_ID, LATENCY } from "../src/index.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const mod = (name: string) => mustValidate(new Uint8Array(readFileSync(new URL(name, root))));
const u = (v: string) => ({ t: "u64" as const, v });

function collect(file: string, inputs: { t: "u64"; v: string }[], F: number, ticks?: never[]) {
  const events: MicroEvent[] = [];
  const watched = runFinite(mod(file), inputs, { config: { fastSlots: F }, onEvent: (e) => events.push(e), ...(ticks ? { ticks } : {}) });
  const plain = runFinite(mod(file), inputs, { config: { fastSlots: F }, ...(ticks ? { ticks } : {}) });
  return { events, watched, plain };
}

describe(`chip instrumentation (${COST_MODEL_ID})`, () => {
  it.each([1, 4, 16, 64])("capstone at F=%i: watching changes nothing; events account for every counter", (F) => {
    const { events, watched, plain } = collect("upstream-capstone-40.anma", [u("20014547621496")], F);
    const strip = (c: typeof watched.counters) => ({ ...c, hostWallTimeMs: 0 });
    expect(strip(watched.counters)).toEqual(strip(plain.counters));
    expect(watched.returnValue).toEqual(plain.returnValue);
    const c = watched.counters;
    const count = (k: MicroEvent["u"]) => events.filter((e) => e.u === k).length;
    expect(count("fetch")).toBe(c.executedInstructions);
    expect(count("hit")).toBe(c.operandHits);
    expect(count("miss")).toBe(c.operandMisses);
    expect(count("evict")).toBe(c.evictions);
    expect(count("reclaim")).toBe(c.reclaimed);
    // A gap-free timeline: each event starts where the previous one ended, and the total is the counter.
    let t = events[0]!.at;
    for (const e of events) {
      expect(e.at).toBe(t);
      t += e.ticks;
    }
    expect(t - events[0]!.at + events[0]!.at).toBe(c.modeledTicks);
    expect(events.reduce((s, e) => s + e.ticks, 0)).toBe(c.modeledTicks);
  });

  it("modeled ticks rise as fast slots shrink (misses and evictions cost backing latency)", () => {
    const at = (F: number) => runFinite(mod("upstream-capstone-40.anma"), [u("7")], { config: { fastSlots: F } }).counters.modeledTicks!;
    expect(at(4)).toBeGreaterThan(at(16));
    expect(at(16)).toBeGreaterThan(at(64));
    const d = runFinite(mod("upstream-capstone-40.anma"), [u("7")], { config: { fastSlots: 4 } }).counters;
    const e = runFinite(mod("upstream-capstone-40.anma"), [u("7")], { config: { fastSlots: 64 } }).counters;
    // Each miss replaces a hit (so it costs miss + install - hit extra); each eviction costs a backing write.
    expect(d.modeledTicks! - e.modeledTicks!).toBe((d.operandMisses! - e.operandMisses!) * (LATENCY.miss + LATENCY.install - LATENCY.hit) + (d.evictions! - e.evictions!) * LATENCY.evict);
  });

  it("device work is priced and interactive runs stay identical when watched", () => {
    const ticks = TASK_BY_ID.get("ball-paddle")!.visible[0]!.ticks as never[];
    const { events, watched, plain } = collect("ball-paddle.anma", [], 8, ticks);
    expect(watched.framebufferHash).toBe(plain.framebufferHash);
    expect({ ...watched.counters, hostWallTimeMs: 0 }).toEqual({ ...plain.counters, hostWallTimeMs: 0 });
    expect(events.some((e) => e.u === "host" && e.name === "display.clear" && e.ticks > LATENCY.host)).toBe(true);
  });

  it("attaching and detaching the listener mid-run changes nothing and sees whole instructions", () => {
    const m = createFiniteMachine(mod("upstream-capstone-40.anma"), [u("7")], { config: { fastSlots: 4 } });
    const seen: MicroEvent[] = [];
    let n = 0;
    while (m.status !== "halted" && m.status !== "trapped") {
      m.setEventSink(n % 3 === 1 ? (e) => seen.push(e) : null);
      m.step();
      n++;
    }
    const plain = runFinite(mod("upstream-capstone-40.anma"), [u("7")], { config: { fastSlots: 4 } });
    const r = m.result();
    expect(r.returnValue).toEqual(plain.returnValue);
    expect({ ...r.counters, hostWallTimeMs: 0 }).toEqual({ ...plain.counters, hostWallTimeMs: 0 });
    expect(seen.filter((e) => e.u === "fetch").length).toBe(Math.floor((n + 1) / 3));
  });
});
