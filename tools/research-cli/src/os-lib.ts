// Shared by the build, the publisher and the verifier, so all three judge a package identically.

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSession, runAttempt } from "@llmtobinary/broker";
import type { LibraryAccess, ModelProfile } from "@llmtobinary/broker";
import { checkCandidate } from "@llmtobinary/check";
import { parseHex } from "@llmtobinary/decode";
import { IMPORTS_V2 } from "@llmtobinary/spec";
import type { BrowserFeedback, LoopEvent } from "@llmtobinary/protocol";
import { CODEX_LANE, CodexModelClient } from "./codex-client.ts";
import { link, type LinkInput } from "@llmtobinary/link";
import { parseModule } from "@llmtobinary/module";
import { validateBytes } from "@llmtobinary/validate";
import { OsMachine } from "@llmtobinary/os";
import { ALL, buildDisk, recordOutputs, reportForModel, runCmdTests, runKernelTests, runLibraryTests, runLiveLibraryTests, runLiveTests, runProcTests, type Failure, type Image } from "./os-tests.ts";
import { SLOTS, type ExportSpec, type Slot } from "../../../os/slots.ts";
import { LIBRARY, librarySlot } from "../../../os/library.ts";

let dir = "";
export const setBuildDir = (d: string): void => void (dir = d);

export interface Built {
  slot: string;
  hex: string;
  sha256: string;
  sessionId: string;
  model: string;
  lane: string;
  sessions: number;
  submissions: number;
  outputTokens: number;
  records: number;
  hungCalls: number;
  builtAt: string;
}

export const lockPath = (id: string) => `${dir}/${id}.json`;
export const built = (id: string): Built | null => (existsSync(lockPath(id)) ? (JSON.parse(readFileSync(lockPath(id), "utf8")) as Built) : null);
export const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

export const LIBRARY_SLOTS: Slot[] = LIBRARY.map(librarySlot);
export const bySlot = new Map([...SLOTS, ...LIBRARY_SLOTS].map((s) => [s.id, s]));
export function closure(s: Slot): Slot[] {
  const out: Slot[] = [];
  const walk = (x: Slot) => {
    for (const d of x.depends) walk(bySlot.get(d)!);
    if (!out.includes(x)) out.push(x);
  };
  walk(s);
  return out;
}

/** Every export a slot may import, in the order the prompt lists them. */
export const importsOf = (s: Slot): ExportSpec[] => s.depends.flatMap((d) => bySlot.get(d)!.exports);

export function linkInput(s: Slot, bytes: Uint8Array): LinkInput {
  const p = parseModule(bytes);
  const first = p.ok ? p.module.functions.length : 0;
  const count = p.ok ? p.module.imports.length : 0;
  const imports = Object.fromEntries(importsOf(s).slice(0, count).map((e, k) => [first + k, e.symbol]));
  return { name: s.id, bytes, exports: Object.fromEntries(s.exports.map((e) => [e.symbol, e.id])), imports };
}

/** A driver-free link: the slot's own module is the root, so its exports stay reachable for tests. */
export function linkFor(s: Slot, bytes: Uint8Array): { image: Image; bytes: Uint8Array } | { error: string } {
  const deps = closure(s).filter((d) => d !== s).map((d) => linkInput(d, bytesOf(built(d.id)!.hex)));
  const r = link([linkInput(s, bytes), ...deps]);
  if (!r.ok) return { error: r.errors.map((e) => `${e.rule}: ${e.message}`).join("; ") };
  const v = validateBytes(r.bytes, { anma2: true });
  if (!v.ok || !v.module) return { error: `the linked image failed validation: ${v.diagnostics.map((d) => d.rule).join(", ")}` };
  return { image: { module: v.module, exportMap: r.exportMap }, bytes: r.bytes };
}

export const programFiles = (): Record<string, Uint8Array> => Object.fromEntries(["hello", "crash", "spin"].map((n) => [n, bytesOf(built(n)!.hex)]));

