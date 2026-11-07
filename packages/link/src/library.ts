// The library a model can reuse while it writes a program. Pure: searching and linking are the same
// code on the site and in the research harness. Nothing here decides what a program should import.
// The model does that, and the linker and validator then judge the result.

import { Op } from "@llmtobinary/spec";
import { parseModule } from "@llmtobinary/module";
import { link, type LinkError, type LinkInput } from "./index.ts";

const HEADER = 32;
const RECORD = 16;
const RANK: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4, E5: 5 };
const TYPE: Record<number, string> = { 0: "unit", 1: "u64", 2: "bool", 3: "handle<u8>", 4: "handle<u64>" };

/** Only packages a second, independent machine has reproduced. */
export const LIBRARY_POLICY = "E4";
export const SEARCH_LIMIT = 12;
const INDEX_CHARS = 6_000;
/** The program being written, as the linker names it. */
export const PROGRAM = "program";

export interface LibraryFunction {
  symbol: string;
  signature: string;
  behaviour: string;
  /** Function ID inside the package. */
  id: number;
  params: number[];
  ret: number;
}

export interface LibraryEntry {
  slot: string;
  title: string;
  objectId: string;
  evidence: string;
  features: number;
  depends: string[];
  functions: LibraryFunction[];
}

export interface LibraryCard {
  symbol: string;
  signature: string;
  behaviour: string;
  package: string;
  evidence: string;
  /** How to declare it. The function ID is the caller's next free ID. */
  importRecords: string;
}

export interface LinkedPackage {
  slot: string;
  objectId: string;
  evidence: string;
  /** Functions of this package the program calls directly. A dependency of a dependency has none. */
  symbols: string[];
}

export type LibraryLink =
  | {
      ok: true;
      bytes: Uint8Array;
      packages: LinkedPackage[];
      /** Imports the program really calls, from a CALL record in its own bytes. */
      uses: string[];
      authority: string[];
    }
  | { ok: false; errors: LinkError[] };

export interface LibraryAccess {
  search(query: string): Promise<LibraryCard[]>;
  cards(symbols: readonly string[]): Promise<{ cards: LibraryCard[]; unknown: string[] }>;
  link(root: Uint8Array, symbols: readonly string[]): Promise<LibraryLink>;
}

const word = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const hexWord = (n: number): string => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * What a program may import: packages at the policy class or above that need no feature the task
 * forbids, and whose dependencies qualify too. A package that fails drops whatever depends on it.
 */
export function eligibleCatalog(entries: readonly LibraryEntry[], allowedFeatures: number, policy: string = LIBRARY_POLICY): LibraryEntry[] {
  const bySlot = new Map(entries.map((e) => [e.slot, e]));
  const memo = new Map<string, boolean>();
  const ok = (slot: string): boolean => {
    const known = memo.get(slot);
    if (known !== undefined) return known;
    memo.set(slot, false); // A cycle cannot qualify.
    const e = bySlot.get(slot);
    const good = !!e && (RANK[e.evidence] ?? -1) >= RANK[policy]! && (e.features & ~allowedFeatures) === 0 && e.depends.every(ok);
    memo.set(slot, good);
    return good;
  };
  return entries.filter((e) => e.functions.length > 0 && ok(e.slot));
}

function importRecords(f: LibraryFunction): string {
  const params = f.params.map((t, k) => `${hexWord(3)}${hexWord(k)}${hexWord(t)}${hexWord(k)}`);
  return [`${hexWord(0x70)}<your next free function ID as a word>${hexWord(f.params.length)}${hexWord(f.ret)}`, ...params].join("\n");
}

const card = (e: LibraryEntry, f: LibraryFunction): LibraryCard => ({ symbol: f.symbol, signature: f.signature, behaviour: f.behaviour, package: e.slot, evidence: e.evidence, importRecords: importRecords(f) });

/** Keyword search over names, signatures and behaviour. An empty or unmatched query lists the start of the library. */
export function searchCatalog(catalog: readonly LibraryEntry[], query: string, limit = SEARCH_LIMIT): LibraryCard[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const scored = catalog.flatMap((e) =>
    e.functions.map((f) => {
      const name = f.symbol.toLowerCase();
      const text = `${e.title} ${f.signature} ${f.behaviour}`.toLowerCase();
      return { e, f, score: words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0) };
    }),
  );
  const hits = scored.filter((s) => s.score > 0);
  return (hits.length ? hits : scored)
    .sort((a, b) => b.score - a.score || a.f.symbol.localeCompare(b.f.symbol))
    .slice(0, limit)
    .map((s) => card(s.e, s.f));
}

