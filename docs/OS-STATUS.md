# OS goal status

Progress log for `PRD-OS.md`. `node scripts/goal-check.mjs` is the measure of done; this file explains it. Legend as in `docs/STATUS.md`: **verified** means automated tests pass, **live** means exercised on deployed Cloudflare, **not yet** means not done.

## Blockers the agent cannot clear

- **GitHub OAuth Apps.** GitHub has no API for creating them, and creating one needs a signed-in browser. Everything else about sign-in is built and tested against a fake provider. Real sign-in cannot be switched on without them.
- **Hyades.** `/etc/donto/hyades.key` is mode 600 root. The ops notes say it is readable by the `ajax` group. Not bypassed, so only one lane qualifies, which weakens Gate B's independence.
- **GitHub Actions.** `pnpm/action-setup` fails at its own install step, before any repo step runs, so `ci` and `deploy` cannot pass on GitHub. Staging is deployed from the box with the README's commands.

## Bugs found on the way

- **Checker rejected correct programs on 21 of 26 curated tasks.** `effects: ["terminal"]` means "the oracle compares the terminal", which for pure tasks means it must stay empty, but `check_candidate` read it as "must print". Those tasks could not be passed, so past failures on them may not reflect the model. Fixed in `778b110`, and not yet deployed to production.
- **A registry failure would have lost a session archive.** Publishing was inside the archive's `try`. Now isolated.

## Decision notes

- **Linked images are plain ANMA-1.** Only `FUNC` field `a` and `CALL` field `b` are rewritten, so the unchanged validator judges the result.
- **Read-only data is root-only in link version 0.** Data offsets are runtime values, so the linker cannot move them.
- **Sign-in sits behind `GENERATION_REQUIRES_SIGN_IN`,** and is ignored until sign-in is configured, so a missing OAuth App cannot stop generation.
- **The per-member quota charges a flat $0.05 per session.** It approximates actual spend. The BudgetLedger stays the hard site-wide cap.
