// BudgetLedger Durable Object (PRD Section 8.3): one named instance per environment. Every
// reserve/reconcile runs inside blockConcurrencyWhile, so no other request can interleave between
// reading the totals and writing them (explicit atomicity, not an assumption about input gates).
// Amounts are integer micro-dollars. Unknown usage keeps the full reservation charged (never shown
// as zero). Aggregate spend persists independently of session TTLs.

import { DurableObject } from "cloudflare:workers";

interface DayTotals {
  committedMicros: number;
  turns: number;
  unknownTurns: number;
}

interface TurnRecord {
  micros: number;
  sessionId: string;
  day: string;
}

export interface LedgerSummary {
  day: string;
  committedUsd: number;
  turns: number;
  unknownTurns: number;
  dailyCapUsd: number;
  sessionCapUsd: number;
}

const MICROS = 1_000_000;
const toMicros = (usd: number) => Math.ceil(usd * MICROS);

function day(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class BudgetLedger extends DurableObject<Env> {
  private caps() {
    const daily = Number(this.env.DAILY_USD_CAP ?? "0");
    const session = Number(this.env.SESSION_USD_CAP ?? "0");
    return { daily: Number.isFinite(daily) ? daily : 0, session: Number.isFinite(session) ? session : 0 };
  }

  private totals(d: string): Promise<DayTotals> {
    return this.ctx.storage.get<DayTotals>(`day:${d}`).then((t) => t ?? { committedMicros: 0, turns: 0, unknownTurns: 0 });
  }

  async reserve(sessionId: string, turnId: string, usd: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!(usd >= 0) || !Number.isFinite(usd)) return { ok: false, reason: "invalid reservation" };
    const caps = this.caps();
    if (caps.daily <= 0 || caps.session <= 0) return { ok: false, reason: "no spend is approved for this environment" };
    const micros = toMicros(usd);
    return this.ctx.blockConcurrencyWhile(async () => {
      const d = day(Date.now());
      const totals = await this.totals(d);
      const sessionMicros = (await this.ctx.storage.get<number>(`sess:${sessionId}`)) ?? 0;
      if (totals.committedMicros + micros > toMicros(caps.daily)) return { ok: false as const, reason: `the daily cap of $${caps.daily.toFixed(2)} would be exceeded` };
      if (sessionMicros + micros > toMicros(caps.session)) return { ok: false as const, reason: `the per-session cap of $${caps.session.toFixed(2)} would be exceeded` };
      totals.committedMicros += micros;
      totals.turns++;
      await this.ctx.storage.put({ [`day:${d}`]: totals, [`sess:${sessionId}`]: sessionMicros + micros, [`turn:${turnId}`]: { micros, sessionId, day: d } satisfies TurnRecord });
      return { ok: true as const };
    });
  }

  async reconcile(turnId: string, actualUsd: number | null): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const t = await this.ctx.storage.get<TurnRecord>(`turn:${turnId}`);
      if (!t) return;
      const totals = await this.totals(t.day);
      if (actualUsd === null || !Number.isFinite(actualUsd)) {
        totals.unknownTurns++;
      } else {
        const delta = toMicros(actualUsd) - t.micros;
        totals.committedMicros = Math.max(0, totals.committedMicros + delta);
        const sessionMicros = (await this.ctx.storage.get<number>(`sess:${t.sessionId}`)) ?? 0;
        await this.ctx.storage.put(`sess:${t.sessionId}`, Math.max(0, sessionMicros + delta));
      }
      await this.ctx.storage.put(`day:${t.day}`, totals);
      await this.ctx.storage.delete(`turn:${turnId}`);
    });
  }

  async summary(): Promise<LedgerSummary> {
    const d = day(Date.now());
    const t = await this.totals(d);
    const caps = this.caps();
    return { day: d, committedUsd: t.committedMicros / MICROS, turns: t.turns, unknownTurns: t.unknownTurns, dailyCapUsd: caps.daily, sessionCapUsd: caps.session };
  }
}
