// Static contract checks (PRD Section 15.4) run by check_candidate against a valid module:
// references, names, parse and type errors, and example shapes. Never executes anything.

import { TypeTag, parseU64Decimal } from "@llmtobinary/spec";
import type { Module } from "@llmtobinary/validate";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import type { ParsedAnnotations } from "./schema.ts";
import { SpecError, parseSpec, typecheck, type Expr, type SpecType, type TypeEnv } from "./spec-lang.ts";

function specType(t: TypeTag): SpecType | "handle" | "unit" {
  return t === TypeTag.U64 ? "u64" : t === TypeTag.BOOL ? "bool" : t === TypeTag.UNIT ? "unit" : "handle";
}

/** Names visible to a function's requires/ensures: declared parameter names and argN. */
export function functionNames(ann: ParsedAnnotations, module: Module, fn: number): Map<string, SpecType | "handle"> {
  const f = module.functions[fn]!;
  const names = new Map<string, SpecType | "handle">();
  f.params.forEach((t, i) => {
    const st = specType(t);
    names.set(`arg${i}`, st === "unit" ? "handle" : st);
  });
  for (const p of ann.params) {
    if (p.function !== fn) continue;
    const t = f.params[p.index];
    if (t !== undefined) {
      const st = specType(t);
      names.set(p.name, st === "unit" ? "handle" : st);
    }
  }
  return names;
}

export function blockNames(ann: ParsedAnnotations, module: Module, fn: number, block: number): Map<string, SpecType | "handle"> {
  const names = functionNames(ann, module, fn);
  const b = module.functions[fn]!.blocks[block]!;
  b.params.forEach((t, i) => {
    const st = specType(t);
    names.set(`bp${i}`, st === "unit" ? "handle" : st);
  });
  return names;
}

export interface CompiledContracts {
  requires: Map<number, { text: string; expr: Expr }[]>;
  ensures: Map<number, { text: string; expr: Expr }[]>;
  invariants: Map<string, { text: string; expr: Expr }[]>; // key "fn:block"
}

function compileOne(text: string, env: TypeEnv): { expr: Expr } | { error: string; kind: "parse" | "type" } {
  let expr: Expr;
  try {
    expr = parseSpec(text);
  } catch (e) {
    const se = e as SpecError;
    return { error: `${se.message} (at character ${se.pos})`, kind: "parse" };
  }
  try {
    const t = typecheck(expr, env);
    if (t !== "bool") return { error: `a contract must be a bool expression, but this one is ${t}`, kind: "type" };
  } catch (e) {
    const se = e as SpecError;
    return { error: `${se.message} (at character ${se.pos})`, kind: "type" };
  }
  return { expr };
}

/** Compile every well-formed contract/invariant; ill-formed ones are reported by checkContracts. */
export function compileContracts(ann: ParsedAnnotations, module: Module): CompiledContracts {
  const out: CompiledContracts = { requires: new Map(), ensures: new Map(), invariants: new Map() };
  for (const c of ann.contracts) {
    const f = module.functions[c.function];
    if (!f) continue;
    const names = functionNames(ann, module, c.function);
    if (c.requires !== null) {
      const r = compileOne(c.requires, { names, result: null });
      if ("expr" in r) (out.requires.get(c.function) ?? out.requires.set(c.function, []).get(c.function)!).push({ text: c.requires, expr: r.expr });
    }
    if (c.ensures !== null) {
      const r = compileOne(c.ensures, { names, result: specType(f.ret) });
      if ("expr" in r) (out.ensures.get(c.function) ?? out.ensures.set(c.function, []).get(c.function)!).push({ text: c.ensures, expr: r.expr });
    }
  }
  for (const inv of ann.invariants) {
    const b = module.functions[inv.function]?.blocks[inv.block];
    if (!b) continue;
    const r = compileOne(inv.expr, { names: blockNames(ann, module, inv.function, inv.block), result: null });
    const key = `${inv.function}:${inv.block}`;
    if ("expr" in r) (out.invariants.get(key) ?? out.invariants.set(key, []).get(key)!).push({ text: inv.expr, expr: r.expr });
  }
  return out;
}

