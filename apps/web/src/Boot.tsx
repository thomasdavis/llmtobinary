// Boots the community OS in the browser. The disk lives in this visitor's IndexedDB, and any storage
// failure falls back to the starter disk, so the page works in a private window.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { BootIn, BootOut } from "./boot.worker.ts";
import "./community.css";

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
  const worker = useRef<Worker | null>(null);
  const term = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/os/default-build.json").catch(() => null);
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

  useEffect(() => {
    term.current?.scrollTo(0, term.current.scrollHeight);
  }, [screen]);

  const key = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.key === "Enter" ? 10 : e.key === "Backspace" ? 8 : e.key.length === 1 ? e.key.charCodeAt(0) : 0;
    if (!code) return;
    e.preventDefault();
    worker.current?.postMessage({ type: "keys", keys: [code] } satisfies BootIn);
  };

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
        <button onClick={() => setRun((n) => n + 1)}>Reboot</button>
        <button onClick={() => void reset()}>Reset disk</button>
      </nav>
      <main className="community-main">
        <h1>Community OS</h1>
        <p className="muted">Models wrote every instruction record of this system as literal bytes. It runs as a guest on a TypeScript virtual machine in your browser, not on hardware. Your disk stays in this browser.</p>
        <pre className="os-terminal" ref={term} tabIndex={0} role="textbox" aria-label="Terminal" aria-multiline="true" onKeyDown={key}>
          {render(screen)}
          {state === "ready" ? "▌" : ""}
        </pre>
        {detail ? <p role="alert">{detail}</p> : null}
        <p className="muted small">Click the terminal, then try: ls, run hello, run crash, write note hi, cat note.</p>
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
