// Chip-view sessions inside the machine Web Worker. They drive the SAME engines as the machine panel
// (the fifo-v1 finite machine and the ANMR-1 stepping machine) with an onEvent listener; nothing
// here re-implements execution. Each step returns the exact microsteps the engine performed.

import { validateBytes } from "@llmtobinary/validate";
import { disassemble } from "@llmtobinary/decode";
import { createFiniteMachine, type FiniteMachine } from "@llmtobinary/runtime";
import { AnmrMachine, anmrClaim, validateAnmr } from "@llmtobinary/research";
import type { ChipUnit, MicroEvent } from "@llmtobinary/protocol";
import type { ChipCell, ChipState, ChipStep, FromChip, ToChip } from "../worker-protocol.ts";
import { isSpillTraffic, unitsOf } from "./units.ts";

const MAX_EVENTS_PER_STEP = 600;
const MAX_STEPS_PER_BATCH = 400;

interface Session {
  kind: "ANMA-1" | "ANMR-1";
  anma: FiniteMachine | null;
  anmr: AnmrMachine | null;
  n: number;
  sink: ((e: MicroEvent) => void) | null;
}

const sessions = new Map<number, Session>();

function shortName(value: string | null): string | null {
  if (!value) return null;
  const i = value.lastIndexOf(".");
  return i >= 0 ? value.slice(i + 1) : value;
}

function stateOf(s: Session): ChipState {
  if (s.anma) {
    const snap = s.anma.snapshot();
    const r = s.anma.status === "halted" || s.anma.status === "trapped" ? s.anma.result() : null;
    const cells: ChipCell[] = snap.slots.map((c) => ({ label: shortName(c.value), value: c.value, payload: c.payload }));
    const counters: Record<string, number> = {};
    for (const [k, v] of Object.entries(snap.counters)) if (typeof v === "number") counters[k] = v;
    const terminal = new TextDecoder().decode(s.anma.devices.terminal());
    return {
      isa: "ANMA-1",
      status: snap.status,
      rec: snap.position?.recordIndex ?? null,
      text: snap.position ? disassemble(s.anma.module.records[snap.position.recordIndex]!) : "",
      cells,
      memOccupied: snap.backing.occupied,
      memCapacity: snap.backing.capacity,
      latches: snap.latches,
      frames: snap.frames.length,
      depth: snap.position ? snap.position.depth + 1 : 1,
      liveValues: snap.liveValues,
      counters,
      terminal: terminal.length > 2000 ? terminal.slice(-2000) : terminal,
      result: r?.returnValue ? (r.returnValue.t === "u64" ? r.returnValue.v : r.returnValue.t === "bool" ? String(r.returnValue.v) : r.returnValue.t) : null,
      trap: r?.trap ? `${r.trap.code}: ${r.trap.message}` : null,
    };
  }
  const m = s.anmr!;
  const cells: ChipCell[] = m.regs.map((v, i) => ({ label: v === undefined ? null : `r${i}`, value: v === undefined ? null : `r${i}`, payload: v === undefined ? null : v.toString() }));
  const memOccupied: number[] = [];
  m.slots.forEach((v, i) => v !== undefined && memOccupied.push(i));
  const ins = m.program.instrs[m.pc];
  return {
    isa: "ANMR-1",
    status: m.status === "ready" ? (m.counters.instructions ? "paused" : "ready") : m.status,
    rec: ins ? ins.rec : null,
    text: ins ? anmrClaim(ins) : "",
    cells,
    memOccupied,
    memCapacity: m.program.S,
    latches: { A: null, B: null, R: null },
    frames: 1,
    depth: 1,
    liveValues: m.regs.filter((v) => v !== undefined).length + memOccupied.length,
    counters: { ...m.counters, executedInstructions: m.counters.instructions },
    terminal: "",
    result: m.value !== null ? m.value.toString() : null,
    trap: m.trap ? `${m.trap.rule}: ${m.trap.message}` : null,
  };
}

