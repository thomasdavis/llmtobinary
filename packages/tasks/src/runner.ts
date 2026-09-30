// Task test runner (PRD Sections 7.6 outer loop, 15.2, 15.4). Runs on the REFERENCE engine in the
// browser machine worker (never on the Cloudflare Worker): visible and holdout cases against the
// independent oracle, model-claimed examples, model contracts (T2), and the task author's
// reference contract. Produces a protocol TestReport with rule-ID'd diagnostics.

import { TypeTag, parseU64Decimal } from "@llmtobinary/spec";
import type { Module } from "@llmtobinary/validate";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import { runToCompletion } from "@llmtobinary/reference";
import { createContractMonitor, type ContractMonitor, type ParsedAnnotations } from "@llmtobinary/annotations";
import { formatGuestValue } from "@llmtobinary/devices";
import type { EngineHooks, EntryInput, RunResult, TestCaseResult, TestReport, TickEvent } from "@llmtobinary/protocol";
import type { TaskSpec, TestCase } from "./registry.ts";
import { holdoutCases, oracleFor, type OracleOutcome } from "./oracles.ts";

export interface RunnerOptions {
  annotations?: ParsedAnnotations | null;
  /** T1 outcome from check_candidate. */
  claims?: { checked: number; matched: number } | null;
  includeHoldout?: boolean;
  /** Structural pressure witness (packages/research), for tasks with a pressure requirement. */
  witness?: (module: Module, pressure: NonNullable<TaskSpec["pressure"]>) => { ok: boolean; diagnostic: Diagnostic | null };
  /** Fuel for examples of open-ended tasks. */
  openTaskFuel?: number;
  /** Host policy for open tasks. */
  allowedFeatures?: number;
}

const MAX_DIAGNOSTICS = 24;
const SNIP = 160;

function combine(...hooks: (EngineHooks | null | undefined)[]): EngineHooks {
  const hs = hooks.filter((h): h is EngineHooks => !!h);
  return {
    onCall: (fn, args, depth) => hs.forEach((h) => h.onCall?.(fn, args, depth)),
    onBlockEnter: (fn, b, p, e) => hs.forEach((h) => h.onBlockEnter?.(fn, b, p, e)),
    onReturn: (fn, e, r) => hs.forEach((h) => h.onReturn?.(fn, e, r)),
  };
}

function typeWord(t: TypeTag): "u64" | "bool" | "unit" | "handle" {
  return t === TypeTag.U64 ? "u64" : t === TypeTag.BOOL ? "bool" : t === TypeTag.UNIT ? "unit" : "handle";
}

function toInputs(module: Module, texts: readonly string[]): EntryInput[] {
  const entry = module.functions[module.entry]!;
  return entry.params.map((t, i) => (t === TypeTag.BOOL ? { t: "bool", v: texts[i] === "true" } : { t: "u64", v: texts[i] ?? "" }));
}

function snippet(s: string, at: number): string {
  const start = Math.max(0, at - 40);
  return JSON.stringify(s.slice(start, start + SNIP));
}

function resultText(r: RunResult): string {
  return r.returnValue ? (r.returnValue.t === "unit" ? "unit" : formatGuestValue(r.returnValue)) : "none";
}

/** Trusted parse bounds for task-author reference contracts (model annotations keep the public limits). */
export const TASK_CONTRACT_LIMITS = { maxBytes: 1 << 20, maxDepth: 4096 };

/** Build a monitor for the task author's reference contract. */
function taskMonitor(task: TaskSpec, module: Module): ContractMonitor | null {
  if (!task.referenceContract) return null;
  const entry = module.functions[module.entry]!;
  if (entry.params.length !== task.params.length) return null;
  const annotations: ParsedAnnotations = {
    summary: "task reference contract",
    params: task.paramNames.map((name, index) => ({ function: module.entry, index, name })),
    records: [],
    contracts: [{ function: module.entry, requires: null, ensures: task.referenceContract }],
    invariants: [],
    examples: [],
  };
  return createContractMonitor(annotations, module, { parseLimits: TASK_CONTRACT_LIMITS });
}

