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

export const KERNEL: Slot = {
  id: "kernel", kind: "root", features: HEAP | TERMINAL | TEXT | BLOCK | TASKS, depends: ["str", "fmt", "fs", "line", "proc"],
  brief: `The kernel and shell. The entry function is fn0() -> u64.

Print "anma os\\n" once. Then loop: print "> ", read a line with line.read into a 256-byte buffer (cap 256), and run it.
Split the line at the first space, using str.word_end and str.skip_spaces. The first word is the command.
- "ls": for each slot 0 to 15 with a name from fs.name_at, print the name and a newline.
- "cat <name>": print the file's bytes then a newline, or "not found\\n".
- "write <name> <text>": the text is everything after the name, up to the end of the line. Copy it into a 4608-byte buffer, call fs.write, and print "ok\\n", or "failed\\n" if it returns 0.
- "run <name>": call proc.run and print a line for its result: 0 "ok", 1 "not found", 2 "invalid", 3 "trapped", 4 "out of fuel".
- "format": call fs.format and print "ok\\n".
- "exit": return 0 from fn0.
- An empty line prints nothing. Anything else prints "?\\n".
Keep message text in your read-only data section and print it with terminal.print_utf8.`,
  exports: [],
};

const GEN = 1 << 8;

/** The kernel plus live generation. Separate, so the plain kernel stands as its own milestone. */
export const KERNEL_LIVE: Slot = {
  ...KERNEL,
  id: "kernel-live",
  features: KERNEL.features | GEN,
  brief: `${KERNEL.brief}

Also add live generation. A program can be requested while the system keeps running.
- "gen <name> <prompt>": the prompt is everything after the name. If a job is already running, print "busy\n". Otherwise copy the prompt into a buffer, call gen.request(buffer, length), remember the job and the name, and print "started\n". If gen.request returns 0, print "failed\n" instead.
- Just before printing each "> " prompt, if a job is running, call gen.poll(job). Result 0 means still pending, so do nothing. Result 2 means it failed: print "generation failed\n" and forget the job. Result 1 means ready: call gen.read(job, buffer) with a 4608-byte buffer to get the length, save it with fs.write under the remembered name, print "generated <name>\n", and forget the job.
The shell must never wait for a job. Keep the remembered job and name in a heap buffer passed through your functions, or in values carried around your main loop.`,
};

export const HELLO: Slot = { id: "hello", kind: "program", features: TERMINAL, depends: [], exports: [], brief: `A program stored on disk. Entry fn0() -> u64. Print exactly "hello from disk\\n" with terminal.print_utf8, then return 0.` };
export const CRASH: Slot = { id: "crash", kind: "program", features: 0, depends: [], exports: [], brief: "A program stored on disk that always crashes. Entry fn0() -> u64. Divide 1 by 0 at run time with UDIV_U64 so the program traps, and return the result." };
export const SPIN: Slot = { id: "spin", kind: "program", features: 0, depends: [], exports: [], brief: "A program stored on disk that never finishes. Entry fn0() -> u64. Loop forever using JUMP between blocks." };

/** Dependency order, so each package is judged against packages that already passed. */
export const SLOTS: Slot[] = [STR, FMT, HELLO, CRASH, SPIN, FS, LINE, PROC, KERNEL, KERNEL_LIVE];

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
