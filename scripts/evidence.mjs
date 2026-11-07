#!/usr/bin/env node
// Records one acceptance item: node scripts/evidence.mjs <id> <pass|fail|blocked> "<command>" "<note>"
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [id, result, command, note = ""] = process.argv.slice(2);
if (!/^A\d+\.\d+$/.test(id ?? "") || !["pass", "fail", "blocked"].includes(result)) throw new Error("usage: evidence.mjs <id> <pass|fail|blocked> <command> [note]");
const root = new URL("..", import.meta.url).pathname;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
writeFileSync(join(root, "docs/os-evidence", `${id}.json`), `${JSON.stringify({ id, result, command, commit, note, recordedAt: new Date().toISOString() }, null, 2)}\n`);
