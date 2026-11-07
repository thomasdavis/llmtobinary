# Gate C pre-registration

Committed before any Gate C session ran. Do not edit after results exist; add a dated note instead.

**Question.** Does a library of earlier packages make later ones cheaper, when budgets are matched?

**Tasks.** Definitions and oracles are in `tools/research-cli/src/gate-c.ts`, committed with this file.

| Task | Depth | Library arm may import |
|---|---|---|
| `sum` | 2 | `str`, `fmt`, `parse-dec` |
| `filesum` | 3 | `str`, `fmt`, `parse-dec`, `fs` |

**Arms.** `library`: the prompt lists the imports, and the modules are linked in. `alone`: the same task text, with no imports, so everything must be written from scratch. `filesum` alone still gets the block device and the disk layout.

**Protocol.** 10 sessions per task per arm, 20 per arm in total, on `codex-sol` with the watchdog. Session budget: 40 turns, 24 checks, 8 submissions, 30 minutes. Test feedback works as in the OS build. Sessions run interleaved, so lane conditions are shared between arms.

**Measures.** Success rate, output tokens per passing session, submissions per passing session, record count. **Reuse is measured from the bytes:** a call edge counts only if a `CALL` in the model's module targets an import. A declared but uncalled import does not count.

**Decision.** This gate does not block anything (PRD §7). The result is reported whichever way it falls.

- Compounding is claimed only if the library arm has a higher success rate, or at least 25% lower median output tokens per passing session, and at least half its passing sessions make a real call edge.
- Otherwise the report says reuse showed no benefit here.