/** One line per function, for the task message. Past the limit it says how much was left out. */
export function renderIndex(catalog: readonly LibraryEntry[], maxChars = INDEX_CHARS): string {
  const lines = catalog.flatMap((e) => e.functions.map((f) => `- ${f.symbol}${f.signature}: ${f.behaviour.split(/(?<=\.)\s/)[0]}`)).sort();
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) break;
    kept.push(l);
    used += l.length + 1;
  }
  const rest = lines.length - kept.length;
  return `${kept.join("\n")}${rest ? `\n(${rest} more: use search_library)` : ""}`;
}

/** Imports this module's own CALL records reach. A declared but uncalled import does not count. */
function calledImports(root: Uint8Array, first: number): Set<number> {
  const called = new Set<number>();
  const records = word(root, 12);
  for (let i = 0; i < records; i++) {
    const at = HEADER + i * RECORD;
    if (word(root, at) === Op.CALL && word(root, at + 8) >= first) called.add(word(root, at + 8));
  }
  return called;
}

/** Links a program against the library. `symbols[k]` is the program's kth import, in declared order. */
export async function linkWithLibrary(catalog: readonly LibraryEntry[], root: Uint8Array, symbols: readonly string[], fetchBytes: (objectId: string) => Promise<Uint8Array | null>, allowedFeatures: number): Promise<LibraryLink> {
  const parsed = parseModule(root);
  if (!parsed.ok) return { ok: false, errors: [{ rule: parsed.error.rule, message: parsed.error.message }] };
  const m = parsed.module;
  if (m.imports.length !== symbols.length) return { ok: false, errors: [{ rule: "LINK-MAP", message: `The program declares ${m.imports.length} IMPORT records but use_library selected ${symbols.length} symbols. Declare one IMPORT per selected symbol, in the same order.` }] };

  const bySlot = new Map(catalog.map((e) => [e.slot, e]));
  const owner = new Map(catalog.flatMap((e) => e.functions.map((f) => [f.symbol, e] as const)));
  const unknown = symbols.filter((s) => !owner.has(s));
  if (unknown.length) return { ok: false, errors: [{ rule: "LINK-UNKNOWN", message: `Not in the library: ${unknown.join(", ")}.` }] };

  const needed = new Map<string, LibraryEntry>();
  const need = (e: LibraryEntry): void => {
    if (needed.has(e.slot)) return;
    needed.set(e.slot, e);
    for (const d of e.depends) need(bySlot.get(d)!);
  };
  for (const s of symbols) need(owner.get(s)!);

  const first = m.functions.length;
  const inputs: LinkInput[] = [{ name: PROGRAM, bytes: root, exports: {}, imports: Object.fromEntries(symbols.map((s, k) => [first + k, s])) }];
  for (const e of needed.values()) {
    const bytes = await fetchBytes(e.objectId);
    if (!bytes) return { ok: false, errors: [{ rule: "LINK-FETCH", message: `The bytes of ${e.slot} could not be read.` }] };
    const p = parseModule(bytes);
    if (!p.ok) return { ok: false, errors: [{ rule: p.error.rule, message: `${e.slot}: ${p.error.message}` }] };
    const wanted = e.depends.flatMap((d) => bySlot.get(d)!.functions);
    const start = p.module.functions.length;
    inputs.push({
      name: e.slot,
      bytes,
      exports: Object.fromEntries(e.functions.map((f) => [f.symbol, f.id])),
      imports: Object.fromEntries(wanted.slice(0, p.module.imports.length).map((f, k) => [start + k, f.symbol])),
    });
  }

  const r = link(inputs, { allowedFeatures });
  if (!r.ok) return { ok: false, errors: r.errors };
  const called = calledImports(root, first);
  const uses = [...new Set(symbols.filter((_, k) => called.has(first + k)))];
  return {
    ok: true,
    bytes: r.bytes,
    packages: r.modules.filter((n) => n !== PROGRAM).map((n) => ({ slot: n, objectId: needed.get(n)!.objectId, evidence: needed.get(n)!.evidence, symbols: uses.filter((u) => owner.get(u)!.slot === n) })),
    uses,
    authority: r.authority,
  };
}

/** The tools' view of a catalog, shared by the site and the research harness. */
export function catalogAccess(catalog: readonly LibraryEntry[], fetchBytes: (objectId: string) => Promise<Uint8Array | null>, allowedFeatures: number): LibraryAccess {
  const cardFor = (symbol: string): LibraryCard | null => {
    for (const e of catalog) for (const f of e.functions) if (f.symbol === symbol) return card(e, f);
    return null;
  };
  return {
    search: async (query) => searchCatalog(catalog, query),
    cards: async (symbols) => ({ cards: symbols.map(cardFor).filter((c): c is LibraryCard => !!c), unknown: symbols.filter((s) => !cardFor(s)) }),
    link: (root, symbols) => linkWithLibrary(catalog, root, symbols, fetchBytes, allowedFeatures),
  };
}

export const typeName = (t: number): string => TYPE[t] ?? `type ${t}`;
