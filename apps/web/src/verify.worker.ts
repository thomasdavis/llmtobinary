/// <reference lib="webworker" />
// Classic dedicated worker for T3 verification (PRD Section 15.5). It loads the z3 solver from
// hash-checked static chunks (cross-origin-isolated pages only), proves the task author's reference
// contract or the model's own contracts, and reports honest labels. It never executes guest code.

import { init } from "z3-solver";
import { browserZ3Backend, SolverUnavailable, type Z3Init } from "@llmtobinary/verify/browser";
import { verifyFunction, type VerificationReport } from "@llmtobinary/verify";
import { validateBytes } from "@llmtobinary/validate";
import { parseAnnotations, type ParsedAnnotations } from "@llmtobinary/annotations";
import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { DEFAULT_LIMITS } from "@llmtobinary/spec";

declare const self: DedicatedWorkerGlobalScope;

export interface VerifyRequest {
  jobId: number;
  bytes: ArrayBuffer;
  taskId: string | null;
  annotations: unknown;
}

export type VerifyResponse = { jobId: number; ok: true; report: VerificationReport } | { jobId: number; ok: false; unavailable: string };

const TASK_LIMITS = { maxBytes: 1 << 20, maxDepth: 4096 };

// z3-solver's browser build reads `global.initZ3` (installed by importScripts); alias it in the worker.
(self as unknown as { global: unknown }).global = self;

self.onmessage = async (ev: MessageEvent<VerifyRequest>) => {
  const { jobId, bytes, taskId, annotations } = ev.data;
  try {
    const v = validateBytes(new Uint8Array(bytes));
    if (!v.ok || !v.module) throw new SolverUnavailable("only valid executables can be verified");
    const m = v.module;
    const task = taskId ? TASK_BY_ID.get(taskId) : null;
    let ann: ParsedAnnotations | null = null;
    let owner: "task" | "model" = "model";
    if (task?.referenceContract) {
      const p = parseAnnotations(
        { summary: "", params: task.paramNames.map((name, index) => ({ function: m.entry, index, name })), records: [], contracts: [{ function: m.entry, requires: null, ensures: task.referenceContract }], invariants: [], examples: [] },
        { ...DEFAULT_LIMITS, contractExpressionBytes: 1 << 20, annotationBytes: 1 << 22 },
      );
      ann = p.annotations;
      owner = "task";
    } else {
      const p = parseAnnotations(annotations);
      if (p.ok && p.annotations?.contracts.length) ann = p.annotations;
    }
    if (!ann) throw new SolverUnavailable("there is no task reference contract or model contract to prove");
    const backend = await browserZ3Backend(`${self.location.origin}/z3`, init as unknown as Z3Init);
    const report = await verifyFunction(m, ann, m.entry, backend, { contractOwner: owner, timeoutMs: 20_000, ...(owner === "task" ? { parseLimits: TASK_LIMITS } : {}) });
    self.postMessage({ jobId, ok: true, report } satisfies VerifyResponse);
  } catch (e) {
    self.postMessage({ jobId, ok: false, unavailable: (e as Error).message } satisfies VerifyResponse);
  }
};
