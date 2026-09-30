// Task registry (PRD Section 15.2): pure, JSON-serializable data plus prompt text.
// Safe for the Cloudflare Worker (no engines). Oracles and the test runner live elsewhere.

import { Feature } from "@llmtobinary/spec";
import type { TickEvent } from "@llmtobinary/protocol";

export type ParamType = "u64" | "bool";
export type ReturnType = "unit" | "u64" | "bool";

export interface TestCase {
  name: string;
  inputs: string[];
  ticks?: TickEvent[];
}

export interface TaskSpec {
  id: string;
  version: number;
  title: string;
  tier: "public" | "research";
  /** What the model is asked (curated wording). */
  prompt: string;
  params: ParamType[];
  paramNames: string[];
  returns: ReturnType;
  /** Permitted feature bits. */
  features: number;
  /** Semantic contract in prose. */
  semantics: string;
  /** Developer fixture implementing the task (never shown to the model as a worked example). */
  fixture: string | null;
  /** Reference contract in ANMA-Spec, authored by the task author (pure tasks only). */
  referenceContract: string | null;
  visible: TestCase[];
  holdout: { seed: string; count: number; kind: "u64" | "small" | "fizzbuzz" | "fib" | "none"; include: TestCase[] };
  /** Which effects the oracle checks exactly. */
  effects: ("terminal" | "framebuffer" | "frames")[];
  /** Structural pressure requirement (capstone): all K producers complete before the fold. */
  pressure: { kind: "capstone"; K: number; stride: number } | null;
  /** Executed-instruction fuel per test run. */
  fuel: number;
}

const M = "18446744073709551615";
const U64_EDGE = ["0", "1", "2", "4294967295", "4294967296", "9007199254740992", M];

// Scripted input for the ball/paddle game: hold Right, then Left, idle, and quit with Escape.
function ballTicks(): TickEvent[] {
  const out: TickEvent[] = [];
  for (let t = 1; t <= 260; t++) {
    const keys = t < 40 ? 0b10 : t < 90 ? 0b01 : t < 150 ? 0 : t % 7 < 3 ? 0b10 : t % 7 < 5 ? 0b01 : 0;
    out.push({ tick: String(t), keys });
  }
  out.push({ tick: "261", keys: 1 << 6 });
  return out;
}

function capstoneContract(K: number, stride: number, param = "x"): string {
  let a = "0";
  for (let j = 0; j < K; j++) a = `(bxor (mul ${a} 3) (add ${param} ${(stride * j) % K}))`;
  return `(eq result ${a})`;
}

const capstoneText = (K: number, stride: number, exact: boolean) =>
  [
    `Create one function with a u64 input x and a u64 return value. All arithmetic is modulo 2^64.`,
    `First compute ${K} separate values v[i] = x + i for i = 0..${K - 1}, each with its own ADD_U64 (use a constant and an add even for i = 0), and finish all ${K} of them before the fold starts.`,
    `Then fold: a = 0; for j = 0..${K - 1}: a = (a * 3) XOR v[(${stride} * j) mod ${K}]. Use each v[i] exactly once at its fold position; do not recompute any v[i].`,
    `Return a. The input arrives at runtime; do not hard-code answers for example inputs.`,
    exact ? `This is the exact upstream forty-value capstone (skelpo/llm-to-native-binary).` : ``,
    `Return one complete ANMA-1 executable.`,
  ]
    .filter(Boolean)
    .join("\n");

const ringText = (K: number) =>
  [
    `Create one function with a u64 input x and a u64 return value. All arithmetic is modulo 2^64.`,
    `Initialize ${K} values v[i] = x + i for i = 0..${K - 1}. Then repeat 1000 times: for i = 0..${K - 1} in order,`,
    `v[i] = v[i] + v[(i+1) mod ${K}] * 3, then v[i] = v[i] XOR v[(i+2) mod ${K}] — updates are in place and sequential, so later indices see values already updated in the same iteration.`,
    `Finally return v[0] XOR v[1] XOR … XOR v[${K - 1}]. Return one complete ANMA-1 executable.`,
  ].join("\n");

