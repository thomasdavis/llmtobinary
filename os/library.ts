// Leaf libraries for the community registry, beyond what the OS itself needs. Written before any
// bytes exist. Each function has a JavaScript oracle, which drives its doctests and its holdouts.

import type { Arg, Slot } from "./slots.ts";

const H8 = 3;
const U = 1;
const HEAP = 1;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const M = (1n << 64n) - 1n;

export interface LibCase {
  args: Arg[];
  want: bigint | null;
  /** Expected contents of a buffer argument after the call. */
  buffer?: { index: number; bytes: Uint8Array };
}

export interface LibFunction {
  symbol: string;
  signature: string;
  behaviour: string;
  params: number[];
  ret: number;
  /** Shown in the docs and run as doctests. */
  examples: LibCase[];
  /** Holdout generator: `next` returns a random u64, `int(n)` a random integer below n. */
  random(next: () => bigint, int: (n: number) => number): LibCase;
}

/** The right answer for any input. This is what decides a "Break this package" claim. */
export const ORACLES: Record<string, (args: Arg[]) => bigint | null> = {
  "math.gcd": ([a, b]) => gcd(a as bigint, b as bigint),
  "math.isqrt": ([n]) => isqrt(n as bigint),
  "hash.fnv1a": ([b, n]) => fnv(b as Uint8Array, Number(n)),
  "crc.crc8": ([b, n]) => crc8(b as Uint8Array, Number(n)),
  "font.row": ([c, r]) => glyphRow(c as bigint, r as bigint),
};

