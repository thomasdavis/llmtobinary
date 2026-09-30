// ANMA-Spec (PRD Section 15.4): a small expression language for requires/ensures/invariants
// whose operators have exactly the ISA's semantics. Bounded parser, typechecker, evaluator.

import { DEFAULT_LIMITS, Op, U64_MASK, evalBinary, rotl64, rotr64 } from "@llmtobinary/spec";

export type SpecType = "u64" | "bool";

export type Expr =
  | { k: "lit"; v: bigint | boolean; pos: number }
  | { k: "name"; name: string; pos: number }
  | { k: "result"; pos: number }
  | { k: "app"; op: string; args: Expr[]; pos: number };

export class SpecError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

const U64_BINARY: Record<string, number> = {
  add: Op.ADD_U64,
  sub: Op.SUB_U64,
  mul: Op.MUL_U64,
  udiv: Op.UDIV_U64,
  urem: Op.UREM_U64,
  band: Op.AND_U64,
  bor: Op.OR_U64,
  bxor: Op.XOR_U64,
  shl: Op.SHL_U64,
  shr: Op.SHR_U64,
  rotl: Op.ROTL_U64,
  rotr: Op.ROTR_U64,
};
const COMPARE = new Set(["eq", "ne", "lt", "le", "gt", "ge"]);
const BOOL_BINARY = new Set(["and", "or", "implies"]);
export const OPERATORS = [...Object.keys(U64_BINARY), ...COMPARE, "not", ...BOOL_BINARY, "ite"];

export interface ParseLimits {
  maxBytes: number;
  maxDepth: number;
}

const DEFAULT_PARSE: ParseLimits = { maxBytes: DEFAULT_LIMITS.contractExpressionBytes, maxDepth: DEFAULT_LIMITS.contractAstDepth };

/** Parse one ANMA-Spec expression. Throws SpecError with a character position. */
export function parseSpec(text: string, limits: ParseLimits = DEFAULT_PARSE): Expr {
  if (new TextEncoder().encode(text).length > limits.maxBytes) throw new SpecError(`expression is longer than ${limits.maxBytes} bytes`, 0);
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const atom = (): string => {
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i]!)) i++;
    return text.slice(start, i);
  };
  const parse = (depth: number): Expr => {
    if (depth > limits.maxDepth) throw new SpecError(`expression nests deeper than ${limits.maxDepth} levels`, i);
    skip();
    if (i >= text.length) throw new SpecError("unexpected end of expression", i);
    const pos = i;
    if (text[i] === ")") throw new SpecError('unexpected ")"', i);
    if (text[i] === "(") {
      i++;
      skip();
      const op = atom();
      if (!op) throw new SpecError('expected an operator after "("', i);
      if (!OPERATORS.includes(op)) throw new SpecError(`unknown operator ${JSON.stringify(op)}; operators are ${OPERATORS.join(" ")}`, pos + 1);
      const args: Expr[] = [];
      while (true) {
        skip();
        if (i >= text.length) throw new SpecError(`missing ")" to close (${op} …`, i);
        if (text[i] === ")") {
          i++;
          break;
        }
        args.push(parse(depth + 1));
      }
      const arity = op === "not" ? 1 : op === "ite" ? 3 : 2;
      if (args.length !== arity) throw new SpecError(`${op} takes ${arity} argument${arity === 1 ? "" : "s"}; got ${args.length}`, pos);
      return { k: "app", op, args, pos };
    }
    const a = atom();
    if (a === "true" || a === "false") return { k: "lit", v: a === "true", pos };
    if (/^[0-9]/.test(a)) {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(a)) throw new SpecError(`${JSON.stringify(a)} is not a decimal u64 literal (no prefixes, signs, or leading zeros)`, pos);
      const v = BigInt(a);
      if (v > U64_MASK) throw new SpecError(`${a} exceeds 2^64-1`, pos);
      return { k: "lit", v, pos };
    }
    if (a === "result") return { k: "result", pos };
    if (!/^[a-z_][a-z0-9_]*$/.test(a)) throw new SpecError(`${JSON.stringify(a)} is not a valid name`, pos);
    return { k: "name", name: a, pos };
  };
  const e = parse(0);
  skip();
  if (i < text.length) throw new SpecError("unexpected text after the expression", i);
  return e;
}

export interface TypeEnv {
  /** Visible names and their types; handle-typed names map to "handle". */
  names: Map<string, SpecType | "handle">;
  /** Type of `result` (null: not allowed here). */
  result: SpecType | "unit" | "handle" | null;
}

