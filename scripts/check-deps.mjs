// CI import-graph checks (PRD Sections 6.1, 20.2):
//  1. The Cloudflare Worker never imports an execution engine, the verifier, research code, or the
//     fixture builder (the server never executes guest code; no hidden compiler in the live path).
//  2. The live generation path (everything the Worker reaches) never imports an encoder/builder.
//  3. Package sources never import node:* (they run in browsers, workers, and workerd).
//  4. Package sources import only the @llmtobinary packages they declare.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const errors = [];
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(file) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2]);
  return out;
}

function pkgEntry(spec) {
  if (spec === "@llmtobinary/fixture-builder") return join(root, "tools/fixture-builder/src/index.ts");
  const m = /^@llmtobinary\/([a-z-]+)(?:\/([a-z-]+))?$/.exec(spec);
  if (!m) return null;
  const pkgDir = join(root, "packages", m[1]);
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const target = pj.exports?.[m[2] ? `./${m[2]}` : "."];
  if (!target) throw new Error(`${spec} is not exported by packages/${m[1]}`);
  return join(pkgDir, target);
}

/** Transitive closure of source files reachable from an entry (workspace code only). */
function graph(entry) {
  const seen = new Map(); // file -> importer chain
  const stack = [[entry, [entry]]];
  while (stack.length) {
    const [file, chain] = stack.pop();
    if (seen.has(file)) continue;
    seen.set(file, chain);
    for (const s of specifiers(file)) {
      let next = null;
      if (s.startsWith(".")) next = resolve(dirname(file), s);
      else if (s.startsWith("@llmtobinary/")) next = pkgEntry(s);
      if (next && existsSync(next)) stack.push([next, [...chain, next]]);
    }
  }
  return seen;
}

const rel = (f) => f.replace(`${root}/`, "");

// 1 + 2: the Worker graph
const FORBIDDEN_IN_WORKER = ["packages/runtime/", "packages/reference/", "packages/devices/", "packages/verify/", "packages/research/", "tools/", "packages/tasks/src/runner.ts", "packages/tasks/src/oracles.ts"];
const workerGraph = graph(join(root, "apps/web/worker/index.ts"));
for (const [file, chain] of workerGraph) {
  const r = rel(file);
  if (FORBIDDEN_IN_WORKER.some((f) => r.startsWith(f))) errors.push(`worker reaches ${r} via ${chain.map(rel).join(" -> ")}`);
}
// The live generation path also covers the browser's check pipeline.
for (const [file, chain] of graph(join(root, "packages/check/src/index.ts"))) {
  const r = rel(file);
  if (r.startsWith("tools/") || /builder|encoder|assembl/i.test(r)) errors.push(`live check path reaches an encoder/builder ${r} via ${chain.map(rel).join(" -> ")}`);
}

// 3 + 4: package sources
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
for (const pkg of readdirSync(join(root, "packages"))) {
  const dir = join(root, "packages", pkg);
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declared = new Set(Object.keys(pj.dependencies ?? {}));
  for (const file of walk(join(dir, "src"))) {
    for (const s of specifiers(file)) {
      if (s.startsWith("node:")) errors.push(`${rel(file)} imports ${s} (package sources must be runtime-neutral)`);
      const m = /^(@llmtobinary\/[a-z-]+)/.exec(s);
      if (m && m[1] !== pj.name && !declared.has(m[1])) errors.push(`${rel(file)} imports ${m[1]} without declaring it in packages/${pkg}/package.json`);
      if (s.includes("fixture-builder") || s.includes("/tools/")) errors.push(`${rel(file)} imports the developer fixture builder`);
    }
  }
}

if (errors.length) {
  console.error(`check-deps: ${errors.length} problem(s)\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-deps: ok (worker graph ${workerGraph.size} files; no engines, verifier, research, or builders; package imports declared)`);
