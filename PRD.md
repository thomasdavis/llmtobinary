# llmtobinary — Final Product and Engineering Requirements

**Product name:** `llmtobinary` (formerly drafted as "ANMA Browser Lab")  
**Document version:** 3.2 · **Date:** 30 September 2026  
**Wire format:** ANMA-1, compatible with the previously supplied 144-byte and 192-byte examples  
**Generation provider:** OpenAI, using the Responses API from a TypeScript Cloudflare Worker  
**Hosting:** Cloudflare Workers (static assets + API in one Worker named `llmtobinary`), built and deployed with Wrangler  
**Guest execution:** A virtual machine and peripherals implemented in TypeScript, running in the visitor's browser  
**Status:** Implementation specification, not a claim that the application or a physical ANMA processor already exists

> **Change from 3.0:** the product is named **llmtobinary** and is hosted on **Cloudflare** using **Wrangler**. The Node inference broker becomes a Cloudflare Worker, session and budget state move to Durable Objects, and the static Vite build is served as Workers static assets from the same Worker and origin. The ISA, fixtures, prompts, schema, and experiment protocol are unchanged.
>
> **Change from 3.2 (additive):** a **chip view** (Section 14A) animates a modeled floorplan from the engine's own executed micro-events, with a declared latency model (`anma-cost/1`, "modeled ticks") and an ANMA-1 vs ANMR-1 compare. No ISA, fixture, prompt or protocol change.
>
> **Change from 3.1:** generation is an **agentic loop**, not a single response plus three repairs. Models will often produce malformed bytes, so the loop keeps going until the candidate passes or a declared budget runs out. The model gets a static `check_candidate` tool that never executes anything and returns precise, model-oriented diagnostics (Section 7.7). Browser test results feed the next iteration. Submissions may carry **annotations and machine-checked contracts** (Section 15.3–15.5): record-level comments cross-checked against the decoded bytes, `requires`/`ensures`/invariant contracts checked at runtime, and, as a P2 tier, bit-vector SMT proofs. Annotations are a sidecar: ANMA-1 bytes, hashes, and fixtures are unchanged. The submission schema (7.2), request shape (7.3), repair rules (7.6), error classes (9), limits (14.1), trial conditions (18.6), manifest (19), acceptance tests (20), and milestones (21) change accordingly.

This document supersedes the earlier conceptual and browser PRDs and version 3.0. It is the implementation authority for the web demonstration. The bundled prompts, schema, and executable fixtures are supporting conformance material. "Must" denotes a requirement; explicitly deferred features are not launch dependencies. External research supports the source review and platform integration; ANMA's encoding, limits, interfaces, and execution rules are project design decisions.

`llmtobinary` is an independent project. It is not affiliated with, and must not be presented as, the upstream `skelpo/llm-to-native-binary` repository reviewed in Section 3.

## Navigation

