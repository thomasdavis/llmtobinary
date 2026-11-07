# Gate D results

Pre-registration: `gate-d-prereg.md`. Harness: `tools/research-cli/src/gate-d.ts`. Rows: `gate-d/results.jsonl`, and the full report in `gate-d/report.txt`. 60 sessions on `codex-sol` (`gpt-6.1-sol`, medium effort), run at commit `bbced7d`. The pilot (12 sessions, `gate-d/pilot.jsonl`) found no harness problem, so nothing changed between pilot and run, and the pilot is not counted.

**Decision by the pre-registered rule: release.** All three conditions hold. Two hold narrowly, as set out below.

| | Passed | Median output tokens per pass | Median records the model wrote |
|---|---|---|---|
| Library, reuse tasks | 20/20 | 2,349 | 33.5 |
| No library, reuse tasks | 19/20 | 2,845 | 46 |
| Library, control tasks | 10/10 | 2,223 | 35.5 |
| No library, control tasks | 9/10 | 2,264 | 34 |

| Task | Library arm imported | Tokens, library | Tokens, no library |
|---|---|---|---|
| `lcm3` | 0 of 5 (never searched) | 2,568 | 2,823 |
| `isqrt-sum` | 0 of 5 (never searched) | 2,543 | 2,768 |
| `digest` | 5 of 5: `fmt.dec`, `hash.fnv1a` | 1,721 | 2,696 |
| `crc-sorted` | 5 of 5: `fmt.dec`, `sort.u8`, `crc.crc8` | 2,047 | 5,586 |
| `collatz` (control) | 0 of 5 | 2,461 | 2,794 |
| `popcount-xor` (control) | 0 of 5 | 1,863 | 2,184 |

## The conditions, read strictly

- **P1, real reuse: passes at the threshold.** 10 of 20 passing reuse-task sessions call an import, and the bar was half. Every one of those calls is a `CALL` in the model's own bytes.
- **P2, benefit: passes on the letter, not on the substance of success rate.** The library arm's success rate is higher, 20/20 against 19/20, but the one failure was `lane_hung` (no reply after 4 calls), an infrastructure fault rather than a wrong program. On tokens alone, the median fell 17%, short of the 25% bar.
- **P3, no harm: passes.** 30 against 28. Both failures in the `alone` arm were `lane_hung`.

## What the data does show

- **The model decides sensibly.** It never searched on the two easy reuse tasks or the controls, so it does not import out of habit. On the two tasks where a library function saves real work, it searched and imported in all 10 sessions.
- **Where it reused, reuse paid.** Output tokens fell 36% on `digest` and 63% on `crc-sorted`, and the records it had to write itself fell from 46 to 22 and from 128 to 28.
- **Nothing got worse.** Every library session passed its holdouts, and none imported on a control task.

## Limits

- The lane is `gpt-6.1-sol`. On staging, the site's own `gpt-6-luna` imported in 2 of 3 reuse prompts and in a `gen` run inside the OS, and all of those programs were correct, but that is 5 sessions, not a measurement (`gate-d/live-staging.jsonl`).
- `gate-d/live-staging-no-catalog.jsonl` is a discarded first attempt: staging then had no E4 packages, so those sessions ran without a library. It is kept for the record and not counted.
- Small tasks, a small library and 5 sessions per cell. The two easy reuse tasks did not exercise reuse at all.
