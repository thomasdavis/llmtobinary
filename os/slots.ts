// OS slots: interface, task text and tests for each package, written before any bytes exist.
// `visible` tests are reported to the model. `holdout` tests use a seed kept outside the repo.

export type Arg = bigint | Uint8Array;

export interface ExportSpec {
  symbol: string;
  signature: string;
  behaviour: string;
  id: number;
  params: number[];
  ret: number;
}

export interface OsCall {
  symbol: string;
  args: Arg[];
  keys?: number[];
  /** Expected return value, and expected contents of buffer arguments by index. */
  want?: bigint | null;
  buffers?: Record<number, Uint8Array>;
  terminal?: string;
}

export interface Slot {
  id: string;
  kind: "library" | "root" | "program";
  features: number;
  depends: string[];
  exports: ExportSpec[];
  brief: string;
}

const H8 = 3;
const U = 1;
const TEXT = 1 << 4;
const BLOCK = 1 << 5;
const TASKS = 1 << 6;
const HEAP = 1;
const TERMINAL = 2;

const e = (symbol: string, signature: string, behaviour: string, id: number, params: number[], ret: number): ExportSpec => ({ symbol, signature, behaviour, id, params, ret });

export const STR: Slot = {
  id: "str", kind: "library", features: HEAP, depends: [], brief: "Byte-string helpers over handle<u8> buffers.",
  exports: [
    e("str.eq", "(a: handle<u8>, ai: u64, b: handle<u8>, bi: u64, n: u64) -> u64", "Returns 1 if the n bytes at a[ai..] equal the n bytes at b[bi..], otherwise 0. n of 0 returns 1.", 1, [H8, U, H8, U, U], U),
    e("str.copy", "(dst: handle<u8>, di: u64, src: handle<u8>, si: u64, n: u64) -> unit", "Copies n bytes from src[si..] to dst[di..], lowest index first.", 2, [H8, U, H8, U, U], 0),
    e("str.word_end", "(buf: handle<u8>, start: u64, end: u64) -> u64", "Returns the first index i with start <= i < end where buf[i] is 32 (space), or end if there is none.", 3, [H8, U, U], U),
    e("str.skip_spaces", "(buf: handle<u8>, start: u64, end: u64) -> u64", "Returns the first index i with start <= i < end where buf[i] is not 32, or end if there is none.", 4, [H8, U, U], U),
  ],
};

export const FMT: Slot = {
  id: "fmt", kind: "library", features: HEAP, depends: [], brief: "Number formatting.",
  exports: [e("fmt.dec", "(buf: handle<u8>, at: u64, value: u64) -> u64", "Writes value in decimal as ASCII at buf[at..], most significant digit first, no leading zeros, and 0 as the single digit 0. Returns the digit count.", 1, [H8, U, U], U)],
};

const DISK = `The disk has 512-byte sectors. Sector 0 is the directory: 16 entries of 32 bytes. Entry bytes 0 to 15 hold the name, zero padded. Byte 16 is the name length. Byte 17 is 1 when the entry is used. Bytes 18 and 19 are the size, little-endian. File slot i (0 to 15) owns sectors 1 + 8*i to 8 + 8*i, so a file holds at most 4096 bytes. block.read and block.write always transfer exactly one 512-byte sector through a handle<u8> of at least 512 bytes.`;

export const FS: Slot = {
  id: "fs", kind: "library", features: HEAP | BLOCK, depends: ["str"], brief: `A tiny file system. ${DISK}`,
  exports: [
    e("fs.format", "() -> unit", "Writes sector 0 as all zeros, then calls block.flush.", 1, [], 0),
    e("fs.find", "(name: handle<u8>, at: u64, len: u64) -> u64", "Returns slot + 1 of the used entry whose name is exactly the len bytes at name[at..], or 0 if there is none.", 2, [H8, U, U], U),
    e("fs.read", "(file: u64, out: handle<u8>) -> u64", "file is a value returned by fs.find. Copies the file's bytes to out[0..] and returns its size. out holds at least 4608 bytes.", 3, [U, H8], U),
    e("fs.write", "(name: handle<u8>, at: u64, len: u64, data: handle<u8>, size: u64) -> u64", "Creates or replaces the file named by the len bytes at name[at..] with the first size bytes of data. Returns slot + 1, or 0 if len is 0 or above 16, size is above 4096, or no slot is free. Reuses the slot of an existing file of that name, otherwise the lowest unused slot. Order matters for crash safety: write every data sector, call block.flush, then write sector 0, then call block.flush. data holds at least 4608 bytes.", 4, [H8, U, U, H8, U], U),
    e("fs.name_at", "(slot: u64, out: handle<u8>) -> u64", "For slot 0 to 15: if that entry is used, copies its name to out[0..] and returns the name length, otherwise returns 0.", 5, [U, H8], U),
  ],
};

