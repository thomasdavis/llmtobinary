// The merge linker (spec/anma-2.md). Untrusted by design: it resolves symbols, renumbers function
// IDs and joins records, then the ordinary validator judges the result. A linker bug can produce a
// wrong program, never an unsafe one. It writes no instruction records of its own.

import { IMPORTS, Op } from "@llmtobinary/spec";
import { parseModule, type ModuleImport, type ParsedModule, type Signature } from "@llmtobinary/module";
import { validateBytes } from "@llmtobinary/validate";

const HEADER = 32;
const RECORD = 16;
const MAGIC = 0x414d4e41;

export interface LinkInput {
  name: string;
  bytes: Uint8Array;
  /** Symbol to defined function ID. */
  exports: Record<string, number>;
  /** Import function ID to symbol. */
  imports: Record<number, string>;
}

export interface LinkError {
  rule: string;
  message: string;
}

export interface LinkedEdge {
  from: string;
  to: string;
  symbol: string;
}

export interface LinkSuccess {
  ok: true;
  bytes: Uint8Array;
  modules: string[];
  edges: LinkedEdge[];
  /** Host operations reachable from the entry function. */
  authority: string[];
  label: "linked";
}

export type LinkResult = LinkSuccess | { ok: false; errors: LinkError[] };

const sigText = (s: Signature): string => `(${s.params.join(",")})->${s.ret}`;
const sameSig = (a: Signature, b: Signature): boolean => sigText(a) === sigText(b);

const word = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const setWord = (b: Uint8Array, at: number, v: number): void => {
  b[at] = v & 255;
  b[at + 1] = (v >>> 8) & 255;
  b[at + 2] = (v >>> 16) & 255;
  b[at + 3] = (v >>> 24) & 255;
};

interface Loaded {
  input: LinkInput;
  module: ParsedModule;
}

