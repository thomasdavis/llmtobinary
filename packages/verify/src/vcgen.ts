// T3 verification-condition generation (PRD Section 15.5). Pure and runtime-neutral: turns a valid
// module plus ANMA-Spec contracts into SMT-LIB QF_BV queries by symbolic execution over the typed
// block graph, cut at loop headers by invariants. Partial correctness only (termination is not
// proved). Division definedness and callee preconditions are separate obligations.

import { Op, TypeTag, U64_MASK } from "@llmtobinary/spec";
import type { Block, Func, Module } from "@llmtobinary/validate";
import { compileContracts, functionNames, blockNames, parseSpec, type CompiledContracts, type Expr, type ParsedAnnotations, type ParseLimits } from "@llmtobinary/annotations";

export const VCGEN_ID = "llmtobinary-vcgen/1";

export type Obligation = {
  id: string;
  functionId: number;
  kind: "ensures" | "invariant-entry" | "invariant-preserved" | "callee-requires" | "no-division-by-zero";
  description: string;
  /** Record where the obligation arises. */
  recordIndex: number;
  /** True when the VC starts at function entry, so a model is a concrete input (counterexample). */
  fromEntry: boolean;
  /** Names of entry-argument constants for counterexample extraction. */
  inputs: string[];
  smt: string;
};

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

export interface VcSet {
  functionId: number;
  eligibility: Eligibility;
  obligations: Obligation[];
}

const W = 64;
const lit = (v: bigint) => `(_ bv${(v & U64_MASK).toString(10)} ${W})`;
const ZERO = lit(0n);

class Fresh {
  private n = 0;
  decls: string[] = [];
  make(prefix: string, sort: "u64" | "bool"): string {
    const name = `${prefix}_${this.n++}`;
    this.decls.push(`(declare-const ${name} ${sort === "u64" ? `(_ BitVec ${W})` : "Bool"})`);
    return name;
  }
}

function rot(a: string, b: string, left: boolean): string {
  const c = `(bvand ${b} ${lit(63n)})`;
  const back = `(bvsub ${lit(64n)} ${c})`;
  return left ? `(bvor (bvshl ${a} ${c}) (bvlshr ${a} ${back}))` : `(bvor (bvlshr ${a} ${c}) (bvshl ${a} ${back}))`;
}

function binTerm(op: number, a: string, b: string): string {
  switch (op) {
    case Op.ADD_U64: return `(bvadd ${a} ${b})`;
    case Op.SUB_U64: return `(bvsub ${a} ${b})`;
    case Op.MUL_U64: return `(bvmul ${a} ${b})`;
    case Op.UDIV_U64: return `(bvudiv ${a} ${b})`;
    case Op.UREM_U64: return `(bvurem ${a} ${b})`;
    case Op.AND_U64: return `(bvand ${a} ${b})`;
    case Op.OR_U64: return `(bvor ${a} ${b})`;
    case Op.XOR_U64: return `(bvxor ${a} ${b})`;
    case Op.SHL_U64: return `(bvshl ${a} (bvand ${b} ${lit(63n)}))`;
    case Op.SHR_U64: return `(bvlshr ${a} (bvand ${b} ${lit(63n)}))`;
    case Op.ROTL_U64: return rot(a, b, true);
    case Op.ROTR_U64: return rot(a, b, false);
    case Op.EQ_U64: return `(= ${a} ${b})`;
    case Op.LT_U64: return `(bvult ${a} ${b})`;
    case Op.LE_U64: return `(bvule ${a} ${b})`;
  }
  throw new Error(`no SMT translation for opcode ${op}`);
}