/** Typecheck; returns the expression's type. Throws SpecError. */
export function typecheck(e: Expr, env: TypeEnv): SpecType {
  switch (e.k) {
    case "lit":
      return typeof e.v === "boolean" ? "bool" : "u64";
    case "result":
      if (env.result === null) throw new SpecError("`result` is only available in ensures", e.pos);
      if (env.result === "unit") throw new SpecError("`result` is not available: the function returns unit", e.pos);
      if (env.result === "handle") throw new SpecError("`result` is a handle; handles cannot be used in v1 contracts", e.pos);
      return env.result;
    case "name": {
      const t = env.names.get(e.name);
      if (!t) throw new SpecError(`unknown name ${JSON.stringify(e.name)}; visible names are ${[...env.names.keys()].join(", ") || "none"}`, e.pos);
      if (t === "handle") throw new SpecError(`${e.name} is a handle; handles cannot be used in v1 contracts`, e.pos);
      return t;
    }
    case "app": {
      const ts = e.args.map((a) => typecheck(a, env));
      const need = (want: SpecType, idx: number) => {
        if (ts[idx] !== want) throw new SpecError(`argument ${idx + 1} of ${e.op} must be ${want} but is ${ts[idx]}`, e.args[idx]!.pos);
      };
      if (e.op in U64_BINARY) {
        need("u64", 0);
        need("u64", 1);
        return "u64";
      }
      if (COMPARE.has(e.op)) {
        if (e.op === "eq" || e.op === "ne") {
          if (ts[0] !== ts[1]) throw new SpecError(`${e.op} compares two values of the same type; got ${ts[0]} and ${ts[1]}`, e.pos);
          return "bool";
        }
        need("u64", 0);
        need("u64", 1);
        return "bool";
      }
      if (e.op === "not") {
        need("bool", 0);
        return "bool";
      }
      if (BOOL_BINARY.has(e.op)) {
        need("bool", 0);
        need("bool", 1);
        return "bool";
      }
      // ite
      need("bool", 0);
      if (ts[1] !== ts[2]) throw new SpecError(`ite branches must have the same type; got ${ts[1]} and ${ts[2]}`, e.pos);
      return ts[1]!;
    }
  }
}

export class EvalError extends Error {}

export interface EvalBudget {
  steps: number;
  max: number;
}

/** Evaluate with exact ISA semantics. Division by zero is an evaluation error, never true. */
export function evaluate(e: Expr, values: ReadonlyMap<string, bigint | boolean>, result: bigint | boolean | null, budget: EvalBudget): bigint | boolean {
  if (++budget.steps > budget.max) throw new EvalError(`contract evaluation exceeded ${budget.max} steps`);
  switch (e.k) {
    case "lit":
      return e.v;
    case "result":
      if (result === null) throw new EvalError("result is not available");
      return result;
    case "name": {
      const v = values.get(e.name);
      if (v === undefined) throw new EvalError(`no value for ${e.name}`);
      return v;
    }
    case "app": {
      if (e.op === "ite") {
        const c = evaluate(e.args[0]!, values, result, budget) as boolean;
        return evaluate(c ? e.args[1]! : e.args[2]!, values, result, budget);
      }
      if (e.op === "and" || e.op === "or" || e.op === "implies") {
        // Both sides are evaluated so ill-defined operands (e.g. udiv by zero) are never hidden.
        const a = evaluate(e.args[0]!, values, result, budget) as boolean;
        const b = evaluate(e.args[1]!, values, result, budget) as boolean;
        return e.op === "and" ? a && b : e.op === "or" ? a || b : !a || b;
      }
      if (e.op === "not") return !(evaluate(e.args[0]!, values, result, budget) as boolean);
      const a = evaluate(e.args[0]!, values, result, budget);
      const b = evaluate(e.args[1]!, values, result, budget);
      if (e.op === "eq") return a === b;
      if (e.op === "ne") return a !== b;
      const x = a as bigint;
      const y = b as bigint;
      switch (e.op) {
        case "lt": return x < y;
        case "le": return x <= y;
        case "gt": return x > y;
        case "ge": return x >= y;
        case "rotl": return rotl64(x, y);
        case "rotr": return rotr64(x, y);
      }
      const r = evalBinary(U64_BINARY[e.op]!, x, y);
      if (!r.ok) throw new EvalError(`${e.op} by zero inside a contract`);
      return r.value;
    }
  }
}

/** Names referenced by an expression (for violation reports). */
export function namesIn(e: Expr, out = new Set<string>()): Set<string> {
  if (e.k === "name") out.add(e.name);
  else if (e.k === "result") out.add("result");
  else if (e.k === "app") for (const a of e.args) namesIn(a, out);
  return out;
}

/** Render back to canonical s-expression text. */
export function printSpec(e: Expr): string {
  switch (e.k) {
    case "lit": return String(e.v);
    case "name": return e.name;
    case "result": return "result";
    case "app": return `(${e.op} ${e.args.map(printSpec).join(" ")})`;
  }
}

/** The grammar text included in the model manual. */
export function renderSpecGrammar(): string {
  return [
    "ANMA-Spec contract language (requires / ensures / invariants):",
    "expr  := u64-literal | true | false | name | result",
    "       | (add e e) | (sub e e) | (mul e e) | (udiv e e) | (urem e e)",
    "       | (band e e) | (bor e e) | (bxor e e)",
    "       | (shl e e) | (shr e e) | (rotl e e) | (rotr e e)",
    "       | (eq e e) | (ne e e) | (lt e e) | (le e e) | (gt e e) | (ge e e)",
    "       | (not e) | (and e e) | (or e e) | (implies e e) | (ite e e e)",
    "name  := a parameter name from annotations.params, argN (function argument N at activation entry),",
    "         or bpN (block parameter N; invariants only)",
    "Semantics: u64 arithmetic is modulo 2^64 exactly as the ISA; comparisons are unsigned; shift/rotate",
    "counts use the low six bits; eq/ne compare two values of the same type (u64 or bool); other comparisons",
    "take u64; not/and/or/implies take bool; ite needs a bool condition and same-typed branches.",
    "There is no implicit u64/bool conversion. `result` exists only in ensures of non-unit functions.",
    "udiv/urem by zero inside a contract is an evaluation error, never true. No quantifiers, heap, or device",
    "state in v1 contracts. Literals are plain decimal (no 0x, signs, or leading zeros).",
  ].join("\n");
}
