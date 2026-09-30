// Plain-English readings of ANMA-1 records, for readers who have never seen machine code. Each
// line restates the record's specified meaning (Section 10); it adds no interpretation.

import { IMPORTS, Op, TYPE_NAMES, UNIT_SENTINEL, constFromWords, type TypeTag } from "@llmtobinary/spec";
import type { RawRecord } from "@llmtobinary/decode";

const v = (n: number) => `v${n}`;
const INFIX: Record<number, string> = {
  [Op.ADD_U64]: "+",
  [Op.SUB_U64]: "−",
  [Op.MUL_U64]: "×",
  [Op.UDIV_U64]: "÷",
  [Op.UREM_U64]: "mod",
  [Op.AND_U64]: "AND",
  [Op.OR_U64]: "OR",
  [Op.XOR_U64]: "XOR",
  [Op.SHL_U64]: "shifted left by",
  [Op.SHR_U64]: "shifted right by",
  [Op.ROTL_U64]: "rotated left by",
  [Op.ROTR_U64]: "rotated right by",
  [Op.EQ_U64]: "equals",
  [Op.LT_U64]: "is less than",
  [Op.LE_U64]: "is at most",
};

export function plainEnglish(r: Pick<RawRecord, "op" | "a" | "b" | "c">): string {
  const { op, a, b, c } = r;
  switch (op) {
    case Op.FUNC:
      return `Start of function ${a} (${b} input${b === 1 ? "" : "s"}, returns ${TYPE_NAMES[c as TypeTag] ?? "?"})`;
    case Op.BLOCK:
      return `Block ${a} begins (${b} input${b === 1 ? "" : "s"}, ${c} value${c === 1 ? "" : "s"} in all)`;
    case Op.PARAM:
      return `${v(a)} is input ${c} (${TYPE_NAMES[b as TypeTag] ?? "?"})`;
    case Op.END_FUNC:
      return "End of function";
    case Op.CONST_U64:
      return `${v(a)} = ${constFromWords(b, c).toString()}`;
    case Op.CONST_BOOL:
      return `${v(a)} = ${b ? "true" : "false"}`;
    case Op.NOT_BOOL:
      return `${v(a)} = not ${v(b)}`;
    case Op.BOOL_TO_U64:
      return `${v(a)} = 1 if ${v(b)} is true, else 0`;
    case Op.U64_NONZERO:
      return `${v(a)} = whether ${v(b)} is not zero`;
    case Op.JUMP:
      return `Go to block ${a}, passing ${b} value${b === 1 ? "" : "s"}`;
    case Op.BR_IF:
      return `If ${v(a)} is true go to block ${b}, otherwise block ${c}`;
    case Op.CALL:
      return `${a === UNIT_SENTINEL ? "Call" : `${v(a)} = result of calling`} function ${b} with ${c} value${c === 1 ? "" : "s"}`;
    case Op.RETURN:
      return a === UNIT_SENTINEL ? "Return" : `Return ${v(a)}`;
    case Op.ARG:
      return `…passing ${v(a)}`;
    case Op.EDGE_ARGS:
      return `…${a} value${a === 1 ? "" : "s"} for the next target`;
    case Op.ALLOC_U64:
    case Op.ALLOC_U8:
      return `${v(a)} = new memory block of ${v(b)} ${op === Op.ALLOC_U64 ? "numbers" : "bytes"}`;
    case Op.LOAD_U64:
    case Op.LOAD_U8:
      return `${v(a)} = item ${v(c)} of memory block ${v(b)}`;
    case Op.STORE_U64:
    case Op.STORE_U8:
      return `Store ${v(c)} as item ${v(b)} of memory block ${v(a)}`;
    case Op.HOST: {
      const imp = IMPORTS[b];
      const name = imp?.name ?? `device ${b}`;
      const what: Record<string, string> = {
        "terminal.print_u64": "print a number",
        "terminal.print_utf8": "print text",
        "display.clear": "fill the screen with one colour",
        "display.pixel": "set one pixel",
        "display.present": "show the finished frame",
        "input.key_down": "check whether a key is held",
        "input.wait_tick": "wait for the next moment of time",
      };
      return `${a === UNIT_SENTINEL ? "" : `${v(a)} = `}${what[name] ?? name} (${name})`;
    }
    default: {
      const sym = INFIX[op];
      return sym ? `${v(a)} = ${v(b)} ${sym} ${v(c)}` : "Unknown instruction";
    }
  }
}
