// Boots the community OS in the browser. The disk lives in this visitor's IndexedDB, and any storage
// failure falls back to the starter disk, so the page works in a private window.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { BootIn, BootOut } from "./boot.worker.ts";
import "./community.css";
import { OsIntro } from "./Intro.tsx";
import { BuildLog, generateLogged, type LogEntry, type LogInput } from "./BuildLog.tsx";

interface Build {
  name: string;
  imageHex: string;
  imageSha256: string;
  diskHex: string;
  diskSha256: string;
  packages: { slot: string; sha256: string; records: number; model: string }[];
}

const DB = "llmtobinary-os";
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

const GUIDE = "Write a program for a small operating system. It runs as a task with its own heap. Entry signature fn0() -> u64, with no inputs. It may print with terminal.print_u64 and terminal.print_utf8, and must return 0 when it finishes.";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("disks");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function loadDisk(key: string): Promise<Uint8Array | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const q = db.transaction("disks").objectStore("disks").get(key);
      q.onsuccess = () => resolve((q.result as Uint8Array | undefined) ?? null);
      q.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveDisk(key: string, disk: Uint8Array | null): Promise<void> {
  try {
    const db = await open();
    const s = db.transaction("disks", "readwrite").objectStore("disks");
    if (disk) s.put(disk, key);
    else s.delete(key);
  } catch {
    /* The disk stays in memory for this visit. */
  }
}

/** Applies backspace, so "ab\b \b" shows as "a". */
function render(text: string): string {
  const out: string[] = [];
  for (const c of text) {
    if (c === "\b") out.pop();
    else out.push(c);
  }
  return out.join("");
}

