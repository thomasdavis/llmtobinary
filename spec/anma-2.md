# ANMA-2 module format

ANMA-2 lets separately written programs be joined. ANMA-1 stays frozen: a linked image is an ordinary ANMA-1 file, and the unchanged ANMA-1 validator judges it. Later phases add capabilities to this document.

## 1. Modules

A module is an ANMA-1 file with these differences:

- Header word 1 (version) is `2`.
- Zero or more IMPORT declarations follow the last `END_FUNC`.

Everything else, including records, types and read-only data, follows ANMA-1. The entry function must be a defined function.

## 2. IMPORT

| Opcode | Record fields a, b, c |
|---|---|
| `0x70 IMPORT` | function ID, parameter count, return type |

Each IMPORT is immediately followed by its parameter count of `PARAM` records. Parameter `k` is `PARAM` with value ID `k`, a value type tag, and parameter index `k`.

Imports take the function IDs after the module's defined functions, densely and in declaration order. A module with `n` defined functions has its first import at ID `n`. `CALL` reaches an import exactly as it reaches a defined function.

The bytes hold no names. A separate link map gives each import a symbol and each exported function a symbol, because names are metadata and never change a module's hash.

## 3. Linking

The linker takes a root module and the modules it reaches. It then:

1. Resolves every import to an export by symbol.
2. Rejects a missing symbol, a duplicate export, a signature mismatch or a cycle before any execution.
3. Assigns new function IDs, root first, then each reached module in visit order.
4. Copies each module's records unchanged, rewriting only `FUNC` field `a` and `CALL` field `b`.
5. Emits the union of the modules' feature bits, the root's data and the root's entry function. The header version is 1 unless the image uses an ANMA-2 feature bit, and then it is 2.
6. Runs the validator on the output, which decides whether the image is accepted.

The linker writes no instruction records. Unreached modules are left out.

**Version 0 limits:** no cycles, no function pointers, and read-only data only in the root module, because data offsets are runtime values the linker cannot move. A library takes text through a `handle<u8>` argument instead.

## 4. Authority

The linker reports the host operations reachable from the entry function. This list is a manifest, not a restriction, until host operations become explicit imports.

## 5. The machine

The host stays a dumb device. It offers keys, sectors, validated program loading and isolated tasks. Files, the shell and scheduling are guest bytes.

### 5.1 Feature bits

| Bit | Name | Grants |
|---|---|---|
| 4 | text | `input.next_key`, `terminal.print_bytes` |
| 5 | block | `block.*` |
| 6 | tasks | `module.load`, `task.spawn`, `task.resume` |
| 7 | syscall | `task.yield` |
| 8 | gen | `gen.*` |

These bits are valid only in version 2 files.

### 5.2 Host operations

| Import | Signature | Feature |
|---|---|---|
| 7 | `input.next_key() -> u64` | text |
| 8 | `terminal.print_bytes(buffer: handle<u8>, offset: u64, length: u64) -> unit` | text |
| 9 | `block.count() -> u64` | block |
| 10 | `block.read(sector: u64, buffer: handle<u8>) -> unit` | block |
| 11 | `block.write(sector: u64, buffer: handle<u8>) -> unit` | block |
| 12 | `block.flush() -> unit` | block |
| 13 | `module.load(buffer: handle<u8>, length: u64) -> u64` | tasks |
| 14 | `task.spawn(module: u64, fuel: u64, heapBytes: u64) -> u64` | tasks |
| 15 | `task.resume(task: u64, mailbox: handle<u8>) -> u64` | tasks |
| 16 | `task.yield(mailbox: handle<u8>, code: u64) -> unit` | syscall |
| 17 | `gen.request(prompt: handle<u8>, length: u64) -> u64` | gen |
| 18 | `gen.poll(job: u64) -> u64` | gen |
| 19 | `gen.read(job: u64, buffer: handle<u8>) -> u64` | gen |

- `input.next_key` waits until a key is available. Keys are recorded, so a run replays exactly.
- Sectors are 512 bytes. A sector outside the disk traps.
- `module.load` validates the bytes under the program capability mask. It returns a module ID, or 0 if the bytes are invalid or ask for a capability a program cannot have.
- `task.spawn` returns a task ID, or 0. The entry function must take no parameters.
- `task.resume` returns a status in its low 8 bits: 0 exited, 1 yielded, 2 trapped, 3 out of fuel. For a yield, the code is in the bits above.
- `gen.poll` returns 0 pending, 1 ready, 2 failed. `gen.read` returns the byte count.

Module and task IDs are plain `u64` indexes into the kernel's own tables. Only the kernel holds the tasks capability, so forging an ID reaches nothing it does not already own.

### 5.3 Programs and isolation

The kernel holds heap, terminal, text, block, tasks and gen. A program may hold heap, terminal, text and syscall, and `input.next_key` is refused to it. A program cannot reach the block device, control tasks or request generation.

Each task runs in its own engine with its own heap, fuel and frames, so a trap ends that task and its memory with it. `task.resume` runs the child synchronously until it yields, exits, traps or runs out of fuel. Fuel is the only preemption, which keeps replay deterministic.

Mailboxes are copied, never shared. On a yield, the program's mailbox is copied to the kernel's. On the next resume, the kernel's mailbox is copied back. System calls are a yield with a request in the mailbox.

### 5.4 Replay

A run is identified by its image hash, disk image hash, key sequence and generation record. Replay feeds the recorded generation events and never calls a model.
