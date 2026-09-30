import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { createFiniteMachine } from "@llmtobinary/runtime";
import { runAnmr, validateAnmr } from "@llmtobinary/research";
import type { MicroEvent } from "@llmtobinary/protocol";
import { ChipViewModel } from "./viewmodel.ts";
import { unitsOf } from "./units.ts";

const root = new URL("../../../../fixtures/", import.meta.url);
const bytes = (f: string) => new Uint8Array(readFileSync(new URL(f, root)));

describe("the chip view model is a faithful replay of engine events", () => {
  it.each([1, 4, 8, 64])("ANMA capstone at F=%i ends in the engine's exact slot and backing state", (F) => {
    const events: MicroEvent[] = [];
    const m = createFiniteMachine(mustValidate(bytes("upstream-capstone-40.anma")), [{ t: "u64", v: "20014547621496" }], { config: { fastSlots: F }, onEvent: (e) => events.push(e) });
    const vm = new ChipViewModel("ANMA-1", F);
    // Replay up to just before the final RETURN releases the block, and compare with a mid-run snapshot.
    let n = 0;
    while (m.status !== "halted") {
      m.step();
      for (; n < events.length; n++) vm.apply(events[n]!);
      const snap = m.snapshot();
      expect(vm.cells.map((c) => c.value)).toEqual(snap.slots.map((s) => s.value));
      expect(vm.cells.map((c) => c.payload)).toEqual(snap.slots.map((s) => s.payload));
      expect([...vm.mem.keys()].sort((a, b) => a - b)).toEqual(snap.backing.occupied);
    }
    const c = m.result().counters;
    expect(vm.counters.ticks).toBe(c.modeledTicks);
    expect(vm.counters.instructions).toBe(c.executedInstructions);
    expect(vm.counters.misses).toBe(c.operandMisses);
    expect(vm.counters.evictions).toBe(c.evictions);
    expect(vm.counters.backingReads).toBe(c.backingReads);
    expect(vm.counters.backingWrites).toBe(c.backingWrites);
  });

  it("ANMR capstone: registers, spills, and ticks match the stepping machine", () => {
    const v = validateAnmr(bytes("anmr-capstone-r8.anmr"));
    if (!v.ok) throw new Error();
    const events: MicroEvent[] = [];
    const r = runAnmr(v.program, 5n, (e) => events.push(e));
    const vm = new ChipViewModel("ANMR-1", v.program.R, "5");
    for (const e of events) vm.apply(e);
    expect(vm.counters.saves).toBe(r.counters.saves);
    expect(vm.counters.restores).toBe(r.counters.restores);
    expect(vm.counters.ticks).toBe(r.counters.modeledTicks);
    expect(vm.mem.size).toBe(r.counters.saves); // every save used a distinct slot in this fixture
  });

  it("every event lights at least one unit", () => {
    const events: MicroEvent[] = [];
    createFiniteMachine(mustValidate(bytes("fibonacci.anma")), [{ t: "u64", v: "6" }], { config: { fastSlots: 2 }, onEvent: (e) => events.push(e) }).run(1_000_000);
    expect(events.length).toBeGreaterThan(100);
    for (const e of events) expect(unitsOf(e).length).toBeGreaterThan(0);
  });
});
