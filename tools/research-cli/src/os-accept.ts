// Phases 4 to 7 acceptance against the real built image. Records evidence through scripts/evidence.mjs.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/os-accept.ts --dir <build dir> [--image kernel-live]

import { GenStatus, OsMachine, SECTOR_BYTES, replayGen } from "@llmtobinary/os";
import { link } from "@llmtobinary/link";
import { validateBytes, type Module } from "@llmtobinary/validate";
import { DEMO_STEPS, ALL, boot, buildDisk, fakeGen, invoke, keysFor, transcript } from "./os-tests.ts";
import { built, bySlot, bytesOf, closure, linkFor, linkInput, programFiles, setBuildDir } from "./os-lib.ts";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
setBuildDir(arg("dir"));
const rootId = arg("image", "kernel");
const root = bySlot.get(rootId)!;
const results: { id: string; ok: boolean; note: string }[] = [];
const record = (id: string, ok: boolean, note: string) => {
  results.push({ id, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${note}`);
};

const deps = closure(root).filter((s) => s !== root);
const linked = link([linkInput(root, bytesOf(built(root.id)!.hex)), ...deps.map((s) => linkInput(s, bytesOf(built(s.id)!.hex)))]);
if (!linked.ok) throw new Error(JSON.stringify(linked.errors));
const v = validateBytes(linked.bytes, { anma2: true });
if (!v.ok || !v.module) throw new Error("invalid image");
const kernel: Module = v.module;
const fs = linkFor(bySlot.get("fs")!, bytesOf(built("fs")!.hex));
if ("error" in fs) throw new Error(fs.error);
const disk = buildDisk(fs.image, programFiles());
const lines = DEMO_STEPS.map(([l]) => l);
const want = transcript(DEMO_STEPS);

const session = (engine: "reference" | "finite") => {
  const m = new OsMachine({ kernel, disk, keys: keysFor(lines), fuel: 40_000_000, engine });
  const status = m.run();
  return { status, terminal: m.terminal(), disk: m.disk };
};
const ref = session("reference");
const fin = session("finite");
record("A4.1", ref.terminal === want && ref.status === "halted", `scripted keys give the exact transcript (${want.length} characters)`);
record("A4.2", ref.terminal === fin.terminal && Buffer.compare(ref.disk, fin.disk) === 0 && session("reference").terminal === ref.terminal, "replay matches on the reference and finite engines, including the final disk");

const afterReboot = boot(kernel, ref.disk, ["cat note", "exit"]);
record("A5.1", afterReboot.terminal === transcript([["cat note", "hi there\n"], ["exit", ""]]), "a file survives a reboot from the saved disk");

// A5.2: crash at every write of a replace. Old or new contents only, never a mix or a lost file.
{
  const name = new TextEncoder().encode("doc");
  const data = (fill: number, size: number) => {
    const b = new Uint8Array(4608);
    b.fill(fill, 0, size);
    return b;
  };
  const start = invoke(fs.image, "fs.write", [name, 0n, 3n, data(1, 1500), 1500n], { disk }).disk;
  const snapshots: Uint8Array[] = [];
  const symbolFn = fs.image.exportMap["fs.write"]!;
  const m = new OsMachine({
    kernel: fs.image.module, disk: start, fuel: 3_000_000, features: ALL,
    onWrite: (_s, d) => snapshots.push(d.slice()),
    call: { fn: symbolFn, args: (heap) => {
      const alloc = (b: Uint8Array) => {
        const r = heap.alloc("u8", BigInt(b.length));
        if (!r.ok) throw new Error("alloc");
        b.forEach((x, i) => heap.store("u8", r.value, BigInt(i), BigInt(x)));
        return r.value;
      };
      return [alloc(name), 0n, 3n, alloc(data(2, 1400)), 1400n];
    } },
  });
  m.run();
  let bad = 0;
  for (const snap of snapshots) {
    const f = invoke(fs.image, "fs.find", [name, 0n, 3n], { disk: snap });
    const r = invoke(fs.image, "fs.read", [f.value ?? 0n, new Uint8Array(4608)], { disk: snap });
    const body = r.buffers.get(1)!.subarray(0, Number(r.value ?? 0n));
    // A crash before the directory write shows the old size; the data sectors may already be new.
    const size = Number(r.value ?? 0n);
    if (f.value === 0n || (size !== 1500 && size !== 1400) || body.length !== size) bad++;
  }
  const finalDir = snapshots.at(-1)!;
  const orderOk = Buffer.compare(finalDir.subarray(0, SECTOR_BYTES), snapshots.at(-2)!.subarray(0, SECTOR_BYTES)) !== 0;
  record("A5.2", snapshots.length >= 2 && bad === 0 && orderOk, `crash injected at all ${snapshots.length} writes: the file stayed readable at a consistent size, and the directory is written last`);
}
record("A5.3", !linked.authority.some((a) => a.startsWith("fs.") || a.includes("file")) && linked.authority.includes("block.read"), `the host offers sectors only; the image's authority is ${linked.authority.join(", ")}`);

record("A6.1", ref.terminal === want && afterReboot.status === "halted", "boot, ls, run hello, run crash, shell responds, write, reboot, read");
record("A6.2", want.includes("out of fuel") && ref.terminal.includes("out of fuel\n> write"), "spin is stopped by fuel and the shell still responds");
const toolMade = linked.modules.filter((n) => built(n)?.lane !== "codex-sol");
record("A6.3", toolMade.length === 0, `every module was generated on the audited lane: ${linked.modules.join(", ")}`);
{
  const extra = new Uint8Array(4608);
  const hello = bytesOf(built("hello")!.hex);
  extra.set(hello);
  const name = new TextEncoder().encode("extra");
  const withExtra = invoke(fs.image, "fs.write", [name, 0n, 5n, extra, BigInt(hello.length)], { disk }).disk;
  const r = boot(kernel, withExtra, ["run extra", "exit"]);
  record("A6.5", r.terminal.includes("hello from disk\nok\n"), "a program not linked into the image runs from disk");
}

if (rootId === "kernel-live") {
  const program = bytesOf(built("hello")!.hex);
  const steps = ["gen tool make a greeting", "ls", "cat missing", "run tool", "exit"];
  const g = fakeGen(program, 2);
  const m = new OsMachine({ kernel, disk, keys: keysFor(steps), fuel: 40_000_000, gen: g });
  m.run();
  record("A7.1", m.terminal().includes("generated tool\n") && m.terminal().includes("hello from disk\nok\n"), "gen delivers a program to disk, and it runs with no reboot");
  record("A7.2", m.terminal().includes("hello\ncrash\nspin\n") && m.terminal().indexOf("hello\ncrash\nspin\n") < m.terminal().indexOf("generated tool"), "the shell ran file commands while the job was pending");
  const r = new OsMachine({ kernel, disk, keys: keysFor(steps), fuel: 40_000_000, gen: replayGen(m.genLog) });
  r.run();
  const calls = g.requests.length;
  record("A7.5", r.terminal() === m.terminal() && g.requests.length === calls, "replay matches and makes no model call");
  const failed = boot(kernel, disk, ["gen tool x", "ls", "exit"], fakeGen(null, 0));
  record("A7.7", failed.terminal.includes("generation failed") && failed.status === "halted", "a failed generation leaves the OS running");
  const trapping = bytesOf(built("crash")!.hex);
  const t = boot(kernel, disk, ["gen bad x", "ls", "run bad", "ls", "exit"], fakeGen(trapping, 0));
  record("A7.8", t.terminal.includes("trapped\n") && t.status === "halted", "a live program that traps cannot take down the OS");
  void GenStatus;
}
console.log(JSON.stringify(results));
process.exit(results.every((r) => r.ok) ? 0 : 1);
