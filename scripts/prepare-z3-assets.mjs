// Stage the z3 solver for the browser verifier (PRD Sections 8.6, 15.5): copy z3-built.js and split
// the 34 MB wasm into chunks below Cloudflare's 25 MiB per-file static-asset limit, with a
// hash-checked manifest. Output: apps/web/public/z3/ (generated; gitignored).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../packages/verify/package.json", import.meta.url));
const pkgDir = dirname(require.resolve("z3-solver/package.json"));
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const out = new URL("../apps/web/public/z3/", import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "z3-built.js"), readFileSync(join(pkgDir, "build/z3-built.js")));
const wasm = readFileSync(join(pkgDir, "build/z3-built.wasm"));
const CHUNK = 20 * 1024 * 1024;
const chunks = [];
for (let i = 0; i * CHUNK < wasm.length; i++) {
  const name = `z3-built.wasm.part${i}`;
  writeFileSync(join(out, name), wasm.subarray(i * CHUNK, (i + 1) * CHUNK));
  chunks.push(name);
}
const manifest = { script: "z3-built.js", wasmChunks: chunks, wasmBytes: wasm.length, wasmSha256: createHash("sha256").update(wasm).digest("hex"), z3Version: version };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`z3 ${version}: ${chunks.length} wasm chunks (${wasm.length} bytes) staged in apps/web/public/z3/`);
