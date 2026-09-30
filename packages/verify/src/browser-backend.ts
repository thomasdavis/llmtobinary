// Browser solver backend (P2, Section 15.5 / 8.6). Runs inside a CLASSIC dedicated worker on a
// cross-origin-isolated page (z3's WebAssembly threads need SharedArrayBuffer). The 34 MB wasm is
// served as sub-25 MiB static chunks (Cloudflare's per-file asset limit) listed in a manifest,
// reassembled here, hash-checked, and passed to emscripten as `wasmBinary`.

import type { SolverBackend } from "./driver.ts";
import { backendFromZ3, type Z3LowLevel } from "./z3-common.ts";

export class SolverUnavailable extends Error {}

export interface SolverAssetManifest {
  script: string;
  wasmChunks: string[];
  wasmBytes: number;
  wasmSha256: string;
  z3Version: string;
}

declare const importScripts: ((...urls: string[]) => void) | undefined;

async function sha256Hex(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

let cached: Promise<SolverBackend> | null = null;

export function browserZ3Backend(baseUrl: string): Promise<SolverBackend> {
  cached ??= (async () => {
    if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
      throw new SolverUnavailable("this page is not cross-origin isolated, so SharedArrayBuffer (needed by z3's threads) is unavailable");
    }
    if (typeof importScripts !== "function") throw new SolverUnavailable("the solver must run in a classic dedicated worker");
    const res = await fetch(`${baseUrl}/manifest.json`);
    if (!res.ok) throw new SolverUnavailable(`solver assets are not deployed (${res.status})`);
    const manifest = (await res.json()) as SolverAssetManifest;
    const parts = await Promise.all(manifest.wasmChunks.map(async (c) => new Uint8Array(await (await fetch(`${baseUrl}/${c}`)).arrayBuffer())));
    const wasm = new Uint8Array(manifest.wasmBytes);
    let o = 0;
    for (const p of parts) {
      wasm.set(p, o);
      o += p.length;
    }
    if (o !== manifest.wasmBytes || (await sha256Hex(wasm)) !== manifest.wasmSha256) throw new SolverUnavailable("solver wasm chunks do not match the manifest hash");
    importScripts(`${baseUrl}/${manifest.script}`);
    const { init } = (await import("z3-solver")) as unknown as { init(overrides: object): Promise<{ Z3: Z3LowLevel }> };
    const { Z3 } = await init({ wasmBinary: wasm.buffer, mainScriptUrlOrBlob: `${baseUrl}/${manifest.script}`, locateFile: (p: string) => `${baseUrl}/${p}` });
    return backendFromZ3(Z3, "browser");
  })();
  return cached;
}
