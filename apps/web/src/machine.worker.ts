/// <reference lib="webworker" />
// The machine Web Worker: validates and executes guest bytes off the UI thread in bounded
// instruction chunks, yielding between chunks so Pause/Stop work mid-run. It never evaluates
// guest-derived code and has no credentials. Snapshots are throttled, never per instruction.

import { validateBytes, type Module } from "@llmtobinary/validate";
import { createFiniteMachine, type FiniteMachine } from "@llmtobinary/runtime";
import { runTaskTests, redactForModel, TASK_BY_ID } from "@llmtobinary/tasks";
import { parseAnnotations } from "@llmtobinary/annotations";
import { capstoneWitness, runInvariance } from "@llmtobinary/research";
import type { TickEvent } from "@llmtobinary/protocol";
import type { CompareRow, FromChip, FromMachine, ToChip, ToMachine } from "./worker-protocol.ts";
import { handleChip } from "./chip/chip-worker.ts";

declare const self: DedicatedWorkerGlobalScope;

const CHUNK = 20_000;
const SLICE_MS = 30;
const SNAPSHOT_MS = 100;

let machine: FiniteMachine | null = null;
let runId = -1;
let running = false;
let lastSnap = 0;
let lastFrames = -1;

const post = (m: FromMachine, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function frame(): Uint8ClampedArray | null {
  const f = machine?.devices.presentedFrame();
  return f ? new Uint8ClampedArray(f) : null;
}

function terminalText(): string {
  return machine ? new TextDecoder().decode(machine.devices.terminal()) : "";
}

function sendState(force = false): void {
  if (!machine) return;
  const now = performance.now();
  if (!force && now - lastSnap < SNAPSHOT_MS) return;
  lastSnap = now;
  const fp = machine.devices.framesPresented;
  const f = fp !== lastFrames ? frame() : null;
  lastFrames = fp;
  post({ type: "state", runId, snapshot: machine.snapshot(), terminal: terminalText(), frame: f, framesPresented: fp }, f ? [f.buffer] : []);
}

function finished(): boolean {
  const s = machine?.status;
  return s === "halted" || s === "trapped" || s === "cancelled";
}

function sendDone(): void {
  if (!machine) return;
  const f = frame();
  post({ type: "done", runId, result: machine.result(), snapshot: machine.snapshot(), terminal: terminalText(), frame: f }, f ? [f.buffer] : []);
}

function loop(id: number): void {
  if (id !== runId || !machine || !running) return;
  const t0 = performance.now();
  while (performance.now() - t0 < SLICE_MS) {
    const s = machine.run(CHUNK);
    if (s !== "paused") break;
  }
  if (finished()) {
    running = false;
    sendDone();
    return;
  }
  sendState();
  if (machine.status === "waiting-input") {
    running = true; // resumed by the next tick message
    return;
  }
  setTimeout(() => loop(id), 0);
}

function copy(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf.slice(0));
}

function validated(bytes: Uint8Array, allowedFeatures: number): Module {
  const v = validateBytes(bytes, { allowedFeatures });
  if (!v.ok || !v.module) {
    const first = v.diagnostics.find((d) => d.severity === "error");
    throw new Error(first ? `${first.rule}: ${first.message}` : "invalid executable");
  }
  return v.module;
}

self.onmessage = (ev: MessageEvent<ToMachine | ToChip>) => {
  if (ev.data.type.startsWith("chip-")) {
    handleChip(ev.data as ToChip, (r: FromChip) => self.postMessage(r));
    return;
  }
  const m = ev.data as ToMachine;
  try {
    switch (m.type) {
      case "load": {
        runId = m.runId;
        running = false;
        lastFrames = -1;
        const module = validated(copy(m.bytes), m.allowedFeatures);
        machine = createFiniteMachine(module, m.inputs, { config: m.config, allowedFeatures: m.allowedFeatures, ticks: m.ticks });
        post({ type: "loaded", runId });
        sendState(true);
        return;
      }
      case "run":
        if (m.runId !== runId || !machine || finished()) return;
        running = true;
        loop(runId);
        return;
      case "pause":
        if (m.runId !== runId) return;
        running = false;
        sendState(true);
        return;
      case "step":
        if (m.runId !== runId || !machine || finished()) return;
        running = false;
        machine.step();
        if (finished()) sendDone();
        else sendState(true);
        return;
      case "stop":
        if (m.runId !== runId || !machine) return;
        running = false;
        machine.cancel();
        sendDone();
        return;
      case "tick":
        if (m.runId !== runId || !machine || finished()) return;
        try {
          machine.pushTick(m.event);
        } catch {
          return; // out-of-order or full queue: the event is dropped, never half-applied
        }
        if (running && machine.status !== "running") loop(runId);
        return;
      case "test": {
        const bytes = copy(m.bytes);
        const module = validated(bytes, m.allowedFeatures);
        const task = m.taskId ? (TASK_BY_ID.get(m.taskId) ?? null) : null;
        const ann = parseAnnotations(m.annotations);
        const witnessResults: unknown[] = [];
        const report = runTaskTests(module, task, {
          annotations: ann.ok ? ann.annotations : null,
          claims: m.claims,
          allowedFeatures: m.allowedFeatures,
          witness: (mod, p) => {
            const w = capstoneWitness(mod, p.K, p.stride);
            witnessResults.push(w.ok ? w.certificate : w.diagnostic);
            return { ok: w.ok, diagnostic: w.diagnostic };
          },
        });
        post({ type: "test-result", jobId: m.jobId, report, modelReport: redactForModel(report), witness: witnessResults[0] ?? null });
        return;
      }
      case "compare": {
        const module = validated(copy(m.bytes), m.allowedFeatures);
        const rep = runInvariance(module, m.inputs, { Fs: m.Fs, ticks: m.ticks as TickEvent[] });
        const rows: CompareRow[] = rep.rows.map((r) => ({
          F: r.F,
          status: r.status,
          trap: r.trap,
          returnValue: r.returnValue,
          terminalSha256: r.terminalSha256,
          effectsHash: r.effectsHash,
          framebufferHash: r.framebufferHash,
          backingReads: r.counters.backingReads ?? 0,
          backingWrites: r.counters.backingWrites ?? 0,
          operandMisses: r.counters.operandMisses ?? 0,
          evictions: r.counters.evictions ?? 0,
          microsteps: r.counters.microsteps ?? 0,
          executedInstructions: r.counters.executedInstructions ?? 0,
          peakLiveValues: r.counters.peakLiveValues ?? 0,
        }));
        post({ type: "compare-result", jobId: m.jobId, rows, reference: rep.reference, semanticAgreement: rep.semanticAgreement, missingBackingActivity: rep.missingBackingActivity, resourceLimited: rep.resourceLimited });
        return;
      }
    }
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if ("jobId" in m) post({ type: "job-error", jobId: m.jobId, message });
    else post({ type: "load-error", runId: "runId" in m ? m.runId : -1, message });
  }
};
