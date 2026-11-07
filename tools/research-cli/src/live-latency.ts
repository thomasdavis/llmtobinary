// A7.6: real generations for the OS, measured end to end through a deployed site. Every session and
// failure is counted. Spends real money within the site's own caps, so it is run by hand.
//
//   node --experimental-transform-types --no-warnings tools/research-cli/src/live-latency.ts <url> <sessions> <out.jsonl>

import { appendFileSync } from "node:fs";
import { validateBytes } from "@llmtobinary/validate";
import { OsMachine } from "@llmtobinary/os";

const [url, countText, out] = process.argv.slice(2) as [string, string, string];
const count = Number(countText);
const origin = new URL(url).origin;
const headers = { "content-type": "application/json", origin };
const GUIDE = "Write a program for a small operating system. It runs as a task with its own heap. Entry signature fn0() -> u64, with no inputs. It may print with terminal.print_u64 and terminal.print_utf8, and must return 0 when it finishes.";
const PROMPTS = ["print hello world", "print the first ten square numbers", "print a countdown from 5 to 1", "print the numbers 1 to 20 that are divisible by 3", "print the sum of 1 to 100"];
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

async function one(i: number): Promise<void> {
  const started = Date.now();
  const prompt = PROMPTS[i % PROMPTS.length]!;
  const r: Record<string, unknown> = { index: i, prompt, ok: false };
  try {
    const res = await fetch(`${url}/api/generation-sessions`, { method: "POST", headers, body: JSON.stringify({ task: { taskId: null, description: `${GUIDE}\n\nThe program: ${prompt}`, params: [], returns: "u64", allowedFeatures: 3, requireClaims: false }, mode: "tools", profile: "default" }) });
    const created = (await res.json()) as { sessionId?: string; token?: string; error?: string };
    if (!created.token) throw new Error(created.error ?? `HTTP ${res.status}`);
    const run = await fetch(`${url}/api/generation-sessions/${created.sessionId}/attempts`, { method: "POST", headers: { ...headers, authorization: `Bearer ${created.token}` }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), feedback: null }) });
    const text = await run.text();
    let hex: string | null = null;
    let tokens = 0;
    for (const l of text.split("\n").filter(Boolean)) {
      const e = JSON.parse(l) as { type?: string; envelopeText?: string; counters?: { outputTokens: number } };
      if (e.type === "candidate.submitted" && e.envelopeText) hex = (JSON.parse(e.envelopeText) as { hex: string }).hex.replace(/\s+/g, "");
      if (e.type === "loop.budget" && e.counters) tokens = e.counters.outputTokens;
    }
    r.seconds = Math.round((Date.now() - started) / 100) / 10;
    r.outputTokens = tokens;
    if (!hex) throw new Error("no submission");
    const v = validateBytes(bytesOf(hex));
    r.valid = v.ok;
    if (v.ok && v.module) {
      const m = new OsMachine({ kernel: v.module, disk: new Uint8Array(512), fuel: 2_000_000, features: 3 });
      r.status = m.run(2_000_000);
      r.printed = m.terminal().slice(0, 120);
      r.ok = r.status === "halted";
    }
  } catch (e) {
    r.error = (e as Error).message.slice(0, 200);
    r.seconds ??= Math.round((Date.now() - started) / 100) / 10;
  }
  appendFileSync(out, `${JSON.stringify(r)}\n`);
  console.log(i, r.ok ? "ok" : "failed", `${String(r.seconds)}s`, r.printed ?? r.error ?? "");
}

let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < count) await one(next++);
}));