export function Boot() {
  const [build, setBuild] = useState<Build | null | "missing">(null);
  const [screen, setScreen] = useState("");
  const [state, setState] = useState("booting");
  const [detail, setDetail] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [ask, setAsk] = useState<{ job: number; prompt: string } | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [genStatus, setGenStatus] = useState<string | null>(null);
  const logId = useRef(0);
  // After a generation, the page collects the program and runs it, watching the terminal for each step.
  const follow = useRef<{ job: number; stage: "collect" | "run"; from: number; name?: string } | null>(null);
  const screenRef = useRef("");
  const trust = useRef(false);
  const worker = useRef<Worker | null>(null);
  const term = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/default-build.json").catch(() => null);
      if (!r?.ok || !(r.headers.get("content-type") ?? "").includes("json")) return setBuild("missing");
      const base = (await r.json()) as Build;
      // A community build swaps the image and keeps the starter disk.
      const image = new URLSearchParams(location.search).get("image");
      if (!image) return setBuild(base);
      const b = await fetch(`/api/registry/${encodeURIComponent(image)}/bytes`).catch(() => null);
      if (!b?.ok) return setBuild("missing");
      const hex = [...new Uint8Array(await b.arrayBuffer())].map((x) => x.toString(16).padStart(2, "0")).join("");
      setBuild({ ...base, name: "Community build", imageHex: hex, imageSha256: image.replace("sha256:", ""), packages: [] });
    })();
  }, []);

  useEffect(() => {
    if (!build || build === "missing") return;
    let live = true;
    setScreen("");
    setState("booting");
    const w = new Worker(new URL("./boot.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e: MessageEvent<BootOut>) => {
      const m = e.data;
      if (m.type === "terminal") setScreen((s) => s + m.text);
      else if (m.type === "disk") void saveDisk(build.imageSha256, m.disk);
      else if (m.type === "gen-request") {
        if (trust.current) void runJob(m.job, m.prompt);
        else setAsk({ job: m.job, prompt: m.prompt });
      }
      else {
        setState(m.state);
        setDetail(m.detail ?? null);
      }
    };
    void loadDisk(build.imageSha256).then((saved) => {
      if (live) w.postMessage({ type: "boot", imageHex: build.imageHex, disk: saved ?? bytesOf(build.diskHex) } satisfies BootIn);
    });
    return () => {
      live = false;
      w.terminate();
    };
  }, [build, run]);

  const addLog = (job: number) => (e: LogInput) => setLog((xs) => [...xs, { ...e, id: ++logId.current, job, at: Date.now() }]);
  const typeKeys = (text: string) => worker.current?.postMessage({ type: "keys", keys: [...text].map((c) => c.charCodeAt(0)) } satisfies BootIn);
  const atPrompt = (text: string) => /(^|\n)> $/.test(text);

  useEffect(() => {
    term.current?.scrollTo(0, term.current.scrollHeight);
    const shown = render(screen);
    screenRef.current = shown;
    const f = follow.current;
    if (!f) return;
    const say = addLog(f.job);
    const fresh = shown.slice(f.from);
    if (f.stage === "collect") {
      const ok = /generated (\S+)/.exec(fresh);
      if (ok && atPrompt(shown)) {
        say({ tone: "ok", title: `The OS saved it to disk as ${ok[1]}` });
        say({ tone: "info", title: `Typed “run ${ok[1]}” in the terminal` });
        follow.current = { job: f.job, stage: "run", from: shown.length, name: ok[1]! };
        setGenStatus(`Running ${ok[1]}…`);
        typeKeys(`run ${ok[1]}\n`);
      } else if (/generation failed/.test(fresh)) {
        say({ tone: "bad", title: "The OS reports that the generation failed", output: fresh.replace(/\n> $/, "").trim() });
        follow.current = null;
      }
    } else if (f.stage === "run") {
      const lines = fresh.split("\n");
      // The echo of the command, then the program's output, then the shell's next prompt.
      if (lines.length > 1 && atPrompt(fresh)) {
        const shownOut = lines.slice(1, -1).join("\n");
        // The shell ends every run with one status word, straight after whatever the program printed.
        const end = /(ok|trapped|out of fuel|not found)$/.exec(shownOut);
        const output = end ? shownOut.slice(0, end.index) : shownOut;
        const how: Record<string, [LogInput["tone"], string]> = {
          ok: ["ok", "finished normally"],
          trapped: ["bad", "crashed (the chip trapped it), and the OS carried on"],
          "out of fuel": ["bad", "ran too long and the OS stopped it"],
          "not found": ["bad", "was not found on the disk"],
        };
        const [tone, verb] = end ? how[end[1]!]! : ["info" as const, "ran"];
        say({ tone, title: `${f.name} ${verb}. It printed:`, output: output.replace(/\n$/, "") });
        setGenStatus(null);
        follow.current = null;
      }
    }
  }, [screen]);

  // Spending happens only after this page says so, outside the guest, where a kernel cannot reach.
  async function runJob(job: number, prompt: string) {
    const say = addLog(job);
    let bytes: Uint8Array | null = null;
    try {
      bytes = await generateLogged(`${GUIDE}\n\nThe program: ${prompt}`, prompt, say, setGenStatus);
    } catch (e) {
      say({ tone: "bad", title: "The connection to the server was lost", detail: [String((e as Error)?.message ?? e)] });
    }
    setGenStatus(null);
    worker.current?.postMessage({ type: "gen-result", job, bytes } satisfies BootIn);
    say({ tone: bytes ? "info" : "bad", title: bytes ? "Handed the program to the OS" : "Told the OS the generation failed" });
    follow.current = { job, stage: "collect", from: screenRef.current.length };
    if (atPrompt(screenRef.current)) {
      say({ tone: "info", title: "Pressed Enter in the terminal so the OS collects it" });
      typeKeys("\n");
    } else say({ tone: "warn", title: "Press Enter in the terminal to collect it (you were typing, so the page didn't)" });
  }

  const answer = (allow: boolean) => {
    const a = ask!;
    setAsk(null);
    if (allow) {
      trust.current = trusted;
      void runJob(a.job, a.prompt);
    } else {
      addLog(a.job)({ tone: "warn", title: `You refused the request: “${a.prompt}”` });
      worker.current?.postMessage({ type: "gen-result", job: a.job, bytes: null } satisfies BootIn);
    }
  };

  const key = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.key === "Enter" ? 10 : e.key === "Backspace" ? 8 : e.key.length === 1 ? e.key.charCodeAt(0) : 0;
    if (!code) return;
    e.preventDefault();
    worker.current?.postMessage({ type: "keys", keys: [code] } satisfies BootIn);
  };

  const [tour, setTour] = useState(false);
  const reset = async () => {
    if (build && build !== "missing") await saveDisk(build.imageSha256, null);
    setRun((n) => n + 1);
  };

  if (build === "missing") {
    return (
      <div className="community">
        <main className="community-main">
          <h1>Boot</h1>
          <p>No OS build has been published yet.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="community">
      <nav className="community-bar" aria-label="Boot">
        <a className="community-brand" href="/">llmtobinary</a>
        <a href="/registry">Registry</a>
        <span className="community-spacer" />
        <span className="muted small">{state}</span>
        <button onClick={() => setTour(true)}>What is this?</button>
        <button onClick={() => setRun((n) => n + 1)}>Reboot</button>
        <button onClick={() => void reset()}>Reset disk</button>
      </nav>
      <main className="community-main">
        <h1>Community OS</h1>
        <p className="muted">Models wrote every instruction record of this system as literal bytes. It runs as a guest on a TypeScript virtual machine in your browser, not on hardware. Your disk stays in this browser.</p>
        <p className="tour-callout">New to this? <button className="link" onClick={() => setTour(true)}>Take the short tour</button> of how AI-written programs became this operating system.</p>
        <OsIntro open={tour} onClose={() => setTour(false)} />
        <pre className="os-terminal" ref={term} tabIndex={0} role="textbox" aria-label="Terminal" aria-multiline="true" onKeyDown={key}>
          {render(screen)}
          {state === "ready" ? "▌" : ""}
        </pre>
        {detail ? <p role="alert">{detail}</p> : null}
        {ask ? (
          <div className="os-confirm" role="alertdialog" aria-label="Allow this generation?">
            <p><strong>The OS is asking to generate a program.</strong> This page shows you what it will send. It uses your generation quota and is published to the registry.</p>
            <p className="package-prompt-full">{ask.prompt}</p>
            <label>
              <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} /> Allow for the rest of this session
            </label>
            <div className="package-actions">
              <button onClick={() => answer(true)}>Allow</button>
              <button onClick={() => answer(false)}>Refuse</button>
            </div>
          </div>
        ) : null}
        {genStatus ? <p className="muted small">Keep this tab open: closing it ends the generation.</p> : null}
        <BuildLog entries={log} status={genStatus} onClear={() => setLog([])} />
        <p className="muted small">Click the terminal, then try: <code>ls</code>, <code>run hello</code>, <code>run crash</code>, <code>write note hi</code>, <code>cat note</code>, or <code>gen NAME what to make</code>, such as <code>gen hi print hello world</code>. The first word after <code>gen</code> is the file name. The build log below shows every step, then runs the program for you.</p>
        {build ? (
          <details>
            <summary>What this build is made of</summary>
            <ul className="package-list">
              {build.packages.map((p) => (
                <li key={p.slot}>
                  <a href={`/package/sha256:${p.sha256}`}>{p.slot}</a> <span className="muted small">{p.records} records · {p.model}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </main>
    </div>
  );
}