function compare(task: TaskSpec, c: TestCase, kind: "visible" | "holdout", r: RunResult, want: OracleOutcome): TestCaseResult {
  const base = { name: c.name, kind, inputs: c.inputs, expected: want.result, actual: resultText(r) };
  if (r.status === "trapped") {
    const t = r.trap!;
    const limited = t.code === "FUEL_EXHAUSTED" || t.code === "RESOURCE_EXHAUSTED";
    const d = limited
      ? diag("ANMA-K-009", { message: `The run stopped on a ${t.code === "FUEL_EXHAUSTED" ? "fuel" : "resource"} limit (${t.message}) before finishing ${c.name}.`, location: { recordIndex: t.recordIndex, byteOffset: t.byteOffset, functionId: t.functionId, blockId: t.blockId }, found: `${t.code} ${t.resource ?? ""}`.trim(), expected: `completion within ${task.fuel} executed instructions`, stage: Stage.TASK })
      : diag(t.rule, { message: `${c.name}: runtime trap ${t.code}: ${t.message}.`, location: { recordIndex: t.recordIndex, byteOffset: t.byteOffset, functionId: t.functionId, blockId: t.blockId }, found: t.message, stage: Stage.RUNTIME });
    return { ...base, passed: false, actual: `trap ${t.code}`, diagnostic: d };
  }
  if (r.status === "cancelled") {
    return {
      ...base,
      passed: false,
      actual: "still waiting for input",
      diagnostic: diag("ANMA-K-002", { message: `${c.name}: the program was still waiting for input after the recorded ticks ran out.`, expected: "return after Escape or the tick limit", stage: Stage.TASK }),
    };
  }
  const got = resultText(r);
  if (got !== want.result) {
    return { ...base, passed: false, diagnostic: diag("ANMA-K-001", { message: `${c.name}: returned ${got} but the task oracle expects ${want.result}.`, found: got, expected: want.result, derived: c.inputs.length ? `inputs: ${c.inputs.join(", ")}` : null, stage: Stage.TASK }) };
  }
  if (task.effects.includes("terminal")) {
    const text = new TextDecoder().decode(r.terminal);
    if (text !== want.terminal) {
      let at = 0;
      while (at < text.length && at < want.terminal.length && text[at] === want.terminal[at]) at++;
      return {
        ...base,
        passed: false,
        diagnostic: diag("ANMA-K-002", {
          message: `${c.name}: terminal output differs from the task oracle at byte ${at}.`,
          found: `${text.length} bytes, near ${snippet(text, at)}`,
          expected: `${want.terminal.length} bytes, near ${snippet(want.terminal, at)}`,
          stage: Stage.TASK,
        }),
      };
    }
  }
  if (task.effects.includes("framebuffer") && want.framebufferHash && r.framebufferHash !== want.framebufferHash && !r.finalFramebuffer) {
    return {
      ...base,
      passed: false,
      diagnostic: diag("ANMA-K-002", {
        message: `${c.name}: the program never draws. It does not declare the FRAMEBUFFER feature (0x4) and makes no display.* call, so the screen stays blank; the task oracle presents ${want.framesPresented ?? "at least one"} frame(s).`,
        found: `blank framebuffer (every pixel 0x00000000), ${r.framesPresented} frames presented`,
        expected: `the drawing the task describes, shown with display.present (${want.framesPresented ?? "at least one"} frame(s))`,
        stage: Stage.TASK,
      }),
    };
  }
  if (task.effects.includes("framebuffer") && want.framebufferHash && r.framebufferHash !== want.framebufferHash) {
    const d = pixelDiff(r.finalFramebuffer ?? null, want.framebuffer ?? null);
    return {
      ...base,
      passed: false,
      diagnostic: diag("ANMA-K-002", {
        message: `${c.name}: the final framebuffer differs from the task oracle${d ? ` in ${d.count} of 36864 pixels` : ""}.`,
        found: d ? `first difference at (x=${d.x}, y=${d.y}): your pixel is ${d.got}` : `framebuffer sha256 ${r.framebufferHash}`,
        expected: d ? `pixel (x=${d.x}, y=${d.y}) is ${d.want}` : `framebuffer sha256 ${want.framebufferHash}`,
        derived: d ? `differences span x ${d.x0}..${d.x1}, y ${d.y0}..${d.y1}. ${d.summary}` : null,
        stage: Stage.TASK,
      }),
    };
  }
  if (task.effects.includes("frames") && want.framesPresented !== undefined && r.framesPresented !== want.framesPresented) {
    return { ...base, passed: false, diagnostic: diag("ANMA-K-002", { message: `${c.name}: presented ${r.framesPresented} frames; the oracle presents ${want.framesPresented}.`, found: String(r.framesPresented), expected: String(want.framesPresented), stage: Stage.TASK }) };
  }
  return { ...base, passed: true, diagnostic: null };
}

