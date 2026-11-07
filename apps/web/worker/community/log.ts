// RegistryLog Durable Object: the append-only event log. One writer, so each entry can chain to the
// previous hash without racing. Anyone can download it and verify the chain.

import { DurableObject } from "cloudflare:workers";
import { appendLog, type LogEntry } from "@llmtobinary/registry";

export class RegistryLog extends DurableObject<Env> {
  async append(e: Pick<LogEntry, "at" | "kind" | "subject" | "detail">): Promise<LogEntry> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const head = (await this.ctx.storage.get<number>("head")) ?? -1;
      const prev = head >= 0 ? ((await this.ctx.storage.get<LogEntry>(`e${head}`)) ?? null) : null;
      const entry = await appendLog(prev, e);
      await this.ctx.storage.put({ [`e${entry.seq}`]: entry, head: entry.seq });
      return entry;
    });
  }

  async page(from: number, limit: number): Promise<{ entries: LogEntry[]; head: number }> {
    const head = (await this.ctx.storage.get<number>("head")) ?? -1;
    const keys = Array.from({ length: Math.max(0, Math.min(limit, head - from + 1, 128)) }, (_, i) => `e${from + i}`);
    const got = keys.length ? await this.ctx.storage.get<LogEntry>(keys) : new Map<string, LogEntry>();
    return { entries: keys.map((k) => got.get(k)).filter((x): x is LogEntry => !!x), head };
  }
}
