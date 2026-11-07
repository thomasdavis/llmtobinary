#!/usr/bin/env node
// Evaluates PRD-OS section 8 from evidence files. An item with no evidence is pending, never a
// pass, and evidence only counts if its commit is an ancestor of HEAD. Exit 0 only when all pass.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const prd = readFileSync(join(root, "PRD-OS.md"), "utf8");
const ids = [...prd.matchAll(/^\| (A\d+\.\d+) \|/gm)].map((m) => m[1]);
if (!ids.length) throw new Error("no acceptance items found in PRD-OS.md");

const ancestor = (commit) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const counts = { pass: 0, fail: 0, blocked: 0, pending: 0, stale: 0 };
for (const id of ids) {
  const file = join(root, "docs/os-evidence", `${id}.json`);
  let state = "pending";
  let note = "";
  if (existsSync(file)) {
    const e = JSON.parse(readFileSync(file, "utf8"));
    note = e.note ?? "";
    if (e.result === "blocked") state = "blocked";
    else if (e.result === "fail") state = "fail";
    else if (e.result !== "pass" || !e.command || !e.commit) state = "fail";
    else state = ancestor(e.commit) ? "pass" : "stale";
  }
  counts[state]++;
  console.log(`${id.padEnd(6)} ${state.padEnd(8)} ${note}`);
}
console.log(`\n${ids.length} items: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
process.exit(counts.pass === ids.length ? 0 : 1);