const W = 256;
const H = 144;
const hexColour = (fb: Uint8Array, i: number) => `0x${[fb[i]!, fb[i + 1]!, fb[i + 2]!, fb[i + 3]!].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Pixel-level comparison of two 256x144 RGBA framebuffers (facts only; never a corrected image). */
export function pixelDiff(got: Uint8Array | null, want: Uint8Array | null): { count: number; x: number; y: number; got: string; want: string; x0: number; x1: number; y0: number; y1: number; summary: string } | null {
  if (!got || !want || got.length !== want.length) return null;
  let count = 0;
  let first = -1;
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  let extra = 0;
  let missing = 0;
  const bg = hexColour(want, 0);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (got[i] === want[i] && got[i + 1] === want[i + 1] && got[i + 2] === want[i + 2] && got[i + 3] === want[i + 3]) continue;
    count++;
    if (first < 0) first = p;
    const x = p % W;
    const y = Math.floor(p / W);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    if (hexColour(want, i) === bg) extra++;
    else missing++;
  }
  if (first < 0) return null;
  const i = first * 4;
  return {
    count,
    x: first % W,
    y: Math.floor(first / W),
    got: hexColour(got, i),
    want: hexColour(want, i),
    x0, x1, y0, y1,
    summary: `${missing} expected non-background pixel(s) are missing or wrong; ${extra} pixel(s) are drawn where the oracle has background ${bg}.`,
  };
}

function signatureMismatch(task: TaskSpec, module: Module): Diagnostic | null {
  const entry = module.functions[module.entry]!;
  const got = `(${entry.params.map(typeWord).join(", ")}) -> ${typeWord(entry.ret)}`;
  const want = `(${task.params.join(", ")}) -> ${task.returns}`;
  if (got === want) return null;
  return diag("ANMA-K-003", { message: `The entry function has signature ${got} but the task requires ${want}.`, found: got, expected: want, stage: Stage.TASK });
}

export function runTaskTests(module: Module, task: TaskSpec | null, opts: RunnerOptions = {}): TestReport {
  const ann = opts.annotations ?? null;
  const cases: TestCaseResult[] = [];
  const diagnostics: Diagnostic[] = [];
  const monitors: ContractMonitor[] = [];
  let taskContractChecks = 0;
  let taskContractViolations = 0;

  if (task) {
    const sig = signatureMismatch(task, module);
    if (sig) {
      return { taskId: task.id, passed: false, cases: [], diagnostics: [sig], tier: "T0", contractOwner: null };
    }
    const run = (c: TestCase, kind: "visible" | "holdout") => {
      const modelMon = ann && (ann.contracts.length || ann.invariants.length) ? createContractMonitor(ann, module) : null;
      const tMon = taskMonitor(task, module);
      const r = runToCompletion(module, toInputs(module, c.inputs), {
        limits: { executedInstructions: task.fuel },
        allowedFeatures: task.features,
        ...(c.ticks ? { ticks: c.ticks as TickEvent[] } : {}),
        hooks: combine(modelMon, tMon),
      });
      if (modelMon) monitors.push(modelMon);
      if (tMon) {
        taskContractChecks += tMon.checks();
        taskContractViolations += tMon.diagnostics().filter((d) => d.rule === "ANMA-K-006").length;
        for (const d of tMon.diagnostics()) diagnostics.push({ ...d, message: `Task reference contract: ${d.message}` });
      }
      cases.push(compare(task, c, kind, r, oracleFor(task, c)));
    };
    for (const c of task.visible) run(c, "visible");
    if (opts.includeHoldout !== false) for (const c of holdoutCases(task)) run(c, "holdout");
    if (task.pressure && opts.witness) {
      const w = opts.witness(module, task.pressure);
      cases.push({ name: `pressure witness (K = ${task.pressure.K})`, kind: "witness", passed: w.ok, inputs: [], expected: "certificate", actual: w.ok ? "certificate" : "rejected", diagnostic: w.diagnostic });
    }
  }

  // Model-claimed examples (labelled model-claimed; they cannot certify task intent).
  if (ann) {
    const fuel = task?.fuel ?? opts.openTaskFuel ?? 1_000_000;
    const entry = module.functions[module.entry]!;
    ann.examples.forEach((ex, i) => {
      if (ex.inputs.length !== entry.params.length || ex.inputs.some((s, k) => (entry.params[k] === TypeTag.BOOL ? s !== "true" && s !== "false" : parseU64Decimal(s) === null))) return; // reported statically (A-010)
      const modelMon = ann.contracts.length || ann.invariants.length ? createContractMonitor(ann, module) : null;
      const r = runToCompletion(module, toInputs(module, ex.inputs), {
        limits: { executedInstructions: fuel },
        allowedFeatures: task?.features ?? opts.allowedFeatures ?? module.features,
        ...(modelMon ? { hooks: modelMon } : {}),
      });
      if (modelMon) monitors.push(modelMon);
      const got = resultText(r);
      const text = new TextDecoder().decode(r.terminal);
      const problems: string[] = [];
      // runToCompletion only cancels a program that is waiting for input: examples run without ticks.
      const waiting = r.status === "cancelled";
      if (waiting) {
        if (ex.result !== null) problems.push(`the program was still waiting for input (examples run with no input ticks), so the claimed result ${ex.result} was never returned`);
        if (ex.terminal !== null && text !== ex.terminal) problems.push(`before waiting for input it printed ${JSON.stringify(text.slice(0, SNIP))}, the example claims ${JSON.stringify(ex.terminal.slice(0, SNIP))}`);
      } else if (r.status !== "halted") {
        const fuelHint = r.trap?.code === "FUEL_EXHAUSTED" ? ` (an example must finish within ${fuel.toLocaleString("en-US")} executed instructions, or wait for input with input.wait_tick)` : "";
        problems.push(r.trap ? `trapped ${r.trap.code}: ${r.trap.message}${fuelHint}` : "did not finish");
      } else {
        if (ex.result !== null && got !== ex.result) problems.push(`returned ${got}, the example claims ${ex.result}`);
        if (ex.terminal !== null && text !== ex.terminal) problems.push(`printed ${JSON.stringify(text.slice(0, SNIP))}, the example claims ${JSON.stringify(ex.terminal.slice(0, SNIP))}`);
      }
      cases.push({
        name: `model example ${i}`,
        kind: "example",
        passed: problems.length === 0,
        inputs: ex.inputs,
        expected: ex.result,
        actual: r.status === "halted" ? got : waiting ? "waiting for input" : `trap ${r.trap?.code ?? ""}`,
        diagnostic: problems.length ? diag("ANMA-K-005", { message: `Model-claimed example ${i} does not hold: ${problems.join("; ")}.`, found: problems.join("; "), expected: JSON.stringify(ex), stage: Stage.TASK }) : null,
      });
    });
  }

  let modelChecks = 0;
  let modelViolations = 0;
  for (const m of monitors) {
    modelChecks += m.checks();
    for (const d of m.diagnostics()) {
      if (d.rule === "ANMA-K-006") modelViolations++;
      diagnostics.push(d);
    }
  }
  if (modelChecks > 0 || ann?.contracts.length || ann?.invariants.length) {
    cases.push({
      name: "model contracts",
      kind: "contract",
      passed: modelViolations === 0 && !monitors.some((m) => m.diagnostics().length),
      inputs: [],
      expected: "all contracts hold",
      actual: `${modelChecks - modelViolations} of ${modelChecks} evaluations held`,
      diagnostic: null,
    });
  }
  if (task?.referenceContract && taskContractChecks > 0) {
    cases.push({ name: "task reference contract", kind: "contract", passed: taskContractViolations === 0, inputs: [], expected: task.referenceContract, actual: `${taskContractChecks - taskContractViolations} of ${taskContractChecks} evaluations held`, diagnostic: null });
  }
  for (const c of cases) if (c.diagnostic) diagnostics.push(c.diagnostic);

  const passed = cases.length > 0 && cases.every((c) => c.passed) && !diagnostics.some((d) => d.severity === "error");
  let tier: TestReport["tier"] = "T0";
  if (opts.claims && opts.claims.checked > 0 && opts.claims.matched === opts.claims.checked) tier = "T1";
  const contractHeld = (modelChecks > 0 && modelViolations === 0) || (taskContractChecks > 0 && taskContractViolations === 0);
  const examplesHeld = cases.some((c) => c.kind === "example") && cases.filter((c) => c.kind === "example").every((c) => c.passed);
  if (passed && (contractHeld || examplesHeld)) tier = "T2";
  const contractOwner: TestReport["contractOwner"] = taskContractChecks > 0 ? "task" : modelChecks > 0 ? "model" : null;
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const k = `${d.rule}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { taskId: task?.id ?? null, passed, cases, diagnostics: unique.slice(0, MAX_DIAGNOSTICS), tier, contractOwner };
}

/**
 * Redact holdout details before a report is sent to the model as loop feedback: holdout inputs
 * and expected values are never revealed; only that a hidden case failed and in which category.
 */
export function redactForModel(report: TestReport): TestReport {
  const cases = report.cases.map((c) =>
    c.kind !== "holdout"
      ? c
      : {
          ...c,
          name: "hidden holdout case",
          inputs: [],
          expected: null,
          actual: c.passed ? "passed" : "failed",
          diagnostic: c.diagnostic ? { ...c.diagnostic, message: `A hidden holdout case failed (${c.diagnostic.category}).`, found: null, expected: null, derived: null, context: null } : null,
        },
  );
  const holdoutMsgs = new Set(report.cases.filter((c) => c.kind === "holdout" && c.diagnostic).map((c) => c.diagnostic!.message));
  const diagnostics = report.diagnostics.map((d) => (holdoutMsgs.has(d.message) ? { ...d, message: `A hidden holdout case failed (${d.category}).`, found: null, expected: null, derived: null, context: null } : d));
  return { ...report, cases, diagnostics };
}
