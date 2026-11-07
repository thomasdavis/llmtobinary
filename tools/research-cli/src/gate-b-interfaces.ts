// Gate B interfaces: what each side is told, and the oracle that judges the linked program.
// Inputs here are never shown to a model.

const M = (1n << 64n) - 1n;
const w = (x: bigint): bigint => x & M;

export interface Export {
  symbol: string;
  signature: string;
  behaviour: string;
  /** Function ID in the library. Function 0 is the library's trivial entry. */
  id: number;
  params: number[];
  ret: number;
}

export interface GateInterface {
  id: string;
  exports: Export[];
  features: number;
  app: { params: ("u64" | "bool")[]; signature: string; behaviour: string };
  oracle(inputs: bigint[]): bigint;
  cases: bigint[][];
  /** Generous enough for a simple O(n^2) library. */
  fuel: number;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

function sorted(seed: bigint, n: bigint): bigint {
  const a: bigint[] = [];
  let x = seed;
  for (let i = 0n; i < n; i++) {
    x = w(x * 6364136223846793005n + 1442695040888963407n);
    a.push(x >> 33n);
  }
  a.sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
  return a.reduce((s, v, i) => w(s + v * BigInt(i + 1)), 0n);
}

function stack(n: bigint): bigint {
  const s: bigint[] = [];
  for (let i = 1n; i <= n; i++) s.push(i);
  while (s.length > 1) {
    const a = s.pop()!;
    const b = s.pop()!;
    s.push(w(a * 31n + b));
  }
  return s[0] ?? 0n;
}

export const INTERFACES: GateInterface[] = [
  {
    id: "gcd",
    features: 0,
    exports: [{ symbol: "math.gcd", signature: "(a: u64, b: u64) -> u64", behaviour: "The greatest common divisor of a and b. gcd(a, 0) is a and gcd(0, b) is b.", id: 1, params: [1, 1], ret: 1 }],
    app: { params: ["u64"], signature: "(n: u64) -> u64", behaviour: "Returns the sum of math.gcd(i, n) for every i from 1 to n inclusive, and 0 when n is 0." },
    oracle: ([n]) => {
      let s = 0n;
      for (let i = 1n; i <= n!; i++) s += gcd(i, n!);
      return w(s);
    },
    cases: [[0n], [1n], [2n], [12n], [97n], [360n], [1001n]],
    fuel: 20_000_000,
  },
  {
    id: "sort",
    features: 1,
    exports: [{ symbol: "arr.sort", signature: "(a: handle<u64>, len: u64) -> unit", behaviour: "Sorts elements 0 to len-1 of a into ascending unsigned order, in place. Elements from len onward are left alone.", id: 1, params: [4, 1], ret: 0 }],
    app: {
      params: ["u64", "u64"],
      signature: "(seed: u64, n: u64) -> u64",
      behaviour: "Allocates a u64 array of n elements. With x starting at seed, for each i from 0 to n-1: x = x * 6364136223846793005 + 1442695040888963407 (wrapping), then a[i] = x >> 33. Calls arr.sort(a, n). Returns the wrapping sum of a[i] * (i + 1) for i from 0 to n-1, and 0 when n is 0.",
    },
    oracle: ([seed, n]) => sorted(seed!, n!),
    cases: [[1n, 0n], [1n, 1n], [7n, 2n], [42n, 10n], [99n, 33n], [123456789n, 100n], [18446744073709551615n, 64n]],
    fuel: 20_000_000,
  },
  {
    id: "fmt",
    features: 1,
    exports: [{ symbol: "fmt.dec", signature: "(buf: handle<u8>, value: u64) -> u64", behaviour: "Writes value in decimal as ASCII digits at buf[0] onward, most significant digit first, with no leading zeros. Zero writes the single digit 0. Returns the number of digits written. buf holds at least 20 bytes.", id: 1, params: [3, 1], ret: 1 }],
    app: {
      params: ["u64"],
      signature: "(x: u64) -> u64",
      behaviour: "Allocates a u8 buffer of 32 bytes, calls fmt.dec(buf, x) to get length L, then returns the sum of (buf[i] - 48) * (i + 1) for i from 0 to L-1, plus L * 1000.",
    },
    oracle: ([x]) => {
      const d = x!.toString();
      let s = 0n;
      for (let i = 0; i < d.length; i++) s += BigInt(d.charCodeAt(i) - 48) * BigInt(i + 1);
      return s + BigInt(d.length) * 1000n;
    },
    cases: [[0n], [7n], [10n], [305n], [1000000n], [9876543210n], [18446744073709551615n]],
    fuel: 2_000_000,
  },
  {
    id: "stack",
    features: 1,
    exports: [
      { symbol: "stack.new", signature: "(capacity: u64) -> handle<u64>", behaviour: "Creates an empty stack that can hold capacity values. The handle's contents are private to this library, so choose your own layout.", id: 1, params: [1], ret: 4 },
      { symbol: "stack.push", signature: "(s: handle<u64>, v: u64) -> unit", behaviour: "Pushes v. The caller never pushes past capacity.", id: 2, params: [4, 1], ret: 0 },
      { symbol: "stack.pop", signature: "(s: handle<u64>) -> u64", behaviour: "Removes and returns the most recently pushed value. The caller never pops an empty stack.", id: 3, params: [4], ret: 1 },
      { symbol: "stack.size", signature: "(s: handle<u64>) -> u64", behaviour: "Returns how many values the stack holds.", id: 4, params: [4], ret: 1 },
    ],
    app: {
      params: ["u64"],
      signature: "(n: u64) -> u64",
      behaviour: "Creates a stack with capacity n + 1 and pushes 1, 2, ... n in order. While stack.size is above 1: a = pop, b = pop, then push the wrapping value a * 31 + b. Finally returns pop if the stack holds a value, otherwise 0. Treat the handle as opaque: never LOAD or STORE through it yourself.",
    },
    oracle: ([n]) => stack(n!),
    cases: [[0n], [1n], [2n], [3n], [10n], [100n], [1000n]],
    fuel: 5_000_000,
  },
];

const TYPE: Record<number, string> = { 0: "0 (unit)", 1: "1 (u64)", 2: "2 (bool)", 3: "3 (handle<u8>)", 4: "4 (handle<u64>)" };

const RULES = `This program is an ANMA-2 MODULE, not a complete ANMA-1 program. A module is exactly an ANMA-1 file except:
- Header word 1 (version) is 2, not 1.
- After the last END_FUNC, it may list IMPORT declarations. Record 0x70 IMPORT has fields: function ID, parameter count, return type. Each IMPORT is immediately followed by its parameter count of PARAM records, where parameter k is PARAM with value ID k, its type tag, and parameter index k.
- Imports take the function IDs right after your defined functions: with n defined functions, the first import is function n. CALL reaches an import exactly like a defined function.
- recordCount includes the IMPORT and their PARAM records.
Someone else writes the other side, and you will never see it. Rely only on the interface below. Nothing is executed for you here, so check_candidate is purely static: work out the logic carefully before you submit.`;

export function libraryPrompt(i: GateInterface): string {
  const list = i.exports.map((e) => `function ${e.id}: ${e.symbol}${e.signature}\n  ${e.behaviour}`).join("\n");
  return `${RULES}

Write the LIBRARY side. It has no imports.

Function 0 must be a trivial entry: fn0() -> u64 that returns 0. Nothing calls it.
Define these functions with exactly these function IDs:
${list}
Add any private helper functions after them.`;
}

export function appPrompt(i: GateInterface): string {
  const list = i.exports.map((e, k) => `import ${k}: ${e.symbol}${e.signature}\n  ${e.behaviour}\n  IMPORT return type ${TYPE[e.ret]}, parameter types ${e.params.map((p) => TYPE[p]).join(", ") || "none"}`).join("\n");
  return `${RULES}

Write the APPLICATION side. It uses this library, which is linked in later:
${list}
Declare one IMPORT for each, in this order.

Your entry function must be function 0 with signature ${i.app.signature}.
${i.app.behaviour}`;
}
