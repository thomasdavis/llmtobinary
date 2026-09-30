# llmtobinary

Describe a program; an OpenAI model writes its **literal ANMA-1 bytes** in a checker-assisted agentic loop; a **TypeScript virtual machine runs those exact bytes in your browser** — and reruns the same file with fewer fast-value slots, showing the real backing-store traffic the machine (not the model) manages.

- Production (live OpenAI generation, $4.00/session and $20.00/day caps): https://llmtobinary.thomasalwyndavis.workers.dev
- Staging (live OpenAI generation, hard spend caps): https://llmtobinary-staging.thomasalwyndavis.workers.dev

The authority is [`PRD.md`](PRD.md) (v3.2). What is implemented, verified, tested live, and not yet tested is in [`docs/STATUS.md`](docs/STATUS.md).

## Layout

```
apps/web/               React UI, machine Web Worker (src/), Cloudflare Worker + Durable Objects (worker/), wrangler.jsonc
packages/spec           ANMA-1 wire constants, opcode/import tables, u64 semantics, limits, SPEC_SHA256
packages/decode         strict hex/envelope transport, header/record decoding, claim-syntax disassembly
packages/diagnostics    versioned rule catalog (the manual's error chapter), root-cause-first report assembly
packages/validate       independent validator -> Module IR
packages/check          check_candidate pipeline (shared by the Worker and the browser); ANMR check
packages/annotations    annotation sidecar, T1 record claims, ANMA-Spec contracts, T2 runtime monitor
packages/reference      independent semantic interpreter (hooks for contract monitoring)
packages/runtime        the finite-resource machine (F fast slots, backing store, A/B/R latches, fifo-v1)
packages/devices        terminal, framebuffer, input, heap arena, input binding, sync SHA-256
packages/tasks          task registry (Worker-safe `@llmtobinary/tasks/registry`), independent oracles, test runner
packages/research       capstone pressure witness, ANMR-1 interpreter, machine-invariance harness
packages/anmr           ANMR-1 matched register control: validator + static witness
packages/verify         T3: QF_BV verification conditions + z3 driver (Node backend; chunked browser backend)
packages/broker         agentic loop controller, OpenAI Responses adapter, prompts/manual, scripted fake model
packages/protocol       shared types (engine contract, loop events, session API)
packages/artifacts      IndexedDB history, manifests (Section 19), portable export/import
tools/fixture-builder   DEVELOPER-ONLY symbolic builder for fixtures (never imported by live code; CI enforces)
tools/research-cli      Section 18.6 trial runner (refuses without approval) and T3 verify CLI
fixtures/               3 PRD fixtures (bytes re-derived from published SHA-256) + tool-created fixtures + manifest
spec/anma-1.md          normative Sections 10–13, extracted from the PRD (hash in packages/spec)
```

## Commands

```sh
pnpm install
pnpm test                    # unit/conformance/property/fuzz/corpus tests (vitest)
pnpm test:worker             # Worker + Durable Objects inside workerd with the scripted fake model
pnpm typecheck
node scripts/check-deps.mjs  # import-graph rules (no engines/verifier/builders in the Worker, declared deps)
node scripts/spec-hash.mjs --check
node --experimental-transform-types --no-warnings tools/fixture-builder/src/build-fixtures.ts [--check]
pnpm dev                     # Vite + Worker + Durable Objects locally (reads apps/web/.dev.vars)
node scripts/live-test.mjs <url> [--fake | --openai <taskId>]
node tests/e2e/browser-e2e.mjs <url> [--live]
node tests/e2e/chip-e2e.mjs <url> [screenshot-dir]   # /chip view
node --experimental-transform-types --no-warnings tools/research-cli/src/verify.ts fixtures/upstream-capstone-40.anma --task capstone-40
```

## Deploy (Cloudflare Workers, Wrangler)

```sh
cd apps/web
CLOUDFLARE_ENV=staging npx vite build && npx wrangler deploy     # llmtobinary-staging
npx vite build && npx wrangler deploy                            # llmtobinary (production)
npx wrangler secret put OPENAI_API_KEY --name llmtobinary-staging
npx wrangler secret put SESSION_SIGNING_KEY --name llmtobinary-staging
npx wrangler rollback <version-id> --name llmtobinary-staging
```

Live generation is enabled per environment by `LIVE_GENERATION_ENABLED`, `OPENAI_MODEL`, price ceilings, and `SESSION_USD_CAP`/`DAILY_USD_CAP` in `wrangler.jsonc`; secrets are never in the repo. Production has live generation enabled with those caps.

## Chip view

`/chip` shows a modeled floorplan of the machine: fetch/decode, value directory, fast slots, latches, ALU, backing SRAM, staging, stack and I/O. Units light up as the engine executes each microstep. Every light is an event the engine actually emitted. Time is in **modeled ticks** from the declared cost model `anma-cost/1`, not measured cycles. For the forty-value capstone, **Compare with ANMR-1** runs the model-managed-register control next to it on the same clock. The machine panel links to it via "Open in chip view".

## What this does and does not show

An OpenAI model generates these executable bytes, working in a visible loop against a checker that explains its mistakes but never writes bytes for it. A TypeScript virtual machine executes them in the browser. The same file runs with fewer fast-value slots because the machine — not the model — manages backing storage. It does not show a native chip, compiler-free computation, or a universal register limit on LLM programming.
