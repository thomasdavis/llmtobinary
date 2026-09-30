// T2 runtime contract monitoring (PRD Section 15.4). Plugs into an engine's observation hooks.
// It never mutates engine state; violations become CONTRACT_VIOLATED diagnostics that feed the
// next loop iteration. A passing monitor is evidence ("held on N executions"), not proof.

import { DEFAULT_LIMITS } from "@llmtobinary/spec";
import type { Module } from "@llmtobinary/validate";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import type { EngineHooks, RuntimeValue } from "@llmtobinary/protocol";
import type { ParsedAnnotations } from "./schema.ts";
import { compileContracts } from "./contracts.ts";
import { EvalError, evaluate, namesIn, type EvalBudget, type Expr } from "./spec-lang.ts";

export interface ContractMonitor extends EngineHooks {
  diagnostics(): Diagnostic[];
  /** Number of contract evaluations performed. */
  checks(): number;
  /** Number of evaluations that held. */
  held(): number;
}

const MAX_DIAGNOSTICS = 20;

function fmt(v: RuntimeValue | bigint | boolean | null | undefined): string {
  if (v === null || v === undefined) return "()";
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "boolean") return String(v);
  return `handle<${v.elem}>#${v.handle}`;
}

export function createContractMonitor(ann: ParsedAnnotations, module: Module, opts: { maxSteps?: number } = {}): ContractMonitor {
  const compiled = compileContracts(ann, module);
  const paramNames = new Map<number, Map<number, string>>();
  for (const p of ann.params) (paramNames.get(p.function) ?? paramNames.set(p.function, new Map()).get(p.function)!).set(p.index, p.name);
  const budget: EvalBudget = { steps: 0, max: opts.maxSteps ?? DEFAULT_LIMITS.contractSteps };
  const out: Diagnostic[] = [];
  let checks = 0;
  let held = 0;
  let exhausted = false;
  const stack: { fn: number; args: readonly RuntimeValue[] }[] = [];
  let entryInputs: string[] | null = null;

  const env = (fn: number, args: readonly RuntimeValue[], blockParams?: readonly RuntimeValue[]) => {
    const m = new Map<string, bigint | boolean>();
    args.forEach((a, i) => {
      if (typeof a === "object") return;
      m.set(`arg${i}`, a);
      const n = paramNames.get(fn)?.get(i);
      if (n) m.set(n, a);
    });
    blockParams?.forEach((a, i) => {
      if (typeof a !== "object") m.set(`bp${i}`, a);
    });
    return m;
  };

  const path = () => stack.map((f, d) => `fn${f.fn}@depth${d}`).join(" → ");

  const check = (kind: "requires" | "ensures" | "invariant", fn: number, block: number | null, c: { text: string; expr: Expr }, values: Map<string, bigint | boolean>, result: bigint | boolean | null) => {
    if (exhausted) return;
    checks++;
    let ok: boolean;
    let error: string | null = null;
    try {
      ok = evaluate(c.expr, values, result, budget) as boolean;
    } catch (e) {
      if (e instanceof EvalError && budget.steps > budget.max) {
        exhausted = true;
        out.push(diag("ANMA-K-009", { message: `Contract checking stopped after ${budget.max} evaluation steps.`, stage: Stage.TASK, derived: `${checks} contract evaluations were performed before the limit.` }));
        return;
      }
      ok = false;
      error = (e as Error).message;
    }
    if (ok) {
      held++;
      return;
    }
    if (out.length >= MAX_DIAGNOSTICS) return;
    const used = [...namesIn(c.expr)].map((n) => `${n} = ${n === "result" ? fmt(result) : fmt(values.get(n))}`);
    const entryFail = kind === "requires" && stack.length === 1;
    out.push(
      diag("ANMA-K-006", {
        message:
          kind === "requires"
            ? `The requires of fn${fn} is false on this activation${entryFail ? "; the model's precondition excludes an input the task requires" : ""}.`
            : kind === "ensures"
              ? `The ensures of fn${fn} is false when it returns.`
              : `The invariant of fn${fn} block ${block} is false on entry to that block.`,
        location: { functionId: fn, blockId: block },
        found: error ? `${c.text} could not be evaluated: ${error}` : `${c.text} evaluated to false`,
        expected: `${c.text} holds`,
        derived: `inputs: ${entryInputs ? entryInputs.join(", ") : "(none)"}; activation: ${path() || `fn${fn}`}; values: ${used.join(", ")}`,
        stage: Stage.TASK,
      }),
    );
  };

  return {
    onCall(fn, args) {
      if (stack.length === 0 && entryInputs === null) entryInputs = args.map((a) => fmt(a));
      stack.push({ fn, args });
      for (const c of compiled.requires.get(fn) ?? []) check("requires", fn, null, c, env(fn, args), null);
    },
    onBlockEnter(fn, block, params, entryArgs) {
      for (const c of compiled.invariants.get(`${fn}:${block}`) ?? []) check("invariant", fn, block, c, env(fn, entryArgs, params), null);
    },
    onReturn(fn, entryArgs, result) {
      const r = result === null || typeof result === "object" ? null : result;
      for (const c of compiled.ensures.get(fn) ?? []) check("ensures", fn, null, c, env(fn, entryArgs), r);
      stack.pop();
    },
    diagnostics: () => out,
    checks: () => checks,
    held: () => held,
  };
}
