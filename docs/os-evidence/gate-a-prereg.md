# Gate A pre-registration

Committed before any Gate A session ran. Do not edit after results exist; add a dated note instead.

**Lane:** `codex-sol`: `codex exec`, model `gpt-6.1-sol`, reasoning effort medium, flat ChatGPT subscription.

**Lane qualification.** Trap test on 2026-11-07: with the execution host disabled, the model's `exec` call was refused (`code-mode host is disabled`) and no file appeared. A tools-on control logged `command_execution` and wrote its file, so the event log does record tool use. Some tools are still declared to the model, so the lane is qualified only under this audit: any session with a tool item, any error item other than the exact fail-closed startup notice, or a `codex_core::tools::router` refusal on stderr counts as a failure, reported as `tool-audit-failed`.

**Not available:** Hyades. `/etc/donto/hyades.key` is mode 600 root, not readable by this account.

**Buckets (task, reference fixture size):**

| Bucket | Task | Reference records |
|---|---|---|
| 64 | `checkerboard` | 52 |
| 128 | `fizzbuzz` | 125 |
| 256 | `ball-paddle` | 311 |
| 512 | `capstone-k128` | 519 |

Task tests and holdouts already exist in `packages/tasks` and are unchanged.

**Protocol:** 20 independent sessions per bucket, fresh context, `checked` arm of PRD §18.6 (`check_candidate` available, annotations optional), prompt version from `packages/broker/src/prompts.ts`.

**Per-session budget:** 24 turns, 16 checks, 6 submissions, 20 minutes.

**Scoring:** final success means `runTaskTests` passes, holdouts included. Every session counts in the denominator, including infrastructure failures, timeouts and audit failures. Infrastructure failures are also reported separately.

**Pass rule (PRD §7):** at least 16 of 20 in the 128 bucket. The largest bucket at 16 of 20 or better sets the package size limit.

**Run order:** 128, 64, 256, 512. A bucket may be skipped only if the next smaller bucket scored below 16 of 20, and a skip is reported.

## Note, 2026-11-07: lane fault

Bucket 128 ran without a call watchdog and stands as run. Its failures so far are all calls that never returned, with 0 output tokens at turn 1. Buckets 64, 256 and 512 run with the 240-second watchdog described in `gate-b-prereg.md`. Nothing else changes.