export const LINE: Slot = {
  id: "line", kind: "library", features: HEAP | TEXT, depends: [], brief: "Reads one line of keyboard input with echo.",
  exports: [e("line.read", "(buf: handle<u8>, cap: u64) -> u64", "Reads keys with input.next_key until key 10 (enter). A key from 32 to 126 is stored at the next position in buf and echoed with terminal.print_bytes, unless the line already holds cap - 1 bytes, when it is ignored. Key 8 (backspace) removes the last byte if there is one, and echoes bytes 8, 32, 8. Other keys are ignored. Key 10 echoes byte 10 and returns the line length.", 1, [H8, U], U)],
};

export const PROC: Slot = {
  id: "proc", kind: "library", features: HEAP | TASKS | BLOCK, depends: ["fs"], brief: "Runs a program stored on disk.",
  exports: [e("proc.run", "(name: handle<u8>, at: u64, len: u64) -> u64", "Finds the file named by the len bytes at name[at..]. Returns 1 if there is none. Reads it into a new 4608-byte buffer, calls module.load, and returns 2 if that returns 0. Calls task.spawn with fuel 200000 and heapBytes 1048576, and returns 2 if that returns 0. Allocates a 64-byte mailbox and calls task.resume in a loop while the low 8 bits of its result are 1. Then returns 0 for low bits 0, 3 for low bits 2, and 4 for low bits 3.", 1, [H8, U, U], U)],
};

export const CMD: Slot = {
  id: "cmd", kind: "library", features: HEAP | TEXT | BLOCK | TASKS, depends: ["str", "fs", "proc"],
  brief: `The shell's commands. A line is the bytes line[0..len]. Split it with str.word_end and str.skip_spaces: the first word is the command, the next word is the name, and the text is everything after the name up to len. Print with terminal.print_bytes. This library has no read-only data, so to print a newline, store byte 10 in a small heap buffer.`,
  exports: [
    e("cmd.word", "(line: handle<u8>, len: u64) -> u64", "Identifies the first word. Returns 0 for an empty line or one of only spaces, 1 for ls, 2 for cat, 3 for write, 4 for run, 5 for format, 6 for exit, 7 for gen, and 8 for anything else.", 1, [H8, U], U),
    e("cmd.ls", "() -> unit", "For each slot 0 to 15 where fs.name_at returns a non-zero length, prints the name and a newline.", 2, [], 0),
    e("cmd.cat", "(line: handle<u8>, len: u64) -> u64", "Finds the file named by the second word. Returns 1 if there is none. Otherwise reads it into a new 4608-byte buffer, prints its bytes and a newline, and returns 0.", 3, [H8, U], U),
    e("cmd.write", "(line: handle<u8>, len: u64) -> u64", "The second word is the name. Skip the spaces after it: the rest of the line is the text. Copies the text to the start of a new 4608-byte buffer and calls fs.write. Returns 0 if fs.write returned non-zero, otherwise 1.", 4, [H8, U], U),
    e("cmd.run", "(line: handle<u8>, len: u64) -> u64", "Calls proc.run on the second word and returns its result.", 5, [H8, U], U),
    e("cmd.format", "() -> unit", "Calls fs.format.", 6, [], 0),
  ],
};

export const KERNEL: Slot = {
  id: "kernel", kind: "root", features: HEAP | TERMINAL | TEXT | BLOCK | TASKS, depends: ["cmd", "line"],
  brief: `The kernel. The entry function is fn0() -> u64. It is a small loop, because the commands live in the cmd library.

Print "anma os\\n" once. Allocate a 256-byte line buffer. Then loop: print "> ", call line.read(buffer, 256) to get len, then call cmd.word(buffer, len) and act on the result.
- 0: do nothing.
- 1: call cmd.ls.
- 2: call cmd.cat. If it returns 1, print "not found\\n".
- 3: call cmd.write. Print "ok\\n" if it returns 0, otherwise "failed\\n".
- 4: call cmd.run, and print a line for its result: 0 "ok", 1 "not found", 2 "invalid", 3 "trapped", 4 "out of fuel".
- 5: call cmd.format, then print "ok\\n".
- 6: return 0 from fn0.
- Anything else: print "?\\n".
Keep message text in your read-only data section and print it with terminal.print_utf8.`,
  exports: [],
};

export const LIVE: Slot = {
  id: "live", kind: "library", features: HEAP | TEXT | BLOCK | (1 << 8), depends: ["str", "fs"],
  brief: `Live generation. state is a 64-byte handle<u8> the kernel keeps. state[0] is 1 while a job runs. state[1] to state[8] hold the job, little-endian. state[9] holds the name length, and state[10] onward hold the name.`,
  exports: [
    e("live.start", "(state: handle<u8>, line: handle<u8>, len: u64) -> u64", "The line is \"gen <name> <prompt>\". The name is the second word, and the prompt is everything after it, past any spaces. Returns 1 if state[0] is 1. Otherwise copies the prompt to a new buffer and calls gen.request(buffer, promptLength). Returns 2 if that returns 0. Otherwise records the job and the name in state, sets state[0] to 1, and returns 0.", 1, [H8, H8, U], U),
    e("live.poll", "(state: handle<u8>) -> u64", "Returns 0 if state[0] is 0. Otherwise calls gen.poll(job). For result 0 it returns 0. For result 2 it sets state[0] to 0 and returns 2. For result 1 it calls gen.read(job, buffer) with a new 4608-byte buffer to get the length, saves it with fs.write under the name in state, sets state[0] to 0, and returns 1.", 2, [H8], U),
    e("live.print_name", "(state: handle<u8>) -> unit", "Prints the name in state with terminal.print_bytes.", 3, [H8], 0),
  ],
};