const TASK_LIST: TaskSpec[] = [
  {
    id: "return-42",
    version: 1,
    title: "Return 42",
    tier: "public",
    prompt: "Create one function with no inputs and a u64 return value that returns 42.\nReturn one complete ANMA-1 executable in the required JSON envelope.",
    params: [],
    paramNames: [],
    returns: "u64",
    features: 0,
    semantics: "Returns 42 and has no effects.",
    fixture: "return-42.anma",
    referenceContract: "(eq result 42)",
    visible: [{ name: "returns 42", inputs: [] }],
    holdout: { seed: "0", count: 0, kind: "none", include: [] },
    effects: ["terminal"],
    pressure: null,
    fuel: 10_000,
  },
  {
    id: "square-plus-two",
    version: 1,
    title: "n*n + 2, print and return",
    tier: "public",
    prompt: [
      "Create one function with a u64 input n and a u64 return value.",
      "Compute n*n + 2 modulo 2^64, using multiplication and addition.",
      "Print that value exactly once with terminal.print_u64 and return it.",
      "The input arrives at runtime; do not hard-code answers for example inputs.",
      "Return one complete ANMA-1 executable in the required JSON envelope.",
    ].join("\n"),
    params: ["u64"],
    paramNames: ["n"],
    returns: "u64",
    features: Feature.TERMINAL,
    semantics: "Returns (n*n + 2) mod 2^64 and prints exactly that value's decimal digits once, with no newline.",
    fixture: "square-plus-two.anma",
    referenceContract: "(eq result (add (mul n n) 2))",
    visible: [
      { name: "n = 12", inputs: ["12"] },
      { name: "n = 2^32 wraps", inputs: ["4294967296"] },
    ],
    holdout: { seed: "0x5eed0001", count: 8, kind: "u64", include: U64_EDGE.map((v) => ({ name: `n = ${v}`, inputs: [v] })) },
    effects: ["terminal"],
    pressure: null,
    fuel: 10_000,
  },
  {
    id: "hello",
    version: 1,
    title: "Hello text",
    tier: "public",
    prompt: "Create one function with no inputs and a unit return value that prints exactly \"Hello, world!\" followed by one newline (\\n), using terminal.print_utf8 on bytes stored in the read-only data section.\nReturn one complete ANMA-1 executable.",
    params: [],
    paramNames: [],
    returns: "unit",
    features: Feature.TERMINAL,
    semantics: 'Terminal output is exactly "Hello, world!\\n".',
    fixture: "hello.anma",
    referenceContract: null,
    visible: [{ name: "prints the greeting", inputs: [] }],
    holdout: { seed: "0", count: 0, kind: "none", include: [] },
    effects: ["terminal"],
    pressure: null,
    fuel: 10_000,
  },
  {
    id: "fizzbuzz",
    version: 1,
    title: "FizzBuzz 1..N",
    tier: "public",
    prompt: [
      "Create one function with a u64 input n and a unit return value.",
      'For each i from 1 to n inclusive, print one line: "FizzBuzz" if i is divisible by 15, else "Fizz" if divisible by 3, else "Buzz" if divisible by 5, else the decimal digits of i. Every line ends with "\\n". Print nothing when n = 0.',
      "Use terminal.print_u64 for numbers and terminal.print_utf8 with the read-only data section for text.",
      "Return one complete ANMA-1 executable.",
    ].join("\n"),
    params: ["u64"],
    paramNames: ["n"],
    returns: "unit",
    features: Feature.TERMINAL,
    semantics: "Terminal output is exactly the FizzBuzz lines for 1..n.",
    fixture: "fizzbuzz.anma",
    referenceContract: null,
    visible: [
      { name: "n = 15", inputs: ["15"] },
      { name: "n = 0", inputs: ["0"] },
    ],
    holdout: { seed: "0x5eed0002", count: 5, kind: "fizzbuzz", include: [{ name: "n = 1", inputs: ["1"] }, { name: "n = 100", inputs: ["100"] }] },
    effects: ["terminal"],
    pressure: null,
    fuel: 500_000,
  },
  {
    id: "fibonacci",
    version: 1,
    title: "Recursive Fibonacci",
    tier: "public",
    prompt: [
      "Create an entry function with a u64 input n and a u64 return value that returns fib(n), where fib(0) = 0, fib(1) = 1, fib(n) = fib(n-1) + fib(n-2) (modulo 2^64).",
      "Implement fib as a separate recursive function called with CALL. Inputs are at most 20.",
      "Return one complete ANMA-1 executable.",
    ].join("\n"),
    params: ["u64"],
    paramNames: ["n"],
    returns: "u64",
    features: 0,
    semantics: "Returns the n-th Fibonacci number (n <= 20 in tests).",
    fixture: "fibonacci.anma",
    referenceContract: null,
    visible: [
      { name: "n = 10", inputs: ["10"] },
      { name: "n = 1", inputs: ["1"] },
    ],
    holdout: { seed: "0x5eed0003", count: 4, kind: "fib", include: [{ name: "n = 0", inputs: ["0"] }, { name: "n = 20", inputs: ["20"] }] },
    effects: ["terminal"],
    pressure: null,
    fuel: 2_000_000,
  },
  {
    id: "checkerboard",
    version: 1,
    title: "Pixel checkerboard",
    tier: "public",
    prompt: [
      "Create one function with no inputs and a unit return value that draws a checkerboard on the 256x144 framebuffer and then calls display.present once.",
      "For every pixel (x, y), the cell parity is ((x >> 4) XOR (y >> 4)) AND 1. Parity 0 is colour 0x1f2933ff; parity 1 is colour 0xe4e7ebff. Set every pixel with display.pixel using guest loops (no display.clear).",
      "Return one complete ANMA-1 executable.",
    ].join("\n"),
    params: [],
    paramNames: [],
    returns: "unit",
    features: Feature.FRAMEBUFFER,
    semantics: "Final framebuffer is the 16x16-cell checkerboard; exactly one present.",
    fixture: "checkerboard.anma",
    referenceContract: null,
    visible: [{ name: "draws the board", inputs: [] }],
    holdout: { seed: "0", count: 0, kind: "none", include: [] },
    effects: ["framebuffer", "frames"],
    pressure: null,
    fuel: 1_000_000,
  },
  {
    id: "ball-paddle",
    version: 2,
    title: "Moving ball / keyboard paddle",
    tier: "public",
    prompt: [
      "Create one function with no inputs returning a u64 score. State: ball (bx, by) = (128, 20), velocity (dx, dy) = (1, 1) where -1 is 2^64-1, paddle x px = 116, score = 0, tick count n = 0.",
      "Each tick: call input.wait_tick. If key 6 (Escape) is down, return score immediately.",
      "Paddle: if Left (key 0) is down and px >= 4, px -= 4; then if Right (key 1) is down and px <= 228, px += 4.",
      "Ball: nx = bx + dx; if nx == 0 or nx == 254, dx = -dx. ny = by + dy.",
      "If ny == 140: if px <= nx < px + 24 (using the already-updated px), set dy = -1, score += 1 and move the ball to (bx, by) = (nx, ny); otherwise reset the ball to (bx, by) = (128, 20) with dy = 1 (dx keeps its updated value). Otherwise move the ball to (bx, by) = (nx, ny), and if ny == 0 set dy = 1.",
      "Draw: display.clear(0x000000ff); paddle pixels (px+i, 142) and (px+i, 143) for i = 0..23 in 0xffffffff; ball pixels (bx,by),(bx+1,by),(bx,by+1),(bx+1,by+1) in 0xffd166ff using the new position; display.present.",
      "n += 1; after 600 ticks return score. Return one complete ANMA-1 executable.",
    ].join("\n"),
    params: [],
    paramNames: [],
    returns: "u64",
    features: Feature.FRAMEBUFFER | Feature.INPUT,
    semantics: "Deterministic game driven by recorded ticks; checked by score, final framebuffer, and frames presented.",
    fixture: "ball-paddle.anma",
    referenceContract: null,
    visible: [{ name: "scripted play then Escape", inputs: [], ticks: ballTicks() }],
    holdout: { seed: "0", count: 0, kind: "none", include: [] },
    effects: ["framebuffer", "frames"],
    pressure: null,
    fuel: 2_000_000,
  },
  {
    id: "capstone-40",
    version: 1,
    title: "Exact upstream capstone (forty live values)",
    tier: "public",
    prompt: capstoneText(40, 17, true),
    params: ["u64"],
    paramNames: ["x"],
    returns: "u64",
    features: 0,
    semantics: "Section 3.3 verbatim with the prescribed-pressure structure: forty x+i producers complete before the fold, each consumed once at its fold position.",
    fixture: "upstream-capstone-40.anma",
    referenceContract: capstoneContract(40, 17),
    visible: [
      { name: "upstream reference input 0x0000123400005678", inputs: ["20014547621496"] },
      { name: "x = 1", inputs: ["1"] },
    ],
    holdout: { seed: "0x5eed0040", count: 8, kind: "u64", include: U64_EDGE.map((v) => ({ name: `x = ${v}`, inputs: [v] })) },
    effects: ["terminal"],
    pressure: { kind: "capstone", K: 40, stride: 17 },
    fuel: 10_000,
  },
  {
    id: "capstone-40-unrestricted",
    version: 1,
    title: "Capstone, unrestricted algorithm",
    tier: "public",
    prompt: [
      "Create one function with a u64 input x and a u64 return value; all arithmetic modulo 2^64.",
      "Return a, where a = 0 and for j = 0..39: a = (a * 3) XOR (x + ((17 * j) mod 40)). Any correct algorithm is accepted (recomputation and streaming are fine).",
      "Return one complete ANMA-1 executable.",
    ].join("\n"),
    params: ["u64"],
    paramNames: ["x"],
    returns: "u64",
    features: 0,
    semantics: "Same value as the capstone; no structural pressure requirement and no pressure certificate.",
    fixture: "upstream-capstone-40.anma",
    referenceContract: capstoneContract(40, 17),
    visible: [{ name: "x = 1", inputs: ["1"] }],
    holdout: { seed: "0x5eed0041", count: 8, kind: "u64", include: U64_EDGE.map((v) => ({ name: `x = ${v}`, inputs: [v] })) },
    effects: ["terminal"],
    pressure: null,
    fuel: 100_000,
  },
  ...[8, 128, 256, 1024].map(
    (K): TaskSpec => ({
      id: `capstone-k${K}`,
      version: 1,
      title: `Generalized capstone, K = ${K}`,
      tier: K <= 128 ? "public" : "research",
      prompt: capstoneText(K, 17, false),
      params: ["u64"],
      paramNames: ["x"],
      returns: "u64",
      features: 0,
      semantics: `Generalized capstone with ${K} values and stride 17 (coprime with ${K}); not the exact upstream test.`,
      fixture: `capstone-k${K}.anma`,
      referenceContract: K <= 128 ? capstoneContract(K, 17) : null,
      visible: [{ name: "x = 1", inputs: ["1"] }],
      holdout: { seed: `0x5eed1${K}`, count: 4, kind: "u64", include: [{ name: "x = 0", inputs: ["0"] }, { name: `x = ${M}`, inputs: [M] }] },
      effects: ["terminal"],
      pressure: { kind: "capstone", K, stride: 17 },
      fuel: 200 + 40 * K,
    }),
  ),
  ...[2, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 96].map(
    (K): TaskSpec => ({
      id: `ring-mix-k${K}`,
      version: 1,
      title: `Upstream ring mix, K = ${K}`,
      tier: "research",
      prompt: ringText(K),
      params: ["u64"],
      paramNames: ["x"],
      returns: "u64",
      features: 0,
      semantics: "Upstream pressure_probe.py workload with in-place sequential updates (not a Jacobi update).",
      fixture: `ring-mix-k${K}.anma`,
      referenceContract: null,
      visible: [{ name: "x = 1", inputs: ["1"] }],
      holdout: { seed: `0x5eed2${K}`, count: 2, kind: "u64", include: [{ name: "x = 0", inputs: ["0"] }] },
      effects: ["terminal"],
      pressure: null,
      fuel: 4 * (1000 * (3 * K + 10) + 4 * K + 100),
    }),
  ),
];