/** Translate an ANMA-Spec expression; collects divisors for definedness. */
function specTerm(e: Expr, env: ReadonlyMap<string, string>, result: string | null, divisors: string[]): string {
  switch (e.k) {
    case "lit":
      return typeof e.v === "boolean" ? String(e.v) : lit(e.v);
    case "name":
      return env.get(e.name)!;
    case "result":
      return result!;
    case "app": {
      const a = e.args.map((x) => specTerm(x, env, result, divisors));
      const [x, y, z] = a as [string, string, string];
      switch (e.op) {
        case "add": return `(bvadd ${x} ${y})`;
        case "sub": return `(bvsub ${x} ${y})`;
        case "mul": return `(bvmul ${x} ${y})`;
        case "udiv": divisors.push(y); return `(bvudiv ${x} ${y})`;
        case "urem": divisors.push(y); return `(bvurem ${x} ${y})`;
        case "band": return `(bvand ${x} ${y})`;
        case "bor": return `(bvor ${x} ${y})`;
        case "bxor": return `(bvxor ${x} ${y})`;
        case "shl": return `(bvshl ${x} (bvand ${y} ${lit(63n)}))`;
        case "shr": return `(bvlshr ${x} (bvand ${y} ${lit(63n)}))`;
        case "rotl": return rot(x, y, true);
        case "rotr": return rot(x, y, false);
        case "eq": return `(= ${x} ${y})`;
        case "ne": return `(not (= ${x} ${y}))`;
        case "lt": return `(bvult ${x} ${y})`;
        case "le": return `(bvule ${x} ${y})`;
        case "gt": return `(bvugt ${x} ${y})`;
        case "ge": return `(bvuge ${x} ${y})`;
        case "not": return `(not ${x})`;
        case "and": return `(and ${x} ${y})`;
        case "or": return `(or ${x} ${y})`;
        case "implies": return `(=> ${x} ${y})`;
        case "ite": return `(ite ${x} ${y} ${z})`;
      }
      throw new Error(`unknown operator ${e.op}`);
    }
  }
}

/** A contract as an SMT formula including definedness (every divisor nonzero). */
function contractTerm(e: Expr, env: ReadonlyMap<string, string>, result: string | null): string {
  const divs: string[] = [];
  const body = specTerm(e, env, result, divs);
  if (!divs.length) return body;
  return `(and ${divs.map((d) => `(not (= ${d} ${ZERO}))`).join(" ")} ${body})`;
}

function conj(xs: readonly string[]): string {
  return xs.length === 0 ? "true" : xs.length === 1 ? xs[0]! : `(and ${xs.join(" ")})`;
}

interface PathState {
  vals: string[];
  assumptions: string[];
  entryArgs: string[];
  fresh: Fresh;
  depth: number;
}

const MAX_PATHS = 4096;
const MAX_STEPS = 200_000;

export interface VcOptions {
  /** Parse bounds for the contracts (trusted task contracts may exceed model limits). */
  parseLimits?: ParseLimits;
}

function sortOf(t: TypeTag): "u64" | "bool" {
  return t === TypeTag.BOOL ? "bool" : "u64";
}

function loopHeaders(f: Func): Set<number> {
  const heads = new Set<number>();
  const state = new Map<number, 1 | 2>();
  const visit = (b: number) => {
    state.set(b, 1);
    const t = f.blocks[b]!.term;
    const targets = t.k === "jump" ? [t.edge.target] : t.k === "br" ? [t.t.target, t.f.target] : [];
    for (const x of targets) {
      const s = state.get(x);
      if (s === 1) heads.add(x);
      else if (s === undefined) visit(x);
    }
    state.set(b, 2);
  };
  visit(0);
  return heads;
}

