// Judges a pair: link, validate with the unchanged ANMA-1 validator, then compare every input with
// the oracle on the reference interpreter.

import { link } from "@llmtobinary/link";
import { runToCompletion } from "@llmtobinary/reference";
import { validateBytes } from "@llmtobinary/validate";
import type { GateInterface } from "./gate-b-interfaces.ts";

export type PairVerdict =
  | { stage: "pass"; cases: number; records: number; authority: string[] }
  | { stage: "link-failed"; detail: string }
  | { stage: "validate-failed"; detail: string }
  | { stage: "wrong-result"; detail: string; passedCases: number; cases: number };

export function scorePair(i: GateInterface, lib: Uint8Array, app: Uint8Array): PairVerdict {
  const firstImport = appImportBase(app);
  const imports: Record<number, string> = Object.fromEntries(i.exports.map((e, k) => [firstImport + k, e.symbol]));
  const linked = link([
    { name: "app", bytes: app, exports: {}, imports },
    { name: "lib", bytes: lib, exports: Object.fromEntries(i.exports.map((e) => [e.symbol, e.id])), imports: {} },
  ]);
  if (!linked.ok) return { stage: "link-failed", detail: linked.errors.map((e) => `${e.rule}: ${e.message}`).join("; ") };
  const v = validateBytes(linked.bytes);
  if (!v.ok || !v.module) return { stage: "validate-failed", detail: v.diagnostics.map((d) => d.rule).join(", ") };
  let passed = 0;
  const failures: string[] = [];
  for (const c of i.cases) {
    const want = i.oracle(c);
    const r = runToCompletion(v.module, c.map((x) => ({ t: "u64" as const, v: x.toString() })), { limits: { executedInstructions: i.fuel, microsteps: i.fuel * 10 } });
    const got = r.returnValue?.t === "u64" ? BigInt(r.returnValue.v) : null;
    if (r.status === "halted" && got === want) passed++;
    else failures.push(`(${c.join(", ")}): want ${want}, got ${r.status === "trapped" ? `trap ${r.trap?.code}` : String(got)}`);
  }
  if (failures.length) return { stage: "wrong-result", detail: failures.slice(0, 3).join("; "), passedCases: passed, cases: i.cases.length };
  return { stage: "pass", cases: i.cases.length, records: (linked.bytes.length - 32) / 16, authority: linked.authority };
}

/** The app's first import ID: its count of defined functions. */
function appImportBase(app: Uint8Array): number {
  const dv = new DataView(app.buffer, app.byteOffset, app.byteLength);
  const records = dv.getUint32(12, true);
  let funcs = 0;
  for (let k = 0; k < records; k++) if (dv.getUint32(32 + k * 16, true) === 1) funcs++;
  return funcs;
}