/** Links `inputs`, with `inputs[0]` as the root that supplies the entry function. */
export function link(inputs: readonly LinkInput[], opts: { allowedFeatures?: number } = {}): LinkResult {
  const errors: LinkError[] = [];
  const loaded: Loaded[] = [];
  for (const input of inputs) {
    const p = parseModule(input.bytes);
    if (!p.ok) errors.push({ rule: p.error.rule, message: `${input.name}: ${p.error.message}` });
    else loaded.push({ input, module: p.module });
  }
  if (errors.length) return { ok: false, errors };
  if (!loaded.length) return { ok: false, errors: [{ rule: "LINK-EMPTY", message: "Nothing to link." }] };

  const symbols = new Map<string, { owner: Loaded; id: number }>();
  for (const l of loaded) {
    for (const [symbol, id] of Object.entries(l.input.exports)) {
      if (symbols.has(symbol)) errors.push({ rule: "LINK-DUPLICATE", message: `${symbol} is exported by both ${symbols.get(symbol)!.owner.input.name} and ${l.input.name}.` });
      else if (!l.module.functions[id]) errors.push({ rule: "LINK-EXPORT", message: `${l.input.name} exports ${symbol} as function ${id}, which it does not define.` });
      else symbols.set(symbol, { owner: l, id });
    }
  }

  const edges: LinkedEdge[] = [];
  const resolved = new Map<Loaded, Map<number, { owner: Loaded; id: number }>>();
  for (const l of loaded) {
    const map = new Map<number, { owner: Loaded; id: number }>();
    resolved.set(l, map);
    for (const imp of l.module.imports) {
      const symbol = l.input.imports[imp.id];
      if (symbol === undefined) {
        errors.push({ rule: "LINK-UNNAMED", message: `${l.input.name}: import ${imp.id} has no symbol in the link map.` });
        continue;
      }
      const target = symbols.get(symbol);
      if (!target) {
        errors.push({ rule: "LINK-MISSING", message: `${l.input.name} imports ${symbol}, which nothing exports.` });
        continue;
      }
      const have = target.owner.module.functions[target.id]!;
      if (!sameSig(imp, have)) {
        errors.push({ rule: "LINK-TYPE", message: `${l.input.name} imports ${symbol} as ${sigText(imp)} but ${target.owner.input.name} defines it as ${sigText(have)}.` });
        continue;
      }
      map.set(imp.id, target);
      edges.push({ from: l.input.name, to: target.owner.input.name, symbol });
    }
  }
  if (errors.length) return { ok: false, errors };

  // Version 0 forbids cycles, so a module's reach is a tree walk from the root.
  const order: Loaded[] = [];
  const state = new Map<Loaded, "visiting" | "done">();
  const visit = (l: Loaded): boolean => {
    if (state.get(l) === "done") return true;
    if (state.get(l) === "visiting") {
      errors.push({ rule: "LINK-CYCLE", message: `${l.input.name} is part of an import cycle.` });
      return false;
    }
    state.set(l, "visiting");
    order.push(l);
    for (const t of resolved.get(l)!.values()) if (t.owner !== l && !visit(t.owner)) return false;
    state.set(l, "done");
    return true;
  };
  const root = loaded[0]!;
  if (!visit(root)) return { ok: false, errors };

  for (const l of order) if (l !== root && l.module.dataBytes > 0) errors.push({ rule: "LINK-DATA", message: `${l.input.name} has read-only data. Version 0 allows data only in the root module, because data offsets are runtime values the linker cannot move.` });
  if (errors.length) return { ok: false, errors };

  const base = new Map<Loaded, number>();
  let nextId = 0;
  for (const l of order) {
    base.set(l, nextId);
    nextId += l.module.functions.length;
  }
  const remap = (l: Loaded, id: number): number => {
    if (id < l.module.functions.length) return base.get(l)! + id;
    const t = resolved.get(l)!.get(id);
    return t ? base.get(t.owner)! + t.id : id;
  };

  const bodies = order.map((l) => {
    const body = l.module.body.slice();
    for (let at = 0; at < body.length; at += RECORD) {
      const op = word(body, at);
      if (op === Op.FUNC) setWord(body, at + 4, remap(l, word(body, at + 4)));
      if (op === Op.CALL) setWord(body, at + 8, remap(l, word(body, at + 8)));
    }
    return body;
  });
  const bodyBytes = bodies.reduce((n, b) => n + b.length, 0);
  const data = root.module.data;
  const out = new Uint8Array(HEADER + bodyBytes + data.length);
  setWord(out, 0, MAGIC);
  setWord(out, 4, 1);
  setWord(out, 8, order.reduce((f, l) => f | l.module.features, 0));
  setWord(out, 12, bodyBytes / RECORD);
  setWord(out, 16, data.length);
  setWord(out, 20, remap(root, root.module.entry));
  let at = HEADER;
  for (const b of bodies) {
    out.set(b, at);
    at += b.length;
  }
  out.set(data, at);

  const v = validateBytes(out, opts.allowedFeatures === undefined ? {} : { allowedFeatures: opts.allowedFeatures });
  if (!v.ok || !v.module) return { ok: false, errors: [{ rule: "LINK-INVALID", message: `The linked image failed validation: ${v.diagnostics.map((d) => d.rule).join(", ")}` }] };
  return { ok: true, bytes: out, modules: order.map((l) => l.input.name), edges, authority: authorityOf(out), label: "linked" };
}

/** Host operations reachable from the entry function, by walking the call graph. */
export function authorityOf(image: Uint8Array): string[] {
  const records = word(image, 12);
  const funcs: { calls: number[]; hosts: number[] }[] = [];
  for (let i = 0; i < records; i++) {
    const at = HEADER + i * RECORD;
    const op = word(image, at);
    if (op === Op.FUNC) funcs.push({ calls: [], hosts: [] });
    else if (op === Op.CALL) funcs.at(-1)?.calls.push(word(image, at + 8));
    else if (op === Op.HOST) funcs.at(-1)?.hosts.push(word(image, at + 8));
  }
  const seen = new Set<number>();
  const hosts = new Set<number>();
  const walk = (f: number): void => {
    if (seen.has(f) || !funcs[f]) return;
    seen.add(f);
    for (const h of funcs[f]!.hosts) hosts.add(h);
    for (const c of funcs[f]!.calls) walk(c);
  };
  walk(word(image, 20));
  return [...hosts].sort((a, b) => a - b).map((h) => IMPORTS[h]?.name ?? `import-${h}`);
}

export type { ModuleImport };
