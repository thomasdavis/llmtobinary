# OS goal status

Progress log for `PRD-OS.md`. `node scripts/goal-check.mjs` is the measure of done; this file explains it. Legend as in `docs/STATUS.md`: **verified** means automated tests pass, **live** means exercised on deployed Cloudflare, **not yet** means not done.

## Blockers the agent cannot clear

- **GitHub OAuth Apps.** GitHub has no API for creating them, and creating one needs a signed-in browser. Everything else about sign-in is built and tested against a fake provider. Real sign-in cannot be switched on without them.
- **Hyades.** `/etc/donto/hyades.key` is mode 600 root. The ops notes say it is readable by the `ajax` group. Not bypassed, so only one lane qualifies, which weakens Gate B's independence.
- **GitHub Actions.** `pnpm/action-setup` fails at its own install step, before any repo step runs, so `ci` and `deploy` cannot pass on GitHub. Staging is deployed from the box with the README's commands.

## Gate results

**Gate B: passed, 18 of 20 in round 2** (threshold 16). Every pair where both sessions got a reply linked and matched the oracle on every hidden input, so there were 0 link failures and 0 wrong results. The two failures were lane faults: one `codex` exit, and one call that never returned after four attempts. 26 hung calls were retried in total, with 0 tool-audit failures.

| Interface | Passed |
|---|---|
| `fmt` | 5 of 5 |
| `sort` | 5 of 5 |
| `gcd` | 4 of 5 |
| `stack` | 4 of 5 |

**Limits of this result:**

- Round 1 was aborted after 2 of 20 pairs for the same lane fault, and it counts toward the round limit. Its records are in `gate-b/round-1.jsonl`.
- Both sides were the same model, in separate sessions, because only one lane qualified. This shows separate sessions can hold a shared interface. It does not show that different models can.
- The interfaces were small and written by one author.
- Models got only static checks, with no execution feedback.

**Gate A, bucket 128: passed, exactly 16 of 20.** All 4 failures were calls that never returned, at turn 1, with 0 tokens. This bucket ran before the watchdog existed. Bucket 64 ran with it and scored 20 of 20.

## Bugs found on the way

- **Checker rejected correct programs on 21 of 26 curated tasks.** `effects: ["terminal"]` means "the oracle compares the terminal", which for pure tasks means it must stay empty, but `check_candidate` read it as "must print". Those tasks could not be passed, so past failures on them may not reflect the model. Fixed in `778b110`, and not yet deployed to production.
- **A registry failure would have lost a session archive.** Publishing was inside the archive's `try`. Now isolated.

## The "33k token" endings (A0.6)

The research report suggested a limit near 33k output tokens. Production data rules that out: sessions passed at up to 76,665 tokens and 573 seconds, and a staging session passed after 918 seconds. The five `unfinished` sessions end at 215 to 308 seconds with 17k to 41k tokens, so no token count or fixed time explains them.

**Stated cause, inferred from code and data:** `worker/session.ts` aborts the attempt when the client disconnects (`clientGone`). The outer loop also needs the browser, so a closed tab leaves a session unfinished. The archives for those exact sessions were not available, so this is not confirmed per session. The two example games stopping near 34,300 tokens was coincidence.

**Consequence for live generation:** closing a tab kills a generation today, so phase 7 must not depend on one unbroken connection.

## Decision notes

- **Module and task IDs are plain `u64`, not new handle types** (PRD-OS 6.10 said opaque handles). Only the kernel holds the tasks capability, so forging an ID reaches nothing it does not already own. This avoids new type tags and any change to validator typing.
- **Mailboxes are copied, not shared,** as PRD-OS 6.9 planned for process boundaries.
- **Linked images are plain ANMA-1.** Only `FUNC` field `a` and `CALL` field `b` are rewritten, so the unchanged validator judges the result.
- **Read-only data is root-only in link version 0.** Data offsets are runtime values, so the linker cannot move them.
- **Sign-in sits behind `GENERATION_REQUIRES_SIGN_IN`,** and is ignored until sign-in is configured, so a missing OAuth App cannot stop generation.
- **The per-member quota charges a flat $0.05 per session.** It approximates actual spend. The BudgetLedger stays the hard site-wide cap.

## Harness faults during the OS build

- **`proc` session 1 failed from a VM bug, not the model.** A task has its own devices, so its `print_utf8` output never reached the console and `proc`'s tests could not be passed. The model spent 7 submissions and 39,486 tokens on an impossible task. Fixed, with a failing test first. The attempt stays in `attempts.jsonl`.
- **`fmt` session 1 failed from a harness bug, not the model.** The holdout seed is 128 bits and the generator assumed 64, so test numbers overflowed the test buffer and threw a `RangeError`. Fixed, with a test. The attempt stays in `attempts.jsonl`.
