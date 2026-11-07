// Shared by the build, the publisher and the verifier, so all three judge a package identically.

import { existsSync, readFileSync } from "node:fs";
import { link, type LinkInput } from "@llmtobinary/link";
import { parseModule } from "@llmtobinary/module";
import { validateBytes } from "@llmtobinary/validate";
import { OsMachine } from "@llmtobinary/os";
import { ALL, buildDisk, runKernelTests, runLibraryTests, runProcTests, type Failure, type Image } from "./os-tests.ts";
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
  if (s.id === "kernel") {
    const fs = linkFor(bySlot.get("fs")!, bytesOf(built("fs")!.hex));
    if ("error" in fs) return [{ name: "fs", detail: fs.error, holdout: false }];
    return runKernelTests(l.image.module, buildDisk(fs.image, programFiles()), seed);
  }
  return runLibraryTests(s.id, l.image, seed);
}

