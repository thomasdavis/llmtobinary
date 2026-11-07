# Gate D pre-registration

Committed before any Gate D code or session existed. Do not edit after results exist; add a dated note instead.

**Question.** When a model can search the library and decide for itself what to import, does that help?

Gate C could not answer this, because a person chose the imports and the prompt listed them. Here nothing names a library: the task text describes only the program's behaviour.

**Tasks.** Definitions and hidden oracles will be in `tools/research-cli/src/gate-d.ts`. Each is a whole program with a `u64` entry signature, written as a user of the site would ask for it.

| Task | Kind | What it computes | A package that could help |
|---|---|---|---|
| `lcm3` | reuse | least common multiple of three numbers | `math.gcd` |
| `isqrt-sum` | reuse | sum of the integer square roots of 1 to n | `math.isqrt` |
| `digest` | reuse | 64-bit FNV-1a hash of n's decimal digits | `fmt.dec`, `hash.fnv1a` |
| `crc-sorted` | reuse | CRC-8 of n's decimal digits after sorting them | `fmt.dec`, `sort.u8`, `crc.crc8` |
| `collatz` | control | Collatz steps from n to 1 | none |
| `popcount-xor` | control | set bits in a XOR b | none |

**Arms.** `search`: the same code path as the site, with `search_library` and `use_library`, a short index of the library, and server-side linking. The library is the live production registry, limited to packages at E4 or above whose features the task allows. `alone`: the same task text and the same loop, with no library.

**Protocol.** 5 sessions per task per arm, so 30 per arm and 60 in total, on `codex-sol` with the watchdog, at medium effort. Session budget: 40 turns, 24 checks, 8 submissions, 30 minutes. Sessions are interleaved, so lane conditions are shared between arms. A session passes only if its final bytes pass the visible tests and seeded holdouts run by the harness. Feedback to the model names failing visible cases only.

**Measures.** Success rate, output tokens per passing session, turns, and record count written by the model. **Reuse is measured from the bytes:** an import counts only if a `CALL` in the model's own module targets it. Control tasks also report how often the model imported something it did not need.

**Decision.** Automatic linking is released to production only if all three hold on the results below. The report is published whichever way it falls.

- **P1, real reuse:** at least half of the `search` arm's passing sessions on reuse tasks make a real call edge.
- **P2, benefit:** on reuse tasks, the `search` arm has a higher success rate, or at least 25% lower median output tokens per passing session.
- **P3, no harm:** across all 60 sessions, the `search` arm's successes are not more than 3 below the `alone` arm's.

If any of these fails, the feature stays on staging and production keeps generating standalone programs.

**Known limits, stated in advance.** The lane is `gpt-6.1-sol`, not the site's `gpt-6-luna`, so a passing result does not prove the same for the production model. Staging runs on the site's own model will be reported separately. These tasks are small, and the library is small.