/** The kernel plus live generation. Separate, so the plain kernel stands as its own milestone. */
export const KERNEL_LIVE: Slot = {
  ...KERNEL,
  id: "kernel-live",
  features: KERNEL.features | (1 << 8),
  depends: ["cmd", "line", "live"],
  brief: `${KERNEL.brief}

Also add live generation. Allocate a 64-byte state buffer before the loop.
- Just before printing each "> ", call live.poll(state). If it returns 1, print "generated ", call live.print_name(state), and print "\\n". If it returns 2, print "generation failed\\n".
- When cmd.word returns 7, call live.start(state, buffer, len). Print "started\\n" for 0, "busy\\n" for 1, and "failed\\n" for 2.
The shell never waits for a job.`,
};

export const HELLO: Slot = { id: "hello", kind: "program", features: TERMINAL, depends: [], exports: [], brief: `A program stored on disk. Entry fn0() -> u64. Print exactly "hello from disk\\n" with terminal.print_utf8, then return 0.` };
export const CRASH: Slot = { id: "crash", kind: "program", features: 0, depends: [], exports: [], brief: "A program stored on disk that always crashes. Entry fn0() -> u64. Divide 1 by 0 at run time with UDIV_U64 so the program traps, and return the result." };
export const SPIN: Slot = { id: "spin", kind: "program", features: 0, depends: [], exports: [], brief: "A program stored on disk that never finishes. Entry fn0() -> u64. Loop forever using JUMP between blocks." };

/** Dependency order, so each package is judged against packages that already passed. */
export const SLOTS: Slot[] = [STR, FMT, HELLO, CRASH, SPIN, FS, LINE, PROC, CMD, KERNEL, LIVE, KERNEL_LIVE];

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const padded = (s: string, n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b.set(bytes(s));
  return b;
};

/** Visible tests. Holdouts are generated by `randomCalls` from a private seed. */
export const VISIBLE: Record<string, OsCall[]> = {
  str: [
    { symbol: "str.eq", args: [bytes("abcd"), 1n, bytes("xbcd"), 1n, 3n], want: 1n },
    { symbol: "str.eq", args: [bytes("abcd"), 0n, bytes("xbcd"), 0n, 2n], want: 0n },
    { symbol: "str.eq", args: [bytes("a"), 0n, bytes("b"), 0n, 0n], want: 1n },
    { symbol: "str.copy", args: [new Uint8Array(6), 1n, bytes("wxyz"), 1n, 3n], buffers: { 0: Uint8Array.from([0, 120, 121, 122, 0, 0]) } },
    { symbol: "str.word_end", args: [bytes("ab cd"), 0n, 5n], want: 2n },
    { symbol: "str.word_end", args: [bytes("abcde"), 1n, 5n], want: 5n },
    { symbol: "str.skip_spaces", args: [bytes("a  cd"), 1n, 5n], want: 3n },
    { symbol: "str.skip_spaces", args: [bytes("     "), 2n, 5n], want: 5n },
  ],
  fmt: [
    { symbol: "fmt.dec", args: [new Uint8Array(24), 0n, 0n], want: 1n, buffers: { 0: padded("0", 24) } },
    { symbol: "fmt.dec", args: [new Uint8Array(24), 2n, 305n], want: 3n, buffers: { 0: Uint8Array.from([0, 0, 51, 48, 53, ...new Array(19).fill(0)]) } },
    { symbol: "fmt.dec", args: [new Uint8Array(24), 0n, 18446744073709551615n], want: 20n, buffers: { 0: padded("18446744073709551615", 24) } },
  ],
  line: [
    { symbol: "line.read", args: [new Uint8Array(16), 16n], keys: [104, 105, 10], want: 2n, terminal: "hi\n", buffers: { 0: padded("hi", 16) } },
    { symbol: "line.read", args: [new Uint8Array(16), 16n], keys: [97, 98, 8, 99, 10], want: 2n, terminal: "ab\b \bc\n" },
    { symbol: "line.read", args: [new Uint8Array(4), 4n], keys: [97, 98, 99, 100, 101, 10], want: 3n, terminal: "abc\n" },
    { symbol: "line.read", args: [new Uint8Array(4), 4n], keys: [1, 200, 10], want: 0n, terminal: "\n" },
  ],
};
