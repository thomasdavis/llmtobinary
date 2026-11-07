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
5. Emits header version 1, the union of the modules' feature bits, the root's data and the root's entry function.
6. Runs the ANMA-1 validator on the output, which decides whether the image is accepted.

The linker writes no instruction records. Unreached modules are left out.

**Version 0 limits:** no cycles, no function pointers, and read-only data only in the root module, because data offsets are runtime values the linker cannot move. A library takes text through a `handle<u8>` argument instead.

## 4. Authority

The linker reports the host operations reachable from the entry function. This list is a manifest, not a restriction, until host operations become explicit imports.