/** Static contract checks against a valid module. */
export function checkContracts(ann: ParsedAnnotations, module: Module): Diagnostic[] {
  const out: Diagnostic[] = [];
  const S = Stage.ANNOTATIONS;
  for (const p of ann.params) {
    const f = module.functions[p.function];
    if (!f) out.push(diag("ANMA-A-002", { message: `annotations.params names a parameter of fn${p.function}, which does not exist.`, found: `${p.name} → fn${p.function}#${p.index}`, stage: S }));
    else if (p.index >= f.params.length) out.push(diag("ANMA-A-002", { message: `fn${p.function} has ${f.params.length} parameter${f.params.length === 1 ? "" : "s"}, so parameter index ${p.index} (${p.name}) does not exist.`, location: { functionId: p.function }, stage: S }));
  }
  const report = (kind: "parse" | "type", where: string, text: string, error: string, fn: number, block: number | null) =>
    out.push(
      diag(kind === "parse" ? "ANMA-A-007" : "ANMA-A-008", {
        message: `${where} ${kind === "parse" ? "does not parse" : "is ill-typed"}: ${error}.`,
        location: { functionId: fn, blockId: block },
        found: text,
        expected: "an ANMA-Spec bool expression (see the contract grammar in the manual)",
        stage: S,
      }),
    );
  for (const c of ann.contracts) {
    const f = module.functions[c.function];
    if (!f) {
      out.push(diag("ANMA-A-002", { message: `A contract refers to fn${c.function}, which does not exist.`, found: `function ${c.function}`, expected: `a function ID in 0..${module.functions.length - 1}`, stage: S }));
      continue;
    }
    const names = functionNames(ann, module, c.function);
    if (c.requires !== null) {
      const r = compileOne(c.requires, { names, result: null });
      if ("error" in r) report(r.kind, `The requires of fn${c.function}`, c.requires, r.error, c.function, null);
    }
    if (c.ensures !== null) {
      const r = compileOne(c.ensures, { names, result: specType(f.ret) });
      if ("error" in r) report(r.kind, `The ensures of fn${c.function}`, c.ensures, r.error, c.function, null);
    }
  }
  for (const inv of ann.invariants) {
    const f = module.functions[inv.function];
    const b = f?.blocks[inv.block];
    if (!b) {
      out.push(diag("ANMA-A-002", { message: `An invariant refers to block ${inv.block} of fn${inv.function}, which does not exist.`, found: inv.expr, stage: S }));
      continue;
    }
    const r = compileOne(inv.expr, { names: blockNames(ann, module, inv.function, inv.block), result: null });
    if ("error" in r) report(r.kind, `The invariant of fn${inv.function} block ${inv.block}`, inv.expr, r.error, inv.function, inv.block);
  }
  const entry = module.functions[module.entry]!;
  ann.examples.forEach((ex, i) => {
    const problems: string[] = [];
    if (ex.inputs.length !== entry.params.length) problems.push(`it has ${ex.inputs.length} inputs but the entry function takes ${entry.params.length}`);
    else
      ex.inputs.forEach((s, k) => {
        const t = entry.params[k];
        if (t === TypeTag.BOOL ? s !== "true" && s !== "false" : parseU64Decimal(s) === null) problems.push(`input ${k} ${JSON.stringify(s)} is not a canonical ${t === TypeTag.BOOL ? "bool (true/false)" : "u64 decimal"}`);
      });
    if (ex.result !== null) {
      if (entry.ret === TypeTag.UNIT) problems.push("result must be null because the entry function returns unit");
      else if (entry.ret === TypeTag.BOOL ? ex.result !== "true" && ex.result !== "false" : entry.ret === TypeTag.U64 ? parseU64Decimal(ex.result) === null : true) {
        problems.push(`result ${JSON.stringify(ex.result)} is not a canonical ${entry.ret === TypeTag.BOOL ? "bool" : entry.ret === TypeTag.U64 ? "u64 decimal" : "value (handles cannot be compared)"}`);
      }
    }
    if (problems.length) {
      out.push(diag("ANMA-A-010", { message: `Example ${i} does not match the entry signature: ${problems.join("; ")}.`, found: JSON.stringify(ex), expected: "inputs as canonical u64 decimal strings or true/false, one per entry parameter", stage: S }));
    }
  });
  return out;
}
