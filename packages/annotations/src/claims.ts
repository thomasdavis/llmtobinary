// T1 record claims (PRD Section 15.3): parse a claim s-expression and compare it field by field
// with the decoded record. Direction is always bytes -> decoded -> compare. Nothing here turns a
// claim into bytes.

import { IMPORT_BY_NAME, OP_BY_NAME, Op, TYPE_CLAIM_NAMES, UNIT_SENTINEL, constFromWords, type FieldRole, type OpInfo } from "@llmtobinary/spec";
import { disassemble, type RawRecord } from "@llmtobinary/decode";

export interface Claim {
  op: OpInfo;
  /** Claimed a/b/c words for non-"zero" fields (undefined for zero-role fields). */
  fields: [number | undefined, number | undefined, number | undefined];
  /** Claimed 64-bit constant for CONST_U64. */
  constValue?: bigint;
}

export type ClaimParse = { ok: true; claim: Claim } | { ok: false; error: string };

const TYPE_BY_CLAIM_NAME = new Map<string, number>(Object.entries(TYPE_CLAIM_NAMES).map(([k, v]) => [v, Number(k)]));

function tokenize(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return null;
  const inner = t.slice(1, -1).trim();
  if (inner.includes("(") || inner.includes(")")) return null;
  return inner.length ? inner.split(/\s+/) : [];
}

function parseNat(tok: string, max: number): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(tok)) return null;
  const v = Number(tok);
  return Number.isSafeInteger(v) && v <= max ? v : null;
}

function parseRole(role: FieldRole, tok: string): number | null | "bad" {
  const U32 = 0xffffffff;
  switch (role) {
    case "dest":
    case "src":
    case "dest-or-unit":
    case "src-or-unit": {
      if (tok === "_") return UNIT_SENTINEL;
      const m = /^v(0|[1-9][0-9]*)$/.exec(tok);
      if (!m) return "bad";
      return parseNat(m[1]!, U32) ?? "bad";
    }
    case "func": {
      const m = /^fn(0|[1-9][0-9]*)$/.exec(tok);
      return m ? (parseNat(m[1]!, U32) ?? "bad") : "bad";
    }
    case "block": {
      const m = /^block(0|[1-9][0-9]*)$/.exec(tok);
      return m ? (parseNat(m[1]!, U32) ?? "bad") : "bad";
    }
    case "import": {
      const imp = IMPORT_BY_NAME.get(tok);
      if (imp) return imp.id;
      const m = /^import(0|[1-9][0-9]*)$/.exec(tok);
      return m ? (parseNat(m[1]!, U32) ?? "bad") : "bad";
    }
    case "type": {
      const t = TYPE_BY_CLAIM_NAME.get(tok);
      if (t !== undefined) return t;
      const m = /^type(0|[1-9][0-9]*)$/.exec(tok);
      return m ? (parseNat(m[1]!, U32) ?? "bad") : "bad";
    }
    case "imm-bool":
      if (tok === "true") return 1;
      if (tok === "false") return 0;
      return parseNat(tok, U32) ?? "bad";
    case "count":
    case "index":
    case "imm-lo":
    case "imm-hi":
      return parseNat(tok, U32) ?? "bad";
    case "zero":
      return null;
  }
}

const EXAMPLES = "(ADD_U64 v3 v1 v2), (CONST_U64 v2 2), (HOST _ terminal.print_u64 1), (ARG v3), (BR_IF v5 block1 block2)";

export function parseClaim(text: string): ClaimParse {
  const toks = tokenize(text);
  if (!toks || toks.length === 0) return { ok: false, error: `a claim is one parenthesized s-expression such as ${EXAMPLES}` };
  const [name, ...rest] = toks as [string, ...string[]];
  const op = OP_BY_NAME.get(name);
  if (!op) return { ok: false, error: `unknown mnemonic ${JSON.stringify(name)}; use the opcode names from the manual (e.g. ADD_U64)` };
  if (op.code === Op.CONST_U64) {
    if (rest.length !== 2) return { ok: false, error: "CONST_U64 claims have the form (CONST_U64 vN <decimal u64>)" };
    const dst = parseRole("dest", rest[0]!);
    if (dst === "bad" || dst === null) return { ok: false, error: `bad destination ${JSON.stringify(rest[0])}` };
    if (!/^(0|[1-9][0-9]{0,19})$/.test(rest[1]!) || BigInt(rest[1]!) > (1n << 64n) - 1n) return { ok: false, error: `bad u64 constant ${JSON.stringify(rest[1])}` };
    return { ok: true, claim: { op, fields: [dst, undefined, undefined], constValue: BigInt(rest[1]!) } };
  }
  const roles = op.fields.filter((r) => r !== "zero");
  if (rest.length !== roles.length) {
    return { ok: false, error: `${name} claims take ${roles.length} field${roles.length === 1 ? "" : "s"} (${op.summary}); got ${rest.length}` };
  }
  const fields: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
  let k = 0;
  for (let i = 0; i < 3; i++) {
    const role = op.fields[i]!;
    if (role === "zero") continue;
    const tok = rest[k++]!;
    const v = parseRole(role, tok);
    if (v === "bad" || v === null) return { ok: false, error: `field ${i + 1} of ${name} (${role}) cannot be ${JSON.stringify(tok)}` };
    fields[i] = v;
  }
  return { ok: true, claim: { op, fields } };
}

export interface ClaimComparison {
  matches: boolean;
  decodedText: string;
  differences: string[];
}

/** Compare a parsed claim with a decoded record; lists every differing field. */
export function compareClaim(claim: Claim, rec: RawRecord): ClaimComparison {
  const decodedText = disassemble(rec);
  const differences: string[] = [];
  if (claim.op.code !== rec.op) {
    differences.push(`opcode byte is 0x${rec.op.toString(16).padStart(2, "0")} (${decodedText.slice(1).split(/[\s)]/)[0]}), claim says 0x${claim.op.code.toString(16).padStart(2, "0")} (${claim.op.name})`);
    return { matches: false, decodedText, differences };
  }
  if (claim.op.code === Op.CONST_U64) {
    if (claim.fields[0] !== rec.a) differences.push(`destination is v${rec.a}, claim says v${claim.fields[0]}`);
    const actual = constFromWords(rec.b, rec.c);
    if (claim.constValue !== actual) {
      differences.push(`constant is ${actual} (low word ${rec.b}, high word ${rec.c}), claim says ${claim.constValue}`);
    }
  } else {
    const words = [rec.a, rec.b, rec.c];
    const names = ["a", "b", "c"];
    for (let i = 0; i < 3; i++) {
      const want = claim.fields[i];
      if (want === undefined) continue;
      if (want !== words[i]) differences.push(`field ${names[i]} (${claim.op.fields[i]}) is ${words[i]}, claim says ${want}`);
    }
  }
  return { matches: differences.length === 0, decodedText, differences };
}
