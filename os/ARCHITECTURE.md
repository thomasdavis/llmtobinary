# The community OS

The smallest system that passes PRD-OS A6.1. Models write every byte of the packages below. People and agents write this document, the interfaces and the tests.

| Package | Kind | Depends on |
|---|---|---|
| `str` | library | |
| `fmt` | library | |
| `fs` | library | `str` |
| `line` | library | |
| `proc` | library | `fs` |
| `kernel` | root | `str`, `fmt`, `fs`, `line`, `proc` |
| `hello`, `crash`, `spin` | programs on disk | |

**Disk.** Sector 0 is the directory: 16 entries of 32 bytes. Bytes 0 to 15 are the name, zero padded. Byte 16 is the name length. Byte 17 is 1 when the entry is used. Bytes 18 and 19 are the size, little-endian. File `i` owns sectors `1 + 8i` to `8 + 8i`, so a file holds at most 4096 bytes and nothing needs allocating.

**Crash safety.** `fs.write` writes the data sectors, flushes, then writes the directory sector and flushes. A crash never corrupts the directory, and a new file only appears once it is complete. Replacing a file is not atomic: it reuses the same sectors, so a crash partway through can leave a mix of old and new bytes at the old size. The file stays readable and its size stays consistent.

**Shell commands.** `ls`, `cat <name>`, `write <name> <text>`, `run <name>`, `format`, `exit`. `ls` and `cat` are shell commands rather than programs on disk. PRD-OS named them as programs, but programs would need a file system-call protocol that A6.1 does not test.