/** Generate VCs for one function against its contracts. */
export function generateVcs(module: Module, ann: ParsedAnnotations, fnId: number, opts: VcOptions = {}): VcSet {
  const f = module.functions[fnId]!;
  const cc: CompiledContracts = compileContracts(ann, module, opts.parseLimits);
  const inel = (reason: string): VcSet => ({ functionId: fnId, eligibility: { eligible: false, reason }, obligations: [] });
  if (f.params.some((t) => t === TypeTag.HANDLE_U8 || t === TypeTag.HANDLE_U64) || f.ret === TypeTag.HANDLE_U8 || f.ret === TypeTag.HANDLE_U64) return inel("handle-typed parameters or results are outside the v1 verifier");
  if (!cc.ensures.get(fnId)?.length) return inel(`fn${fnId} has no ensures contract to prove`);
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.k === "alloc" || ins.k === "load" || ins.k === "store") return inel("heap operations are outside the v1 verifier");
      if (ins.k === "host" && ins.dst !== null) return inel("host calls that return values (input) are outside the v1 verifier");
      if (ins.k === "call" && !cc.ensures.get(ins.fn)?.length && ins.dst !== null) return inel(`fn${fnId} calls fn${ins.fn}, which has no ensures contract (verification is modular)`);
    }
  }
  const heads = loopHeaders(f);
  for (const h of heads) if (!cc.invariants.get(`${fnId}:${h}`)?.length) return inel(`block ${h} is a loop header without an invariant`);

  const obligations: Obligation[] = [];
  const argNames = (fresh: Fresh) => f.params.map((t, i) => fresh.make(`arg${i}`, sortOf(t)));
  const envFor = (entryArgs: string[], blockParams?: string[]) => {
    const env = new Map<string, string>();
    for (const [name] of functionNames(ann, module, fnId)) {
      const m = /^arg(\d+)$/.exec(name);
      if (m) env.set(name, entryArgs[Number(m[1])]!);
    }
    for (const p of ann.params) if (p.function === fnId && entryArgs[p.index] !== undefined) env.set(p.name, entryArgs[p.index]!);
    blockParams?.forEach((v, i) => env.set(`bp${i}`, v));
    return env;
  };
  const requiresOf = (fn: number, args: string[]) => {
    const rs = cc.requires.get(fn) ?? [];
    const env = new Map<string, string>();
    const callee = module.functions[fn]!;
    callee.params.forEach((_, i) => env.set(`arg${i}`, args[i]!));
    for (const p of ann.params) if (p.function === fn && args[p.index] !== undefined) env.set(p.name, args[p.index]!);
    return rs.map((r) => contractTerm(r.expr, env, null));
  };
  const ensuresOf = (fn: number, args: string[], result: string) => {
    const env = new Map<string, string>();
    const callee = module.functions[fn]!;
    callee.params.forEach((_, i) => env.set(`arg${i}`, args[i]!));
    for (const p of ann.params) if (p.function === fn && args[p.index] !== undefined) env.set(p.name, args[p.index]!);
    return (cc.ensures.get(fn) ?? []).map((r) => contractTerm(r.expr, env, result));
  };
  const invariantOf = (block: number, entryArgs: string[], params: string[]) => (cc.invariants.get(`${fnId}:${block}`) ?? []).map((i) => contractTerm(i.expr, envFor(entryArgs, params), null));
  void blockNames;

  let paths = 0;
  let steps = 0;
  let budgetExceeded: string | null = null;
  const emit = (st: PathState, kind: Obligation["kind"], goal: string, rec: number, description: string, fromEntry: boolean) => {
    const script = [
      "(set-logic QF_BV)",
      ...st.fresh.decls,
      ...st.assumptions.map((a) => `(assert ${a})`),
      `(assert (not ${goal}))`,
      "(check-sat)",
    ].join("\n");
    obligations.push({ id: `fn${fnId}#${obligations.length}`, functionId: fnId, kind, description, recordIndex: rec, fromEntry, inputs: st.entryArgs, smt: script });
  };

  const run = (block: Block, st: PathState, fromEntry: boolean) => {
    if (budgetExceeded) return;
    if (++paths > MAX_PATHS) {
      budgetExceeded = `more than ${MAX_PATHS} paths`;
      return;
    }
    const v = st.vals;
    for (const ins of block.instrs) {
      if (++steps > MAX_STEPS) {
        budgetExceeded = `more than ${MAX_STEPS} symbolic steps`;
        return;
      }
      switch (ins.k) {
        case "const":
          v[ins.dst] = typeof ins.value === "boolean" ? String(ins.value) : lit(ins.value);
          break;
        case "bin":
          if (ins.op === Op.UDIV_U64 || ins.op === Op.UREM_U64) emit(st, "no-division-by-zero", `(not (= ${v[ins.b]} ${ZERO}))`, ins.rec, `divisor at record ${ins.rec} is nonzero`, fromEntry);
          v[ins.dst] = binTerm(ins.op, v[ins.a]!, v[ins.b]!);
          st.assumptions.push(...(ins.op === Op.UDIV_U64 || ins.op === Op.UREM_U64 ? [`(not (= ${v[ins.b]} ${ZERO}))`] : []));
          break;
        case "un":
          v[ins.dst] = ins.op === Op.NOT_BOOL ? `(not ${v[ins.a]})` : ins.op === Op.BOOL_TO_U64 ? `(ite ${v[ins.a]} ${lit(1n)} ${ZERO})` : `(not (= ${v[ins.a]} ${ZERO}))`;
          break;
        case "host":
          break; // unit device effect: no value semantics
        case "call": {
          const args = ins.args.map((a) => v[a]!);
          for (const r of requiresOf(ins.fn, args)) emit(st, "callee-requires", r, ins.rec, `requires of fn${ins.fn} holds at the call in record ${ins.rec}`, fromEntry);
          st.assumptions.push(...requiresOf(ins.fn, args));
          if (ins.dst !== null) {
            const res = st.fresh.make(`ret_fn${ins.fn}`, sortOf(module.functions[ins.fn]!.ret));
            st.assumptions.push(...ensuresOf(ins.fn, args, res));
            v[ins.dst] = res;
          }
          break;
        }
        default:
          throw new Error("unreachable (eligibility)");
      }
    }
    const t = block.term;
    const go = (target: number, args: number[], cond: string | null) => {
      const next: PathState = { vals: [], assumptions: cond ? [...st.assumptions, cond] : [...st.assumptions], entryArgs: st.entryArgs, fresh: st.fresh, depth: st.depth + 1 };
      const params = args.map((a) => v[a]!);
      if (heads.has(target)) {
        emit(next, block.id === 0 && fromEntry && st.depth === 0 ? "invariant-entry" : "invariant-preserved", conj(invariantOf(target, st.entryArgs, params)), t.rec, `invariant of block ${target} holds on the edge from block ${block.id}`, fromEntry);
        return;
      }
      next.vals = [...params];
      run(f.blocks[target]!, next, fromEntry);
    };
    if (t.k === "jump") go(t.edge.target, t.edge.args, null);
    else if (t.k === "br") {
      const c = v[t.cond]!;
      go(t.t.target, t.t.args, c);
      go(t.f.target, t.f.args, `(not ${c})`);
    } else {
      // Unit functions have no `result` (the typechecker forbids it), so "" is never referenced.
      const res = t.src === null ? "" : v[t.src]!;
      for (const e of ensuresOf(fnId, st.entryArgs, res)) emit(st, "ensures", e, t.rec, `ensures of fn${fnId} holds at RETURN (record ${t.rec})`, fromEntry);
    }
  };

  // Entry: assume requires; if block 0 is itself a loop header, its invariant must hold on entry.
  {
    const fresh = new Fresh();
    const args = argNames(fresh);
    const st: PathState = { vals: [...args], assumptions: requiresOf(fnId, args), entryArgs: args, fresh, depth: 0 };
    if (heads.has(0)) emit(st, "invariant-entry", conj(invariantOf(0, args, args)), f.blocks[0]!.rec, "invariant of block 0 holds on entry", true);
    else run(f.blocks[0]!, st, true);
  }
  // Each cut-point: assume requires(args) and its invariant over fresh parameters.
  for (const h of heads) {
    const fresh = new Fresh();
    const args = argNames(fresh);
    const b = f.blocks[h]!;
    const params = b.params.map((t, i) => fresh.make(`bp${i}`, sortOf(t)));
    const st: PathState = { vals: [...params], assumptions: [...requiresOf(fnId, args), ...invariantOf(h, args, params)], entryArgs: args, fresh, depth: 1 };
    run(b, st, false);
  }
  if (budgetExceeded) return inel(`symbolic execution budget exceeded (${budgetExceeded})`);
  return { functionId: fnId, eligibility: { eligible: true }, obligations };
}

export function isParseable(text: string, limits?: ParseLimits): boolean {
  try {
    parseSpec(text, limits);
    return true;
  } catch {
    return false;
  }
}
