// Shared z3 backend over the low-level SMT-LIB string API (used by the Node and browser backends).

import type { SolverBackend } from "./driver.ts";

export interface Z3LowLevel {
  mk_config(): unknown;
  mk_context(cfg: unknown): unknown;
  del_config(cfg: unknown): void;
  eval_smtlib2_string(ctx: unknown, s: string): Promise<string>;
  get_full_version(): string;
}

const VALUE_RE = /\(([A-Za-z0-9_]+) (#x[0-9a-fA-F]+|#b[01]+|true|false|\(_ bv\d+ \d+\))\)/g;

export function backendFromZ3(Z3: Z3LowLevel, where: string): SolverBackend {
  const cfg = Z3.mk_config();
  const ctx = Z3.mk_context(cfg);
  Z3.del_config(cfg);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    id: `z3 ${Z3.get_full_version()} (z3-solver wasm, ${where})`,
    check(script, timeoutMs, getValues) {
      const run = async () => {
        const out = (await Z3.eval_smtlib2_string(ctx, `(reset)\n(set-option :timeout ${Math.max(1, Math.floor(timeoutMs))})\n${script}`)).trim();
        const status = out.split(/\s+/)[0];
        if (status === "unsat") return { status: "unsat" as const };
        if (status !== "sat") return { status: "unknown" as const };
        if (!getValues.length) return { status: "sat" as const, values: {} };
        const vals = (await Z3.eval_smtlib2_string(ctx, `(get-value (${getValues.join(" ")}))`)).trim();
        const values: Record<string, string> = {};
        for (const m of vals.matchAll(VALUE_RE)) values[m[1]!] = m[2]!;
        return { status: "sat" as const, values };
      };
      // One query at a time per context.
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    },
  };
}