export interface LibSlot {
  id: string;
  title: string;
  brief: string;
  functions: LibFunction[];
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
const fnv = (b: Uint8Array, n: number): bigint => {
  let h = 14695981039346656037n;
  for (let i = 0; i < n; i++) h = ((h ^ BigInt(b[i]!)) * 1099511628211n) & M;
  return h;
};
const crc8 = (b: Uint8Array, n: number): bigint => {
  let c = 0;
  for (let i = 0; i < n; i++) {
    c ^= b[i]!;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255;
  }
  return BigInt(c);
};
const randomBytes = (int: (n: number) => number, n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(256));
const text = (int: (n: number) => number, n: number): Uint8Array => Uint8Array.from({ length: n }, () => 97 + int(26));
const buf = (bytes: Uint8Array, size: number): Uint8Array => {
  const b = new Uint8Array(size);
  b.set(bytes);
  return b;
};
/** A 5x7 font row: the row's bits for a glyph are `font.row`'s defined pattern. */
const glyphRow = (c: bigint, row: bigint): bigint => (row >= 7n ? 0n : ((c * 31n + row * 7n) ^ (c >> 2n)) & 31n);

const fn = (symbol: string, signature: string, behaviour: string, params: number[], ret: number, examples: LibCase[], random: LibFunction["random"]): LibFunction => ({ symbol, signature, behaviour, params, ret, examples, random });

export const LIBRARY: LibSlot[] = [
  { id: "math-gcd", title: "Greatest common divisor", brief: "Integer maths.", functions: [fn("math.gcd", "(a: u64, b: u64) -> u64", "The greatest common divisor of a and b. gcd(a, 0) is a, and gcd(0, b) is b.", [U, U], U, [{ args: [12n, 18n], want: 6n }, { args: [0n, 9n], want: 9n }, { args: [7n, 0n], want: 7n }], (next) => { const a = next() >> 20n; const b = next() >> 20n; return { args: [a, b], want: gcd(a, b) }; })] },
  { id: "math-isqrt", title: "Integer square root", brief: "Integer maths.", functions: [fn("math.isqrt", "(n: u64) -> u64", "The largest r with r * r <= n, computed without overflow for every u64.", [U], U, [{ args: [0n], want: 0n }, { args: [15n], want: 3n }, { args: [16n], want: 4n }, { args: [M], want: 4294967295n }], (next) => { const n = next(); return { args: [n], want: isqrt(n) }; })] },
  { id: "parse-dec", title: "Decimal parser", brief: "Text parsing.", functions: [fn("parse.dec", "(buf: handle<u8>, start: u64, end: u64) -> u64", "Parses the ASCII digits in buf[start..end] as an unsigned decimal, wrapping on overflow. A byte that is not a digit stops the parse. An empty range gives 0.", [H8, U, U], U, [{ args: [enc("123"), 0n, 3n], want: 123n }, { args: [enc("12x4"), 0n, 4n], want: 12n }, { args: [enc("7"), 1n, 1n], want: 0n }], (next, int) => { const v = next() >> 8n; const s = v.toString(); return { args: [enc(`x${s}`), 1n, BigInt(s.length + 1)], want: v }; })] },
  { id: "parse-hex", title: "Hex parser", brief: "Text parsing.", functions: [fn("parse.hex", "(buf: handle<u8>, start: u64, end: u64) -> u64", "Parses the ASCII hex digits (0-9, a-f, A-F) in buf[start..end] as an unsigned value, wrapping on overflow. A byte that is not a hex digit stops the parse.", [H8, U, U], U, [{ args: [enc("ff"), 0n, 2n], want: 255n }, { args: [enc("1A"), 0n, 2n], want: 26n }, { args: [enc("9g"), 0n, 2n], want: 9n }], (next) => { const v = next() >> 8n; const s = v.toString(16); return { args: [enc(s), 0n, BigInt(s.length)], want: v }; })] },
  { id: "hash-fnv", title: "FNV-1a hash", brief: "Hashing.", functions: [fn("hash.fnv1a", "(buf: handle<u8>, n: u64) -> u64", "The 64-bit FNV-1a hash of the first n bytes: start at 14695981039346656037, and for each byte xor it in, then multiply by 1099511628211, wrapping.", [H8, U], U, [{ args: [new Uint8Array(1), 0n], want: 14695981039346656037n }, { args: [enc("a"), 1n], want: fnv(enc("a"), 1) }], (_n, int) => { const n = int(40); const b = randomBytes(int, n + 1); return { args: [b, BigInt(n)], want: fnv(b, n) }; })] },
  { id: "crc-8", title: "CRC-8", brief: "Checksums.", functions: [fn("crc.crc8", "(buf: handle<u8>, n: u64) -> u64", "CRC-8 with polynomial 0x07, initial value 0, no reflection and no final xor, over the first n bytes.", [H8, U], U, [{ args: [new Uint8Array(1), 0n], want: 0n }, { args: [enc("123456789"), 9n], want: 0xf4n }], (_n, int) => { const n = int(40); const b = randomBytes(int, n + 1); return { args: [b, BigInt(n)], want: crc8(b, n) }; })] },
  { id: "str-upper", title: "ASCII upper case", brief: "Text transforms.", functions: [fn("str.upper", "(buf: handle<u8>, n: u64) -> unit", "Changes each ASCII lower-case letter in the first n bytes to upper case, in place. Other bytes are left alone.", [H8, U], 0, [{ args: [enc("aB-c"), 4n], want: null, buffer: { index: 0, bytes: enc("AB-C") } }], (_n, int) => { const n = 1 + int(30); const b = randomBytes(int, n); const w = b.map((x) => (x >= 97 && x <= 122 ? x - 32 : x)); return { args: [b, BigInt(n)], want: null, buffer: { index: 0, bytes: w } }; })] },
  { id: "str-reverse", title: "Byte reverse", brief: "Text transforms.", functions: [fn("str.reverse", "(buf: handle<u8>, n: u64) -> unit", "Reverses the first n bytes in place.", [H8, U], 0, [{ args: [enc("abc"), 3n], want: null, buffer: { index: 0, bytes: enc("cba") } }, { args: [enc("ab"), 0n], want: null, buffer: { index: 0, bytes: enc("ab") } }], (_n, int) => { const n = 1 + int(30); const b = randomBytes(int, n); return { args: [b, BigInt(n)], want: null, buffer: { index: 0, bytes: b.slice().reverse() } }; })] },
  { id: "sort-u8", title: "Byte sort", brief: "Sorting.", functions: [fn("sort.u8", "(buf: handle<u8>, n: u64) -> unit", "Sorts the first n bytes into ascending order, in place. Bytes from n onward are left alone.", [H8, U], 0, [{ args: [Uint8Array.from([3, 1, 2]), 3n], want: null, buffer: { index: 0, bytes: Uint8Array.from([1, 2, 3]) } }, { args: [Uint8Array.from([9, 1, 0]), 2n], want: null, buffer: { index: 0, bytes: Uint8Array.from([1, 9, 0]) } }], (_n, int) => { const n = 1 + int(40); const b = randomBytes(int, n + 2); const w = b.slice(); w.subarray(0, n).sort(); return { args: [b, BigInt(n)], want: null, buffer: { index: 0, bytes: w } }; })] },
  { id: "font-row", title: "Procedural font", brief: "A tiny procedural bitmap font.", functions: [fn("font.row", "(c: u64, row: u64) -> u64", "The 5-bit pattern for row `row` of glyph c: 0 if row is 7 or more, otherwise ((c * 31 + row * 7) xor (c >> 2)) and 31, with wrapping arithmetic.", [U, U], U, [{ args: [65n, 0n], want: glyphRow(65n, 0n) }, { args: [65n, 7n], want: 0n }], (_n, int) => { const c = BigInt(int(256)); const r = BigInt(int(9)); return { args: [c, r], want: glyphRow(c, r) }; })] },
  { id: "cache-index", title: "Block cache index", brief: "A direct-mapped block cache lookup.", functions: [fn("cache.lookup", "(tags: handle<u8>, sector: u64, ways: u64) -> u64", "tags holds `ways` one-byte tags. The cache line for a sector is sector modulo ways. Returns 1 if tags[line] equals sector divided by ways, modulo 256, otherwise 0. ways is at least 1.", [H8, U, U], U, [{ args: [Uint8Array.from([0, 1, 0, 0]), 5n, 4n], want: 1n }, { args: [Uint8Array.from([0, 2, 0, 0]), 5n, 4n], want: 0n }], (_n, int) => { const ways = 1 + int(8); const sector = int(5000); const tags = randomBytes(int, ways); if (int(2)) tags[sector % ways] = Math.floor(sector / ways) % 256; return { args: [tags, BigInt(sector), BigInt(ways)], want: tags[sector % ways] === Math.floor(sector / ways) % 256 ? 1n : 0n }; })] },
];

export const librarySlot = (l: LibSlot): Slot => ({ id: l.id, kind: "library", features: HEAP, depends: [], brief: `${l.brief} ${l.title}.`, exports: l.functions.map((f, i) => ({ symbol: f.symbol, signature: f.signature, behaviour: f.behaviour, id: i + 1, params: f.params, ret: f.ret })) });

export { buf };