[Product and boundaries](#1-product-contract) · [Source review](#3-reinspection-of-the-original-experiment) · [OpenAI integration](#7-openai-generation-contract) · [Agentic loop](#76-agentic-generation-loop) · [Model diagnostics](#77-diagnostics-written-for-the-model) · [Cloudflare deployment](#8-broker-protocol-and-cloudflare-deployment) · [Binary specification](#10-anma-1-file-format) · [Finite storage](#12-finite-storage-model) · [Annotations and contracts](#153-annotations-sidecar-comments-bound-to-the-bytes) · [Exact examples](#17-exact-user-prompt-and-model-output-example) · [Experiments](#18-counter-experiment-protocol) · [Acceptance tests](#20-acceptance-tests) · [Implementation sequence](#21-implementation-sequence-and-handoff)

## 1. Product contract

Build a website, **llmtobinary**, where a visitor describes a program, an OpenAI model emits its literal executable bytes, and a visible TypeScript computer executes those exact bytes. The visitor can change runtime inputs, inspect instructions and values, and rerun the unchanged binary with less simulated fast storage.

The defining demonstration is:

> Generate once. Keep the executable hash. Reduce fast-value slots. Run again. Observe actual simulated backing-store transfers, with the same result and no regenerated program.

The model names immutable logical values, not physical registers. The execution system owns their storage placement. The website must expose that machinery rather than implying that its work disappeared.

The product assumes that models will often emit malformed or wrong bytes on the first try. A request for a program therefore starts a bounded **agentic loop**. The model drafts bytes and checks them with a static checker that explains every problem in terms the model can act on. It then submits, the browser tests the submission, and the loop continues until the program passes or the budget runs out. Every candidate, diagnostic, and turn stays visible. The loop never repairs bytes on the model's behalf.

A valid launch demonstrates **direct generation of executable code for a virtual ISA**. It does not demonstrate native ARM/x86 generation, an efficient custom chip, the elimination of all compiler-like machinery, or superiority to optimizing native compilers. The claim about literal bytes concerns the guest-program path, not the ordinary TypeScript-to-JavaScript application build.

## 2. Fixed decisions and boundaries

| Area | Required decision |
|---|---|
| Product / deployment name | `llmtobinary` (Worker name, Wrangler `name`, package scope, page title) |
| Hosting | Cloudflare Workers: one Worker serves the Vite build as static assets and the `/api/*` routes on the same origin |
| Build and deploy tooling | Wrangler (pinned in `devDependencies`), with `@cloudflare/vite-plugin` for local development and builds |
| User interface | React and TypeScript; Vite for the app |
| Machine implementation | TypeScript decoder, validator, interpreter, storage manager, heap, devices, and tracing |
| Execution location | Dedicated browser Web Worker; no server-side guest execution in the public demonstration |
| Generation | Official OpenAI JavaScript/TypeScript SDK and Responses API, called from the Cloudflare Worker |
| Server state | Durable Objects: one `GenerationSession` per session, one `BudgetLedger` for atomic spend accounting |
| Credentials | Wrangler secrets only; never in `wrangler.jsonc`, browser bundles, browser storage, or public artifacts |
| Default model response | A strict `submit_candidate` function call whose arguments are the JSON envelope: ISA tag, literal hex string, and an annotation sidecar |
| Research alternative | Raw-hex text output, explicitly labelled as a different transport condition |
| Guest arithmetic | Exact unsigned 64-bit modular arithmetic using `bigint` |
| Execution order | Sequential instructions within typed basic blocks; no instruction reordering |
| Value residency | Bounded fast slots, bounded backing storage, explicit operand/result latches |
| Main replacement policy | Deterministic FIFO, with no future-use eviction oracle |
| Tools given to the model | Exactly two function tools: `check_candidate` (static decode/validate/annotation cross-check with no execution, which never returns bytes) and `submit_candidate`. There are no builder, assembler, encoder, code-execution, or shell tools. |
| Generation loop | An agentic loop: an inner model↔checker loop inside the `GenerationSession` Durable Object, and an outer loop driven by browser test results. It is bounded by turn, token, spend, wall-clock, and stall limits (Section 7.6). |
| Diagnostics | Deterministic, rule-ID'd, root-cause-first diagnostics written for the model, with annotated disassembly context (Section 7.7) |
| Annotations | An optional sidecar of comments, record claims, contracts, invariants, and examples. It is checked, never trusted, and never used to produce bytes (Section 15.3–15.5). |
| Storage | Local artifact history and export; explicit opt-in for any public publication |
| First fixtures | Return 42; parameterized square-plus-two; exact upstream 40-value capstone |
| Large pressure runs | Separately labelled fixture/runtime scaling tests, not automatically live model generation |

v1 has no Vercel AI Gateway, Cloudflare AI Gateway, Workers AI, generic provider framework, local-model download, WebLLM dependency, OpenAI hosted code interpreter, shell tool, assembler service, JIT, guest WebAssembly backend, or FPGA dependency. The Worker calls the OpenAI API directly. Vite's worker bundling and separate type-checking requirements fit the implementation. Framework-independent machine packages allow later embedding in another application without changing the ISA. [B1]

Use a pnpm workspace. The inference broker is TypeScript that runs on the Cloudflare Workers runtime (`workerd`). It is not a Node service, so broker code must use Web-standard APIs (`fetch`, `Request`/`Response`, streams, `crypto.subtle`) and must not depend on Node built-ins. Enable the `nodejs_compat` compatibility flag only if the pinned OpenAI SDK version requires it, and record that fact. Pin the actual Wrangler, `@cloudflare/vite-plugin`, `@cloudflare/workers-types` (or generated `wrangler types`), OpenAI SDK, TypeScript, and frontend versions in the lockfile and CI, and pin a `compatibility_date` in `wrangler.jsonc`. Do not prescribe an unverified future package version in code.

## 3. Reinspection of the original experiment

### 3.1 Pinned evidence

Repository: `skelpo/llm-to-native-binary`  
Inspected revision: `b79649eb9e1d46e6c35d0d2053d19547e9aadd90`  
Commit timestamp: 9 August 2026, 09:20:56 UTC. [R8]

The review covered the README, instruction encoders/label resolver, Mach-O builder, hand capstone emitter, golden-reference script, pressure-probe script, optimization script, and repository tree. This was source inspection, not a fresh macOS execution or a reproduction of the reported Claude session. The inspected tree does not include a full raw model-interaction transcript. [R1–R8]

### 3.2 Findings that change this PRD

| Observation in the inspected source | Consequence for ANMA |
|---|---|
| `arm64asm.py` encodes instruction fields and resolves labels in two passes. | Do not describe the upstream program path as literal hex alone. Record construction assistance explicitly in both projects. [R2] |
| `machobuild.py` lays out the executable and generates its ad-hoc signature. | A simpler browser container is a changed interface, not evidence of better register allocation. [R6] |
| The hand capstone initializes forty values as `x + i`, then folds them in a fixed permutation. | Include that exact computation, not only the more elaborate workload proposed earlier. [R3, R4] |
| The reported wrong-answer episode concerns `argc` in `x0`. | Classify it as an entry/input or ABI error; it is not by itself an example of an incorrect spill decision. Typed parameters also cannot detect every wrong-input choice. [R1, R3] |
| `pressure_probe.py` compiles a different, in-place ring-mixing workload. | Keep its measurements separate from the forty-value capstone. [R5] |
| The hand emitter's instruction counter covers its tagged instructions, including setup/output, while the C analysis extracts `_kernel`. It excludes separately tagged branch items from that hand counter. | The published totals are not a newly verified, identically scoped count. Separate kernel-only, wrapper, static, and executed counts in any new comparison. [R3, R4] |
| The analysis counts stack-related assembly instructions using a regular expression. | Do not translate this proxy into measured runtime bytes moved or memory bandwidth. [R4, R5] |

The README reports a successful native experiment and an advantage for clang on its chosen examples. Preserve that attribution without turning a single session into a universal LLM failure threshold. This PRD tests a narrower question: **must the program-generating model choose physical register locations when the machine interface does not expose them?** [R1]

### 3.3 Exact capstone semantics

For unsigned input `x`, perform all arithmetic modulo `2^64`:

```text
For i = 0 .. 39:
    v[i] = x + i

a = 0
For j = 0 .. 39:
    a = (a * 3) XOR v[(17 * j) mod 40]

Return a
```

The reference input is `0x0000123400005678`. Its expected result is `13514254791259192080`. For input `1`, the expected result is `8313107083524001560`. These constants identify the upstream computation, not an acceptable hard-coded implementation. [R3, R4]

Do not claim these values are impossible to recompute, reschedule, or simplify. For the **prescribed-pressure** trial, the execution structure is part of the task: construct all forty values before consuming them in the fold, preserve them, and do not recreate them later. A separate unrestricted task accepts any correct algorithm and does not claim forty-value pressure.

## 4. What success means

Three independent questions must remain separate:

**Machine correctness.** The same binary and inputs produce the same guest result/effect sequence across fast-store capacities, when memory and execution budgets suffice.

**Model usability.** Under a declared budget, an OpenAI model can generate valid, task-correct bytes; comparative trials determine whether the logical-value interface reduces errors relative to a matched register interface.

**Direct-byte utility.** Literal-byte output may or may not be preferable to an openly labelled builder-assisted interface. The product must not need a preselected winner to be useful.

The browser demo proves neither hardware feasibility nor general compiler obsolescence. Binary virtual instruction sets already exist, including WebAssembly. EDGE/TRIPS is relevant architectural background, but its compiler-generated blocks are not evidence of compiler-free computation. [B7, B8]

## 5. User journey and interface

The desktop layout has a task panel, executable inspector, and machine/output panel. Narrow screens use tabs, with Stop and execution state always reachable. Use a restrained light interface, readable monospaced bytes, selectable text, keyboard navigation, and non-colour status indicators. Avoid a chat transcript dominating the actual computer.

A visitor can run a clearly labelled bundled fixture before generating anything. Live generation begins only after an explicit action and disclosure that the prompt is sent to OpenAI.

A normal generation proceeds as follows:

1. The visitor selects a task or describes a program, chooses permitted virtual devices, and sees the generation budget.
2. The `llmtobinary` Worker constructs the pinned prompt and starts the agentic loop. The interface streams each draft as an **uncommitted preview** and shows each `check_candidate` call with its diagnostics as the loop runs ("draft 3: 2 errors — HOST at record 6 declares 1 argument but no ARG follows").
3. When the model calls `submit_candidate`, the browser hashes an immutable copy of the literal bytes and validates it independently. It does not trust the server-side check.
4. Under preauthorised test-run permissions, the machine Web Worker tests the frozen candidate snapshot. It runs task tests, the model's own examples, and runtime contract checks (Section 15.4), and it returns structured diagnostics, not a replacement program.
5. If the candidate fails, the browser automatically sends those diagnostics back as the next outer iteration, within the session budget. The visitor sees the loop status and can stop at any point. Every candidate and diagnostic remains visible.
6. A selected candidate becomes the committed artifact. Task failure does not disappear merely because the candidate is structurally valid.
7. The visitor runs it with inputs, inspects storage movement, changes fast-slot capacity, and reruns without changing the hash.
8. Export preserves the bytes, task, inputs, run configuration, and provenance. Publishing is separate and opt-in.

Separate **Cancel generation**, **Stop execution**, **Reset machine**, and **Clear local history**. A global cancel may invoke the first two, but their states and costs remain distinct.

Required inspectors: bytes-to-instructions highlighting; typed logical values and producers; current function/block; fast slots; A/B/R latches; backing occupancy and transfers; frame/staging storage; terminal; framebuffer; attempt history; input editor; and same-binary run comparison. Detailed execution is bounded/sampled with aggregate counters retained. Do not render thousands of values as an unbounded React DOM tree.

## 6. System architecture

```text
Browser UI (React / TypeScript, served as Workers static assets)
    |
    +-- POST /api/* task / bounded loop feedback     (same origin)
    |         |
    |         v
    |   Cloudflare Worker "llmtobinary"
    |     routing, origin/CSRF checks, rate-limit binding
    |         |
    |         v
    |   GenerationSession Durable Object  <-->  BudgetLedger Durable Object
    |     agentic loop controller
    |         |            ^
    |         v            | function_call_output (diagnostics)
    |   OpenAI Responses API --- check_candidate --> static checker
    |         |                                     (decode, validate,
    |   submit_candidate                             annotation cross-check;
    |         |                                      NO execution)
    +---------+
    |    ^
    |    `-- outer loop: browser test/contract diagnostics -> next iteration
    |
    +-- Literal transport decoding + immutable artifact store
    |
    +-- Dedicated TypeScript machine Web Worker (browser)
    |     decoder -> validator -> frozen candidate
    |                         -> reference tests
    |                         -> finite-resource execution
    |                         -> devices / bounded traces
    |
    `-- Canvas, terminal, inspectors, IndexedDB, export
```

The model runs remotely. The generated program runs locally in the visitor's browser. Cloudflare hosts the application and relays generation, and it never executes guest bytes. Display **"OpenAI generation · TypeScript virtual-machine execution in your browser."** Do not call generation offline. Previously saved artifacts can execute without an inference request once application assets are available.

"Worker" is ambiguous in this project, so documentation and code must keep the two apart: the **Cloudflare Worker** (`apps/web/worker/`, server side, hosting and broker) is not the **machine Web Worker** (`apps/web/src/machine.worker.ts`, browser side, guest execution).

The Cloudflare Worker and its Durable Objects must not execute guest code in the public workflow. A separately labelled research CLI may use the same TypeScript runtime under Node for unattended tests; those runs must not be labelled browser executions.

### 6.1 Package layout

```text
apps/web/                    UI, trusted machine module-worker entry, Vite config
apps/web/wrangler.jsonc      Cloudflare Worker "llmtobinary": assets, DO bindings, vars, envs
apps/web/worker/             Cloudflare Worker entry: /api/* router, Durable Object classes
packages/broker/             OpenAI requests, sessions, quotas, streaming (workerd-compatible, no Node built-ins)
packages/spec/               Wire constants, opcode metadata, spec version/hash
packages/decode/             Bounded parser and disassembly
packages/validate/           Grammar, IDs, types, capabilities, control signatures
packages/diagnostics/        Rule catalog, model-facing diagnostic rendering, cascade suppression
packages/annotations/        Annotation schema, record-claim parser/cross-checker, contract language
packages/verify/             (P2) Verification-condition generation and SMT driver; browser-only
packages/reference/          Independent semantic interpreter
packages/runtime/            Finite store, latches, frames, ordered execution
packages/devices/            Terminal, framebuffer, deterministic input
packages/protocol/           Worker, broker, candidate, and manifest schemas
packages/artifacts/          Hashes, IndexedDB, import/export
packages/tasks/              Task specifications and independent test oracles
packages/research/           Pressure witnesses and matched control experiments
fixtures/                    Bytes, hashes, and explicit provenance
prompts/                     Pinned generation manual and task templates
spec/                        Normative extracted documents
```

Strict generation packages may not depend on a symbolic instruction encoder. Test-only fixture builders must live outside that dependency graph. CI must detect accidental imports of a compiler, assembler, guest evaluator, or native/Wasm backend into the live path. CI must also verify that the Cloudflare Worker bundle does not import `packages/runtime`, `packages/reference`, `packages/devices`, or `packages/verify`, since the server never executes guest code. The Worker may import `spec`, `decode`, `validate`, `diagnostics`, and `annotations` for the static `check_candidate` tool. `packages/annotations` parses record claims only to compare them with decoded bytes. It must not contain, or depend on, anything that turns claims into bytes, and CI enforces that with the same no-encoder import rule.

## 7. OpenAI generation contract

### 7.1 API and model policy

Use the official OpenAI SDK and the Responses API, with foreground streaming, from inside the Cloudflare Worker (specifically the `GenerationSession` Durable Object, Section 8.3). Use an administrator-configured, tested model profile rather than a mutable "latest" alias selected automatically. The model must support Responses, streaming, and the selected output mode. Record requested model ID, returned model ID, settings, SDK version, and a dated capability smoke test. Prefer an explicit snapshot when one is available for that model. Listing a model is not a substitute for testing project access. [O1, O4, O8]

`OPENAI_API_KEY` is a Wrangler secret (`wrangler secret put OPENAI_API_KEY`, per environment). For local development it lives in `apps/web/.dev.vars`, which is gitignored and never committed. `OPENAI_MODEL` is required for live generation. It is set as a non-secret `vars` entry in `wrangler.jsonc` per environment, or as a secret if the operator prefers. An empty or inaccessible configuration disables Generate while preserving fixture playback. There is no fallback to another model or provider and no browser-side API-key storage. [O5, C5]

Production configuration also sets allowed reasoning effort, per-call token cap, session cap, timeouts, concurrency, and a versioned price/budget policy. These are environment `vars`, validated at startup against a schema. Omit unsupported sampling parameters rather than assuming every model accepts temperature or seed.

### 7.2 Candidate envelope and tool schemas

Every candidate is one complete file in this envelope. It is the parameter schema of both function tools (`check_candidate` and `submit_candidate`), declared with `strict: true`. Strict mode requires every property to be present, so optional content is expressed as `null` or an empty array.

```json
{
  "type": "object",
  "properties": {
    "isa": { "type": "string", "enum": ["ANMA-1"] },
    "hex": { "type": "string" },
    "annotations": {
      "anyOf": [
        { "type": "null" },
        {
          "type": "object",
          "properties": {
            "summary":   { "type": "string" },
            "params":    { "type": "array", "items": {
              "type": "object",
              "properties": {
                "function": { "type": "integer" },
                "index":    { "type": "integer" },
                "name":     { "type": "string" }
              },
              "required": ["function", "index", "name"],
              "additionalProperties": false } },
            "records":   { "type": "array", "items": {
              "type": "object",
              "properties": {
                "index": { "type": "integer" },
                "claim": { "type": ["string", "null"] },
                "note":  { "type": ["string", "null"] }
              },
              "required": ["index", "claim", "note"],
              "additionalProperties": false } },
            "contracts": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "function": { "type": "integer" },
                "requires": { "type": ["string", "null"] },
                "ensures":  { "type": ["string", "null"] }
              },
              "required": ["function", "requires", "ensures"],
              "additionalProperties": false } },
            "invariants": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "function": { "type": "integer" },
                "block":    { "type": "integer" },
                "expr":     { "type": "string" }
              },
              "required": ["function", "block", "expr"],
              "additionalProperties": false } },
            "examples":  { "type": "array", "items": {
              "type": "object",
              "properties": {
                "inputs":   { "type": "array", "items": { "type": "string" } },
                "result":   { "type": ["string", "null"] },
                "terminal": { "type": ["string", "null"] }
              },
              "required": ["inputs", "result", "terminal"],
              "additionalProperties": false } }
          },
          "required": ["summary", "params", "records", "contracts", "invariants", "examples"],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": ["isa", "hex", "annotations"],
  "additionalProperties": false
}
```

The schema constrains the envelope only. It deliberately does not encode instruction legality, calculate record counts, or select values. The application independently verifies lexical hex and every machine-level rule. The meaning and checking of `annotations` are defined in Sections 15.3–15.5. Annotations never contribute bytes: the executable is exactly the decoded `hex`, and its SHA-256 identity excludes the annotations, which get their own hash (Section 19). Function calling with strict schemas can still produce refusals or incomplete responses, and schema compliance is not semantic correctness. [O2, O9]

Public labels: **"Literal bytes · checker-assisted loop"** (default), and **"Literal bytes · annotated"** when the committed candidate carries annotations. An optional raw-hex research profile uses plain text output with no tools and no annotations, with only outer-loop feedback, and is labelled separately. No mode may accept assembly or a script for later execution.

### 7.3 Request shape

This is the required SDK-level shape inside the Workers runtime. Route authentication, budgets, event forwarding, and diagnostics belong around it. The configured profile must already have passed its capability check. Secrets come from the Worker `env` binding, not `process.env`.

```ts
import OpenAI from "openai";

// Inside GenerationSession (Durable Object); `env` is the Worker environment.
const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  maxRetries: 0, // Retries are accounted for by the application controller.
});

const tools = [
  {
    type: "function",
    name: "check_candidate",
    description:
      "Statically decode and validate a complete ANMA-1 candidate and cross-check its annotations. " +
      "Never executes the program and never returns corrected bytes.",
    strict: true,
    parameters: candidateEnvelopeSchema,
  },
  {
    type: "function",
    name: "submit_candidate",
    description: "Submit a complete ANMA-1 candidate for independent validation and testing.",
    strict: true,
    parameters: candidateEnvelopeSchema,
  },
] as const;

// One model turn of the agentic loop (Section 7.6). `loopInput` is the
// self-contained item list: task, prior output items, and function_call_output items.
const stream = await client.responses.create({
  model: profile.modelId,
  instructions: pinnedGenerationInstructions,
  input: loopInput,
  store: false,
  stream: true,
  include: profile.carryReasoning ? ["reasoning.encrypted_content"] : [],
  max_output_tokens: reservedOutputTokenLimit,
  reasoning: { effort: profile.reasoningEffort },
  tools,
  tool_choice: "required",
  parallel_tool_calls: false,
}, { signal: abortController.signal });
```

There is no `response_format` Chat Completions field in this Responses request, and no `text.format`: structured output arrives as validated function-call arguments. Handle the returned typed stream, including `response.function_call_arguments.delta`/`.done` events, not a concatenation of arbitrary provider events. [O1, O3, O9]

### 7.4 Streaming and finalization

Consume response lifecycle events, including text deltas and completed/error outcomes. Preserve output item identities so unrelated items cannot be concatenated into a candidate. Forward only intended public content and safe metadata. Do not expose encrypted reasoning, provider credentials, or internal server diagnostics. [O3]

Partial function-call arguments may be shown as inert preview text. No partial prefix is executable, and a `check_candidate` draft is never executable. Only a completed `submit_candidate` call creates a candidate. The acceptance gate for a submitted candidate is:

```text
provider completed successfully
AND the candidate arrived as a complete submit_candidate call
AND no refusal
AND permitted response structure
AND bounded JSON/hex parsing succeeds
AND complete binary is within limits
AND immutable candidate snapshot is created
AND independent machine validation succeeds
```

`incomplete`, token exhaustion, refusal, aborted connections, and API errors are distinct from malformed machine code. Do not repair a truncated response by appending guessed bytes or treating the prefix as a program. A later generation must supply a complete new file.

Loop turns use self-contained requests: pinned instructions, original task, the prior output items, and `function_call_output` items carrying diagnostics. They do not require `previous_response_id` or a hosted conversation (`store: false`). A profile may set `carryReasoning`, which requests `reasoning.encrypted_content` and passes those opaque items back on the next turn, as reasoning models expect during tool loops. These items are held only in the session Durable Object for the recovery TTL. They are never shown, logged, exported, or decrypted, and the manifest records whether they were carried. All visible context is recorded. When the input approaches the declared context budget, older `check_candidate` outputs are deterministically elided to one line each ("draft 4: rules ANMA-V-HDR-003, ANMA-V-ARG-001"). The elision is recorded and visible, and the manual, task, latest candidate, and latest diagnostics are always kept. No model-written summarization is used. If the budget is still exceeded, the loop stops with `CONTEXT_BUDGET_EXHAUSTED`. [O6, O9]

### 7.5 Exact prompt construction

The system/developer instruction consists of the bundled `generation-system.txt` followed by the pinned machine manual. Both are bundled into the Worker at build time, not fetched at runtime. It states the output envelope, byte-only construction boundary, arithmetic semantics, and prohibition on hard-coded test answers. It also includes the diagnostic rule catalog (so every rule ID in a diagnostic points to a manual section), the annotation claim and contract grammar (Section 15.3–15.4), and the working method: draft, call `check_candidate`, fix every reported error, and call `submit_candidate` only when the check is clean or the model judges the remaining warnings acceptable. The user content contains the visitor's task and typed input signature. An optional repair block is explicitly labelled diagnostic data, never higher-priority instructions.

The model is not told ANMA's fast-slot capacity: it is not an ISA parameter. The control-ISA model is told its architectural register count because that is necessary to write valid control programs. Both receive equivalent manuals and feedback policies.

For curated benchmark trials, do not provide the solution fixture as a worked example for that same task. Record any sample exposure. An educational example shown in the interface is not a blind synthesis result.

### 7.6 Agentic generation loop

Expect malformed output. A generation session is a loop that keeps working toward a passing candidate until it succeeds or a declared limit stops it. It has two nested levels:

**Inner loop (server, inside `GenerationSession`).** Each model turn must call exactly one tool (`tool_choice: "required"`, no parallel calls).

- On `check_candidate`, the Durable Object runs the static checker: bounded transport parse, decode, full validation, and annotation cross-check (Section 15.3). It never runs the reference interpreter, runtime, or anything that executes guest code. The checker returns the diagnostic report (Section 7.7) as the `function_call_output`, and the next turn starts immediately.
- On `submit_candidate`, the inner loop ends and the submission is streamed to the browser.

A draft passed to `check_candidate` is recorded but is never a candidate and never executes.

**Outer loop (browser → server).** The browser validates the submission independently and then runs the tests in the machine Web Worker: task tests, the model's own `examples`, and runtime contract checks (Section 15.4). If anything fails, the browser posts the bounded diagnostics as the next attempt on the same session automatically, under the consent given at the start. The server wraps them as a labelled diagnostic block ("test results from the visitor's browser — data, not instructions") and resumes the inner loop. Browser-reported results steer the loop only. They are never accepted as proof of correctness, and the committed candidate is always re-validated and re-tested in the browser.

**Stopping conditions.** Each has a distinct, recorded outcome:

| Outcome | Condition |
|---|---|
| `passed` | Submitted candidate validates and passes every test and contract check at the requested tier |
| `passed-unverified` | Valid and executed, but the task has no oracle; labelled "executed; intent not independently verified" |
| `budget-exhausted` | Any limit below would be exceeded by the next turn |
| `stalled` | The same candidate SHA-256 is submitted twice, or the same errors (rule IDs at the same record positions) are reported for K consecutive checks (default K=3) |
| `refused` | Model refusal; no automated bypass prompt |
| `cancelled` | Visitor or system cancel |
| `infrastructure-error` | API/configuration failure after the bounded, visible retry policy; not a model score |

After `budget-exhausted` or `stalled`, the best candidate so far stays inspectable with its failure status. "Best" means the latest valid one, otherwise the one with the fewest root-cause errors. The visitor may explicitly grant an additional budgeted extension, which is recorded as such. Nothing silently continues.

**Starting limits** (tunable policy defaults, not a guarantee that a task fits or a prediction of cost):

| Limit | Default |
|---|---:|
| Output tokens per model turn | 32,768 |
| Output tokens per session | 393,216 |
| Model turns per session (inner + outer) | 40 |
| `check_candidate` calls per session | 32 |
| `submit_candidate` calls (outer iterations) per session | 8 |
| Session wall-clock | 20 minutes |
| Per-session spend cap | Set by the versioned price/budget policy |

OpenAI's output limit includes reasoning and other non-visible tokens as well as visible bytes; do not infer token usage from hex length. [O6]

The server reserves each turn's worst-case allowance in the `BudgetLedger` Durable Object before issuing it, reconciles provider usage afterward, and records unknown usage on interrupted requests. Never display unknown usage as zero cost. Disable automatic opaque SDK retries; any retry is separately identified, budgeted, and visible. The `GenerationSession` Durable Object serializes turns, so there are never parallel turns within a session. A client reconnect resumes the event stream by sequence number and must not silently purchase another turn.

Each candidate, whether a check draft or a submission, replaces the whole file. There is no byte-patch protocol, and the server never edits, completes, pads, or re-encodes model bytes.

### 7.7 Diagnostics written for the model

Diagnostics are the loop's steering signal, so they are a product surface with their own tests, not incidental error strings. They are produced deterministically from a versioned rule catalog (`packages/diagnostics`) and not written by a model.

Each diagnostic has this shape:

```ts
interface Diagnostic {
  rule: string;            // stable ID, e.g. "ANMA-V-ARG-001"; documented in the manual
  severity: "error" | "warning";
  category: ErrorClass;    // Section 9, e.g. BAD_RECORD_GRAMMAR
  message: string;         // one plain sentence stating what is wrong
  location: {
    byteOffset: number | null;
    recordIndex: number | null;
    field: string | null;  // "header.word3", "record.a", "hex.char", ...
    functionId: number | null;
    blockId: number | null;
  };
  found: string | null;    // the actual bytes and how they decode
  expected: string | null; // the rule stated as a requirement, not as patched bytes
  derived: string | null;  // facts the checker computed, e.g. "file holds 9 complete records"
  context: string | null;  // up to 7 lines of annotated disassembly around the location
  claim: string | null;    // the model's own annotation for this record, if any
  manualRef: string;       // manual section to re-read
}
```

Rendering rules:

- **Root cause first, cascades suppressed.** Report the earliest structural failure first. Suppress errors that are consequences of it (for example, dozens of decode errors after a header length mismatch) and state how many were suppressed. Where the format allows safe resynchronization at record boundaries, continue and report independent errors too, up to 12 per report.
- **Show the program as the machine reads it.** Every report includes a bounded annotated disassembly: record index, byte offset, raw bytes, decoded mnemonic and fields, dense value IDs, and the model's `claim`/`note` beside each record. Most malformations become obvious once the model sees its bytes decoded. This lenient diagnostic decoding exists only to write messages, and its output never executes or becomes a candidate.
- **Derived facts are allowed; patches are not.** A diagnostic may state computed facts: "header word 3 declares 10 records; 176 bytes = 32 + 16×9, so 9 complete records are present"; "the next dense value ID in block 0 is 4". It must never contain replacement hex, a corrected record, or a full corrected header. The model writes every byte.
- **Clean checks say so.** A clean check returns `ok: true`, the byte length, SHA-256, the decoded listing, and the annotation cross-check result, so the model can submit with confidence.
- **Bounded and untrusted.** Reports are capped (Section 14.1) and escaped. Any model text echoed back (claims, notes) is labelled as the model's own text.

The rule catalog is tested as a product surface. A **malformation corpus** holds hand-made cases plus real failures harvested from staging loops (stored without prompts), each with a snapshot of the expected diagnostic report. For research, record per-rule **fix rates**: the fraction of diagnostics for a rule that are resolved in the next candidate. Use these to improve message wording, and version the catalog when wording changes.

### 7.8 Privacy

Set `store: false`; do not describe that flag as Zero Data Retention. OpenAI's application-state, abuse-monitoring, and project-specific retention controls are separate considerations. The application discloses that prompts and any repair diagnostics are sent through its Cloudflare-hosted server to OpenAI, and that Cloudflare processes requests as the hosting provider. Runtime inputs are not sent merely because a visitor runs a saved program; sending failing inputs for repair requires the generation/test consent already shown. [O7]

Default server logs (`console.*` in the Worker, Workers Logs / `wrangler tail`) contain identifiers, timings, status, and usage. They never contain prompt bodies, full bytes, or API keys. If Workers observability is enabled in `wrangler.jsonc`, the same redaction rule applies to everything it captures. Local history is user-clearable. Public publishing requires an explicit content/visibility choice.

## 8. Broker protocol and Cloudflare deployment

### 8.1 Endpoints

The `llmtobinary` Worker implements these project-owned endpoints:

| Endpoint | Contract |
|---|---|
| `GET /api/config` | Available model profile labels, spec hash, allowed capabilities, limits, live-generation availability |
| `POST /api/generation-sessions` | Create a bounded owner-scoped session from task, mode, profile, and allowed capabilities |
| `POST /api/generation-sessions/:id/attempts` | Start one idempotent, owner-scoped outer-loop iteration (the first carries no feedback; later ones carry bounded browser test diagnostics), run the inner loop, and stream normalized events until `submit_candidate` or a stop condition |
| `GET /api/generation-sessions/:id/events?after=<seq>` | Owner-only resumption of the event stream after a reconnect; never starts a new turn |
| `POST /api/generation-sessions/:id/cancel` | Cancel active generation and close further automatic loop iterations |
| `GET /api/generation-sessions/:id` | Owner-only recovery of retained attempt metadata; never implicitly restart a request |

Use `fetch` with a streamed POST response in the browser; do not assume `EventSource` can submit the request body. A public anonymous session may use a signed, expiring server-issued identity (HMAC key held as a Wrangler secret), but that is not a sufficient abuse defense by itself. Before public deployment, add per-session, per-IP, and global admission controls, concurrent-request ceilings, origin/CSRF checks, and a durable server budget ledger. Client counters cannot enforce spending.

Every application event has `sessionId`, `attemptId`, and a monotonically increasing sequence. Event classes include:

- Attempt lifecycle: `attempt.started`, `attempt.completed`, `attempt.refused`, `attempt.incomplete`, `attempt.error`, `attempt.cancelled`.
- Model turns: `turn.started`, `model.text.delta`, `model.tool_args.delta`.
- Checks and submissions: `check.requested`, `check.result` (the full diagnostic report), `candidate.submitted`.
- Loop state: `loop.budget` (remaining turns/tokens/spend), `loop.stopped` (with the stop outcome from Section 7.6), and an optional `heartbeat`. Normalize against the actual provider events and retain the original provider status. A completed model response is not a successful guest program.

The Worker owns the model allowlist, prompt version, output schema, maximum budgets, and outbound OpenAI endpoint. Clients cannot submit arbitrary system prompts, provider URLs, tools, model names outside policy, or larger budgets. Feedback from the browser is untrusted data and is not accepted as an attestation of correct execution.

### 8.2 Single Worker: static assets plus API

One Cloudflare Worker named `llmtobinary` serves both the Vite build output and the API, on one origin. There is no separate Pages project and no cross-origin API. [C1, C3]

Minimum `apps/web/wrangler.jsonc` shape (illustrative; versions and dates are pinned by the implementation, not by this document):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "llmtobinary",
  "main": "./worker/index.ts",
  "compatibility_date": "<pinned at implementation time>",
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "durable_objects": {
    "bindings": [
      { "name": "GENERATION_SESSION", "class_name": "GenerationSession" },
      { "name": "BUDGET_LEDGER", "class_name": "BudgetLedger" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["GenerationSession", "BudgetLedger"] }
  ],
  "ratelimits": [
    { "name": "ADMISSION_LIMITER", "namespace_id": "<id>", "simple": { "limit": 10, "period": 60 } }
  ],
  "vars": { "OPENAI_MODEL": "", "LIVE_GENERATION_ENABLED": "false" },
  "observability": { "enabled": true },
  "env": {
    "staging": { "name": "llmtobinary-staging" }
  }
}
```

Requirements:

- `run_worker_first` covers `/api/*` so API requests always reach Worker code. All other paths are served from static assets, with SPA fallback to `index.html`.
- `OPENAI_API_KEY` and the session-signing key are never in `vars`. They are set with `wrangler secret put` per environment. `.dev.vars` is gitignored.
- The rate-limit binding is an admission control only. It is approximate and per-location, and it is not a spending guard. Spending is enforced only by `BudgetLedger`. [C7]
- Deployment environments are `staging` (`llmtobinary-staging`) and production (`llmtobinary`). Each has its own secrets, Durable Object namespaces, and budget ledger.
- The default public URL is `llmtobinary.<account-subdomain>.workers.dev`. A custom domain is optional and configured through `routes`/custom domains when the owner chooses one. It is not a launch dependency.

### 8.3 Durable Objects

**`GenerationSession`** is one instance per session, addressed by `idFromName(sessionId)`. It is the **agentic loop controller** (Section 7.6). It stores attempt metadata, idempotency keys, the event log with sequence numbers (for resumption), every draft and submission with its diagnostics, loop counters, and the visible prompt/feedback history for the disclosed recovery TTL. It serializes turns so there are never parallel turns in a session. It runs the static checker in-process for `check_candidate` calls, which involves no guest execution. It performs the OpenAI streaming requests itself and owns the `AbortController`, so cancellation, client disconnect, and finalization are handled in one place with durable storage available. It uses a Durable Object alarm to purge session content when the recovery TTL expires. [C4]

**`BudgetLedger`** is a single named instance per environment (optionally sharded by day, with a global roll-up). It atomically reserves each request's worst-case token/spend allowance before the upstream call and reconciles actual usage afterward. It records `unknown` usage for interrupted requests and refuses reservations that would exceed session, daily, or global caps. Durable Object single-threaded execution with transactional storage provides the atomicity requirement. Aggregate spend accounting persists independently of session TTLs.

The Worker's fetch handler does routing, origin/CSRF checks, identity verification, and rate-limit admission. It then forwards the request to the session Durable Object and returns its streamed `Response` unchanged.

### 8.4 Streaming, cancellation, and limits

The session Durable Object returns a streamed `Response` built from a `TransformStream` of normalized events (newline-delimited JSON or `text/event-stream` framing, fixed by the protocol package). Waiting on the upstream OpenAI stream is I/O and does not count as Worker CPU time. Configure `limits.cpu_ms` only if measured parsing/normalization CPU requires it. [C6]

Client disconnect and explicit cancellation propagate to the upstream OpenAI request through the Durable Object's `AbortController`. When the downstream stream is cancelled or its writes fail, the Durable Object aborts upstream, marks the attempt `cancelled`, and records final or unknown usage in `BudgetLedger` before releasing the reservation. No detached background generation is required. Do not rely on `ctx.waitUntil` alone for ledger correctness.

Verify streaming and cancellation on the **deployed** staging Worker, not only under `wrangler dev`. Check that events arrive incrementally through Cloudflare's edge (no buffering) and that long reasoning-model generations with sparse deltas survive idle periods. If idle gaps are a problem, the protocol may emit periodic `heartbeat` events. Do not silently switch to a different API mode, background polling, or a non-streaming request to bypass a platform timeout.

### 8.5 Build, local development, and deploy

- **Local development:** `pnpm --filter web dev` runs Vite with `@cloudflare/vite-plugin`, which executes the Worker and Durable Objects in `workerd` locally with bindings from `wrangler.jsonc` and secrets from `.dev.vars`. [C2]
- **Types:** `wrangler types` generates the `Env` interface. CI fails if the generated types are stale.
- **Build:** `pnpm --filter web build` produces the client assets and the Worker bundle.
- **Deploy:** `pnpm --filter web exec wrangler deploy` (production) and `... wrangler deploy --env staging`. Wrangler is a pinned devDependency; do not rely on a globally installed or `npx`-latest Wrangler.
- **CI/CD:** GitHub Actions deploys staging on merge to `main` and production on a tagged release, using `CLOUDFLARE_API_TOKEN` (scoped to Workers edit for the one account) and `CLOUDFLARE_ACCOUNT_ID` as CI secrets. OpenAI secrets are set out-of-band with `wrangler secret put`, never passed through CI logs.
- **Rollback:** use `wrangler rollback` / versioned deployments. Every deployment's version ID and git commit are recorded, and the git commit is exposed in `GET /api/config` as the machine build commit used by manifests (Section 19).

The API is the only required server surface. Browser-local artifacts need no mandatory cloud database. The production budget ledger is the `BudgetLedger` Durable Object (persistent and atomic). Session content has a short, disclosed recovery TTL, while aggregate spend accounting persists independently.

### 8.6 Security headers

Serve a restrictive Content Security Policy and related headers for static assets through a `_headers` file in the Vite `public/` directory (copied into the asset output). The Worker sets matching headers on `/api/*` responses. The CSP allows only same-origin scripts, the same-origin machine Web Worker (`worker-src 'self'`), and same-origin `connect-src` (the browser never contacts OpenAI directly). It forbids `unsafe-eval`. [C8]

The P2 SMT verifier (Section 15.5) is trusted host code compiled to WebAssembly. If it ships, it needs `'wasm-unsafe-eval'` in `script-src`, and it probably needs cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`. Scope those headers to the verifier's route or worker if possible, and never extend them to guest execution. The solver binary must also fit the Workers static-asset per-file size limit, or be loaded from an R2-backed route. Verify both constraints before committing to a solver. [C6, B9]

## 9. Candidate states, authenticity, and errors

The browser stores the exact model response separately from the decoded bytes. A candidate moves through:

```text
check draft (check_candidate) -> diagnostics only; never frozen, never executes
submit_candidate:
streaming -> response-complete -> transport-checked -> frozen
          -> validating -> valid | invalid
valid -> bounded-test-run -> task-passed | task-failed | resource-limited
valid -> selected committed artifact -> visitor execution
```

Tests may execute a **frozen, validated candidate** before it becomes the selected artifact. This corrects the earlier ambiguity about testing only "committed" files. Mutable buffers and streaming prefixes never execute. A task-failing but structurally valid program remains inspectable and may be run explicitly; the UI keeps its failure status.

JSON parsing must be size-bounded and verify the exact allowed keys/types. Literal hex allows ASCII hex digits and the explicitly permitted whitespace characters: space, tab, CR, and LF. Strip only these characters, require an even nonzero digit count, and reject everything else. No `0x` prefixes, prose stripping, auto-padding, label resolution, default headers, checksum repair, or count fixing is permitted. A contiguous hex string is canonical in the JSON profile; exported `.hex` may be formatted for readability.

Copy bytes into private owned storage before validation. The validator/runtime must not accept a mutable caller-owned buffer after the check. Hashes shown for validation, tests, execution, export, and comparison refer to the same byte sequence. Transfer copies to workers, not the sole canonical buffer: ArrayBuffer transfers detach the sender's buffer. [B4]

Error classes must include:

- Provider/transport: `API_ERROR`, `REFUSAL`, `INCOMPLETE_RESPONSE`, `TRANSPORT_INVALID`, `CANCELLED`.
- Binary: `BAD_HEADER`, `LENGTH_MISMATCH`, `UNKNOWN_OPCODE`, `BAD_RECORD_GRAMMAR`, `INVALID_ID`, `TYPE_MISMATCH`, `CAPABILITY_NOT_DECLARED`.
- Runtime: `DIVIDE_BY_ZERO`, `BOUNDS`, `INVALID_HANDLE`, `CAPABILITY_DENIED`, `RESOURCE_EXHAUSTED`, `FUEL_EXHAUSTED`.
- Task: `WRONG_RESULT`, `WRONG_EFFECTS`, `SIGNATURE_MISMATCH`, `PRESSURE_STRUCTURE_MISMATCH`.
- Annotation/contract: `ANNOTATION_INVALID` (bad schema, unknown record index, unparsable claim or contract), `ANNOTATION_MISMATCH` (claim disagrees with decoded bytes), `EXAMPLE_FAILED`, `CONTRACT_VIOLATED` (runtime check failed, with the inputs and observed values), `CONTRACT_REFUTED` (P2 solver counterexample), `CONTRACT_UNPROVEN` (P2 timeout/unknown; a warning, not a failure).
- Loop: `LOOP_BUDGET_EXHAUSTED`, `LOOP_STALLED`, `CONTEXT_BUDGET_EXHAUSTED`.

Diagnostics follow the model-facing format in Section 7.7: rule ID, byte offset and function/block/record where known, found/expected/derived information, annotated disassembly context, and an explicit category. Validation never claims to prove the natural-language task. Arbitrary visitor tasks without an oracle are labelled **"executed; intent not independently verified."**

## 10. ANMA-1 file format

This section is normative and preserves the previously supplied bytes.

### 10.1 Header and records

All numeric words are unsigned 32-bit little-endian. A file contains a 32-byte header, `recordCount` 16-byte records, then exactly `dataBytes` read-only bytes.

| Header word | Meaning |
|---|---|
| 0 | Magic bytes `41 4e 4d 41` (`ANMA`) |
| 1 | Version, exactly `1` |
| 2 | Requested feature/capability bitmask |
| 3 | Record count, including declarations and argument metadata |
| 4 | Read-only data byte count |
| 5 | Entry function ID |
| 6, 7 | Reserved, both zero |

The file length must equal `32 + 16 * recordCount + dataBytes`. Check quotas and arithmetic before allocating or traversing counts. Reject trailing bytes and unknown version/feature bits. Capabilities are bit 0 typed heap, bit 1 terminal, bit 2 framebuffer, and bit 3 event input. An opcode requiring a feature must have it declared; host policy separately grants or denies the declaration.

A record is `[opcode, a, b, c]`. Unused fields must be zero. Numeric IDs are 32-bit, but validation and runtime quotas impose much smaller supported limits. They are not an unlimited physical resource.

### 10.2 Types and declarations

Type tags: `0 unit`, `1 u64`, `2 bool`, `3 handle<u8>`, `4 handle<u64>`. Unit is valid only as a function/host return type; it has no value payload or parameter.

| Opcode | Record fields a, b, c |
|---|---|
| `0x01 FUNC` | function ID, parameter count, return type |
| `0x02 BLOCK` | block ID, parameter count, local value count |
| `0x03 PARAM` | value ID, type tag, parameter index |
| `0x04 END_FUNC` | 0, 0, 0 |

Function IDs and each function's block IDs are dense in declaration order. Every function starts at block 0. Its entry block has parameters matching the function's parameter count and defines their types. Other block signatures come from their own PARAM records.

A block begins with exactly its declared PARAM records, in parameter-index order. Parameter IDs are `0..p-1`; each later producing operation defines the next dense ID. `localValueCount` equals the parameter and result definitions in that block. Source values must already be defined in the same block. There is no direct reference into another block or activation.

Each block has exactly one final terminator. A function's last block is followed by END_FUNC. Functions do not nest. There is no implicit fall-through. Argument metadata belongs to the immediately preceding owner instruction and cannot be jumped into or executed independently.

### 10.3 Arithmetic

| Opcode | Record fields a, b, c |
|---|---|
| `0x10 CONST_U64` | destination, low 32 bits, high 32 bits |
| `0x11 CONST_BOOL` | destination, 0-or-1, 0 |
| `0x20 ADD_U64` | destination, left, right |
| `0x21 SUB_U64` | destination, left, right |
| `0x22 MUL_U64` | destination, left, right |
| `0x23 UDIV_U64` | destination, left, right |
| `0x24 UREM_U64` | destination, left, right |
| `0x25 AND_U64` | destination, left, right |
| `0x26 OR_U64` | destination, left, right |
| `0x27 XOR_U64` | destination, left, right |
| `0x28 SHL_U64` | destination, value, count |
| `0x29 SHR_U64` | destination, value, count |
| `0x2a ROTL_U64` | destination, value, count |
| `0x2b ROTR_U64` | destination, value, count |
| `0x30 EQ_U64` | bool destination, left, right |
| `0x31 LT_U64` | bool destination, left, right |
| `0x32 LE_U64` | bool destination, left, right |
| `0x33 NOT_BOOL` | bool destination, bool operand, 0 |
| `0x34 BOOL_TO_U64` | u64 destination, bool operand, 0 |
| `0x35 U64_NONZERO` | bool destination, u64 operand, 0 |

A u64 is always in `0..2^64-1`. Constants combine the two immediate words; addition, subtraction, multiplication, and bitwise results wrap modulo `2^64`. Division/remainder by zero trap. Shift and rotate counts use the low six bits; rotate by zero is the identity. Comparisons are unsigned. No implicit bool/integer conversion exists.

Implement numeric operations with `bigint`; for modular results use `BigInt.asUintN(64, value)`. Never pass arbitrary guest u64s through JavaScript `number`. Bounded indexes, IDs, and lengths may use `number` after range checking. [B3]

### 10.4 Control, calls, and arguments

| Opcode | Record fields a, b, c |
|---|---|
| `0x40 JUMP` | target block, argument count, 0 |
| `0x41 BR_IF` | bool condition, true block, false block |
| `0x42 CALL` | destination, function ID, argument count |
| `0x43 RETURN` | source value ID, 0, 0 |
| `0x44 ARG` | source value ID, 0, 0 |
| `0x45 EDGE_ARGS` | argument count, 0, 0 |

JUMP and CALL are immediately followed by exactly their argument count of ARG records. BR_IF is followed by EDGE_ARGS and ARG records for the true edge, then EDGE_ARGS and ARG records for the false edge. Both signatures must validate; only the selected edge is transferred at runtime. CALL is not a block terminator. JUMP, BR_IF, and RETURN are terminators.

Use `0xffffffff` for a unit-returning CALL/HOST destination and a unit-returning function's RETURN source. This sentinel is not a logical value ID. A non-unit CALL defines a dense destination with the callee's return type. The callee's parameters must match the supplied arguments exactly; recursive and mutually recursive calls are allowed.

The loader builds function/block lookup indexes but does not rewrite the bytes. Calling and argument placement are defined by these records, not by register conventions.

### 10.5 Heap memory and host calls

| Opcode | Record fields a, b, c |
|---|---|
| `0x50 ALLOC_U64` | destination handle, count-value ID, 0 |
| `0x51 LOAD_U64` | destination, handle-value ID, index-value ID |
| `0x52 STORE_U64` | handle-value ID, index-value ID, source-value ID |
| `0x53 ALLOC_U8` | destination handle, count-value ID, 0 |
| `0x54 LOAD_U8` | u64 destination, handle-value ID, index-value ID |
| `0x55 STORE_U8` | handle-value ID, index-value ID, u64 source-value ID |
| `0x60 HOST` | destination or unit sentinel, import ID, argument count |

HOST is followed by its ARG records and is not a terminator. Validate the import ID, types, count, destination, and declared feature. A host operation cannot resolve a URL or arbitrary JavaScript property supplied by the model.

Heap allocations are zero-initialized, typed, and owned by one run. Counts and indexes are checked as u64 before conversion. Loading/storing outside the allocation traps. u8 stores outside `0..255` trap rather than truncate. A zero-length allocation is valid but has no valid element index. Cap allocation count as well as payload bytes so repeated empty allocations cannot exhaust metadata.

No integer-to-handle cast, raw host address, manual free, code mutation, or guest networking is defined. Aliases are allowed through ordinary handle values and function parameters. Reset releases the run arena. Guest heap storage is separate from automatic logical-value backing storage and must be reported separately.

## 11. Execution and dynamic identity

Execute a block in record order. Effects, traps, and calls occur in that order. The main engine must not constant-fold, rematerialize, fuse, reorder, or dead-code-eliminate guest instructions. Reclaiming an executed result with no future uses is allowed; skipping the producing instruction is not.

A runtime value's identity is `(functionActivation, blockActivation, localValueId)`. Every loop iteration creates a new block activation; recursive calls create new function activations. Static IDs must not alias still-live values in earlier activations.

Branches bind destination parameters simultaneously. Stage all selected arguments in accounted storage before releasing the old block. Calls suspend the caller using an explicit VM frame stack, not JavaScript recursion. The call destination is reserved but not readable until return. Surviving caller values continue to occupy the machine's shared store while the callee executes.

Operand consumption counts repeated uses correctly: `mul v0 v0` consumes two occurrences. Branch metadata may conservatively keep values until block exit; the untaken edge never performs effects. Reclaim the exited block and untaken-edge-only values then. A RETURN transfers its result before releasing the callee frame. Frame and activation identities must not be reused in a way that produces stale references.

Inputs to the public entry function are u64 or bool values, matched exactly to its declared signature. Do not let users fabricate internal handles in JSON. Export u64 values as canonical decimal strings; reject negative, fractional, or overflowing inputs rather than silently wrapping them. This is distinct from arithmetic overflow inside the machine.

## 12. Finite storage model

### 12.1 Count the actual modeled structures

The resource engine has F fast-value slots, bounded backing memory, a logical-value directory, operand latches A/B, result latch R, bounded frame/argument-staging memory, a run heap, and device buffers. F defaults to 16, with comparison choices 4/8/16/32/64. F=1 is a required engineering edge test, **not** a computer with only one storage location.

One slot holds one 64-bit payload. Bool is represented canonically as 0/1, and handles as opaque bounded tokens with separately validated type/allocation metadata. These still occupy slots. The implementation must report metadata, heap, frame, and device budgets rather than hiding them in the fast-slot number.

A persistent logical-value payload has an authoritative home in a fast slot or backing entry. Metadata records location, type, readiness, and usage information; it is not another unlimited payload cache. Temporary copies in A/B/R or an explicitly accounted argument/return buffer are permitted. An evicted constant is reloaded like another value, not silently regenerated from its defining instruction.

### 12.2 Instruction microsteps

For a binary arithmetic instruction:

1. Resolve the first operand through the value directory; on a miss, bring it from backing and copy it into A.
2. Resolve the second operand similarly into B. Evicting the first operand's fast copy is safe because A is an explicit latch.
3. Compute into R using the specified arithmetic.
4. Publish the new result into the store, evicting a live resident if needed.
5. Consume the operand occurrences, reclaim dead persistent values, and clear transient state.

The FIFO policy chooses the longest-resident eligible slot; hits do not promote it. Empty/reclaimed slots are reused in lowest-index order. A backing load takes a declared path, not an unlimited-map shortcut. If a live resident must move out, save its payload before replacing its slot. When F=1 and backing is full, a bounded exchange using the declared transient storage may reuse the loaded operand's backing entry; otherwise report the actual resource failure. Do not invent an uncharged scratch array.

A store with three operands may use A/B/R as operand latches. Calls and host instructions with multiple arguments stage them sequentially into bounded argument storage. Guest operations must make progress with F=1 plus the declared latches and sufficient other resources. Tests must cover source/result aliasing in physical storage, duplicate logical operands, last-use reclamation, calls, and returns.

### 12.3 Implementation prohibition

Do not compute by reading all guest values from `Map<ValueId, bigint>` and animate an unrelated cache. Every semantic operand read in the constrained runtime must use the modeled storage path. The independent reference interpreter may use an unbounded logical map within its own safety limits, but the constrained interpreter must not call it to obtain operands or answers.

Debugger peeks and trace copies are diagnostic, cannot become runtime sources, and do not alter modeled counters. Checkpoints contain the full accounted state and configuration; their storage is separately bounded. Host JavaScript allocation and garbage-collection overhead differ from modeled memory and must not be presented as physical chip measurements.

### 12.4 Counters and guarantees

Track executed guest instructions, argument/record decode work, microsteps, operand hits/misses, backing reads/writes and bytes, evictions, reclaimed values, peak live values, peak occupied storage, and host wall time. A static guest instruction count is not an executed count. One guest operation can incur many storage/device microsteps.

No simulated cycle number is a measured CPU cycle. An optional synthetic cost model is versioned and labelled "modeled ticks." Do not report simulated GHz, power, or native speedup.

When resources are insufficient, stop with a resource status and an exact prefix of effects already performed. Never fall back to unlimited storage. The cross-capacity invariant applies only to runs that complete under their declared resources and identical inputs.

## 13. Virtual peripherals

| Import | Signature | Feature |
|---|---|---|
| 0 | `terminal.print_u64(u64) -> unit` | terminal |
| 1 | `terminal.print_utf8(dataOffset:u64, byteLength:u64) -> unit` | terminal |
| 2 | `display.clear(rgba:u64) -> unit` | framebuffer |
| 3 | `display.pixel(x:u64, y:u64, rgba:u64) -> unit` | framebuffer |
| 4 | `display.present() -> unit` | framebuffer |
| 5 | `input.key_down(keyId:u64) -> bool` | event input |
| 6 | `input.wait_tick() -> u64` | event input |

`print_u64` appends the unsigned decimal digits with no implicit newline. The output log may separately show each host-call event. `print_utf8` reads the bounded read-only data section, not guest heap or host memory, and uses strict UTF-8 decoding. Newlines are explicit data. Text never becomes HTML.

The framebuffer is 256×144 RGBA pixels. Colour is `0xRRGGBBAA` in the low 32 bits; higher bits must be zero. Coordinate errors trap. `clear` and `pixel` update the authoritative machine buffer; `present` publishes a bounded copy. Initial pixels are transparent black. Charge full-buffer operations to work quotas. The renderer may skip visual refreshes when the UI is slow, but cannot change the guest framebuffer/effect log.

The input registry is fixed: 0 Left, 1 Right, 2 Up, 3 Down, 4 Space, 5 Enter, 6 Escape. Unknown IDs trap. A virtual tick event contains a strictly increasing u64 tick number and a complete key-state mask. `wait_tick` consumes one event and latches that mask; without an event it waits without burning instruction fuel. `key_down` reads the most recently latched mask, initially empty. Browser events update the pending next-tick mask, not the guest state halfway through a tick. Recorded events, not wall-clock timing, define replay.

Host calls are small device operations. The host cannot provide `runFizzBuzz`, `solveKernel`, `drawGame`, arbitrary file access, `fetch`, JavaScript evaluation, or DOM access. Algorithms, animation state, collision tests, and pixel decisions must be performed by guest instructions.

## 14. Worker, safety, and responsiveness

This section concerns the **browser machine Web Worker**, not the Cloudflare Worker.

Use a trusted static module worker built from TypeScript. Workers separate execution from the UI thread, but a worker can possess network APIs; the security boundary is the restricted VM, checked memory, and capability allowlist—not the word "worker." [B2]

Execute bounded microstep chunks and yield to the worker event loop. Instructions whose metadata/device work is large must be resumable or independently budgeted; do not hide an unbounded operation inside one "step." Pause must work during computation, argument staging, and input waiting. Stop has a cooperative path and a main-thread hard-termination fallback, followed by a fresh worker. Late events carry a run ID and cannot update a newer run.

The runtime state machine is `empty`, `validating`, `ready`, `running`, `paused`, `waiting-input`, `halted`, `trapped`, or `cancelled`. Changing F resets the machine and reruns the same immutable artifact; live cache migration is deferred. Stepping defaults to guest instructions, with advanced microstep inspection. Backward inspection uses recorded state/replay, never an invented history.

No `eval`, `new Function`, dynamic import from guest strings, guest-to-JavaScript code generation, guest Wasm execution, native addon, or WebGPU kernel execution is allowed. Neither OpenAI credentials nor browser cookies are exposed to the VM. Serve a restrictive CSP (Section 8.6) for trusted static scripts/workers and same-origin API access. Escape terminal and diagnostic text. A published/imported executable starts stopped and requires explicit permission before execution.

### 14.1 Starting resource profiles

These are safeguards to validate and tune, not performance promises.

| Resource | Public default |
|---|---:|
| Imported executable | 1 MiB |
| Live-generation candidate | 64 KiB binary, additionally bounded by output-token budget |
| Model-response text buffer | 256 KiB UTF-8 |
| Values per block | 65,536 |
| Parameters per function/block | 256 |
| Active function frames | 256 |
| Active logical values | 262,144 |
| Backing payload | 32 MiB |
| Heap payload | 16 MiB |
| Frame/argument-staging payload | 4 MiB |
| Modeled metadata | 32 MiB |
| Heap allocations | 65,536 |
| Executed guest instructions | 5,000,000 |
| Internal microsteps | 50,000,000 |
| Cumulative terminal output | 1 MiB |
| Detailed trace ring | 10,000 events |
| Input event queue | 4,096 events |
| Annotation sidecar (UTF-8 JSON) | 128 KiB |
| Record claims / notes | one per record; 512 bytes each |
| Contract/invariant expression | 4 KiB each, AST depth 64 |
| Model examples per candidate | 32 |
| Diagnostic report returned to the model | 24 KiB, ≤ 12 reported errors |
| Runtime contract evaluation | charged to the run's fuel; separate cap of 1,000,000 contract steps |
| SMT query (P2) | 10 s wall-clock and bounded memory per verification condition |

Cap validation work, encoded declarations, checkpoints, snapshots, response events, and export size too. Each limit is enforced independently. Bounds checks precede allocations and copies. Trace saturation may discard oldest detail while maintaining counters and a truncation flag; terminal or semantic resource limits must produce an explicit outcome rather than silently dropping guest output.

Interactive execution can use bounded successive slices with a visible cumulative ceiling; no automatic unlimited fuel renewal. Renderer speed does not determine semantics. Timeout outcomes and instruction-fuel outcomes are recorded separately.

Server-side, the Cloudflare Worker enforces the 256 KiB model-response buffer and the event/body size caps independently of the browser. It must never buffer an unbounded upstream response in Durable Object memory or storage.

## 14A. Chip view and the declared cost model

The chip view (`/chip`) shows a **modeled floorplan** of an ANMA-1 machine: instruction memory, fetch and decode, the value directory, fast slots, A/B/R latches, the ALU, backing SRAM, argument staging, the call stack, the typed heap, and the I/O bus with the terminal, framebuffer and input devices. It exists so a viewer can see where values live while a program runs. It is not a hardware design, a netlist, or a timing claim.

**Honesty rules (must):**

1. Every light, packet and analyzer bar corresponds to one **micro-event** the engine actually executed. Events come from an optional `onEvent` listener on the same engines the machine panel uses (the fifo-v1 finite machine and the ANMR-1 stepping machine). Nothing in the view re-implements execution. Tests prove that attaching the listener never changes counters or results.
2. The die shows state **rebuilt only by replaying those events in order**. The worker runs ahead of the animation, so its snapshot is in the future. Tests prove the replayed state equals the engine's slots, payloads and backing occupancy after every instruction, at F = 1, 4, 8 and 64, and for ANMR-1.
3. The animation clock never passes the last buffered event.
4. Time is shown in **modeled ticks** from the declared cost model `anma-cost/1`, never as "cycles":
   - fetch + decode 2;
   - fast-slot read 1 and write 1;
   - backing read 4 and write 4;
   - ALU 1, except multiply 3 and divide or remainder 20;
   - staging 1 per value;
   - branch 1, call 2, return 2;
   - heap alloc 2 and access 4;
   - host call 4 plus device work.

   The page states that these latencies are declared, not measured.
5. Amber marks datapath events. A distinct cool colour and a distinct shape (a diamond, not a circle) mark **only** backing and spill traffic, so the cost of limited fast storage is visible without relying on colour alone.

**Modes:**

- **Event clock:** 4, 12, 40 or 120 ticks per second, with step-instruction, step-microstep and reset, and a logic-analyzer strip with one lane per unit over a 120-tick window.
- **Heat:** 2k or 50k instructions per second. Units glow by their share of executed microsteps; per-event traces pause. On return to the event clock, the view resynchronises from the engine's own reported state.

**Compare:** available for the forty-value capstone only. It shows ANMA-1 at F fast slots next to the ANMR-1 register control at R ∈ {4, 8, 16, 32}, on one clock with the same input. The left die shows storage traffic placed by the hardware; the right die shows SAVE/RESTORE traffic the model wrote. Both must return the same value.

**Other controls:**

- Deep links: `?fixture=`, `?sha=` (a locally stored artifact), `&F=`, `&x=`, `&compare=1&R=`.
- **Export trace** writes the executed events together with the cost-model id and the program hash.
- Keyboard: Space plays or pauses, → steps one instruction, `.` steps one microstep, R resets.
- Under reduced motion, travelling packets and glow decay are omitted; every state change stays visible.

The chip view uses the Worker isolation, fuel and limits of Section 14. It runs in its own machine-worker instance.

## 15. Independent validation, annotations, and correctness

### 15.1 Validator

The validator checks header/version/length, resource limits, declaration grammar, all opcode fields, dense IDs, definition-before-use, exact types, block and function signatures, terminators, argument framing, import signatures, and declared capabilities. It may build indexes and usage metadata. It must not repair bytes, select physical locations, introduce spill instructions, optimize arithmetic, or use a model-supplied validity flag. It is the same code in the Worker's `check_candidate` tool and in the browser's independent validation. The browser result is the one that gates execution.

### 15.2 Reference interpreter and task oracles

The reference interpreter is a separate execution loop with straightforward logical values. It does not invoke the resource interpreter with a large F and call that independence. Sharing a binary reader is acceptable, but then fixed byte fixtures, malformed inputs, and a separate decoding cross-check must cover common parser mistakes.

For each curated task, separate the **task oracle** from both interpreters. Agreement between two engines on a wrong program is not task correctness. Use arithmetic boundary cases and multiple inputs rather than only a displayed golden number. Curated test data must not include provider/model credentials or other private information.

The task registry fixes task ID/version, entry signature, permitted features, semantic contract, visible tests, holdout tests, input distribution/seed, effect expectations, and any structural pressure requirement. The model cannot redefine its own grading function. New open-ended visitor tasks are not silently turned into "verified" programs using a model-generated oracle. Pure (device-free, heap-free) curated tasks also carry a **reference contract** in the contract language of Section 15.4, written by the task author. For example, square-plus-two's contract is `(eq result (add (mul n n) 2))`, and the capstone's is a closed-form fold expression. This enables the strongest claim in Section 15.5.

### 15.3 Annotations: sidecar comments bound to the bytes

A candidate may carry an `annotations` sidecar (schema in Section 7.2). Annotations make the program legible to people, help the model think about what each record should be, and give the checker something to hold the bytes to. They are **checked, never trusted, and never a source of bytes**. The executable is exactly the decoded `hex`, and a candidate with perfect annotations and wrong bytes fails.

Annotations are a sidecar rather than an in-binary section. This keeps the ANMA-1 format, the fixture bytes, and the executable hash unchanged. An in-binary annotation section (a new feature bit) is deferred. The manifest binds the sidecar to the artifact by recording both hashes (Section 19).

| Field | Meaning | Checked how |
|---|---|---|
| `summary` | Free-text description of the program | Not checked. Displayed as "model's comment". |
| `params` | Names for function parameters, used in contracts and the inspector | Index must exist; names must be unique identifiers. Static. |
| `records[].note` | Free-text comment for one record | Not checked. Displayed beside the record in the inspector and in diagnostic listings. |
| `records[].claim` | A formal statement of what one record decodes to | **Exact static cross-check** against the decoded record (T1) |
| `contracts[]` | `requires`/`ensures` per function | Runtime-checked (T2); provable in P2 (T3) |
| `invariants[]` | A predicate that must hold on every entry to a block | Runtime-checked (T2); required as loop cut-points for P2 proofs (T3) |
| `examples[]` | The model's own input → result/terminal claims | Executed as extra tests (T2); labelled model-claimed |

**Record claim grammar.** A claim is an s-expression naming the mnemonic and fields exactly as the manual's opcode tables define them:

```text
(MUL_U64 v1 v0 v0)      (CONST_U64 v2 2)          (ADD_U64 v3 v1 v2)
(HOST _ terminal.print_u64 1)   (ARG v3)          (RETURN v3)
(BR_IF v5 block1 block2)        (EDGE_ARGS 1)     (FUNC fn0 1 u64)
```

`vN` is a block-local value ID, `blockN` and `fnN` are declaration IDs, `_` is the unit sentinel `0xffffffff`, imports are named by their Section 13 names, type tags by their names, and constants are full 64-bit decimal values. The checker decodes the record and compares every field. A mismatch produces `ANNOTATION_MISMATCH` with both readings side by side ("record 5 is claimed as `(ADD_U64 v3 v1 v2)` but its opcode byte is `0x21`, which is SUB_U64"). This targets the most common failure: the model knows what it meant but wrote the wrong byte. The comparison runs only in the direction bytes → decoded → compare. Nothing turns a claim into bytes, and CI enforces this (Section 6.1).

### 15.4 Contract language and runtime checking (T2)

Contracts and invariants use **ANMA-Spec**, a small, total-where-possible expression language whose operators have exactly the ISA's semantics (Section 10.3):

```text
expr  := u64-literal | true | false | name | result
       | (add e e) | (sub e e) | (mul e e) | (udiv e e) | (urem e e)
       | (band e e) | (bor e e) | (bxor e e)
       | (shl e e) | (shr e e) | (rotl e e) | (rotr e e)
       | (eq e e) | (ne e e) | (lt e e) | (le e e) | (gt e e) | (ge e e)
       | (not e) | (and e e) | (or e e) | (implies e e)
       | (ite e e e)
name  := a declared parameter name, argN (function argument N at activation entry),
         or bpN (block parameter N; invariants only)
```

- u64 arithmetic is modulo 2^64 and comparisons are unsigned. Expressions are typed (u64 vs bool) with no implicit conversion. `result` is available only in `ensures` of non-unit functions. Division or remainder by zero inside a contract is a contract evaluation error, reported as a diagnostic and never treated as true.
- v1 has no quantifiers, no heap access, and no device state in contracts. These are deferred.
- The parser is a real grammar parser with bounded size and depth (Section 14.1). It is shared by the checker, the runtime checker, and the P2 verifier.

**Runtime checking** runs in the reference interpreter in the browser, never in the finite-resource runtime, so that modeled storage counters are unaffected:

- `requires` is checked at every activation of the function.
- `ensures` is checked at every RETURN.
- Invariants are checked at every activation of their block.
- `examples` are run as additional test cases.

A failure produces `CONTRACT_VIOLATED` or `EXAMPLE_FAILED` with the inputs, the activation path, and the concrete values of every name in the failing expression. That report feeds the next loop iteration. If a public-entry `requires` fails on a task test input, the diagnostic says so explicitly: the model's precondition excludes an input the task requires.

A passing T2 result is labelled **"contracts held on N executions"**. It is evidence, not proof.

### 15.5 Verification tiers and formal proof

| Tier | What is established | Where | Release |
|---|---|---|---|
| T0 | Nothing. Comments are displayed as the model's words. | Inspector | P0 |
| T1 | Each claimed record decodes exactly as claimed | `check_candidate` (server) + browser | P0 |
| T2 | Contracts, invariants, and examples held on every executed test | Browser reference interpreter | P1 |
| T3 | Contract proved for **all** inputs (partial correctness) | Browser verifier worker | P2 |

**T3 proof (P2).** For a function that satisfies all of the following:

- it uses no heap,
- its only host calls are unit-returning effects (treated as no-ops for value reasoning),
- every call targets a function with a contract (proved modularly),
- every loop is cut by an invariant on its header block,

`packages/verify` generates verification conditions over 64-bit bit-vectors (SMT-LIB `QF_BV`) by weakest-precondition over the typed block graph. A trusted SMT solver compiled to WebAssembly discharges them in a dedicated browser worker.

Outcomes:

- `proved`.
- `refuted`: the counterexample becomes a concrete test input, is re-run through T2 to confirm it, and is returned to the model as a `CONTRACT_REFUTED` diagnostic.
- `unknown`/`timeout`: `CONTRACT_UNPROVEN`, a warning.

Termination is not proved. Every T3 claim is partial correctness, and the UI says so.

**What a proof means depends on whose contract it is.**

- Proving the **model's own** contract shows that the bytes do what the model said they do. The label is "proved against the model's stated contract". This does not show the model understood the task.
- Proving the **task registry's reference contract** (Section 15.2) is the strongest statement the product makes: **"proved to meet the task specification for all inputs (partial correctness)"**.

The two labels must never be conflated.

**Trust and cross-checks.** The trusted computing base for T3 is the contract parser, the VC generator, and the solver. They are kept independent of the finite-resource runtime. Every `proved` result is also cross-checked with T2 on the task's holdout inputs plus seeded random inputs. A T3 `proved` alongside a T2 failure is treated as a verifier bug: the proof label is withdrawn and the event is reported. The verifier never modifies bytes and never feeds an "expected" program back to the model.

## 16. Required examples and fixtures

The application ships these exercises. Each has a plain-language task, expected interface, independently authored fixture, visible tests, and provenance.

| Exercise | Purpose |
|---|---|
| Return 42 | Minimal header/record/arithmetic conformance |
| `n*n + 2`, print and return | Runtime input binding, u64 overflow, terminal effects |
| Hello text | Data-section bounds and UTF-8 output |
| FizzBuzz 1..N | Branches, loops, integer/remainder semantics, exact text |
| Recursive Fibonacci | Calls, return values, activation identity, bounded recursion |
| Pixel checkerboard | Guest-driven graphics and loop execution |
| Moving ball / keyboard paddle | Deterministic ticks, memory/state, pixel effects |
| Exact upstream capstone | Forty-live-value storage exercise |
| Upstream ring mix | In-place sequential updates across 1,000 iterations; research fixture initially |

Fibonacci inputs and test execution budgets must be sensible for a recursive implementation; an exponential fixture exceeding fuel is not silently rewritten. Host calls may not perform any of these algorithms for the guest.

The bundle includes three checked byte fixtures. Their verification status concerns encoding and a limited semantic checker, not a completed browser runtime or actual OpenAI generation:

| File | Bytes | SHA-256 |
|---|---:|---|
| `return-42.anma` | 144 | `cb05d607bc9708d41340eb0eadfb80dca4dc8153f23e51af319ad3a6a01e1bd8` |
| `square-plus-two.anma` | 192 | `d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1` |
| `upstream-capstone-40.anma` | 2704 | `d6e710f149bac62226ad57f9d3a2f4e4bf958cebbf3727994f0ec5477013e88a` |

The capstone fixture is independently encoded ANMA code for the upstream mathematical workload, not a redistributed Mach-O binary. Its manifest labels it a specification/tool-created fixture. No fixture is presented as a captured OpenAI response. Fixtures ship as static assets of the `llmtobinary` Worker, so fixture playback works with live generation disabled.

## 17. Exact user prompt and model output example

With the bundled arithmetic manual, the user task is:

```text
Create one function with a u64 input n and a u64 return value.
Compute n*n + 2 modulo 2^64, using multiplication and addition.
Print that value exactly once with terminal.print_u64 and return it.
The input arrives at runtime; do not hard-code answers for example inputs.
Return one complete ANMA-1 executable in the required JSON envelope.
```

One valid model-output shape is `{"isa":"ANMA-1","hex":"<literal hex digits>"}`. The angle-bracket placeholder here is explanatory and must never appear in a real accepted response. The exact 192-byte program's transport payload is provided in `fixtures/square-plus-two.response.json`.

Its raw bytes are:

```text
41 4e 4d 41 01 00 00 00 02 00 00 00 0a 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
01 00 00 00 00 00 00 00 01 00 00 00 01 00 00 00
02 00 00 00 00 00 00 00 01 00 00 00 04 00 00 00
03 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00
22 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00
10 00 00 00 02 00 00 00 02 00 00 00 00 00 00 00
20 00 00 00 03 00 00 00 01 00 00 00 02 00 00 00
60 00 00 00 ff ff ff ff 00 00 00 00 01 00 00 00
44 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00
43 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00
04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

The decoded computation is `v0=parameter(0); v1=v0*v0; v2=2; v3=v1+v2; print(v3); return(v3)`. Input 12 produces digits `146` and return value `146`; input `4294967296` produces `2`. No new bytes are needed when input changes.

This example demonstrates the encoding and runtime parameter interface. It is too small to establish the forty-value pressure result and is not a prediction that every API call returns identical bytes.

### 17.1 The same program as an annotated submission

The `submit_candidate` arguments for the same 192 bytes, with annotations. The bytes and SHA-256 (`d3f7f9e0…05c1`) are identical to the unannotated fixture:

```json
{
  "isa": "ANMA-1",
  "hex": "414e4d4101000000020000000a0000000000000000000000000000000000000001000000000000000100000001000000020000000000000001000000040000000300000000000000010000000000000022000000010000000000000000000000100000000200000002000000000000002000000003000000010000000200000060000000ffffffff0000000001000000440000000300000000000000000000004300000003000000000000000000000004000000000000000000000000000000",
  "annotations": {
    "summary": "Returns n*n + 2 (mod 2^64) and prints it once.",
    "params": [{ "function": 0, "index": 0, "name": "n" }],
    "records": [
      { "index": 0, "claim": "(FUNC fn0 1 u64)",              "note": "entry function, one u64 param" },
      { "index": 1, "claim": "(BLOCK block0 1 4)",            "note": "v0..v3" },
      { "index": 2, "claim": "(PARAM v0 u64 0)",              "note": "n" },
      { "index": 3, "claim": "(MUL_U64 v1 v0 v0)",            "note": "n*n" },
      { "index": 4, "claim": "(CONST_U64 v2 2)",              "note": null },
      { "index": 5, "claim": "(ADD_U64 v3 v1 v2)",            "note": "n*n + 2" },
      { "index": 6, "claim": "(HOST _ terminal.print_u64 1)", "note": "print once" },
      { "index": 7, "claim": "(ARG v3)",                      "note": null },
      { "index": 8, "claim": "(RETURN v3)",                   "note": null },
      { "index": 9, "claim": "(END_FUNC)",                    "note": null }
    ],
    "contracts": [
      { "function": 0, "requires": null, "ensures": "(eq result (add (mul n n) 2))" }
    ],
    "invariants": [],
    "examples": [
      { "inputs": ["12"],         "result": "146", "terminal": "146" },
      { "inputs": ["4294967296"], "result": "2",   "terminal": "2" }
    ]
  }
}
```

In this case the model's `ensures` is identical to the task's reference contract, so a P2 proof of it carries the task-level label. T1 passes (every claim matches its record), T2 passes (both examples and all task tests), and T3 is a single straight-line bit-vector query.

### 17.2 A malformed draft and the diagnostic the model receives

A typical first draft forgets the ARG record after HOST (deleting bytes 144–159) but keeps the header's record count of 10. The result is 176 bytes, SHA-256 `402eb506…cce6`. `check_candidate` returns this report. It is the checker's actual output for that input, captured from `packages/check` and reproduced by its tests; only the listing is abridged here:

```json
{
  "ok": false,
  "byteLength": 176,
  "sha256": "402eb506b64f8dda3e5a9e6397abf73b8c8bad060b9e890643dee3443bb8cce6",
  "errors": [
    {
      "rule": "ANMA-V-HDR-004",
      "severity": "error",
      "category": "LENGTH_MISMATCH",
      "message": "File length does not match the header.",
      "location": {
        "byteOffset": 12,
        "recordIndex": null,
        "field": "header.word3",
        "functionId": null,
        "blockId": null
      },
      "found": "176 bytes; header word 3 (record count) = 10, word 4 (data bytes) = 0",
      "expected": "length = 32 + 16 * recordCount + dataBytes",
      "derived": "10 records need 192 bytes. 176 = 32 + 16*9, so the file holds 9 complete records: either one record is missing or the header count is wrong.",
      "context": null,
      "claim": null,
      "manualRef": "§10.1"
    },
    {
      "rule": "ANMA-V-ARG-001",
      "severity": "error",
      "category": "BAD_RECORD_GRAMMAR",
      "message": "HOST declares 1 argument but is not followed by 1 ARG record.",
      "location": {
        "byteOffset": 144,
        "recordIndex": 7,
        "field": "record.opcode",
        "functionId": 0,
        "blockId": 0
      },
      "found": "record 7 is (RETURN v3)",
      "expected": "record 7 must be ARG (opcode 0x44), because record 6 is HOST with argument count 1",
      "derived": "If the missing record is added, the file will hold 10 records, which matches header word 3.",
      "context": "  4 @96  10 00 00 00 02 00 00 00 02 00 00 00 00 00 00 00  (CONST_U64 v2 2)   ; claim: (CONST_U64 v2 2)\n  5 @112  20 00 00 00 03 00 00 00 01 00 00 00 02 00 00 00  (ADD_U64 v3 v1 v2)   ; claim: (ADD_U64 v3 v1 v2)\n  6 @128  60 00 00 00 ff ff ff ff 00 00 00 00 01 00 00 00  (HOST _ terminal.print_u64 1)   ; claim: (HOST _ terminal.print_u64 1)\n> 7 @144  43 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00  (RETURN v3)   ; claim: (ARG v3)\n  8 @160  04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  (END_FUNC)   ; claim: (RETURN v3)",
      "claim": "(ARG v3)",
      "manualRef": "§10.4"
    }
  ],
  "warnings": [],
  "suppressed": 3,
  "omitted": 0,
  "listing": "…bounded annotated disassembly of all 9 decodable records…",
  "listingTruncated": false,
  "annotations": {
    "present": true,
    "records": 10,
    "claimsChecked": 9,
    "claimsMatched": 7,
    "contracts": 1,
    "invariants": 0,
    "examples": 0,
    "sha256": "ae7144831a5eff1077e19869e2e9bff20718e680494ad0bebea82f8012bf8f6f"
  },
  "catalogVersion": "anma-diagnostics/1"
}
```

Here the model's own annotations point straight at the fault: it claimed record 7 was `(ARG v3)`, but its bytes put RETURN there. The report states facts and rules, and the model writes every byte of the fixed file. The three suppressed errors are annotation cascades: after the missing record, the claims for records 7 and 8 no longer line up with the bytes, and the claim for record 9 names a record that does not exist.

## 18. Counter-experiment protocol

### 18.1 Machine-invariance track

For each fixed artifact, run F=4/8/16/32/64, and F=1 as an engineering edge test. Hold constant the artifact hash, inputs, heap/device configuration, input-event recording, runtime semantics, and replacement-policy version. Use adequate declared fuel/backing capacity for every run.

Compare returned values, terminal bytes, ordered device effects, and final framebuffer hash. Compare storage counters separately; they are expected to vary. Resource exhaustion is not a wrong numeric answer and must not be hidden by increasing limits without recording the change.

For the forty-value task, require a witness that all forty designated producer results coexist with future uses before reduction begins. Require actual backing-store activity for configurations that cannot hold the live payloads in fast slots. A trace animation with a separately computed result is a failing implementation.

### 18.2 Exact upstream capstone track

Use Section 3.3 verbatim as the mathematical task, with runtime input. Keep the core computation separate from any terminal wrapper. The prescribed structure requires forty explicit `x+i` result definitions, all completed before folding; even `x+0` remains a producing operation in this particular exercise. Each designated result is consumed at the required fold position without rematerialization.

The witness checker walks decoded operations and use relationships; it does not trust supplied result names or compare numeric values only. It recognizes parameter/constant/add origins, verifies the permutation and fold, and checks future uses across the producer/consumer boundary. Its output is a bounded certificate referring to record positions and value IDs. It is not a compiler and does not change the program.

Always include the upstream reference input and input 1. Add 0, `2^32-1`, `2^32`, `2^53`, `2^64-1`, and recorded pseudorandom inputs. Report published-input agreement separately from holdout agreement.

For an **unrestricted algorithm** variant, permit recomputation or streaming. Do not award a pressure certificate to it unless its actual execution meets the pressure definition. The unrestricted variant addresses algorithm generation, not forced storage placement.

### 18.3 Ring-mix track

The upstream pressure probe is a distinct workload: initialize K values from `x+i`; perform 1,000 iterations; within each iteration visit indices in order, update each value by adding three times its next neighbour, then XOR with its second neighbour; finally XOR all values. Updates are in place, so later indices can observe earlier changes. ANMA must reproduce that order, not a simultaneous/Jacobi update. [R5]

Pin K to the upstream set `2,4,8,12,16,20,24,28,32,40,48,64,96` for the replication track. Loop block parameters or typed heap are implementation possibilities, but the pressure claim must name what is live and where. A heap-array implementation is a memory workload, not automatically K immutable values in the logical-value store. Start this as a runtime/reference test; publish model-generation trials only after the representation and feedback are fixed.

### 18.4 Scaling beyond forty

Expose K=8/40/128 as understandable public presets. K=256/1,024/10,000 are research-scale tiers. Generalized capstone constants/permutations must be specified; `(17*j) mod K` visits every index only when 17 and K are coprime. Reject an invalid permutation or select a declared coprime stride in the extension task. Do not silently call that modified workload the exact original forty-value test.

A 10,000-value tool-generated fixture demonstrates runtime scale only. A long OpenAI response may hit generation token/transport limits before the machine's resource limit; report those categories separately. Do not require live 10,000-value hex emission for public-demo acceptance.

### 18.5 Matched register-control ISA

A comparative usability claim requires a matched control, not just ANMA versus macOS file-format complexity. Implement a small straight-line control ISA named **ANMR-1** for the storage-only tasks. It is a separate interpreter and artifact extension, not an ANMA execution backend.

Control specification for the first comparison:

- Magic is `ANMR`; the remaining header layout is analogous, except word 6 declares architectural register count R and word 7 declares bounded spill-slot count S. These fields are not ANMA fields.
- One function, one block, one u64 input bound to register 0. FUNC/BLOCK/PARAM syntax is analogous; BLOCK's final word is zero, since registers are mutable rather than dense value definitions.
- Registers are indices `0..R-1`; values are u64 only for this track. CONST/ADD/SUB/MUL/XOR/RETURN use the corresponding numeric opcodes but operand/destination fields name registers. Read all source operands before overwriting the destination. Uninitialized reads trap.
- `0x70 SAVE [sourceRegister, spillSlot, 0]` writes a u64 to a private bounded spill slot; `0x71 RESTORE [destinationRegister, spillSlot, 0]` reads an initialized slot. Spill slots are `0..S-1` and initially uninitialized.
- No hidden spilling, virtual-register expansion, or computation replay is allowed. The generator must insert SAVE/RESTORE itself when necessary. The control interpreter's host implementation is not claimed to be real silicon.
- Input/output, modular arithmetic, complete-file generation, envelope assistance, test feedback, and resource safety match ANMA as closely as possible. Pure-return capstone tasks request no devices in either condition.

Use R=4/8/16/32 with sufficient, fixed S. Require well-tested developer fixtures proving that each task is implementable at each tested R. Preserve the same prescribed producer/fold structure using dynamic register-write version identities and spill/restore provenance in the control witness. Do not classify a legitimate spill-everything strategy as failure merely because it resembles compilation.

ANMR-1 initially tests storage responsibility, not all ANMA calls, types, graphics, and memory features. Do not claim a full ABI comparison from this restricted control. Implementing the control is required before publishing comparative superiority claims, but not before releasing the basic ANMA playground.

### 18.6 OpenAI trial design

For a small initial study, use 20 independent generation sessions per selected condition, with fresh context, fixed model profile, fixed prompt/task versions, equal repair feedback, and declared budgets. This is an exploratory sample, not a guaranteed statistical power calculation. Report uncertainty and raw denominators; do not make a leaderboard from one successful session.

Use two views where output sizes differ: a common spending/token ceiling, and a non-size-starved experiment with token/length effects reported. Separate header/hex errors, invalid IDs/types, semantic errors, pressure-structure failures, infrastructure errors, refusals, and size limits. Architectural differences in available validation are part of the interface and must be disclosed.

The loop's assistance is part of the condition and must be declared. Run these conditions as separate, labelled arms, never pooled:

- **Bare:** raw or envelope bytes with outer-loop test feedback only; no `check_candidate`, no annotations.
- **Checked:** the default agentic loop with `check_candidate`; annotations are optional.
- **Annotated:** the checked loop, with record claims required by the prompt.

The same arms apply to ANMR-1 with an equivalent checker, so the ANMA-vs-ANMR comparison is not confounded by unequal diagnostics.

Record the following:

- first-draft validity and first-submission validity;
- first-submission task success, and final success within the loop budget;
- check and submission counts;
- turns to first valid candidate and turns to success;
- stop outcome;
- per-rule diagnostic counts and fix rates;
- annotation-mismatch counts;
- actual model usage, response bytes, and relevant runtime transfers. Publish failures as well as successes. No hidden tool-generated replacements are permitted in a live-model trial.

Research trials run against a dedicated Wrangler environment (for example `--env research`) with its own `BudgetLedger` and caps, so study spend never shares a ledger with the public demo.

Keep the public experience simple; research measurement is a separate mode. There is no requirement to build a broad optimization leaderboard, conduct expensive automatic multi-model sweeps, or block normal exploration on completing a study.

### 18.7 Native performance comparisons

The upstream native counts are attributed historical results unless rerun on a documented Apple Silicon environment. This browser project must not claim it reproduced those native results. Any future native comparison records toolchain version, flags, disassembly boundaries, input, static instructions, dynamically executed operations, and measured traffic separately. A browser interpreter's wall time is not an ISA or silicon efficiency comparison. [R3–R5]

## 19. Artifacts, replay, and publication

Use IndexedDB for bounded local artifacts/settings/history, with explicit file export and graceful storage-quota/eviction handling. Hash exact executable bytes using SHA-256. A hash proves identity, not correctness, authorship, or honest execution. [B5, B6]

A versioned manifest records:

```text
document/spec hash and ANMA wire version
machine build commit, Cloudflare deployment version ID, and runtime/replacement policy
artifact hash, length, filename, and provenance
source upstream commit/task reference where applicable
generation session/attempt IDs and provider response IDs
requested/returned OpenAI model, settings, SDK, mode, prompt hashes
visible prompt/output/feedback history and failed candidates
loop transcript: every check draft and submission (hashes), diagnostic reports, rule-catalog version, stop outcome, loop counters, and any context elision
reasoning-carried flag (encrypted reasoning items themselves are never exported)
annotation sidecar and its SHA-256, bound to the artifact hash; contract-language version
verification tier reached (T0–T3), contract owner (model vs task reference), T2 execution count, T3 prover/solver version and per-condition outcomes
provider status, usage, unknown-usage marker, budget policy
validation outcome and task/test/witness versions
machine configuration, inputs, deterministic event stream
return value, exact terminal bytes, device-effect/final-frame hashes
instruction/microstep/storage counters and resource/trap outcomes
trace coverage/truncation and any manual edits or assisted construction
```

Every generation has an addressable session/attempt identity; every executable has a content identity; every execution has a run identity. Generation is not claimed reproducible bit-for-bit just because settings are fixed. Deterministic execution is the required reproducibility property.

A portable export contains the binary, manifest, task specification, and selected replay inputs. Full prompt history is opt-in because it may contain private text. Export/import paths are sanitized and bounded. A public share service is an optional module. If built, it stays on Cloudflare: artifact bytes in an R2 bucket keyed by SHA-256, with a metadata index in a Durable Object or D1, bound in the same `wrangler.jsonc`. It starts artifacts stopped, never executes uploads server-side, and labels client-provided results unverified until the recipient reruns them. No social features are required.

## 20. Acceptance tests

### 20.1 P0 — machine and authenticity

- The 144-byte and 192-byte fixtures validate unchanged and compute their declared results; every displayed/exported hash agrees.
- The 2,704-byte capstone fixture agrees with the independent oracle on boundary and seeded inputs and has the forty-value witness.
- Finite and reference engines agree across F=1/4/8/16/32/64 with adequate resources, including duplicate operands and forced eviction/reload.
- Branch transfers, recursive calls, return-value transfer, caller-surviving values, and repeated block IDs do not alias, disappear, or leak indefinitely.
- Bounds, bool conversions, shifts/rotates, zero division, heap initialization, stale/invalid handles, UTF-8 errors, capability declarations, and resource exhaustion have tests.
- Fuzzed/truncated/oversized inputs cannot bypass bounds, hang validation indefinitely, invoke host code, or exhaust unbounded memory.
- No mutable, partial, unvalidated, or post-validation-changed bytes execute.
- Every rule in the diagnostic catalog has at least one malformation-corpus case with a snapshot-tested report. Reports are deterministic, bounded, root-cause-first, and contain no replacement hex, corrected records, or corrected headers (checked by test). The Section 17.2 example reproduces exactly.
- T1 record-claim cross-checking catches every opcode/field/ID/constant mismatch in a generated mutation suite. Annotations never change the executable bytes or hash, and a candidate with correct claims and wrong bytes fails.

### 20.2 P0 — OpenAI, Cloudflare, and browser

- `wrangler deploy` publishes the `llmtobinary` Worker (and `llmtobinary-staging`) from a clean checkout using only the pinned Wrangler. The deployed site serves the app, SPA routes fall back to `index.html`, `/api/*` reaches Worker code, and fixture playback works with live generation disabled.
- A real, explicitly budgeted OpenAI smoke test generates a fresh candidate through the **deployed staging Worker**, and its exact bytes execute locally in the browser. A fixture replay or a `wrangler dev`-only run does not satisfy this criterion.
- API keys and provider secrets are absent from `wrangler.jsonc`, `vars`, the git history, frontend builds, static assets, machine-worker messages, local storage, exports, Workers Logs, CI logs, and telemetry. `.dev.vars` is gitignored.
- Complete/refused/incomplete/error/cancelled streaming outcomes are handled independently; no dropped connection becomes a false success. Incremental streaming and client-disconnect cancellation are verified through Cloudflare's edge on the deployed Worker.
- The agentic loop runs end to end on the deployed staging Worker for a live task. It includes at least one real malformed draft that is reported by `check_candidate` and then fixed by the model, and one outer iteration driven by a browser test failure. Each stop outcome in Section 7.6 (`passed`, `passed-unverified`, `budget-exhausted`, `stalled`, `refused`, `cancelled`, `infrastructure-error`) is exercised by a test, using a scripted fake model where a live model cannot be made to produce it on demand. The fake model is used only in tests and is labelled as such.
- `check_candidate` in the Worker is proven, by import-graph check and by test, to never execute guest code.
- Loop turns, checks, submissions, and tokens are counted and bounded server-side by `GenerationSession` and `BudgetLedger`. Reconnection, idempotency, and concurrent-request tests do not trigger duplicate paid calls. Concurrent sessions cannot overspend the global cap.
- Stop, Pause, input waiting, and hard machine-worker termination are tested with runaway programs. Large traces do not freeze the UI.
- Slots can be changed and the same committed binary rerun without generating new bytes. Comparisons use identical inputs/events.
- Curated outputs come from guest computation, not task-specific host implementations. Imported/shared binaries start stopped.
- The CSP from `_headers` is present on deployed asset responses and forbids `unsafe-eval` and cross-origin `connect-src`.

### 20.3 P1 — complete demo

- Hello text, FizzBuzz, recursive calls, a pixel pattern, and an interactive example work as fixtures and have live generation paths with honest outcomes.
- Literal JSON-envelope mode and raw-hex mode remain distinguishable in prompts, UI, and manifests.
- Export/import reproduces artifact bytes, inputs, execution outcome, and trace truncation status.
- Browser tests cover supported Chromium, Firefox, and WebKit versions recorded by CI, run against the `wrangler dev` build and a deployed preview. The VM requires no WebGPU or local-model assets.
- `wrangler rollback` to the previous deployment version is exercised once on staging.
- T2 runtime contract checking works for `requires`, `ensures`, invariants, and examples. Violations report inputs, activation path, and concrete values, and feed the next loop iteration. Contract checking does not change finite-runtime storage counters.
- The inspector shows each record's claim and note beside its bytes, with verification tier badges that use distinct wording for "model's comment", "claim matches bytes", "held on N executions", and (P2) "proved".
- Documentation states what was implemented, verified, tested live, and not yet tested.

### 20.4 P2 — comparative research release

- ANMR-1 passes its own fixtures and pressure witness checks at every tested register count.
- T3 proves the reference contracts of return-42, square-plus-two, and the exact capstone against their fixtures. It refutes seeded wrong variants with counterexamples that T2 confirms, reports `unknown` rather than `proved` on timeout, and passes the proved-vs-T2 cross-check on holdout and random inputs. The task-contract and model-contract labels are distinct in UI, manifest, and export.
- Trial conditions, model profile, prompts, budgets, failure taxonomy, and sample counts are fixed before examining comparative results.
- Reports contain actual runs only. Native-count claims remain attributed unless separately rerun. The public summary does not convert same-binary invariance into an unmeasured model-superiority claim.

## 21. Implementation sequence and handoff

**Milestone A — freeze executable semantics.** Extract Sections 10–13 into versioned spec files. Check the bundled fixtures. Implement bounded decoding, validation, and the independent reference engine. Build the diagnostic rule catalog, the malformation corpus, and T1 record-claim cross-checking together with the validator, not as polish afterwards. Gate: numeric/binary conformance and diagnostic snapshot tests pass without any OpenAI or Cloudflare dependency.

**Milestone B — build the finite machine.** Implement real residency, backing pages, latches, frames/staging, lifetime reclamation, quotas, and counters. Gate: forced-eviction and cross-F differential tests pass, including the exact capstone.

**Milestone C — expose the computer in the browser and ship it.** Integrate the machine Web Worker, byte/instruction views, terminal, storage display, controls, and export. Scaffold `apps/web/wrangler.jsonc` with static assets, the `_headers` CSP, and a stub `GET /api/config` that reports live generation disabled. Deploy the fixture-only demo to `llmtobinary-staging` and then `llmtobinary` with `wrangler deploy`. Gate: the fixture-only demo is live on Cloudflare, responsive, and replayable, with no secrets configured.

**Milestone D — connect OpenAI and run the agentic loop.** Implement the Worker router, the `GenerationSession` loop controller and `BudgetLedger` Durable Objects, rate-limit admission, and Wrangler secrets. Add the `check_candidate`/`submit_candidate` tools, streaming with resumable events, candidate freezing, the automatic outer loop from browser test results, stop conditions, and transcript/usage recording. Build a scripted fake-model harness for deterministic loop tests. Gate: a live task on the deployed staging Worker goes from malformed draft to passing candidate through the loop, and every stop outcome and error/cancel path is exercised.

**Milestone E — complete programming features.** Finish loop/call/memory/graphics/input examples, deterministic interactive replay, browser coverage, and security tests. Add the ANMA-Spec contract language and T2 runtime contract/example checking, with annotation display in the inspector. Gate: the user can request and run small guest programs, not just the single arithmetic fixture.

**Milestone F — run the counter-experiment and add proofs.** Implement the matched control and pressure witnesses, and implement T3 verification (VC generation, the solver in a browser worker, and the proof labels) after confirming solver size, CSP, and isolation constraints on Cloudflare. Run the declared study only with an approved budget in the dedicated research environment. Gate: the report accurately separates architecture, model-generation, and performance findings.

Parallel agents can own spec/validation, finite runtime, browser UI, Cloudflare/OpenAI integration, and experiments. They meet at fixed binary fixtures and versioned schemas. They may refactor implementation details but may not silently change the ISA, weaken a witness, remove a failing test, add a hidden compiler, relabel a fixture as model output, put patched bytes in a diagnostic, or blur the verification-tier labels.

Developer fixture builders and test interpreters are allowed in their explicitly labelled test paths. Do not mistake that allowance for permission to supply a builder to the live generation model.

## 22. Deferred work and guardrails against scope growth

Deferred: FPGA/silicon implementation, gate-level or cycle-accurate claims, out-of-order dataflow scheduling, custom learned eviction, rematerialization, floating point, tensors, proof certificates, Alpha lowering, native/Wasm guest backends, model-local inference, multi-provider orchestration, Cloudflare AI Gateway / Workers AI routing, server-side (Cloudflare) guest execution, cloud code execution, in-binary annotation sections (a new ANMA feature bit), quantifiers/heap/device state in contracts, termination proofs, proof certificates checkable without the solver, the R2-backed share service, custom-domain setup, and social publishing features.

The future hardware project may adopt the same bytes, but hardware-realizability is not established by this TypeScript interpreter. The future Alpha frontend belongs to an explicitly compiled track. Neither is a prerequisite for this public counter-experiment.

## 23. Final release statement

A truthful successful release of llmtobinary can say:

> An OpenAI model generated these executable bytes, working in a visible loop against a checker that explained its mistakes but never wrote bytes for it. A TypeScript virtual machine executed them in the browser. The same file ran with fewer fast-value slots because the machine—not the model—managed the backing storage. The bytes, tests, and assistance history are inspectable.

It must not say that no compiler-like machinery exists, that a native chip has been demonstrated, or that a particular register count is a universal limit on LLM programming.

---

## Appendix A. Source register

Sources R, O, and B were checked on 29 September 2026. Sources C were added on 30 September 2026 for the Cloudflare hosting change and must be re-verified against the pinned Wrangler and `compatibility_date` during Milestone C. Upstream references are pinned to the inspected commit. Platform documentation can change; deployment must verify its configured SDK/model and Wrangler configuration rather than rely on a label in this document. These sources support factual platform/source-review statements, not claims that this proposed implementation has already shipped.

**R1 — Upstream README.** Reported experiment, environment, outcomes, and methodology.  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/README.md

**R2 — Instruction encoders and two-pass label resolver.**  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/arm64asm.py

**R3 — Hand capstone emitter and counters.**  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/emit_kernel_hand.py

**R4 — Golden evaluator and clang function-body statistics.**  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/analysis/golden.py

**R5 — Separate ring-mix pressure probe.**  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/analysis/pressure_probe.py

**R6 — Mach-O layout and signature builder.**  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/machobuild.py

**R7 — Native optimization probe.**  
https://github.com/skelpo/llm-to-native-binary/blob/b79649eb9e1d46e6c35d0d2053d19547e9aadd90/analysis/optimization.sh

**R8 — Commit and inspected tree.**  
https://github.com/skelpo/llm-to-native-binary/commit/b79649eb9e1d46e6c35d0d2053d19547e9aadd90

**O1 — OpenAI Responses integration and request-shape differences.**  
https://developers.openai.com/api/docs/guides/migrate-to-responses

**O2 — OpenAI Structured Outputs.** JSON schema constraints, refusals, and incomplete output handling.  
https://developers.openai.com/api/docs/guides/structured-outputs

**O3 — OpenAI response streaming.**  
https://developers.openai.com/api/docs/guides/streaming-responses

**O4 — Official OpenAI SDKs.**  
https://developers.openai.com/api/docs/libraries

**O5 — OpenAI API-key security.**  
https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety

**O6 — Reasoning and output-token accounting.**  
https://developers.openai.com/api/docs/guides/reasoning  
https://developers.openai.com/api/docs/guides/token-counting

**O7 — OpenAI platform data controls.**  
https://developers.openai.com/api/docs/guides/your-data

**O8 — OpenAI model catalog.** Availability/configuration reference, not a substitute for a project smoke test.  
https://developers.openai.com/api/docs/models

**O9 — OpenAI function calling** (strict function schemas, `tool_choice`, `function_call_output`, stateless tool loops). Added 30 September 2026; verify against the pinned SDK.  
https://developers.openai.com/api/docs/guides/function-calling

**C1 — Cloudflare Workers static assets** (assets directory, SPA `not_found_handling`, `run_worker_first`).  
https://developers.cloudflare.com/workers/static-assets/

**C2 — Cloudflare Vite plugin.**  
https://developers.cloudflare.com/workers/vite-plugin/

**C3 — Wrangler configuration and commands** (`wrangler.jsonc`, environments, `deploy`, `rollback`, `types`).  
https://developers.cloudflare.com/workers/wrangler/configuration/  
https://developers.cloudflare.com/workers/wrangler/commands/

**C4 — Durable Objects** (storage, alarms, single-threaded consistency).  
https://developers.cloudflare.com/durable-objects/

**C5 — Workers secrets and local `.dev.vars`.**  
https://developers.cloudflare.com/workers/configuration/secrets/

**C6 — Workers platform limits** (CPU time vs. wall time, request/response sizes).  
https://developers.cloudflare.com/workers/platform/limits/

**C7 — Workers Rate Limiting binding.**  
https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

**C8 — Static-asset custom headers (`_headers`).**  
https://developers.cloudflare.com/workers/static-assets/headers/

**B1 — Vite TypeScript and worker support.**  
https://vite.dev/guide/features

**B2 — Worker execution, available APIs, and termination.**  
https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers

**B3 — Unsigned modular BigInt truncation.**  
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt/asUintN

**B4 — Transferable buffers and detachment.**  
https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects

**B5 — Browser structured storage.**  
https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

**B6 — Browser cryptographic hashing.**  
https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest

**B7 — WebAssembly binary virtual-machine precedent.**  
https://webassembly.github.io/spec/core/intro/introduction.html

**B8 — EDGE architecture and compiler-created execution blocks.**  
https://www.microsoft.com/en-us/research/publication/compiling-for-edge-architectures/

**B9 — SMT-LIB bit-vector logic and a WebAssembly SMT solver candidate (Z3 JavaScript bindings).** Added 30 September 2026 for the P2 verifier; solver choice, binary size, and threading requirements must be verified before Milestone F.  
https://smt-lib.org/logics-all.shtml#QF_BV  
https://github.com/Z3Prover/z3/tree/master/src/api/js

## Appendix B. Handoff contents and verification limits

The accompanying archive contains this PRD, the pinned generation/manual text, user-task and repair templates, the candidate schema, three binary fixtures with hashes and complete response envelopes, and a small TypeScript subset checker with deterministic test records.

The included preparation run passed 2,015 fixture executions and rejected 30 invalid binary, transport, or input cases. It also checked the forty designated values and original permutation in the capstone fixture. Full results and checker source hashes are in `verification/results.json`.

The subset checker covers only the fixture instruction subset and structural rules needed for those fixtures. It is not the production validator, resource-constrained runtime, browser UI, or OpenAI broker. Its test results do not establish finite-storage behavior, browser security, or model-generation success. No live OpenAI request, Cloudflare deployment, or native macOS execution was performed while preparing this handoff. The version 3.2 additions have not been prototyped: the agentic loop, diagnostic catalog, annotations, contract language, and verification tiers. Implementation status is recorded in `docs/STATUS.md` (implemented, verified, tested live, not yet tested). The Section 17.2 report is captured checker output.
