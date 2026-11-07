// A2.4: reruns recorded Gate B pairs on both engines. Uses the model-written bytes from a round's
// records, so it judges real linked programs rather than fixtures.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/gate-b-engines.ts <round.jsonl>

import { readFileSync } from "node:fs";
import { link } from "@llmtobinary/link";
import { parseModule } from "@llmtobinary/module";
import { runToCompletion } from "@llmtobinary/reference";
import { runFinite } from "@llmtobinary/runtime";
import { validateBytes } from "@llmtobinary/validate";
import { INTERFACES } from "./gate-b-interfaces.ts";

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
const rows = readFileSync(process.argv[2]!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { passed: boolean; interface: string; index: number; library: { hex: string }; application: { hex: string } });
let compared = 0;
let mismatches = 0;
for (const r of rows.filter((x) => x.passed)) {
  const i = INTERFACES.find((x) => x.id === r.interface)!;
  const app = bytesOf(r.application.hex);
  const lib = bytesOf(r.library.hex);
  const p = parseModule(app);
  if (!p.ok) throw new Error("parse");
  const imports = Object.fromEntries(i.exports.map((e, k) => [p.module.functions.length + k, e.symbol]));
  const l = link([{ name: "app", bytes: app, exports: {}, imports }, { name: "lib", bytes: lib, exports: Object.fromEntries(i.exports.map((e) => [e.symbol, e.id])), imports: {} }]);
  if (!l.ok) throw new Error("link");
  const v = validateBytes(l.bytes);
  if (!v.ok || !v.module) throw new Error("validate");
  for (const c of i.cases) {
    const inputs = c.map((x) => ({ t: "u64" as const, v: x.toString() }));
    const opts = { limits: { executedInstructions: i.fuel, microsteps: i.fuel * 40 } };
    const a = runToCompletion(v.module, inputs, opts);
    const b = runFinite(v.module, inputs, opts);
    compared++;
    if (JSON.stringify(a.returnValue) !== JSON.stringify(b.returnValue) || a.status !== b.status || a.effectsHash !== b.effectsHash) {
      mismatches++;
      console.log(`mismatch ${r.interface} #${r.index} (${c.join(", ")})`);
    }
  }
}
console.log(`${compared} runs compared, ${mismatches} mismatches, across ${rows.filter((x) => x.passed).length} pairs`);
process.exit(mismatches ? 1 : 0);