export const TASKS: readonly TaskSpec[] = TASK_LIST;
export const TASK_BY_ID: ReadonlyMap<string, TaskSpec> = new Map(TASK_LIST.map((t) => [t.id, t]));

export function signatureText(params: readonly ParamType[], returns: ReturnType, names: readonly string[] = []): string {
  return `fn0(${params.map((p, i) => `${names[i] ?? `arg${i}`}: ${p}`).join(", ")}) -> ${returns}`;
}

const FEATURE_WORDS: [number, string][] = [
  [Feature.HEAP, "typed heap"],
  [Feature.TERMINAL, "terminal"],
  [Feature.FRAMEBUFFER, "framebuffer"],
  [Feature.INPUT, "event input"],
];

export function featureText(mask: number): string {
  const on = FEATURE_WORDS.filter(([b]) => (mask & b) !== 0).map(([, w]) => w);
  return on.length ? on.join(", ") : "none (pure computation)";
}

/** The user-content text for a curated task (Section 7.5). Visible tests are listed; holdouts never are. */
export function taskPromptText(task: TaskSpec, opts: { requireClaims?: boolean } = {}): string {
  const lines = [
    task.prompt,
    "",
    `Entry signature (the header's entry function): ${signatureText(task.params, task.returns, task.paramNames)}`,
    `Permitted devices: ${featureText(task.features)}. Declare exactly the feature bits you use.`,
  ];
  if (opts.requireClaims) lines.push("Record claims are required: annotate every record with its claim in the annotations sidecar.");
  return lines.join("\n");
}

/** User-content text for an open-ended visitor task. */
export function openTaskPromptText(description: string, params: readonly ParamType[], returns: ReturnType, features: number, opts: { requireClaims?: boolean } = {}): string {
  const lines = [
    "Visitor task (natural language; there is no independent oracle):",
    description.trim(),
    "",
    `Entry signature: ${signatureText(params, returns)}`,
    `Permitted devices: ${featureText(features)}. Declare exactly the feature bits you use.`,
    "Include examples in the annotations so the program can be checked against your own claims.",
  ];
  if (features & 8) {
    lines.push(
      "Examples run once with the given inputs and NO input ticks. A program that loops on input.wait_tick (for example one meant to run until the visitor quits, or forever) never finishes such a run: that is accepted when the example claims no result and no terminal text (use null for both), but a claimed result can never be observed.",
    );
  }
  if (opts.requireClaims) lines.push("Record claims are required: annotate every record with its claim in the annotations sidecar.");
  return lines.join("\n");
}