function finished(s: Session): boolean {
  if (s.anma) return ["halted", "trapped", "cancelled", "waiting-input"].includes(s.anma.status);
  return s.anmr!.status !== "ready";
}

function stepOnce(s: Session): ChipStep | null {
  if (finished(s)) return null;
  const events: MicroEvent[] = [];
  s.sink = (e) => {
    if (events.length < MAX_EVENTS_PER_STEP) events.push(e);
  };
  let rec: number | null = null;
  let text = "";
  if (s.anma) {
    rec = s.anma.position()?.recordIndex ?? null;
    text = rec !== null ? disassemble(s.anma.module.records[rec]!) : "";
    s.anma.step();
  } else {
    const ins = s.anmr!.program.instrs[s.anmr!.pc]!;
    rec = ins.rec;
    text = anmrClaim(ins);
    s.anmr!.step();
  }
  s.sink = null;
  return { n: ++s.n, rec, text, events };
}

export function handleChip(m: ToChip, post: (r: FromChip) => void): void {
  try {
    switch (m.type) {
      case "chip-load": {
        const bytes = new Uint8Array(m.bytes.slice(0));
        const prologue: MicroEvent[] = [];
        const s: Session = { kind: m.isa, anma: null, anmr: null, n: 0, sink: (e) => prologue.push(e) };
        if (m.isa === "ANMA-1") {
          const v = validateBytes(bytes, { allowedFeatures: m.allowedFeatures });
          if (!v.ok || !v.module) throw new Error(v.diagnostics.find((d) => d.severity === "error")?.message ?? "invalid executable");
          s.anma = createFiniteMachine(v.module, m.inputs, { config: { fastSlots: m.fastSlots, policy: "fifo-v1", trace: false }, allowedFeatures: m.allowedFeatures, ticks: m.ticks, onEvent: (e) => s.sink?.(e) });
        } else {
          const v = validateAnmr(bytes);
          if (!v.ok) throw new Error(v.diagnostics[0]?.message ?? "invalid ANMR-1 program");
          const x = m.inputs[0] && m.inputs[0].t === "u64" ? BigInt(m.inputs[0].v) : 0n;
          s.anmr = new AnmrMachine(v.program, x, (e) => s.sink?.(e));
        }
        s.sink = null;
        sessions.set(m.chipId, s);
        post({ type: "chip-loaded", chipId: m.chipId, state: stateOf(s), prologue: { n: 0, rec: null, text: "entry: arguments installed as block 0 parameters", events: prologue } });
        return;
      }
      case "chip-step": {
        const s = sessions.get(m.chipId);
        if (!s) throw new Error("no chip session");
        const steps: ChipStep[] = [];
        for (let i = 0; i < Math.min(m.instructions, MAX_STEPS_PER_BATCH); i++) {
          const st = stepOnce(s);
          if (!st) break;
          steps.push(st);
        }
        post({ type: "chip-steps", chipId: m.chipId, steps, state: stateOf(s) });
        return;
      }
      case "chip-run": {
        const s = sessions.get(m.chipId);
        if (!s) throw new Error("no chip session");
        const activity: Partial<Record<ChipUnit, number>> = {};
        let spill = 0;
        s.sink = (e) => {
          for (const u of unitsOf(e)) activity[u] = (activity[u] ?? 0) + 1;
          if (isSpillTraffic(e)) spill++;
        };
        const t0 = performance.now();
        let done = 0;
        while (done < m.maxInstructions && performance.now() - t0 < m.maxMs && !finished(s)) {
          if (s.anma) {
            const before = s.anma.counters.executedInstructions;
            s.anma.run(Math.min(5000, m.maxInstructions - done));
            done += s.anma.counters.executedInstructions - before;
          } else {
            s.anmr!.step();
            done++;
          }
        }
        s.n += done;
        s.sink = null;
        post({ type: "chip-heat", chipId: m.chipId, activity, spill, instructions: done, state: stateOf(s) });
        return;
      }
    }
  } catch (e) {
    post({ type: "chip-error", chipId: m.chipId, message: (e as Error)?.message ?? String(e) });
  }
}
