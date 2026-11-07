// Runs the community OS: the same OsMachine the tests use, in a dedicated worker. The page sends
// keys and receives terminal text. Guest bytes never touch the page.

import { GenStatus, OsMachine, type GenProvider } from "@llmtobinary/os";
import { validateBytes } from "@llmtobinary/validate";

export type BootIn = { type: "boot"; imageHex: string; disk: Uint8Array } | { type: "keys"; keys: number[] } | { type: "gen-result"; job: number; bytes: Uint8Array | null };
export type BootOut = { type: "terminal"; text: string } | { type: "disk"; disk: Uint8Array } | { type: "state"; state: string; detail?: string } | { type: "gen-request"; job: number; prompt: string };

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
const post = (m: BootOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let os: OsMachine | null = null;
let sent = 0;
let dirty = false;
let running = false;

// The guest hands over a prompt and polls. The page decides whether it runs at all.
const jobs = new Map<number, { status: number; bytes?: Uint8Array }>();
let nextJob = 1;
const gen: GenProvider = {
  request(prompt) {
    const job = nextJob++;
    jobs.set(job, { status: GenStatus.PENDING });
    post({ type: "gen-request", job, prompt: new TextDecoder().decode(prompt) });
    return job;
  },
  poll(job) {
    return jobs.get(job) ?? { status: GenStatus.FAILED };
  },
};

function flush(): void {
  if (!os) return;
  const text = os.terminal();
  if (text.length > sent) {
    post({ type: "terminal", text: text.slice(sent) });
    sent = text.length;
  }
  if (dirty) {
    dirty = false;
    const copy = os.disk.slice();
    post({ type: "disk", disk: copy }, [copy.buffer]);
  }
}

function pump(): void {
  if (!os || running) return;
  running = true;
  const step = () => {
    const status = os!.run(250_000);
    flush();
    if (status === "paused" || status === "running") {
      setTimeout(step, 0);
      return;
    }
    running = false;
    if (status === "waiting-input") post({ type: "state", state: "ready" });
    else if (status === "halted") post({ type: "state", state: "halted" });
    else post({ type: "state", state: "stopped", detail: os!.result().trap?.message ?? status });
  };
  step();
}

self.onmessage = (e: MessageEvent<BootIn>) => {
  const m = e.data;
  if (m.type === "boot") {
    const v = validateBytes(bytesOf(m.imageHex), { anma2: true });
    if (!v.ok || !v.module) {
      post({ type: "state", state: "stopped", detail: "The OS image failed validation." });
      return;
    }
    sent = 0;
    os = new OsMachine({ kernel: v.module, disk: m.disk, fuel: Number.MAX_SAFE_INTEGER, gen, onWrite: () => void (dirty = true) });
    pump();
  } else if (m.type === "gen-result") {
    jobs.set(m.job, m.bytes ? { status: GenStatus.READY, bytes: m.bytes } : { status: GenStatus.FAILED });
  } else if (os) {
    os.pushKeys(m.keys);
    pump();
  }
};