/** Runs a slot's tests. */
export function judge(s: Slot, bytes: Uint8Array, seed: bigint | null): Failure[] {
  if (s.kind === "program") {
    const v = validateBytes(bytes, { anma2: true });
    if (!v.ok || !v.module) return [{ name: s.id, detail: "the program is not a valid standalone file", holdout: false }];
    const m = new OsMachine({ kernel: v.module, disk: new Uint8Array(512), fuel: 100_000, features: ALL });
    const status = m.run(100_000);
    const r = m.result();
    if (s.id === "hello") return status === "halted" && m.terminal() === "hello from disk\n" ? [] : [{ name: "hello", detail: `ended ${status} and printed ${JSON.stringify(m.terminal())}`, holdout: false }];
    if (s.id === "crash") return r.trap?.code === "DIVIDE_BY_ZERO" ? [] : [{ name: "crash", detail: `ended ${status} with ${r.trap?.code ?? "no trap"}, expected a divide-by-zero trap`, holdout: false }];
    return r.trap?.code === "FUEL_EXHAUSTED" || status === "paused" ? [] : [{ name: "spin", detail: `ended ${status}, expected to run forever`, holdout: false }];
  }
  const l = linkFor(s, bytes);
  if ("error" in l) return [{ name: "link", detail: l.error, holdout: false }];
  if (s.id === "proc") return runProcTests(l.image, programFiles());
  if (s.id === "cmd") return runCmdTests(l.image, programFiles());
  if (s.id === "live") return runLiveLibraryTests(l.image, bytesOf(built("hello")!.hex));
  if (s.id === "kernel" || s.id === "kernel-live") {
    const fs = linkFor(bySlot.get("fs")!, bytesOf(built("fs")!.hex));
    if ("error" in fs) return [{ name: "fs", detail: fs.error, holdout: false }];
    const disk = buildDisk(fs.image, programFiles());
    const failures = runKernelTests(l.image.module, disk, seed);
    return failures.length || s.id === "kernel" ? failures : runLiveTests(l.image.module, disk, bytesOf(built("hello")!.hex));
  }
  return runLibraryTests(s.id, l.image, seed);
}


export const BUDGET = { maxTurns: 40, maxChecks: 24, maxSubmissions: 8, maxWallClockMs: 30 * 60_000 };
const TYPE: Record<number, string> = { 0: "0 (unit)", 1: "1 (u64)", 2: "2 (bool)", 3: "3 (handle<u8>)", 4: "4 (handle<u64>)" };

export interface Generated {
  bytes: Uint8Array | null;
  sessionId: string;
  submissions: number;
  outputTokens: number;
  hungCalls: number;
  last: string;
  audit: string[];
  turns: number;
  libraryCalls: number;
  /** Imports the final program really calls, read from its bytes. */
  uses: string[];
  packages: string[];
  /** Records the model wrote itself in the final program, excluding anything linked in. */
  ownRecords: number | null;
}

