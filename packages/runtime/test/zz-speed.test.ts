import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { createFastMachine, createFiniteMachine } from "../src/index.ts";
import { INTERACTIVE_RUN_LIMITS } from "@llmtobinary/spec";
it("speed", () => {
  const m = mustValidate(new Uint8Array(readFileSync(new URL("generated/mario-platformer-b.anma", import.meta.url))));
  const out: string[] = [];
  const ticks = Array.from({ length: 120 }, (_, i) => ({ tick: String(i + 1), keys: 2 }));
  for (const [name, make, n] of [["exact", () => createFiniteMachine(m, [{ t: "u64", v: "0" }], { config: { fastSlots: 16 }, ticks, limits: INTERACTIVE_RUN_LIMITS }), 10], ["fast", () => createFastMachine(m, [{ t: "u64", v: "0" }], { ticks, limits: INTERACTIVE_RUN_LIMITS }), 120]] as const) {
    const mc = make();
    const t0 = performance.now();
    while (!["halted", "trapped", "waiting-input"].includes(mc.status) && mc.devices.framesPresented < n) mc.run(100_000);
    const ms = performance.now() - t0;
    const f = mc.devices.framesPresented;
    out.push(`${name}: ${f} frames in ${ms.toFixed(0)} ms = ${(ms / f).toFixed(2)} ms/frame (${(1000 / (ms / f)).toFixed(0)} fps)`);
  }
  writeFileSync("/tmp/claude-1002/-home-ajax-llmtobinary/65aacce7-dcfd-4436-8f9e-cfbd24f7b47b/scratchpad/speed.txt", out.join("\n"));
}, 600_000);
