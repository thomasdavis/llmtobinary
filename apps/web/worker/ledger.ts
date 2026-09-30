// BudgetLedger Durable Object (PRD Section 8.3): one named instance per environment. Reservations
// are atomic because a Durable Object processes one request at a time and storage operations do
// not open its input gate. Unknown usage keeps the full reservation charged (never shown as zero).
// Aggregate spend persists independently of session TTLs.

import { DurableObject } from "cloudflare:workers";

interface DayTotals {
  committedUsd: number;
  turns: number;
  unknownTurns: number;
}

interface TurnRecord {
  usd: number;
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

function day(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class BudgetLedger extends DurableObject<Env> {
  private caps() {
    const daily = Number(this.env.DAILY_USD_CAP ?? "0");
    const session = Number(this.env.SESSION_USD_CAP ?? "0");
    return { daily: Number.isFinite(daily) ? daily : 0, session: Number.isFinite(session) ? session : 0 };
  }

  async reserve(sessionId: string, turnId: string, usd: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!(usd >= 0) || !Number.isFinite(usd)) return { ok: false, reason: "invalid reservation" };
    const caps = this.caps();
    if (caps.daily <= 0 || caps.session <= 0) return { ok: false, reason: "no spend is approved for this environment" };
    const d = day(Date.now());
    const totals = (await this.ctx.storage.get<DayTotals>(`day:${d}`)) ?? { committedUsd: 0, turns: 0, unknownTurns: 0 };
    const sessionUsd = (await this.ctx.storage.get<number>(`sess:${sessionId}`)) ?? 0;
    if (totals.committedUsd + usd > caps.daily) return { ok: false, reason: `the daily cap of $${caps.daily.toFixed(2)} would be exceeded` };
    if (sessionUsd + usd > caps.session) return { ok: false, reason: `the per-session cap of $${caps.session.toFixed(2)} would be exceeded` };
    totals.committedUsd += usd;
    totals.turns++;
    await this.ctx.storage.put({ [`day:${d}`]: totals, [`sess:${sessionId}`]: sessionUsd + usd, [`turn:${turnId}`]: { usd, sessionId, day: d } satisfies TurnRecord });
    return { ok: true };
  }

  async reconcile(turnId: string, actualUsd: number | null): Promise<void> {
    const t = await this.ctx.storage.get<TurnRecord>(`turn:${turnId}`);
    if (!t) return;
    const totals = (await this.ctx.storage.get<DayTotals>(`day:${t.day}`)) ?? { committedUsd: 0, turns: 0, unknownTurns: 0 };
    const sessionUsd = (await this.ctx.storage.get<number>(`sess:${t.sessionId}`)) ?? 0;
    if (actualUsd === null || !Number.isFinite(actualUsd)) {
      totals.unknownTurns++;
    } else {
      const delta = actualUsd - t.usd;
      totals.committedUsd = Math.max(0, totals.committedUsd + delta);
      await this.ctx.storage.put(`sess:${t.sessionId}`, Math.max(0, sessionUsd + delta));
    }
    await this.ctx.storage.put(`day:${t.day}`, totals);
    await this.ctx.storage.delete(`turn:${turnId}`);
  }

  async summary(): Promise<LedgerSummary> {
    const d = day(Date.now());
    const totals = (await this.ctx.storage.get<DayTotals>(`day:${d}`)) ?? { committedUsd: 0, turns: 0, unknownTurns: 0 };
    const caps = this.caps();
    return { day: d, ...totals, dailyCapUsd: caps.daily, sessionCapUsd: caps.session };
  }
}