/** One session through the real loop. `test` is the only judge, and the harness never edits bytes. */
export async function generate(s: Pick<Slot, "features">, prompt: string, test: (bytes: Uint8Array) => Failure[], o: { model: string; effort: string; turnTimeoutMs?: number; wallClockMs?: number; signature?: { params: "u64"[]; returns: "u64" }; plain?: boolean; library?: { access: LibraryAccess; index: string } }): Promise<Generated> {
  const budget = o.wallClockMs ? { ...BUDGET, maxWallClockMs: o.wallClockMs } : BUDGET;
  const profile: ModelProfile = { id: CODEX_LANE, label: `${o.model} via codex exec`, model: o.model, reasoningEffort: "medium", carryReasoning: false, inputPerMTok: 0, outputPerMTok: 0, maxContextChars: 400_000 };
  const client = new CodexModelClient(o);
  const events: LoopEvent[] = [];
  const state = createSession({ sessionId: randomUUID(), task: { taskId: null, description: prompt, params: o.signature?.params ?? [], returns: o.signature?.returns ?? "u64", allowedFeatures: s.features, requireClaims: false, module: !o.plain, ...(o.library ? { library: true } : {}) }, mode: "tools", profile, budget, now: Date.now(), ttlMs: 3_600_000, ...(o.library ? { libraryIndex: o.library.index } : {}) });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget.maxWallClockMs + 60_000);
  let feedback: BrowserFeedback | null = null;
  let last = "no submission";
  let passed: Uint8Array | null = null;
  let final: Extract<LoopEvent, { type: "candidate.submitted" }> | null = null;
  try {
    for (let i = 0; i <= budget.maxSubmissions && !passed; i++) {
      const before = events.length;
      await runAttempt(state, { idempotencyKey: randomUUID(), feedback }, { model: client, ledger: { reserve: async () => ({ ok: true }), reconcile: async () => {} }, emit: async (e) => void events.push(e), now: () => Date.now(), signal: abort.signal, newId: () => randomUUID(), allowedFeatures: s.features, ...(o.library ? { library: o.library.access } : {}) });
      if (state.status !== "active") {
        last = `${state.outcome}: ${state.stopDetail ?? ""}`.slice(0, 300);
        break;
      }
      const sub = events.slice(before).filter((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted").at(-1);
      if (!sub) break;
      const c = await checkCandidate({ envelopeText: sub.envelopeText }, { allowedFeatures: s.features, modules: !o.plain });
      const h = parseHex((JSON.parse(sub.envelopeText) as { hex: string }).hex);
      const failures = h.ok && c.report.ok ? test(h.bytes) : [{ name: "static check", detail: "the file did not pass the static check", holdout: false }];
      if (!failures.length && h.ok) {
        passed = h.bytes;
        final = sub;
        break;
      }
      last = reportForModel(failures);
      feedback = { candidateSha256: c.report.sha256 ?? "", validation: c.report, tests: { taskId: null, passed: false, cases: [{ name: "tests", kind: "visible", passed: false, inputs: [], expected: null, actual: last.slice(0, 2000), diagnostic: null }], diagnostics: [], tier: "T0", contractOwner: null } };
    }
  } catch (e) {
    last = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  const link = final?.candidate.link;
  const own = final ? parseHex((JSON.parse(link?.moduleText ?? final.envelopeText) as { hex: string }).hex) : null;
  const parsed = own?.ok ? parseModule(own.bytes) : null;
  return { bytes: passed, sessionId: state.sessionId, submissions: state.counters.submissions, outputTokens: state.counters.outputTokens, hungCalls: client.hungCalls, last, audit: [...new Set(client.audit.flatMap((a) => a.toolItems))], turns: state.counters.turns, libraryCalls: state.counters.libraryCalls ?? 0, uses: link?.uses ?? [], packages: link?.packages.map((p) => p.slot) ?? [], ownRecords: parsed?.ok ? parsed.module.recordCount : null };
}

export const DEVICES = IMPORTS_V2.filter((i) => i.id >= 7 && i.id !== 16).map((i) => `import ${i.id}: ${i.name}(${i.paramNames.join(", ")}), parameter types ${i.params.map((p) => TYPE[p]).join(", ") || "none"}, returns ${TYPE[i.result]}`).join("\n");

export function promptFor(s: Slot): string {
  const list = s.exports.map((e) => `function ${e.id}: ${e.symbol}${e.signature}\n  ${e.behaviour}`).join("\n");
  const imports = importsOf(s).map((e, k) => `import ${k}: ${e.symbol}${e.signature}\n  ${e.behaviour}\n  IMPORT return type ${TYPE[e.ret]}, parameter types ${e.params.map((p) => TYPE[p]).join(", ") || "none"}`).join("\n");
  const module = `This program is an ANMA-2 module: an ANMA-1 file with these differences.
- Header word 1 (version) is 2. Header word 2 may also set bit 4 (0x10, text), bit 5 (0x20, block), bit 6 (0x40, tasks) and bit 8 (0x100, gen).
- After the last END_FUNC it may list IMPORT declarations. Record 0x70 IMPORT has fields: function ID, parameter count, return type. Each IMPORT is immediately followed by its parameter count of PARAM records, where parameter k is PARAM with value ID k, its type tag, and parameter index k.
- Imports take the function IDs right after your defined functions, and CALL reaches them like any function.
- recordCount includes the IMPORT and PARAM records.
- These extra HOST operations exist:
${DEVICES}
Read-only data is allowed only in the root module.`;
  if (s.kind === "program") return `${s.brief}\nWrite a plain ANMA-1 program. Declare only the features you use.`;
  if (s.kind === "root") return `${module}\n\nDeclare feature bits 0x${s.features.toString(16)}.\n\n${s.brief}\n\nDeclare every IMPORT below, in this order, whether or not you call it:\n${imports}`;
  return `${module}\n\nWrite this library. It is linked with other modules later and has no read-only data.\nDeclare feature bits 0x${s.features.toString(16)}.\n${s.brief}\n\nFunction 0 must be a trivial entry: fn0() -> u64 returning 0. Nothing calls it.\nDefine exactly these functions with these function IDs:\n${list}\nAdd private helpers after them.${imports ? `\n\nDeclare every IMPORT below, in this order, whether or not you call it:\n${imports}` : ""}`;
}


/**
 * A hash of everything the visible tests observed. Holdouts stay out of it, so a verifier without
 * the private seed can reproduce it. Two honest verifiers must get the same value.
 */
export async function outputHashOf(s: Slot, bytes: Uint8Array): Promise<{ hash: string; failures: number }> {
  const { result, outputs } = recordOutputs(() => judge(s, bytes, null));
  const body = new TextEncoder().encode(JSON.stringify([s.id, result.map((f) => f.name), outputs]));
  const digest = await crypto.subtle.digest("SHA-256", body);
  return { hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""), failures: result.length };
}
